import { readFileSync } from "node:fs";

import { getConfigFilePath } from "@/config/paths";
import { ConfigSchema } from "@/config/schema";

export type TestEnv = {
  tokens: string[];
  budgetId?: string;
};

type RawConfig = {
  tokens?: string[];
  budgetId?: string;
};

function parseTokens(raw?: string): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((token) => token.trim())
    .filter(Boolean);
}

function normalizeTokens(tokens?: string[]): string[] {
  if (!tokens) return [];
  return tokens.map((token) => token.trim()).filter(Boolean);
}

function loadConfig(): RawConfig {
  const filePath = getConfigFilePath();
  try {
    const text = readFileSync(filePath, "utf8");
    if (!text.trim()) return {};
    const json = JSON.parse(text) as unknown;
    const parsed = ConfigSchema.safeParse(json);
    if (!parsed.success) {
      const msg = parsed.error.issues.map((issue) => issue.message).join("; ");
      throw new Error(`Invalid config at ${filePath}: ${msg}`);
    }
    return parsed.data;
  } catch (err) {
    if (err && typeof err === "object" && "code" in err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return {};
    }
    if (err instanceof SyntaxError) {
      throw new Error(`Invalid config at ${filePath}: ${err.message}`);
    }
    throw err;
  }
}

export function loadTestEnv(): TestEnv {
  const envTokens = parseTokens(process.env.NAB_TOKENS);
  const envBudgetId = process.env.NAB_BUDGET_ID?.trim();

  if (envTokens.length > 0 && envBudgetId) {
    return { tokens: envTokens, budgetId: envBudgetId };
  }

  const config = loadConfig();
  const tokens = envTokens.length > 0 ? envTokens : normalizeTokens(config.tokens);
  const budgetId = envBudgetId ?? config.budgetId;

  return { tokens, budgetId };
}
