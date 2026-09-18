/**
 * Drives Canva's own Share → Instagram flow in a logged-in browser.
 *
 * This uses the Meta connection that already exists inside your Canva account,
 * so no Instagram API token is involved. The trade-off is that it depends on
 * Canva's DOM: there is no contract here, and Canva can change any of it without
 * notice. Every step therefore tries several strategies, screenshots what it
 * sees, and fails with the step name rather than a generic timeout.
 */
import type { Locator, Page } from "playwright";
import { log } from "../lib/logger.js";
import { snap } from "./session.js";
import { allFramesText, firstVisible } from "./locate.js";

export interface UiPublishOptions {
  designId: string;
  caption?: string;
  /** Stop before the final confirm click. */
  dryRun?: boolean;
  /** Which entry in Canva's share list to target. */
  platform?: string;
  onProgress?: (step: string, detail?: string) => void;
}

export interface UiPublishResult {
  designId: string;
  platform: string;
  dryRun: boolean;
  /** True only when Canva actually confirmed the upload finished. */
  published?: boolean;
  outcome?: "success" | "error" | "timeout";
  outcomeDetail?: string;
  screenshots: string[];
  finishedAt: string;
}

export class StepError extends Error {
  constructor(
    readonly step: string,
    message: string,
    readonly screenshot?: string,
  ) {
    super(message);
    this.name = "StepError";
  }
}

/**
 * Dumps every visible interactive element. When Canva renames something this is
 * what tells you the new label instead of leaving you guessing.
 */
export async function inspect(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    const nodes = document.querySelectorAll<HTMLElement>(
      'button,[role="button"],[role="menuitem"],[role="option"],a[href],input,textarea,[contenteditable="true"]',
    );
    for (const el of Array.from(nodes)) {
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) continue;
      const style = getComputedStyle(el);
      if (style.visibility === "hidden" || style.display === "none") continue;
      const label =
        el.getAttribute("aria-label") ||
        el.getAttribute("placeholder") ||
        (el.textContent || "").trim().slice(0, 70);
      if (!label) continue;
      out.push(`${el.tagName.toLowerCase()}[${el.getAttribute("role") ?? "-"}] "${label}"`);
    }
    return [...new Set(out)];
  });
}


/** Reads back whatever is now in the caption field, textarea or contenteditable. */
export async function readCaption(box: Locator): Promise<string | null> {
  try {
    const value = await box.inputValue().catch(() => null);
    if (value) return value;
    return (await box.textContent())?.trim() ?? null;
  } catch {
    return null;
  }
}

/**
 * Canva renders the caption box as a contenteditable inside the right-hand share
 * panel, with the placeholder drawn as a sibling node rather than a `placeholder`
 * attribute. So: try the accessible routes first, then fall back to picking the
 * editable element that actually sits inside the panel, which is the right half
 * of the viewport.
 */
export async function findCaptionField(page: Page): Promise<Locator | null> {
  // Canva's share panel may live in an iframe (its publish surfaces are
  // iframe-hosted), so search every frame, not just the main document.
  const scopes = [page, ...page.frames().filter((f) => f !== page.mainFrame())];

  for (const scope of scopes) {
    const direct = await firstVisible(
      [
        scope.getByPlaceholder(/write a caption/i),
        scope.getByPlaceholder(/caption/i),
        scope.locator('[aria-placeholder*="caption" i]'),
        scope.locator('[aria-label*="caption" i]'),
        scope.locator('[data-testid*="caption" i]'),
        scope.getByRole("textbox"),
      ],
      scope === page ? 4_000 : 1_500,
    );
    if (direct) {
      log.debug(`caption field found via accessible selector in ${scope === page ? "main frame" : "iframe"}`);
      return direct;
    }
  }

  // The placeholder is often a plain span painted over a custom editor; clicking
  // it focuses the editor, which is all we need.
  for (const scope of scopes) {
    const ph = scope.getByText(/write a caption/i).first();
    if ((await ph.count().catch(() => 0)) > 0 && (await ph.isVisible().catch(() => false))) {
      log.debug("caption field found via placeholder text node");
      return ph;
    }
  }

  // Last resort: any editable element sitting inside the right-hand panel.
  for (const scope of scopes) {
    const editables = scope.locator('[contenteditable="true"], [role="textbox"], textarea');
    const count = await editables.count().catch(() => 0);
    const splitX = (page.viewportSize()?.width ?? 1440) * 0.6;
    for (let i = 0; i < count; i++) {
      const el = editables.nth(i);
      if (!(await el.isVisible().catch(() => false))) continue;
      const box = await el.boundingBox().catch(() => null);
      if (box && box.x >= splitX && box.width > 80 && box.height > 20) {
        log.debug(`caption field matched by panel position at ${Math.round(box.x)},${Math.round(box.y)}`);
        return el;
      }
    }
  }

  // Nothing matched — dump what the panel actually contains so the next run
  // doesn't have to guess.
  await dumpPanel(page);
  return null;
}

/** Logs the editable/interactive elements per frame, for selector repair. */
async function dumpPanel(page: Page): Promise<void> {
  log.warn("Caption field not found. Frames and candidate fields:");
  for (const frame of page.frames()) {
    const found = await frame
      .evaluate(() => {
        const out: string[] = [];
        const sel = 'textarea,input,[contenteditable],[role="textbox"],[aria-label],[placeholder],[aria-placeholder]';
        for (const el of Array.from(document.querySelectorAll<HTMLElement>(sel))) {
          const r = el.getBoundingClientRect();
          if (r.width < 40 || r.height < 15) continue;
          out.push(
            `${el.tagName.toLowerCase()} role=${el.getAttribute("role")} ce=${el.getAttribute("contenteditable")} ` +
              `ph=${el.getAttribute("placeholder") ?? el.getAttribute("aria-placeholder")} ` +
              `aria=${(el.getAttribute("aria-label") ?? "").slice(0, 30)} @${Math.round(r.x)},${Math.round(r.y)}`,
          );
        }
        return out.slice(0, 25);
      })
      .catch(() => [] as string[]);
    log.warn(`  frame ${frame.url().slice(0, 60) || "(main)"} — ${found.length} candidate(s)`);
    for (const f of found) log.warn(`      ${f}`);
  }
}

export async function publishViaCanvaUi(page: Page, opts: UiPublishOptions): Promise<UiPublishResult> {
  const platform = opts.platform ?? "Instagram";
  const shots: string[] = [];
  const emit = (name: string, detail?: string) => {
    log.info(detail ? `${name} — ${detail}` : name);
    opts.onProgress?.(name, detail);
  };
  const step = async (name: string) => shots.push(await snap(page, name));

  const fail = async (stepName: string, msg: string): Promise<never> => {
    const shot = await snap(page, `FAILED-${stepName}`);
    shots.push(shot);
    const seen = await inspect(page).catch(() => []);
    log.error(`Step "${stepName}" failed. Visible controls at that moment:`);
    for (const s of seen.slice(0, 40)) log.error(`    ${s}`);
    throw new StepError(stepName, msg, shot);
  };

  /* 1 ─ open the design */
  emit("Opening design", opts.designId);
  await page.goto(`https://www.canva.com/design/${opts.designId}/edit`, {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });
  await page.waitForTimeout(6_000); // the editor boots asynchronously
  await step("editor-loaded");

  if (/\/login|\/signup/.test(page.url())) {
    await fail("open-design", "Canva redirected to login. Run `npm run canva:login` first.");
  }

  /* 2 ─ Share */
  const share = await firstVisible([
    page.getByRole("button", { name: /^share$/i }),
    page.getByRole("button", { name: /share/i }),
    page.locator('[data-testid*="share" i]'),
    page.locator('button:has-text("Share")'),
  ]);
  if (!share) await fail("click-share", "Could not find the Share button in the editor.");
  emit("Opening the Share menu");
  await share!.click();
  await page.waitForTimeout(2_500);
  await step("share-menu-open");

  /* 3 ─ find the platform, which may sit behind a search box or a "more" list */
  let target = await firstVisible(
    [
      page.getByRole("menuitem", { name: new RegExp(platform, "i") }),
      page.getByRole("button", { name: new RegExp(platform, "i") }),
      page.locator(`[role="option"]:has-text("${platform}")`),
      page.locator(`div[role="dialog"] :text("${platform}")`),
    ],
    6_000,
  );

  if (!target) {
    // Canva's share panel has a search field; use it rather than hunting the list.
    const search = await firstVisible(
      [
        page.getByPlaceholder(/search/i),
        page.locator('div[role="dialog"] input[type="text"]'),
        page.locator('input[placeholder*="Search" i]'),
      ],
      4_000,
    );
    if (search) {
      await search.fill(platform);
      await page.waitForTimeout(1_800);
      await step("share-searched");
      target = await firstVisible(
        [
          page.getByRole("menuitem", { name: new RegExp(platform, "i") }),
          page.getByRole("button", { name: new RegExp(platform, "i") }),
          page.locator(`[role="option"]:has-text("${platform}")`),
          page.locator(`div[role="dialog"] :text("${platform}")`),
        ],
        6_000,
      );
    }
  }
  if (!target) {
    await fail(
      "select-platform",
      `"${platform}" was not offered in the Share menu. Connect it in Canva first (Share → Social → ${platform}), or pass --platform with the exact label Canva shows.`,
    );
  }
  emit("Selecting platform", platform);
  await target!.click();
  await page.waitForTimeout(3_000);
  await step("platform-selected");

  /* 4 ─ caption */
  if (opts.caption) {
    const box = await findCaptionField(page);
    if (!box) {
      log.warn("No caption field found — continuing without one.");
      await step("caption-not-found");
    } else {
      emit("Typing caption");
      await box.click();
      await page.waitForTimeout(400);
      // Canva's caption box is a contenteditable, not a textarea, so fill()
      // often refuses it — type as a fallback.
      await box.fill(opts.caption).catch(async () => {
        await page.keyboard.type(opts.caption!, { delay: 8 });
      });
      await page.waitForTimeout(900);
      await step("caption-entered");

      const typed = await readCaption(box);
      if (typed && typed.includes(opts.caption.slice(0, 12))) {
        emit("Caption confirmed", `${typed.length} chars in the field`);
      } else {
        log.warn(`Caption may not have registered (field reads: "${(typed ?? "").slice(0, 40)}")`);
      }
    }
  }

  /* 5 ─ publish */
  if (opts.dryRun) {
    emit("Dry run", "stopping before the final confirm click");
    await step("dry-run-stop");
    return { designId: opts.designId, platform, dryRun: true, screenshots: shots, finishedAt: new Date().toISOString() };
  }

  const confirm = await firstVisible(
    [
      page.getByRole("button", { name: /^(publish|post|share now|post now)$/i }),
      page.getByRole("button", { name: /publish|post now|share now/i }),
      page.locator('div[role="dialog"] button:has-text("Publish")'),
      page.locator('div[role="dialog"] button:has-text("Post")'),
    ],
    10_000,
  );
  if (!confirm) await fail("confirm-publish", "Could not find the final Publish/Post button.");

  emit("Clicking Publish");
  await confirm!.click();
  await page.waitForTimeout(2_000);
  await step("publish-clicked");

  emit("Waiting for Canva to finish uploading");
  const outcome = await waitForPublishOutcome(page, (detail) => emit("Publishing", detail));
  await step(`outcome-${outcome.state}`);

  if (outcome.state === "error") {
    await fail("publish", `Canva reported a problem: ${outcome.detail ?? "unknown error"}`);
  }
  if (outcome.state === "timeout") {
    log.warn("Canva never showed a clear result. The post may still have gone through — check Instagram.");
  }

  return {
    designId: opts.designId,
    platform,
    dryRun: false,
    published: outcome.state === "success",
    outcome: outcome.state,
    outcomeDetail: outcome.detail,
    screenshots: shots,
    finishedAt: new Date().toISOString(),
  };
}

export interface PublishOutcome {
  state: "success" | "error" | "timeout";
  detail?: string;
}

/**
 * Canva shows a "Publishing your content..." modal while it uploads, then either
 * a success toast or an error. Closing the browser while that modal is up can
 * abort the upload, so wait for it to clear rather than sleeping a fixed amount.
 */
export async function waitForPublishOutcome(
  page: Page,
  onTick: (detail: string) => void,
  timeoutMs = 180_000,
): Promise<PublishOutcome> {
  const deadline = Date.now() + timeoutMs;
  let sawProgress = false;
  let lastTick = 0;

  while (Date.now() < deadline) {
    // Read every frame: the publish panel and its toasts are iframe-hosted.
    const text = await allFramesText(page).catch(() => null);
    if (text === null) return { state: "timeout", detail: "page became unreadable" };
    const state = {
      publishing: /publishing your content|uploading|preparing your design/i.test(text),
      success: /your content has been published|(published|posted|shared)( successfully)?|your design (was|has been) (published|posted|shared)|successfully (published|posted|shared)|view (post|on instagram)/i.test(text),
      error: /(couldn'?t|could not|failed to|unable to) (publish|post|share|upload)|something went wrong|try again later/i.test(text),
    };

    if (state.publishing) {
      sawProgress = true;
      if (Date.now() - lastTick > 10_000) {
        lastTick = Date.now();
        onTick("still uploading…");
      }
    }
    if (state.error) {
      const m = text.match(
        /.{0,90}((couldn'?t|could not|failed to|unable to) (publish|post|share|upload)|something went wrong).{0,90}/i,
      );
      return { state: "error", detail: m?.[0]?.trim().replace(/\s+/g, " ") };
    }
    // Success only counts once the progress modal has actually cleared.
    if (state.success && !state.publishing) {
      return { state: "success", detail: "Canva reported the post was published" };
    }
    // Modal appeared and then went away with no error — treat as done.
    if (sawProgress && !state.publishing) {
      await page.waitForTimeout(3_000);
      const stillClean = await allFramesText(page)
        .then((t) => !/publishing your content|uploading/i.test(t))
        .catch(() => true);
      if (stillClean) return { state: "success", detail: "upload finished, no error shown" };
    }

    await page.waitForTimeout(2_000);
  }
  return { state: "timeout", detail: `no result after ${Math.round(timeoutMs / 1000)}s` };
}


/** Types a caption into Canva's publish panel and reads it back to confirm. */
export async function typeCaption(page: Page, caption: string): Promise<{ ok: boolean; text?: string }> {
  const box = await findCaptionField(page);
  if (!box) {
    await dumpPanel(page);
    return { ok: false };
  }
  await box.click();
  await page.waitForTimeout(400);
  await box.fill(caption).catch(async () => {
    await page.keyboard.type(caption, { delay: 8 });
  });
  await page.waitForTimeout(900);
  const text = (await readCaption(box)) ?? undefined;
  return { ok: Boolean(text && text.includes(caption.slice(0, 12))), text };
}

/** Clicks the final Publish/Post button and waits for Canva to actually finish. */
export async function clickPublishAndWait(
  page: Page,
  onTick: (detail: string) => void = () => {},
): Promise<PublishOutcome> {
  const confirm = await firstVisible(
    [
      page.getByRole("button", { name: /^(publish|post|share now|post now|publish now)$/i }),
      page.getByRole("button", { name: /publish now|post now|share now|publish/i }),
      page.locator('button:has-text("Publish now")'),
      page.locator('button:has-text("Publish")'),
      page.locator('button:has-text("Post")'),
    ],
    10_000,
  );
  if (!confirm) throw new Error("Could not find the final Publish/Post button.");
  await confirm.click();
  await page.waitForTimeout(2_000);
  return waitForPublishOutcome(page, onTick);
}
