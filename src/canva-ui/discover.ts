/**
 * Reads what Canva is actually offering, rather than assuming.
 *
 *  - which share destinations exist for this design
 *  - which account is connected for the one you picked
 *
 * Everything here is discovery: it reports what it found so the caller (and the
 * user) can choose, instead of hard-coding "Instagram" and hoping.
 */
import type { Frame, Locator, Page } from "playwright";
import { log } from "../lib/logger.js";
import { allFramesText, firstVisible } from "./locate.js";

/** Destinations worth surfacing as "social" in the picker. */
const KNOWN_SOCIAL = [
  "Instagram",
  "Facebook",
  "Facebook Page",
  "LinkedIn",
  "Pinterest",
  "TikTok",
  "X",
  "Twitter",
  "Threads",
  "YouTube",
  "Tumblr",
  "WhatsApp",
  "Snapchat",
  "Slack",
  "Mastodon",
  "Reddit",
];

export interface SharePlatform {
  label: string;
  /** True when it matches a social network we recognise. */
  social: boolean;
}

export interface AccountOption {
  handle: string;
  /** True when this is the one Canva currently has selected. */
  current: boolean;
}

export interface ConnectedAccount {
  /** e.g. "your_handle" */
  handle?: string;
  /** The raw line Canva rendered, for display. */
  raw?: string;
  connected: boolean;
}


/** Is a Publish/Post button present and enabled, in any frame? */
async function publishButtonEnabled(page: Page): Promise<boolean> {
  for (const frame of page.frames()) {
    const enabled = await frame
      .evaluate(() => {
        for (const el of Array.from(document.querySelectorAll<HTMLButtonElement>("button"))) {
          const label = (el.getAttribute("aria-label") || el.textContent || "").trim();
          if (/^(publish now|publish|post now|share now)$/i.test(label)) {
            return !el.disabled && el.getAttribute("aria-disabled") !== "true";
          }
        }
        return null;
      })
      .catch(() => null);
    if (enabled !== null) return enabled;
  }
  return false;
}

/** Clicks Share and waits for the panel. */
export async function openShareMenu(page: Page): Promise<void> {
  const share = await firstVisible([
    page.getByRole("button", { name: /^share$/i }),
    page.getByRole("button", { name: /share/i }),
    page.locator('[data-testid*="share" i]'),
    page.locator('button:has-text("Share")'),
  ]);
  if (!share) throw new Error("Could not find the Share button in the Canva editor.");
  await share.click();
  await page.waitForTimeout(2_500);
}

/**
 * Enumerates the destinations in the open Share panel. Canva paginates these
 * behind a "See all" / "More" affordance, so expand first when one is present.
 */
export async function listSharePlatforms(page: Page): Promise<SharePlatform[]> {
  const more = await firstVisible(
    [
      page.getByRole("button", { name: /^(see all|more|show all)$/i }),
      page.locator('button:has-text("See all")'),
    ],
    2_500,
  );
  if (more) {
    await more.click().catch(() => {});
    await page.waitForTimeout(1_800);
  }

  const labels = await page.evaluate(() => {
    const found = new Set<string>();
    const nodes = document.querySelectorAll<HTMLElement>(
      'button,[role="button"],[role="menuitem"],[role="option"],[role="listitem"]',
    );
    for (const el of Array.from(nodes)) {
      const r = el.getBoundingClientRect();
      if (r.width < 20 || r.height < 16) continue;
      const style = getComputedStyle(el);
      if (style.visibility === "hidden" || style.display === "none") continue;
      const label = (el.getAttribute("aria-label") || el.textContent || "").trim();
      if (!label || label.length > 40) continue;
      found.add(label);
    }
    return [...found];
  });

  const platforms: SharePlatform[] = [];
  const seen = new Set<string>();
  for (const label of labels) {
    const match = KNOWN_SOCIAL.find(
      (p) => label.toLowerCase() === p.toLowerCase() || label.toLowerCase().startsWith(p.toLowerCase() + " "),
    );
    const key = (match ?? label).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    if (match) platforms.push({ label: match, social: true });
  }

  log.info(`Share panel offers ${platforms.length} social destination(s): ${platforms.map((p) => p.label).join(", ") || "none"}`);
  if (!platforms.length) {
    log.warn(`No known social destination matched. Raw labels seen: ${labels.slice(0, 40).join(" | ")}`);
  }
  return platforms;
}

/** Clicks a destination by its label. */
export async function selectPlatform(page: Page, platform: string): Promise<void> {
  const rx = new RegExp(`^${platform.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i");
  let target = await firstVisible(
    [
      page.getByRole("menuitem", { name: rx }),
      page.getByRole("button", { name: rx }),
      page.getByRole("button", { name: new RegExp(platform, "i") }),
      page.locator(`[role="option"]:has-text("${platform}")`),
    ],
    6_000,
  );

  if (!target) {
    const search = await firstVisible(
      [page.getByPlaceholder(/search/i), page.locator('input[placeholder*="Search" i]')],
      3_000,
    );
    if (search) {
      await search.fill(platform);
      await page.waitForTimeout(1_800);
      target = await firstVisible(
        [page.getByRole("button", { name: new RegExp(platform, "i") }), page.locator(`:text("${platform}")`)],
        5_000,
      );
    }
  }
  if (!target) throw new Error(`"${platform}" was not offered in Canva's Share panel.`);
  await target.click();
  await page.waitForTimeout(3_500);
}

export interface PanelReadiness {
  ready: boolean;
  reason?: string;
}

/**
 * After picking a platform, Canva renders the publish panel asynchronously:
 * it shows "Creating preview" with a placeholder handle and a disabled Publish
 * button until the media is ready. Reading the account before that lands gives
 * you "your_username", so wait for the panel to settle first.
 */
export async function waitForPanelReady(page: Page, timeoutMs = 90_000): Promise<PanelReadiness> {
  const deadline = Date.now() + timeoutMs;
  let lastReason = "panel never finished loading";

  while (Date.now() < deadline) {
    const text = await allFramesText(page);
    const buildingPreview = /creating preview|you'?ll be able to preview/i.test(text);
    const hasAccountLine = /(logged|signed) in as/i.test(text);
    const publishEnabled = await publishButtonEnabled(page);

    if (!buildingPreview && hasAccountLine && publishEnabled) return { ready: true };

    lastReason = buildingPreview
      ? "Canva is still building the preview"
      : !hasAccountLine
        ? "no connected-account line rendered yet"
        : "the Publish button is still disabled";

    await page.waitForTimeout(1_500);
  }
  log.warn(`Publish panel not fully ready: ${lastReason}`);
  return { ready: false, reason: lastReason };
}

/**
 * Reads which account Canva will post as. Canva renders this as
 * "You are logged in as <handle>" in the publish panel.
 */
export async function detectConnectedAccount(page: Page): Promise<ConnectedAccount> {
  const deadline = Date.now() + 20_000;
  const patterns = [
    /you(?:'re| are) (?:logged|signed) in as\s*\n?\s*([^\n]{1,60})/i,
    /posting (?:to|as)\s*\n?\s*([^\n]{1,60})/i,
    /connected (?:account|as)\s*\n?\s*([^\n]{1,60})/i,
  ];

  while (Date.now() < deadline) {
    const text = await allFramesText(page);

    for (const rx of patterns) {
      const m = text.match(rx);
      const handle = m?.[1]?.trim();
      // "your_username" is Canva's placeholder while the preview builds.
      if (handle && !/^your[_ ]?username$/i.test(handle)) {
        log.info(`Connected account detected: ${handle}`);
        return { handle, raw: m![0].replace(/\s+/g, " ").trim(), connected: true };
      }
    }
    if (/connect (?:your |an )?(account|instagram|facebook|linkedin|tiktok)/i.test(text)) {
      return { connected: false, raw: "Canva is asking you to connect an account for this platform." };
    }
    await page.waitForTimeout(1_200);
  }
  return { connected: false, raw: "Could not read a connected account from the panel." };
}


/** Labels that turn up near the account row but are not accounts. */
const NOT_AN_ACCOUNT =
  /^(add|connect|manage|log ?out|sign ?out|switch|refresh|cancel|done|back|more|settings|home|file|share|analytics|page \d|all changes saved|start your free trial|edit|generate caption|tag people|invite collaborators|add image|add video|post|reel|story|format|choose pages|publish)/i;

/** A plausible social handle: no spaces, not a sentence. */
function looksLikeHandle(label: string): boolean {
  if (!label || label.length > 40) return false;
  if (NOT_AN_ACCOUNT.test(label)) return false;
  if (/\s/.test(label)) return false;
  return /^[A-Za-z0-9._@-]+$/.test(label);
}

/**
 * Lists the accounts Canva has connected for the chosen platform.
 *
 * Deliberately conservative: the current account is always reported (that one
 * is read straight off the panel and is certain), and extra options are only
 * added when they come from the same frame as the account row and actually look
 * like handles. A broad DOM sweep here picks up the editor toolbar instead.
 */
export async function listAccounts(page: Page): Promise<AccountOption[]> {
  const current = await detectConnectedAccount(page);
  const base: AccountOption[] = current.handle ? [{ handle: current.handle, current: true }] : [];

  // Locate the account row; options render in the same frame it lives in.
  let row: { frame: Frame; locator: Locator } | null = null;
  for (const frame of page.frames()) {
    const candidate = frame
      .locator('xpath=//*[contains(translate(text(),"YOULGEDINAS","youlgedinas"),"logged in as")]/ancestor::*[self::button or @role="button" or @role="combobox"][1]')
      .first();
    if ((await candidate.count().catch(() => 0)) > 0 && (await candidate.isVisible().catch(() => false))) {
      row = { frame, locator: candidate };
      break;
    }
  }
  if (!row) {
    log.debug("No account switcher found — reporting the current account only.");
    return base;
  }

  await row.locator.click().catch(() => {});
  await page.waitForTimeout(1_500);

  const labels = await row.frame
    .evaluate(() => {
      const out: string[] = [];
      const nodes = document.querySelectorAll<HTMLElement>(
        '[role="option"],[role="menuitemradio"],[role="listbox"] button,[role="listbox"] li',
      );
      for (const el of Array.from(nodes)) {
        const r = el.getBoundingClientRect();
        if (r.width < 20 || r.height < 14) continue;
        const label = (el.getAttribute("aria-label") || el.textContent || "").trim();
        if (label) out.push(label.split("\n")[0]!.trim());
      }
      return out;
    })
    .catch(() => [] as string[]);

  const accounts = [...base];
  for (const label of labels) {
    if (!looksLikeHandle(label)) continue;
    if (accounts.some((a) => a.handle === label)) continue;
    accounts.push({ handle: label, current: false });
  }

  log.info(
    `Accounts for this platform: ${accounts.map((a) => a.handle + (a.current ? " (current)" : "")).join(", ") || "none"}` +
      (labels.length ? ` (${labels.length} raw option(s) seen)` : ""),
  );
  return accounts;
}

/** Picks one of the accounts returned by {@link listAccounts}. */
export async function selectAccount(page: Page, handle: string): Promise<ConnectedAccount> {
  const rx = new RegExp(handle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
  let clicked = false;

  for (const frame of page.frames()) {
    const option = await firstVisible(
      [
        frame.getByRole("option", { name: rx }),
        frame.getByRole("menuitemradio", { name: rx }),
        frame.getByRole("menuitem", { name: rx }),
        frame.getByRole("button", { name: rx }),
      ],
      2_500,
    );
    if (option) {
      await option.click();
      clicked = true;
      break;
    }
  }
  if (!clicked) throw new Error(`Could not find "${handle}" in Canva's account list.`);

  await page.waitForTimeout(2_500);
  return detectConnectedAccount(page);
}

/** Closes the account dropdown without changing the selection. */
export async function dismissAccountPicker(page: Page): Promise<void> {
  await page.keyboard.press("Escape").catch(() => {});
  await page.waitForTimeout(800);
}
