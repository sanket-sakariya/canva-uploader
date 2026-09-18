/**
 * Keeps a Canva browser session alive across HTTP requests, so the flow can be
 * a conversation: open → choose a platform → type a caption → confirm the
 * account → upload. Sessions are in-memory, idle-expired, and closed on exit.
 */
import { randomUUID } from "node:crypto";
import type { BrowserContext, Page } from "playwright";
import { log } from "../lib/logger.js";
import { openEphemeralContext } from "./session.js";
import type { PwCookie } from "./cookies.js";
import type { AccountOption, ConnectedAccount, SharePlatform } from "./discover.js";

export type SessionState =
  | "opening"
  | "awaiting-code"
  | "picking"
  | "composing"
  | "publishing"
  | "done"
  | "closed";

export interface LiveSession {
  id: string;
  context: BrowserContext;
  page: Page;
  designId: string;
  designTitle?: string;
  state: SessionState;
  platforms: SharePlatform[];
  platform?: string;
  account?: ConnectedAccount;
  accounts?: AccountOption[];
  createdAt: number;
  lastUsed: number;
}

const IDLE_MS = 15 * 60 * 1000;
const sessions = new Map<string, LiveSession>();

export async function create(cookies: PwCookie[] | null, designId: string): Promise<LiveSession> {
  const context = await openEphemeralContext(cookies ?? [], { headless: false });
  const page = context.pages()[0] ?? (await context.newPage());
  const session: LiveSession = {
    id: randomUUID(),
    context,
    page,
    designId,
    state: "opening",
    platforms: [],
    createdAt: Date.now(),
    lastUsed: Date.now(),
  };
  sessions.set(session.id, session);
  log.info(`Live Canva session ${session.id.slice(0, 8)} opened for ${designId}`);
  return session;
}

export function get(id: string): LiveSession {
  const s = sessions.get(id);
  if (!s) throw new Error("That browser session is gone — it expired or was closed. Start again.");
  if (s.state === "closed") throw new Error("That browser session has been closed. Start again.");
  s.lastUsed = Date.now();
  return s;
}

export async function close(id: string): Promise<void> {
  const s = sessions.get(id);
  if (!s) return;
  s.state = "closed";
  sessions.delete(id);
  await s.context.close().catch(() => {});
  log.info(`Live Canva session ${id.slice(0, 8)} closed`);
}

export function list(): Array<Pick<LiveSession, "id" | "designId" | "state" | "platform">> {
  return [...sessions.values()].map((s) => ({
    id: s.id,
    designId: s.designId,
    state: s.state,
    platform: s.platform,
  }));
}

/** Idle sessions hold a real Chrome window open, so reap them. */
export function startJanitor(): NodeJS.Timeout {
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [id, s] of sessions) {
      if (now - s.lastUsed > IDLE_MS) {
        log.info(`Reaping idle Canva session ${id.slice(0, 8)}`);
        void close(id);
      }
    }
  }, 60_000);
  timer.unref();
  return timer;
}

export async function closeAll(): Promise<void> {
  await Promise.all([...sessions.keys()].map((id) => close(id)));
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void closeAll().finally(() => process.exit(0));
  });
}
