/**
 * Browser session for driving Canva's own UI.
 *
 * Must run headed: canva.com returns a Cloudflare challenge (HTTP 403, "Just a
 * moment...") to headless Chrome, and HTTP 200 to a real window. Verified, not
 * assumed.
 *
 * Deliberate design choice: this uses a *persistent Chrome profile* on disk
 * rather than extracting cookies. You log in once, by hand, in a real browser
 * window; Chrome keeps the session in its own profile exactly as it would
 * normally. Nothing here ever reads, serialises or transmits your cookies.
 */
import type { BrowserContext, Page } from "playwright";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { log } from "../lib/logger.js";
import { CHALLENGE_MARKERS, launch } from "./browser.js";
import type { PwCookie } from "./cookies.js";

export const PROFILE_DIR = resolve(process.cwd(), ".canva-profile");
export const DEBUG_DIR = resolve(process.cwd(), ".canva-debug");

export interface SessionOptions {
  headless?: boolean;
  /** Use the system Chrome rather than Playwright's bundled Chromium. */
  useSystemChrome?: boolean;
  slowMo?: number;
}

export async function openContext(opts: SessionOptions = {}): Promise<BrowserContext> {
  mkdirSync(PROFILE_DIR, { recursive: true });
  mkdirSync(DEBUG_DIR, { recursive: true });
  return launch({ userDataDir: PROFILE_DIR, slowMo: opts.slowMo });
}

/**
 * Canva redirects to a login page when the session isn't valid.
 *
 * Navigating here can land on a *fresh* Cloudflare interstitial even when the
 * challenge was already cleared once — it re-arms per navigation, and clears
 * more slowly headless. Judging "signed out" while the interstitial is up is
 * wrong, so wait it out first.
 */
export async function isLoggedIn(page: Page, timeoutMs = 60_000): Promise<boolean> {
  await page.goto("https://www.canva.com/", { waitUntil: "domcontentloaded" }).catch(() => {});

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await page.waitForTimeout(2_000);
    const title = (await page.title().catch(() => "")).toLowerCase();
    if (CHALLENGE_MARKERS.some((m) => title.includes(m))) continue; // still challenged

    const url = page.url();
    if (/\/login|\/signup/.test(url)) return false;

    // The home feed renders a "Create a design" affordance only when signed in.
    const marker = page.getByRole("button", { name: /create a design/i }).first();
    if ((await marker.count().catch(() => 0)) > 0) return true;
    if (/canva\.com\/(folder|design|projects)/.test(url)) return true;

    // Past the challenge, on canva.com, but no signed-in marker yet — give the
    // app shell a moment before calling it.
    if (Date.now() > deadline - 10_000) return false;
  }
  log.warn("Gave up waiting for Canva to get past the Cloudflare challenge");
  return false;
}

let shotCounter = 0;

/** Screenshots are the only way to debug a selector break you can't reproduce. */
export async function snap(page: Page, label: string): Promise<string> {
  const name = `${String(++shotCounter).padStart(2, "0")}-${label.replace(/[^a-z0-9]+/gi, "-")}.png`;
  const path = resolve(DEBUG_DIR, name);
  await page.screenshot({ path, fullPage: false }).catch(() => {});
  log.debug(`screenshot → ${path}`);
  return path;
}


/**
 * A throwaway context seeded with pasted cookies. Nothing is written to a
 * profile directory, so the session lives only for this one publish and
 * disappears with the process.
 */
export async function openEphemeralContext(
  cookies: PwCookie[],
  opts: SessionOptions = {},
): Promise<BrowserContext> {
  mkdirSync(DEBUG_DIR, { recursive: true });

  // A temp profile rather than a shared one: the session dies with the run.
  // It has to be a *persistent* context because that is the only kind
  // Playwright can load an unpacked extension (cf-autoclick) into.
  const userDataDir = mkdtempSync(join(tmpdir(), "canva-session-"));
  const context = await launch({ userDataDir, slowMo: opts.slowMo });

  context.on("close", () => {
    try {
      rmSync(userDataDir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  });

  if (cookies.length) {
    await context.addCookies(cookies);
    log.info(`Injected ${cookies.length} cookie(s) into a throwaway browser context`);
  } else {
    log.info("Opened a throwaway browser context with no cookies (password sign-in)");
  }
  return context;
}
