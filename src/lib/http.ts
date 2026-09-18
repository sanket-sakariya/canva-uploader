import { log } from "./logger.js";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
    readonly url: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export interface RequestOptions extends RequestInit {
  /** Retries on 429 and 5xx. Default 3. */
  retries?: number;
  /** Milliseconds before the request is aborted. Default 30_000. */
  timeoutMs?: number;
}

const RETRYABLE = new Set([408, 425, 429, 500, 502, 503, 504]);

function backoff(attempt: number, retryAfter: string | null): number {
  if (retryAfter) {
    const secs = Number.parseFloat(retryAfter);
    if (!Number.isNaN(secs)) return Math.min(secs * 1000, 30_000);
  }
  return Math.min(500 * 2 ** attempt, 8_000) + Math.random() * 250;
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** fetch + JSON parsing + retry/backoff + errors that actually say what went wrong. */
export async function requestJson<T>(url: string, options: RequestOptions = {}): Promise<T> {
  const { retries = 3, timeoutMs = 30_000, ...init } = options;

  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...init, signal: controller.signal });
      const raw = await res.text();
      const body = raw ? safeJson(raw) : null;

      if (!res.ok) {
        if (RETRYABLE.has(res.status) && attempt < retries) {
          const wait = backoff(attempt, res.headers.get("retry-after"));
          log.warn(`${res.status} from ${shortUrl(url)} — retrying in ${Math.round(wait)}ms`);
          await sleep(wait);
          continue;
        }
        throw new ApiError(describe(res.status, body, raw), res.status, body, url);
      }
      return body as T;
    } catch (err) {
      lastError = err;
      if (err instanceof ApiError) throw err;
      const aborted = err instanceof Error && err.name === "AbortError";
      if (attempt < retries) {
        const wait = backoff(attempt, null);
        log.warn(`${aborted ? "timeout" : "network error"} on ${shortUrl(url)} — retrying in ${Math.round(wait)}ms`);
        await sleep(wait);
        continue;
      }
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`Request to ${url} failed`);
}

/** Downloads binary content (an exported design) with the same retry semantics. */
export async function requestBuffer(url: string, options: RequestOptions = {}): Promise<Buffer> {
  const { retries = 3, timeoutMs = 60_000, ...init } = options;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...init, signal: controller.signal });
      if (!res.ok) {
        if (RETRYABLE.has(res.status) && attempt < retries) {
          await sleep(backoff(attempt, res.headers.get("retry-after")));
          continue;
        }
        throw new ApiError(`Download failed with HTTP ${res.status}`, res.status, null, url);
      }
      return Buffer.from(await res.arrayBuffer());
    } catch (err) {
      if (err instanceof ApiError) throw err;
      if (attempt >= retries) throw err;
      await sleep(backoff(attempt, null));
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(`Download of ${url} failed`);
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function shortUrl(url: string): string {
  try {
    const u = new URL(url);
    return u.host + u.pathname;
  } catch {
    return url;
  }
}

/** Unwraps the two error shapes we deal with: Canva's and Meta's. */
function describe(status: number, body: unknown, raw: string): string {
  if (body && typeof body === "object") {
    const b = body as Record<string, any>;
    // Meta / Instagram Graph
    if (b.error?.message) {
      const e = b.error;
      const bits = [e.message];
      if (e.error_user_title) bits.push(`(${e.error_user_title})`);
      if (e.error_user_msg) bits.push(e.error_user_msg);
      if (e.code) bits.push(`[code ${e.code}${e.error_subcode ? `/${e.error_subcode}` : ""}]`);
      return `Instagram: ${bits.join(" ")}`;
    }
    // Canva Connect
    if (b.message) return `Canva: ${b.message}${b.code ? ` [${b.code}]` : ""}`;
  }
  return `HTTP ${status}: ${raw.slice(0, 400)}`;
}
