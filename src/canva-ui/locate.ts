import type { Locator, Page } from "playwright";

/** Tries each locator in turn and returns the first that's actually visible. */
export async function firstVisible(candidates: Locator[], timeoutMs = 12_000): Promise<Locator | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const candidate of candidates) {
      try {
        const el = candidate.first();
        if ((await el.count()) > 0 && (await el.isVisible())) return el;
      } catch {
        /* locator not resolvable yet */
      }
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  return null;
}

/**
 * Canva renders its publish panel inside an iframe, so reading
 * `document.body.innerText` on the main frame alone misses it. Gather text from
 * every frame instead.
 */
export async function allFramesText(page: Page): Promise<string> {
  const chunks = await Promise.all(
    page.frames().map((f) => f.evaluate(() => document.body?.innerText || "").catch(() => "")),
  );
  return chunks.join("\n");
}
