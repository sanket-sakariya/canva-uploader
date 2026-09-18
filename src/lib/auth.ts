/**
 * Optional bearer-token guard.
 *
 * The session API drives a browser holding the user's Canva cookies, so it must
 * not be reachable by anyone who happens to find the URL. Local runs stay open
 * (no token configured); anything exposed — a Cloudflare tunnel, a deployment —
 * sets API_TOKEN and every /api call must carry it.
 */
import { timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { log } from "./logger.js";

const TOKEN = process.env.API_TOKEN?.trim() ?? "";

export const authEnabled = (): boolean => TOKEN.length > 0;

function matches(candidate: string): boolean {
  const a = Buffer.from(candidate);
  const b = Buffer.from(TOKEN);
  // timingSafeEqual throws on length mismatch, which is itself a signal.
  return a.length === b.length && timingSafeEqual(a, b);
}

export function requireToken(req: Request, res: Response, next: NextFunction): void {
  if (!authEnabled()) return next();

  const header = req.get("authorization") ?? "";
  const bearer = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  const supplied = bearer || (req.get("x-api-token") ?? "").trim();

  if (supplied && matches(supplied)) return next();

  log.warn(`401 ${req.method} ${req.path} — missing or bad API token`);
  res.status(401).json({
    error: "unauthorized",
    message: "This server requires an API token. Send it as `Authorization: Bearer <token>`.",
  });
}

export function announce(): void {
  if (authEnabled()) log.info("API token required (API_TOKEN is set)");
  else log.warn("No API_TOKEN set — the API is open to anyone who can reach this port.");
}
