import { chmod, mkdir } from "node:fs/promises";
import path from "node:path";

import { getConfigFilePath } from "./paths";
import { type Config, ConfigSchema } from "./schema";

export class ConfigStore {
  constructor(private readonly filePath: string = getConfigFilePath()) {}

  get path(): string {
    return this.filePath;
  }

  async load(): Promise<Config> {
    const file = Bun.file(this.filePath);
    if (!(await file.exists())) return {};

    const text = await file.text();
    if (!text.trim()) return {};

    const json = JSON.parse(text) as unknown;
    const parsed = ConfigSchema.safeParse(json);
    if (!parsed.success) {
      // If config becomes corrupt, fail loudly rather than silently ignoring.
      const msg = parsed.error.issues.map((i) => i.message).join("; ");
      throw new Error(`Invalid config at ${this.filePath}: ${msg}`);
    }
    return parsed.data;
  }

  /**
   * Merge-and-save update.
   */
  async save(update: Partial<Config>): Promise<Config> {
    const current = await this.load();
    const next: Config = { ...current, ...update };

    // Ensure directory exists (supports tests with custom file paths).
    const dir = path.dirname(this.filePath);
    await mkdir(dir, { recursive: true });

    await Bun.write(this.filePath, `${JSON.stringify(next, null, 2)}\n`);
    await this.lockDownPermissions(dir, this.filePath);
    return next;
  }

  async clear(keys: (keyof Config)[] | "all" = "all"): Promise<Config> {
    if (keys === "all") {
      return this.save({
        tokens: undefined,
        budgetId: undefined,
        oauth: undefined,
        authMethod: undefined,
      });
    }

    const current = await this.load();
    const next = { ...current } as Record<string, unknown>;
    for (const k of keys) delete next[k];
    return this.save(next as Partial<Config>);
  }

  /**
   * For display in terminals/logs.
   */
  redact(config: Config): Config {
    const mask = (value: string): string => {
      if (value.length <= 8) return `${value.slice(0, 1)}…`;
      return `${value.slice(0, 4)}…${value.slice(-4)}`;
    };

    const next: Config = { ...config };
    if (config.tokens) {
      next.tokens = config.tokens.map((token) => mask(token));
    }

    if (config.oauth) {
      next.oauth = { ...config.oauth };
      if (config.oauth.clientSecret) {
        next.oauth.clientSecret = mask(config.oauth.clientSecret);
      }
      if (config.oauth.token) {
        next.oauth.token = {
          ...config.oauth.token,
          accessToken: mask(config.oauth.token.accessToken),
          refreshToken: mask(config.oauth.token.refreshToken),
        };
      }
    }

    return next;
  }

  private async lockDownPermissions(dir: string, filePath: string): Promise<void> {
    if (process.platform === "win32") return;
    try {
      await chmod(dir, 0o700);
    } catch {
      // Best effort; ignore permission failures.
    }
    try {
      await chmod(filePath, 0o600);
    } catch {
      // Best effort; ignore permission failures.
    }
  }
}
