import { randomUUID } from "node:crypto";
import { config } from "../config.js";
import { log } from "../lib/logger.js";

interface Entry {
  buffer: Buffer;
  contentType: string;
  expiresAt: number;
}

const TTL_MS = 60 * 60 * 1000; // an hour is plenty — Instagram fetches within seconds
const entries = new Map<string, Entry>();

/**
 * Re-hosts an exported image under our own origin. Used when MEDIA_MODE=proxy,
 * i.e. when you'd rather not hand Instagram a Canva-signed URL.
 */
export function put(buffer: Buffer, contentType = "image/jpeg"): { id: string; url: string } {
  const id = randomUUID();
  entries.set(id, { buffer, contentType, expiresAt: Date.now() + TTL_MS });
  return { id, url: `${config.publicBaseUrl}/media/${id}.jpg` };
}

export function get(id: string): Entry | undefined {
  const entry = entries.get(id);
  if (!entry) return undefined;
  if (Date.now() > entry.expiresAt) {
    entries.delete(id);
    return undefined;
  }
  return entry;
}

export function startJanitor(): NodeJS.Timeout {
  const timer = setInterval(() => {
    const now = Date.now();
    let dropped = 0;
    for (const [id, entry] of entries) {
      if (now > entry.expiresAt) {
        entries.delete(id);
        dropped++;
      }
    }
    if (dropped) log.debug(`media cache: evicted ${dropped} expired item(s)`);
  }, 10 * 60 * 1000);
  timer.unref();
  return timer;
}
