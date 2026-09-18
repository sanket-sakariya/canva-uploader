import { Router, type Response } from "express";
import { log } from "../lib/logger.js";
import { parseCookies, describe } from "../canva-ui/cookies.js";
import { isLoggedIn, snap, DEBUG_DIR } from "../canva-ui/session.js";
import {
  detectConnectedAccount,
  listSharePlatforms,
  openShareMenu,
  selectPlatform,
  waitForPanelReady,
  listAccounts,
  selectAccount,
  dismissAccountPicker,
} from "../canva-ui/discover.js";
import { clickPublishAndWait, typeCaption, publishViaCanvaUi, StepError } from "../canva-ui/publisher.js";
import { loginWithPassword, submitCode } from "../canva-ui/login.js";
import * as live from "../canva-ui/live-session.js";

export const canvaUiRouter = Router();

/* ── helpers ──────────────────────────────────────────────────────────── */

function sse(res: Response) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  const beat = setInterval(() => res.write(": ping\n\n"), 15_000);
  return {
    send: (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
    end: () => {
      clearInterval(beat);
      res.end();
    },
  };
}

const fail = (res: Response, err: unknown, status = 400) =>
  res.status(status).json({ ok: false, message: (err as Error).message });

/* ── step 0 · validate the pasted cookies ─────────────────────────────── */

canvaUiRouter.post("/check-cookies", (req, res) => {
  try {
    const parsed = parseCookies((req.body as { cookies?: string }).cookies ?? "");
    res.json({
      ok: true,
      count: parsed.cookies.length,
      format: parsed.format,
      names: parsed.names,
      looksLikeSession: parsed.looksLikeSession,
      hint: parsed.looksLikeSession
        ? undefined
        : "No obvious Canva session cookie found. Copy the whole `Cookie:` request header — httpOnly cookies don't appear in document.cookie.",
    });
  } catch (err) {
    fail(res, err);
  }
});

/* ── step 1 · open Chrome, sign in, list share destinations ──────────── */

type Send = (event: string, data: unknown) => void;

/**
 * Once the browser is signed in: open the design, open Share, and report the
 * destinations Canva offers. Shared by the cookie path and the password path
 * (which may detour through a verification code first).
 */
async function prepareDesign(session: live.LiveSession, send: Send): Promise<void> {
  send("progress", { step: "Opening design", detail: session.designId });
  await session.page.goto(`https://www.canva.com/design/${session.designId}/edit`, {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });
  await session.page.waitForTimeout(7_000);
  session.designTitle = await session.page.title().catch(() => undefined);
  await snap(session.page, "step1-editor");

  send("progress", { step: "Opening the Share menu" });
  await openShareMenu(session.page);
  await snap(session.page, "step1-share-menu");

  send("progress", { step: "Reading available destinations" });
  session.platforms = await listSharePlatforms(session.page);
  session.state = "picking";

  send("ready", {
    sessionId: session.id,
    designId: session.designId,
    designTitle: session.designTitle,
    platforms: session.platforms,
    debugDir: DEBUG_DIR,
  });
}

canvaUiRouter.post("/open", async (req, res) => {
  const { cookies, designId, email, password, mode } = req.body as {
    cookies?: string;
    designId?: string;
    email?: string;
    password?: string;
    mode?: "cookies" | "password";
  };
  const { send, end } = sse(res);
  let sessionId: string | undefined;

  try {
    if (!designId) throw new Error("`designId` is required.");
    const authMode = mode ?? (email && password ? "password" : "cookies");

    let session: live.LiveSession;

    if (authMode === "password") {
      if (!email || !password) throw new Error("Both `email` and `password` are required for password sign-in.");
      send("progress", { step: "Opening Chrome", detail: "headed — Canva blocks headless" });
      session = await live.create(null, designId);
      sessionId = session.id;

      const result = await loginWithPassword(session.page, email, password, (step, detail) =>
        send("progress", { step, detail }),
      );

      if (result.state === "need-code") {
        session.state = "awaiting-code";
        send("need-code", { sessionId: session.id, message: result.detail, codeSource: result.codeSource });
        return; // the browser stays open; the user posts the code next
      }
      if (result.state === "error") throw new Error(result.detail ?? "Canva sign-in failed.");
      send("progress", { step: "Signed in to Canva", detail: email });
    } else {
      const parsed = parseCookies(cookies ?? "");
      send("progress", { step: "Cookies parsed", detail: `${parsed.cookies.length} cookie(s) [${parsed.format}]` });
      log.info(`Canva UI open: ${describe(parsed)}`);
      if (!parsed.looksLikeSession) {
        send("progress", { step: "Warning", detail: "no obvious session cookie — this may not sign in" });
      }

      send("progress", { step: "Opening Chrome", detail: "headed — Canva blocks headless" });
      session = await live.create(parsed.cookies, designId);
      sessionId = session.id;

      send("progress", { step: "Checking the session" });
      if (!(await isLoggedIn(session.page))) {
        throw new Error(
          "Those cookies did not produce a signed-in Canva session. Re-copy the full `Cookie:` header from a canva.com request.",
        );
      }
      send("progress", { step: "Signed in to Canva" });
    }

    await prepareDesign(session, send);
  } catch (err) {
    if (sessionId) await live.close(sessionId).catch(() => {});
    log.error(`open failed: ${(err as Error).message}`);
    send("error", { message: (err as Error).message, debugDir: DEBUG_DIR });
  } finally {
    end();
  }
});

/* ── step 1b · the emailed verification code, when Canva asks for one ── */

canvaUiRouter.post("/:id/code", async (req, res) => {
  const { send, end } = sse(res);
  let sessionId: string | undefined;
  try {
    const session = live.get(req.params.id as string);
    sessionId = session.id;
    const { code } = req.body as { code?: string };
    if (!code) throw new Error("`code` is required.");

    const result = await submitCode(session.page, code, (step, detail) => send("progress", { step, detail }));
    if (result.state === "need-code") throw new Error(result.detail ?? "That code was not accepted.");
    if (result.state === "error") throw new Error(result.detail ?? "Canva sign-in failed.");

    send("progress", { step: "Signed in to Canva" });
    await prepareDesign(session, send);
  } catch (err) {
    log.error(`code submit failed: ${(err as Error).message}`);
    // Keep the session open so the user can retype the code.
    send("error", { message: (err as Error).message, sessionId, retryCode: true, debugDir: DEBUG_DIR });
  } finally {
    end();
  }
});

/* ── step 2 · pick a platform, then read back the connected account ──── */

canvaUiRouter.post("/:id/platform", async (req, res) => {
  try {
    const session = live.get(req.params.id as string);
    const { platform } = req.body as { platform?: string };
    if (!platform) throw new Error("`platform` is required.");

    await selectPlatform(session.page, platform);
    session.platform = platform;

    // Canva builds the preview asynchronously; reading before it settles yields
    // the "your_username" placeholder and a disabled Publish button.
    const readiness = await waitForPanelReady(session.page);
    await snap(session.page, "step2-platform");

    const account = await detectConnectedAccount(session.page);
    session.account = account;
    session.state = "composing";

    // Offer the accounts Canva has connected for this platform, so the user
    // picks rather than silently inheriting whichever one was last used.
    const accounts = await listAccounts(session.page).catch(() => []);
    await dismissAccountPicker(session.page);
    session.accounts = accounts;

    res.json({
      ok: true,
      platform,
      account,
      accounts,
      panelReady: readiness.ready,
      panelReason: readiness.reason,
    });
  } catch (err) {
    fail(res, err);
  }
});

/* ── step 2b · choose which connected account to post as ─────────────── */

canvaUiRouter.post("/:id/account", async (req, res) => {
  try {
    const session = live.get(req.params.id as string);
    const { handle } = req.body as { handle?: string };
    if (!handle) throw new Error("`handle` is required.");

    if (session.account?.handle === handle) {
      return res.json({ ok: true, account: session.account, changed: false });
    }

    await listAccounts(session.page); // reopen the switcher
    const account = await selectAccount(session.page, handle);
    session.account = account;
    await snap(session.page, "step2b-account");

    res.json({ ok: true, account, changed: true });
  } catch (err) {
    fail(res, err);
  }
});

/* ── step 3 · type the description ───────────────────────────────────── */

canvaUiRouter.post("/:id/caption", async (req, res) => {
  try {
    const session = live.get(req.params.id as string);
    const { caption } = req.body as { caption?: string };
    if (!caption) throw new Error("`caption` is required.");

    const result = await typeCaption(session.page, caption);
    await snap(session.page, "step3-caption");
    res.json({
      ok: result.ok,
      text: result.text,
      message: result.ok ? undefined : "Typed, but Canva's field didn't read back the text. Check the browser window.",
    });
  } catch (err) {
    fail(res, err);
  }
});

/* ── step 4 · upload ─────────────────────────────────────────────────── */

canvaUiRouter.post("/:id/upload", async (req, res) => {
  const { send, end } = sse(res);
  try {
    const session = live.get(req.params.id as string);
    session.state = "publishing";
    send("progress", { step: "Clicking Publish", detail: session.platform });

    const outcome = await clickPublishAndWait(session.page, (detail) => send("progress", { step: "Publishing", detail }));
    await snap(session.page, `step4-${outcome.state}`);
    session.state = "done";

    send("done", {
      published: outcome.state === "success",
      outcome: outcome.state,
      detail: outcome.detail,
      platform: session.platform,
      account: session.account,
      debugDir: DEBUG_DIR,
    });
  } catch (err) {
    log.error(`upload failed: ${(err as Error).message}`);
    send("error", { message: (err as Error).message, debugDir: DEBUG_DIR });
  } finally {
    end();
  }
});

/* ── housekeeping ────────────────────────────────────────────────────── */

canvaUiRouter.get("/sessions", (_req, res) => res.json({ sessions: live.list() }));

canvaUiRouter.post("/:id/close", async (req, res) => {
  await live.close(req.params.id as string);
  res.json({ ok: true });
});

/* ── the original one-shot route, still available ────────────────────── */

canvaUiRouter.post("/publish", async (req, res) => {
  const body = req.body as {
    cookies?: string;
    designId?: string;
    caption?: string;
    platform?: string;
    dryRun?: boolean;
  };
  const { send, end } = sse(res);
  let sessionId: string | undefined;
  try {
    if (!body.designId) throw new Error("`designId` is required.");
    const parsed = parseCookies(body.cookies ?? "");
    send("progress", { step: "Cookies parsed", detail: `${parsed.cookies.length} cookie(s)` });
    send("progress", { step: "Launching browser", detail: "headed — Canva blocks headless" });

    const session = await live.create(parsed.cookies, body.designId);
    sessionId = session.id;
    send("progress", { step: "Checking the session" });
    if (!(await isLoggedIn(session.page))) {
      throw new Error("Those cookies did not produce a signed-in Canva session.");
    }
    send("progress", { step: "Signed in to Canva" });

    const result = await publishViaCanvaUi(session.page, {
      designId: body.designId,
      caption: body.caption,
      platform: body.platform,
      dryRun: body.dryRun,
      onProgress: (step, detail) => send("progress", { step, detail }),
    });
    send("done", { ...result, debugDir: DEBUG_DIR });
  } catch (err) {
    const payload =
      err instanceof StepError
        ? { message: err.message, step: err.step, screenshot: err.screenshot, debugDir: DEBUG_DIR }
        : { message: (err as Error).message, debugDir: DEBUG_DIR };
    log.error(`Canva UI publish failed: ${payload.message}`);
    send("error", payload);
  } finally {
    if (sessionId) await live.close(sessionId).catch(() => {});
    end();
  }
});
