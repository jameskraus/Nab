import { mkdir } from "node:fs/promises";
import path from "node:path";

import { getConfigFilePath } from "./paths";
import { ConfigSchema, type Config } from "./schema";

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
    await mkdir(path.dirname(this.filePath), { recursive: true });

    await Bun.write(this.filePath, `${JSON.stringify(next, null, 2)}\n`);
    return next;
  }

  async clear(keys: (keyof Config)[] | "all" = "all"): Promise<Config> {
    if (keys === "all") {
      return this.save({ token: undefined, budgetId: undefined });
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
    if (!config.token) return config;
    return {
      ...config,
      token: `${config.token.slice(0, 4)}…${config.token.slice(-4)}`,
    };
  }
}
