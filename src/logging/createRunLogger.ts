import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import pino from "pino";

import { cleanupRotatedLogs, resolveLogPath, rotateIfNeeded } from "./file";
import { sanitizeArgvForLogs } from "./sanitize";

export type RunLogger = {
  logger: pino.Logger;
  runId: string;
  logPath: string;
  close: () => void;
};

type RunLoggerOptions = {
  argv?: string[];
  env?: NodeJS.ProcessEnv;
};

function parseBool(value?: string | null): boolean {
  if (!value) return false;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function parseNumber(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function createNullLogger(): pino.Logger {
  return pino({ level: "silent" });
}

function buildRedactPaths(): string[] {
  return [
    "token",
    "tokens",
    "*.token",
    "*.tokens",
    "accessToken",
    "refreshToken",
    "clientSecret",
    "oauth.token.accessToken",
    "oauth.token.refreshToken",
    "headers.authorization",
    "authorization",
  ];
}

export function createRunLogger(options: RunLoggerOptions = {}): RunLogger {
  const env = options.env ?? process.env;
  const runId = randomUUID();

  if (parseBool(env.NAB_LOG_DISABLE) || env.NODE_ENV === "test") {
    return { logger: createNullLogger(), runId, logPath: "", close: () => {} };
  }

  const logPath = resolveLogPath(env);
  const logDir = path.dirname(logPath);
  const maxBytes = parseNumber(env.NAB_LOG_MAX_BYTES, 25_000_000);
  const retentionDays = parseNumber(env.NAB_LOG_RETENTION_DAYS, 14);
  const maxFiles = parseNumber(env.NAB_LOG_MAX_FILES, 30);
  const level = env.NAB_LOG_LEVEL?.trim() || "debug";

  try {
    fs.mkdirSync(logDir, { recursive: true });

    rotateIfNeeded(logPath, maxBytes);

    const parsed = path.parse(logPath);
    cleanupRotatedLogs(parsed.dir, parsed.name, retentionDays, maxFiles, parsed.ext);

    const destination = pino.destination({ dest: logPath, sync: true });

    const baseLogger = pino(
      {
        level,
        timestamp: pino.stdTimeFunctions.isoTime,
        formatters: {
          level: (label) => ({ level: label }),
        },
        redact: {
          paths: buildRedactPaths(),
          censor: "[REDACTED]",
        },
        base: {
          app: "nab",
        },
      },
      destination,
    );

    const logger = baseLogger.child({ runId });

    const argv = options.argv ?? [];
    logger.info({ event: "run_start", argv: sanitizeArgvForLogs(argv) });

    const close = () => {
      try {
        destination.flushSync?.();
      } catch {
        // ignore
      }
      try {
        destination.end();
      } catch {
        // ignore
      }
    };

    return { logger, runId, logPath, close };
  } catch {
    return { logger: createNullLogger(), runId, logPath: "", close: () => {} };
  }
}

export function createSilentLogger(): pino.Logger {
  return createNullLogger();
}
