import os from "node:os";
import path from "node:path";

/**
 * Resolves the directory for nab local state:
 * - config.json (tokens, default budget id)
 * - nab.sqlite (history + cache)
 */
export function getConfigDir(): string {
  const override = process.env.NAB_CONFIG_DIR;
  if (override) return override;

  const platform = process.platform;
  const home = os.homedir();

  // macOS
  if (platform === "darwin") {
    return path.join(home, "Library", "Application Support", "nab");
  }

  // Windows
  if (platform === "win32") {
    const appData = process.env.APPDATA;
    return path.join(appData ?? path.join(home, "AppData", "Roaming"), "nab");
  }

  // Linux/others (XDG)
  const xdg = process.env.XDG_CONFIG_HOME;
  return path.join(xdg ?? path.join(home, ".config"), "nab");
}

export function getConfigFilePath(): string {
  return path.join(getConfigDir(), "config.json");
}

export function getSqlitePath(): string {
  return path.join(getConfigDir(), "nab.sqlite");
}
