type Level = "debug" | "info" | "warn" | "error";

const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function getConfig() {
  const format = process.env.LOG_FORMAT === "json" ? "json" : "pretty";
  const configured = (process.env.LOG_LEVEL ?? "info").toLowerCase() as Level;
  const threshold = LEVELS[configured] ?? LEVELS.info;
  return { format, threshold };
}

function write(level: Level, message: string, meta?: Record<string, unknown>) {
  const { format, threshold } = getConfig();
  if (LEVELS[level] < threshold) return;

  const entry: Record<string, unknown> = {
    level,
    ts: new Date().toISOString(),
    msg: message,
    ...meta,
  };

  if (format === "json") {
    // Cloud Logging parses structured JSON lines automatically.
    process.stdout.write(JSON.stringify(entry) + "\n");
  } else {
    const metaStr = meta ? ` ${JSON.stringify(meta)}` : "";
    process.stdout.write(`[${entry.ts}] ${level.toUpperCase()} ${message}${metaStr}\n`);
  }
}

/**
 * Minimal structured logger. NEVER log patient-sensitive details,
 * tokens, keys, or raw message content. Use opaque ids only.
 */
export const logger = {
  debug: (msg: string, meta?: Record<string, unknown>) => write("debug", msg, meta),
  info: (msg: string, meta?: Record<string, unknown>) => write("info", msg, meta),
  warn: (msg: string, meta?: Record<string, unknown>) => write("warn", msg, meta),
  error: (msg: string, meta?: Record<string, unknown>) => write("error", msg, meta),
};
