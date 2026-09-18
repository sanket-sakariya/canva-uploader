/**
 * Accepts a pasted Canva session in either of the two shapes people can
 * actually get out of a browser, and turns it into Playwright cookies.
 *
 *   1. The raw `Cookie:` request header, copied from DevTools → Network.
 *      This is the one to prefer: it includes httpOnly cookies, which
 *      `document.cookie` in the console does not.
 *   2. A JSON array exported by a cookie extension (Cookie-Editor,
 *      EditThisCookie and friends all emit roughly this shape).
 *   3. A Netscape `cookies.txt` file, as produced by "Get cookies.txt" and by
 *      curl/wget. Tab-separated, optionally with a `#HttpOnly_` domain prefix.
 */
import type { Cookie } from "playwright";

export type PwCookie = Parameters<import("playwright").BrowserContext["addCookies"]>[0][number];

const DEFAULT_DOMAIN = ".canva.com";

/** Cookies Canva uses to identify a signed-in session. */
const SESSION_HINTS = ["CANVA_SESSION", "canva_session", "sessionid", "CID", "auth"];

export interface ParsedCookies {
  cookies: PwCookie[];
  format: "header" | "json" | "netscape";
  names: string[];
  looksLikeSession: boolean;
}

function mapSameSite(raw: unknown): "Strict" | "Lax" | "None" | undefined {
  const v = String(raw ?? "").toLowerCase();
  if (v === "strict") return "Strict";
  if (v === "lax") return "Lax";
  if (v === "none" || v === "no_restriction") return "None";
  return undefined;
}

function fromJson(input: string): PwCookie[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    return null;
  }
  const list = Array.isArray(parsed) ? parsed : (parsed as { cookies?: unknown[] })?.cookies;
  if (!Array.isArray(list)) return null;

  const out: PwCookie[] = [];
  for (const raw of list) {
    if (!raw || typeof raw !== "object") continue;
    const c = raw as Record<string, unknown>;
    const name = typeof c.name === "string" ? c.name : "";
    const value = typeof c.value === "string" ? c.value : "";
    if (!name) continue;

    const cookie: PwCookie = {
      name,
      value,
      domain: typeof c.domain === "string" && c.domain ? c.domain : DEFAULT_DOMAIN,
      path: typeof c.path === "string" && c.path ? c.path : "/",
    };
    if (typeof c.httpOnly === "boolean") cookie.httpOnly = c.httpOnly;
    if (typeof c.secure === "boolean") cookie.secure = c.secure;
    const sameSite = mapSameSite(c.sameSite);
    if (sameSite) cookie.sameSite = sameSite;
    // Extensions use `expirationDate` (seconds, float); Playwright wants `expires`.
    const exp = c.expirationDate ?? c.expires;
    if (typeof exp === "number" && Number.isFinite(exp) && exp > 0) cookie.expires = Math.floor(exp);
    out.push(cookie);
  }
  return out.length ? out : null;
}


/**
 * Netscape cookie file:
 *   domain <TAB> includeSubdomains <TAB> path <TAB> secure <TAB> expiry <TAB> name <TAB> value
 * Real files use tabs, but pasted text often arrives space-padded, so fall back
 * to splitting on runs of whitespace and treat everything after field 6 as the
 * value.
 */
function fromNetscape(input: string): PwCookie[] | null {
  const out: PwCookie[] = [];

  for (const rawLine of input.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (!line.trim()) continue;

    // `#HttpOnly_domain` marks an httpOnly cookie; every other # line is a comment.
    let httpOnly = false;
    let working = line;
    if (working.startsWith("#HttpOnly_")) {
      httpOnly = true;
      working = working.slice("#HttpOnly_".length);
    } else if (working.startsWith("#")) {
      continue;
    }

    let parts = working.split("\t");
    if (parts.length < 7) {
      const loose = working.split(/\s+/);
      if (loose.length < 7) continue;
      parts = [...loose.slice(0, 6), loose.slice(6).join(" ")];
    }

    const [domain, , path, secure, expires, name, ...rest] = parts;
    const value = rest.join("\t");
    if (!domain || !name) continue;

    const cookie: PwCookie = {
      name: name.trim(),
      value: value ?? "",
      domain: domain.trim(),
      path: (path ?? "/").trim() || "/",
      secure: String(secure).trim().toUpperCase() === "TRUE",
    };
    if (httpOnly) cookie.httpOnly = true;
    const exp = Number.parseInt(String(expires).trim(), 10);
    // 0 means a session cookie — leave `expires` unset so it behaves like one.
    if (Number.isFinite(exp) && exp > 0) cookie.expires = exp;
    out.push(cookie);
  }
  return out.length ? out : null;
}

function fromHeader(input: string): PwCookie[] | null {
  // Tolerate a pasted "Cookie: a=1; b=2" line as well as the bare value.
  const body = input.replace(/^\s*cookie\s*:\s*/i, "").trim();
  if (!body.includes("=")) return null;

  const out: PwCookie[] = [];
  for (const pair of body.split(/;\s*/)) {
    if (!pair.trim()) continue;
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (!name) continue;
    out.push({ name, value, domain: DEFAULT_DOMAIN, path: "/", secure: true });
  }
  return out.length ? out : null;
}

export function parseCookies(input: string): ParsedCookies {
  const trimmed = (input ?? "").trim();
  if (!trimmed) throw new Error("No cookies provided.");

  // Order matters: a Netscape file also "contains =" inside values, so test it
  // before the header parser, which is the most permissive of the three.
  const json = fromJson(trimmed);
  const netscape = json ? null : fromNetscape(trimmed);
  const cookies = json ?? netscape ?? fromHeader(trimmed);
  if (!cookies) {
    throw new Error(
      "Could not parse that. Paste either the raw `Cookie:` request header from DevTools → Network, " +
        "or a JSON array exported by a cookie extension.",
    );
  }

  const names = cookies.map((c) => c.name);
  return {
    cookies,
    format: json ? "json" : netscape ? "netscape" : "header",
    names,
    looksLikeSession: names.some((n) => SESSION_HINTS.some((h) => n.toLowerCase().includes(h.toLowerCase()))),
  };
}

/** Redacts values so a cookie set can be logged or echoed back safely. */
export function describe(parsed: ParsedCookies): string {
  return `${parsed.cookies.length} cookie(s) [${parsed.format}]: ${parsed.names.slice(0, 12).join(", ")}${
    parsed.names.length > 12 ? ` +${parsed.names.length - 12} more` : ""
  }`;
}

export type { Cookie };
