/**
 * Browser launcher, shared by local runs and CI.
 *
 * Canva serves headless Chrome a Cloudflare interstitial (HTTP 403, "Just a
 * moment..."), so every path here is headed. Locally that means the desktop's
 * own display; on a GitHub runner it means Xvfb.
 *
 * In CI we launch **ungoogled-chromium** with the **cf-autoclick** extension —
 * the same stack the url-scraper workflows use to clear Cloudflare. Chrome
 * refuses to load extensions in headless mode, which is the other reason this
 * must stay headed.
 *
 *   CHROME_BIN        path to the chromium binary   (default: system Chrome)
 *   CF_AUTOCLICK_DIR  unpacked cf-autoclick folder  (default: none)
 */
import { chromium, type BrowserContext } from "playwright";
import { existsSync } from "node:fs";
import { log } from "../lib/logger.js";

export interface LaunchOptions {
  userDataDir: string;
  slowMo?: number;
  viewport?: { width: number; height: number };
  /** Overrides the CANVA_HEADLESS env default. */
  headless?: boolean;
}

/**
 * Headed by default, and that is a measurement rather than a preference.
 *
 * A/B against canva.com, identical code and cookies, minutes apart:
 *
 *   headed   ungoogled-chromium + cf-autoclick → first load is "Home - Canva",
 *            never challenged, full run completes in ~42s
 *   headless ungoogled-chromium + cf-autoclick → "Just a moment...", cleared
 *            once after ~16s, then re-challenged on the next navigation and
 *            never cleared again within 60s
 *
 * So cf-autoclick can beat a single Turnstile headless, but Cloudflare
 * fingerprints the headless browser and re-challenges every navigation, which
 * no amount of clicking fixes. CANVA_HEADLESS=1 remains available to re-test
 * if that ever changes.
 */
export function wantsHeadless(): boolean {
  return process.env.CANVA_HEADLESS?.trim() === "1";
}

/** Cloudflare interstitial fingerprints, as used by the scraper stack. */
export const CHALLENGE_MARKERS = ["just a moment", "challenge-platform", "cf_chl_opt", "cf-mitigated"];

export function chromeBin(): string | undefined {
  const bin = process.env.CHROME_BIN?.trim();
  if (!bin) return undefined;
  if (!existsSync(bin)) throw new Error(`CHROME_BIN points at ${bin}, which does not exist.`);
  return bin;
}

export function cfAutoclickDir(): string | undefined {
  const dir = process.env.CF_AUTOCLICK_DIR?.trim();
  if (!dir) return undefined;
  if (!existsSync(`${dir}/manifest.json`)) {
    log.warn(`CF_AUTOCLICK_DIR=${dir} has no manifest.json — Cloudflare challenges will likely stand.`);
    return undefined;
  }
  return dir;
}

export function describeStack(): string {
  const bin = process.env.CHROME_BIN?.trim();
  const ext = cfAutoclickDir();
  return `${bin ? `chromium=${bin}` : "chromium=system chrome"}, ${ext ? `cf-autoclick=${ext}` : "cf-autoclick=off"}`;
}

/**
 * Persistent context, because Playwright can only load an unpacked extension
 * through one. The caller owns the user-data dir and its lifetime.
 */
export async function launch(opts: LaunchOptions): Promise<BrowserContext> {
  const executablePath = chromeBin();
  const extension = cfAutoclickDir();
  const viewport = opts.viewport ?? { width: 1440, height: 900 };
  const headless = opts.headless ?? wantsHeadless();

  const args = [
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-sync",
    "--disable-translate",
    "--disable-blink-features=AutomationControlled",
    `--window-size=${viewport.width},${viewport.height}`,
  ];

  // Required on GitHub runners and inside containers.
  if (process.env.CI || process.env.CHROME_NO_SANDBOX === "1") {
    args.push("--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu");
  }

  if (extension) {
    // Both flags are needed: the allowlist stops Chrome disabling it on load.
    args.push(`--disable-extensions-except=${extension}`, `--load-extension=${extension}`);
  }

  log.info(`Launching browser — ${describeStack()}, headless=${headless}`);
  if (headless) {
    log.warn("CANVA_HEADLESS=1 — Cloudflare re-challenges headless browsers on every navigation.");
    log.warn("Measured: headless clears the first challenge, then stalls. Expect this run to fail.");
  }

  const context = await chromium.launchPersistentContext(opts.userDataDir, {
    headless,
    executablePath,
    // Only ask for the "chrome" channel when no explicit binary was supplied.
    channel: executablePath ? undefined : "chrome",
    slowMo: opts.slowMo ?? 0,
    viewport,
    args,
  });
  context.setDefaultTimeout(30_000);
  return context;
}

/**
 * Waits out a Cloudflare interstitial. cf-autoclick ticks the Turnstile
 * checkbox on its own; this just watches the title until the challenge stops
 * being served, matching the scraper stack's approach.
 */
export async function clearChallenge(
  context: BrowserContext,
  url: string,
  timeoutMs = 90_000,
): Promise<{ cleared: boolean; title: string }> {
  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 }).catch(() => {});

  const deadline = Date.now() + timeoutMs;
  let lastTitle = "";

  while (Date.now() < deadline) {
    const title = (await page.title().catch(() => "")).trim();
    if (title && title !== lastTitle) {
      log.info(`  title: ${JSON.stringify(title)}`);
      lastTitle = title;
    }
    if (title && !CHALLENGE_MARKERS.some((m) => title.toLowerCase().includes(m))) {
      // Give cf_clearance a moment to be written before anything reads it.
      await page.waitForTimeout(3_000);
      log.info("Cloudflare challenge cleared");
      return { cleared: true, title };
    }
    await page.waitForTimeout(2_000);
  }
  return { cleared: false, title: lastTitle };
}
