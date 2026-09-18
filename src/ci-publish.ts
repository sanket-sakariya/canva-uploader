/**
 * Non-interactive publisher for CI.
 *
 * Runs the same pipeline the web stepper drives, but start-to-finish with no
 * human in the loop: inject Canva cookies → open the design → pick the
 * destination → verify the connected account → type the caption → publish.
 *
 * Designed for a GitHub runner with Xvfb, ungoogled-chromium and cf-autoclick
 * (see .github/workflows/canva-publish.yml). Everything comes from env so
 * nothing secret needs to appear on the command line.
 *
 *   CANVA_COOKIES        the cookie blob itself (any supported format)
 *   CANVA_COOKIES_FILE   …or a path to it
 *   CANVA_DESIGN_ID      e.g. DAGxxxxxxxxx
 *   CANVA_PLATFORM       default: Instagram
 *   CANVA_ACCOUNT        optional: post as this handle
 *   CANVA_CAPTION        optional
 *   CANVA_DRY_RUN        "1" to stop before the final Publish click
 *   CHROME_BIN / CF_AUTOCLICK_DIR  see canva-ui/browser.ts
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { log } from "./lib/logger.js";
import { parseCookies, describe } from "./canva-ui/cookies.js";
import { clearChallenge, describeStack } from "./canva-ui/browser.js";
import { DEBUG_DIR, isLoggedIn, openEphemeralContext, snap } from "./canva-ui/session.js";
import {
  detectConnectedAccount,
  listAccounts,
  listSharePlatforms,
  openShareMenu,
  selectAccount,
  selectPlatform,
  waitForPanelReady,
} from "./canva-ui/discover.js";
import { clickPublishAndWait, typeCaption } from "./canva-ui/publisher.js";

interface Summary {
  ok: boolean;
  dryRun: boolean;
  designId: string;
  designTitle?: string;
  platform: string;
  platformsOffered: string[];
  account?: string;
  accountsOffered: string[];
  caption?: string;
  captionConfirmed?: boolean;
  outcome?: string;
  detail?: string;
  error?: string;
  startedAt: string;
  elapsedMs: number;
}

function env(name: string, fallback?: string): string | undefined {
  const v = process.env[name]?.trim();
  return v || fallback;
}

function readCookies(): string {
  const inline = env("CANVA_COOKIES");
  if (inline) return inline;
  const file = env("CANVA_COOKIES_FILE");
  if (file) return readFileSync(file, "utf8");
  throw new Error("Set CANVA_COOKIES or CANVA_COOKIES_FILE.");
}

async function main(): Promise<void> {
  const startedAt = new Date().toISOString();
  const started = Date.now();

  const designId = env("CANVA_DESIGN_ID");
  if (!designId) throw new Error("CANVA_DESIGN_ID is required.");
  const platform = env("CANVA_PLATFORM", "Instagram")!;
  const wantedAccount = env("CANVA_ACCOUNT");
  const caption = env("CANVA_CAPTION");
  const dryRun = env("CANVA_DRY_RUN") === "1";

  mkdirSync(DEBUG_DIR, { recursive: true });

  const summary: Summary = {
    ok: false,
    dryRun,
    designId,
    platform,
    platformsOffered: [],
    accountsOffered: [],
    caption,
    startedAt,
    elapsedMs: 0,
  };

  log.info(`Stack: ${describeStack()}`);
  log.info(`DISPLAY=${process.env.DISPLAY ?? "(unset)"}`);
  if (!process.env.DISPLAY && process.platform === "linux") {
    throw new Error(
      "No DISPLAY. Canva blocks headless browsers, so CI must provide one (Xvfb). See the workflow.",
    );
  }

  const parsed = parseCookies(readCookies());
  log.info(describe(parsed));
  if (!parsed.looksLikeSession) {
    log.warn("No obvious Canva session cookie — sign-in will probably fail.");
  }

  const context = await openEphemeralContext(parsed.cookies);
  try {
    // Warm up through Cloudflare before anything that matters. cf-autoclick
    // ticks the Turnstile checkbox; this waits for the interstitial to lift.
    const challenge = await clearChallenge(context, "https://www.canva.com/");
    if (!challenge.cleared) {
      throw new Error(
        `Cloudflare challenge never cleared (last title: ${JSON.stringify(challenge.title)}). ` +
          "Check CF_AUTOCLICK_DIR is set and the run is headed.",
      );
    }

    const page = context.pages()[0] ?? (await context.newPage());
    await snap(page, "ci-01-warmed");

    if (!(await isLoggedIn(page))) {
      throw new Error("Cookies did not produce a signed-in Canva session (they may have expired).");
    }
    log.info("Signed in to Canva");

    await page.goto(`https://www.canva.com/design/${designId}/edit`, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    await page.waitForTimeout(7_000);
    summary.designTitle = await page.title().catch(() => undefined);
    await snap(page, "ci-02-editor");

    await openShareMenu(page);
    await snap(page, "ci-03-share");

    const platforms = await listSharePlatforms(page);
    summary.platformsOffered = platforms.map((p) => p.label);
    if (!platforms.some((p) => p.label.toLowerCase() === platform.toLowerCase())) {
      throw new Error(
        `"${platform}" is not connected in Canva. Offered: ${summary.platformsOffered.join(", ") || "none"}`,
      );
    }

    await selectPlatform(page, platform);
    const readiness = await waitForPanelReady(page);
    if (!readiness.ready) log.warn(`Publish panel not fully ready: ${readiness.reason}`);
    await snap(page, "ci-04-platform");

    const accounts = await listAccounts(page).catch(() => []);
    summary.accountsOffered = accounts.map((a) => a.handle);

    let account = await detectConnectedAccount(page);
    if (wantedAccount && account.handle !== wantedAccount) {
      log.info(`Switching account to ${wantedAccount}`);
      account = await selectAccount(page, wantedAccount);
    }
    summary.account = account.handle;
    if (!account.connected) {
      throw new Error(account.raw ?? `No connected ${platform} account in Canva.`);
    }
    if (wantedAccount && account.handle !== wantedAccount) {
      throw new Error(`Wanted to post as ${wantedAccount} but Canva is set to ${account.handle}.`);
    }

    if (caption) {
      const typed = await typeCaption(page, caption);
      summary.captionConfirmed = typed.ok;
      if (!typed.ok) log.warn("Caption did not read back from Canva's field.");
      await snap(page, "ci-05-caption");
    }

    if (dryRun) {
      log.info("Dry run — stopping before the final Publish click.");
      summary.ok = true;
      summary.outcome = "dry-run";
      return;
    }

    const outcome = await clickPublishAndWait(page, (detail) => log.info(`  publishing — ${detail}`));
    await snap(page, `ci-06-${outcome.state}`);
    summary.outcome = outcome.state;
    summary.detail = outcome.detail;
    summary.ok = outcome.state === "success";

    if (!summary.ok) {
      throw new Error(`Publish finished as "${outcome.state}": ${outcome.detail ?? "no detail"}`);
    }
    log.info(`Published to ${platform} as ${account.handle}`);
  } finally {
    summary.elapsedMs = Date.now() - started;
    const out = resolve(DEBUG_DIR, "summary.json");
    writeFileSync(out, JSON.stringify(summary, null, 2));
    log.info(`Summary → ${out}`);
    await context.close().catch(() => {});
  }
}

main().catch((err) => {
  const message = (err as Error).message;
  log.error(`FAILED: ${message}`);
  try {
    const out = resolve(DEBUG_DIR, "summary.json");
    const prev = JSON.parse(readFileSync(out, "utf8")) as Summary;
    writeFileSync(out, JSON.stringify({ ...prev, ok: false, error: message }, null, 2));
  } catch {
    /* summary may not exist yet */
  }
  process.exit(1);
});
