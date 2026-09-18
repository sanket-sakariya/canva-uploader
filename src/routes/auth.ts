import { Router } from "express";
import { config } from "../config.js";
import { buildAuthorizeUrl, exchangeCode } from "../canva/oauth.js";
import type { Pkce } from "../lib/pkce.js";
import { log } from "../lib/logger.js";
import * as tokens from "../store/tokenStore.js";

/**
 * PKCE verifiers, held server-side only — Canva is explicit that the verifier
 * must never be reachable by the browser. Keyed by `state`, short-lived.
 */
const pending = new Map<string, { pkce: Pkce; createdAt: number }>();
const STATE_TTL_MS = 10 * 60 * 1000;

setInterval(() => {
  const now = Date.now();
  for (const [state, entry] of pending) {
    if (now - entry.createdAt > STATE_TTL_MS) pending.delete(state);
  }
}, 60_000).unref();

export const authRouter = Router();

authRouter.get("/canva", (_req, res) => {
  const { url, state, pkce } = buildAuthorizeUrl();
  pending.set(state, { pkce, createdAt: Date.now() });
  log.info("Redirecting to Canva for authorization");
  res.redirect(url);
});

authRouter.get("/canva/callback", async (req, res) => {
  const { code, state, error, error_description } = req.query as Record<string, string | undefined>;

  if (error) {
    return res.status(400).send(page("Canva authorization failed", `${error}: ${error_description ?? ""}`));
  }
  if (!code || !state) {
    return res.status(400).send(page("Canva authorization failed", "Missing `code` or `state` in the callback."));
  }

  const entry = pending.get(state);
  if (!entry) {
    return res
      .status(400)
      .send(page("Canva authorization failed", "Unknown or expired `state`. Start again from /auth/canva."));
  }
  pending.delete(state); // single use, CSRF protection

  try {
    const token = tokens.fromTokenResponse(await exchangeCode(code, entry.pkce.verifier));
    await tokens.save(token);
    log.info(`Connected to Canva (scopes: ${token.scope})`);

    const forBrowser = tokens.browserPayload(token);
    if (forBrowser) {
      // The page stashes this in localStorage and sends it back as x-canva-token.
      const fragment = new URLSearchParams({
        canva_access_token: forBrowser.accessToken,
        expires_at: String(forBrowser.expiresAt),
      });
      return res.redirect(`/#${fragment}`);
    }
    return res.redirect("/?connected=1");
  } catch (err) {
    log.error("Token exchange failed", (err as Error).message);
    return res.status(500).send(page("Token exchange failed", (err as Error).message));
  }
});

authRouter.get("/status", async (_req, res) => {
  const token = await tokens.load();
  res.json({
    connected: Boolean(token),
    tokenStore: config.tokenStore,
    scope: token?.scope,
    expiresAt: token?.expiresAt,
    expired: token ? tokens.isExpired(token) : null,
  });
});

authRouter.post("/logout", async (_req, res) => {
  await tokens.clear();
  res.json({ ok: true });
});

function page(title: string, detail: string): string {
  const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);
  return `<!doctype html><meta charset="utf-8"><title>${esc(title)}</title>
<body style="font:15px/1.6 system-ui;margin:3rem auto;max-width:44rem;padding:0 1rem">
<h1 style="font-size:1.3rem">${esc(title)}</h1><p style="color:#b00">${esc(detail)}</p>
<p><a href="/">Back</a> &middot; <a href="/auth/canva">Try again</a></p>`;
}
