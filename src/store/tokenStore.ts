import { readFile, writeFile, rename } from "node:fs/promises";
import { resolve } from "node:path";
import { config } from "../config.js";
import { log } from "../lib/logger.js";
import { notConnected } from "../lib/errors.js";
import { refreshAccessToken } from "../canva/oauth.js";
import type { CanvaTokenResponse } from "../canva/types.js";

const FILE = resolve(process.cwd(), ".tokens.json");
const REFRESH_SKEW_MS = 60_000; // refresh a minute early rather than race expiry

export interface StoredToken {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scope: string;
}

let cache: StoredToken | null = null;
let inFlight: Promise<StoredToken> | null = null;

export function fromTokenResponse(res: CanvaTokenResponse): StoredToken {
  return {
    accessToken: res.access_token,
    refreshToken: res.refresh_token,
    expiresAt: Date.now() + res.expires_in * 1000,
    scope: res.scope,
  };
}

export async function save(token: StoredToken): Promise<void> {
  cache = token;
  const tmp = `${FILE}.tmp`;
  await writeFile(tmp, JSON.stringify(token, null, 2), { mode: 0o600 });
  await rename(tmp, FILE); // atomic, so a crash mid-write can't truncate the store
  log.debug("Canva token persisted");
}

export async function load(): Promise<StoredToken | null> {
  if (cache) return cache;
  try {
    cache = JSON.parse(await readFile(FILE, "utf8")) as StoredToken;
    return cache;
  } catch {
    return null;
  }
}

export function isExpired(token: StoredToken): boolean {
  return Date.now() >= token.expiresAt - REFRESH_SKEW_MS;
}

/**
 * Returns a usable access token, rotating it when needed. Canva burns a refresh
 * token on every use, so concurrent callers share one in-flight refresh instead
 * of racing each other into an invalid_grant.
 */
export async function getValidAccessToken(): Promise<string> {
  const token = await load();
  if (!token) throw notConnected();
  if (!isExpired(token)) return token.accessToken;

  inFlight ??= (async () => {
    log.info("Canva access token expired — refreshing");
    try {
      const next = fromTokenResponse(await refreshAccessToken(token.refreshToken));
      await save(next);
      return next;
    } finally {
      inFlight = null;
    }
  })();

  return (await inFlight).accessToken;
}

export async function clear(): Promise<void> {
  cache = null;
  try {
    await writeFile(FILE, "null", { mode: 0o600 });
  } catch {
    /* nothing to clear */
  }
}

/** Only handed to the browser when TOKEN_STORE=browser. */
export function browserPayload(token: StoredToken): { accessToken: string; expiresAt: number } | null {
  return config.tokenStore === "browser"
    ? { accessToken: token.accessToken, expiresAt: token.expiresAt }
    : null;
}
