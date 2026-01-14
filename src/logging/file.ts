import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function expandHome(value: string): string {
  if (value.startsWith("~/")) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
}

function normalizeEnvValue(value?: string): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : undefined;
}

export function resolveLogDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = normalizeEnvValue(env.NAB_LOG_DIR);
  if (override) return expandHome(override);

  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Logs", "nab");
  }

  if (process.platform === "win32") {
    const base = normalizeEnvValue(env.LOCALAPPDATA) ?? path.join(os.homedir(), "AppData", "Local");
    return path.join(base, "nab", "Logs");
  }

  const base = normalizeEnvValue(env.XDG_STATE_HOME) ?? path.join(os.homedir(), ".local", "state");
  return path.join(base, "nab");
}

export function resolveLogPath(env: NodeJS.ProcessEnv = process.env): string {
  const rawFile = normalizeEnvValue(env.NAB_LOG_FILE);
  if (rawFile) {
    const expanded = expandHome(rawFile);
    if (path.isAbsolute(expanded)) return expanded;
  }

  const fileName = rawFile ?? "nab.log";
  return path.join(resolveLogDir(env), fileName);
}

function buildRotationName(logPath: string, timestamp: string): string {
  const parsed = path.parse(logPath);
  return path.join(parsed.dir, `${parsed.name}.${timestamp}${parsed.ext}`);
}

function toTimestamp(): string {
  return new Date().toISOString().replace(/[:]/g, "-");
}

export function rotateIfNeeded(logPath: string, maxBytes: number): void {
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) return;
  if (!fs.existsSync(logPath)) return;

  const stats = fs.statSync(logPath);
  if (stats.size <= maxBytes) return;

  const rotated = buildRotationName(logPath, toTimestamp());
  fs.renameSync(logPath, rotated);
}

export function cleanupRotatedLogs(
  dir: string,
  baseName: string,
  retentionDays: number,
  maxFiles: number,
  ext = "",
): void {
  if (!fs.existsSync(dir)) return;

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const rotated = entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => name.startsWith(`${baseName}.`) && (!ext || name.endsWith(ext)))
    .map((name) => {
      const fullPath = path.join(dir, name);
      const stats = fs.statSync(fullPath);
      return { name, fullPath, mtimeMs: stats.mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  const now = Date.now();
  const retentionMs =
    Number.isFinite(retentionDays) && retentionDays > 0
      ? retentionDays * 24 * 60 * 60 * 1000
      : undefined;

  const toDelete: string[] = [];

  if (retentionMs !== undefined) {
    for (const entry of rotated) {
      if (now - entry.mtimeMs > retentionMs) {
        toDelete.push(entry.fullPath);
      }
    }
  }

  if (Number.isFinite(maxFiles) && maxFiles > 0 && rotated.length > maxFiles) {
    for (const entry of rotated.slice(maxFiles)) {
      toDelete.push(entry.fullPath);
    }
  }

  for (const filePath of new Set(toDelete)) {
    try {
      fs.unlinkSync(filePath);
    } catch {
      // best effort
    }
  }
}
