const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 } as const;
type Level = keyof typeof LEVELS;

const current: Level = (process.env.LOG_LEVEL?.trim() as Level) in LEVELS
  ? (process.env.LOG_LEVEL!.trim() as Level)
  : "info";

const COLOR: Record<Level, string> = {
  error: "\x1b[31m",
  warn: "\x1b[33m",
  info: "\x1b[36m",
  debug: "\x1b[90m",
};

function emit(level: Level, msg: string, extra?: unknown): void {
  if (LEVELS[level] > LEVELS[current]) return;
  const ts = new Date().toISOString().slice(11, 23);
  const line = `${COLOR[level]}${ts} ${level.toUpperCase().padEnd(5)}\x1b[0m ${msg}`;
  if (extra === undefined) console.log(line);
  else console.log(line, typeof extra === "string" ? extra : JSON.stringify(extra));
}

export const log = {
  error: (m: string, e?: unknown) => emit("error", m, e),
  warn: (m: string, e?: unknown) => emit("warn", m, e),
  info: (m: string, e?: unknown) => emit("info", m, e),
  debug: (m: string, e?: unknown) => emit("debug", m, e),
};
