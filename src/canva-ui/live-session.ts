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
import type { AccountOption, CanvaUser, ConnectedAccount, SharePlatform } from "./discover.js";

export type SessionState =
  | "opening"
  | "ready"
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
  /** Unset until a design is opened — a session can exist just to browse. */
  designId?: string;
  /** Who Canva says is signed in. */
  user?: CanvaUser;
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

export async function create(cookies: PwCookie[] | null, designId?: string): Promise<LiveSession> {
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
  log.info(`Live Canva session ${session.id.slice(0, 8)} opened${designId ? ` for ${designId}` : ""}`);
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

export interface SessionSummary {
  id: string;
  state: SessionState;
  user?: CanvaUser;
  designId?: string;
  designTitle?: string;
  platform?: string;
  account?: string;
  openedAt: string;
  idleSeconds: number;
}

export function describe(s: LiveSession): SessionSummary {
  return {
    id: s.id,
    state: s.state,
    user: s.user,
    designId: s.designId,
    designTitle: s.designTitle,
    platform: s.platform,
    account: s.account?.handle,
    openedAt: new Date(s.createdAt).toISOString(),
    idleSeconds: Math.round((Date.now() - s.lastUsed) / 1000),
  };
}

export function list(): SessionSummary[] {
  return [...sessions.values()].map(describe);
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
