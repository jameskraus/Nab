import type { YnabApiClient } from "@/api/YnabClient";
import { YnabClient } from "@/api/YnabClient";
import { ConfigStore } from "@/config/ConfigStore";
import type { Config } from "@/config/schema";
import { openJournalDb } from "@/journal/db";
import { MissingBudgetIdError, MissingTokenError } from "./errors";

export type AppContext = {
  configStore: ConfigStore;
  config: Config;
  db: Awaited<ReturnType<typeof openJournalDb>> | undefined;
  tokens?: string[];
  budgetId?: string;
  ynab?: YnabApiClient;
};

export type AppContextOptions = {
  argv?: {
    "budget-id"?: string;
    budgetId?: string;
  };
  env?: NodeJS.ProcessEnv;
  configStore?: ConfigStore;
  dbPath?: string;
  createDb?: boolean;
  requireToken?: boolean;
  requireBudgetId?: boolean;
  ynab?: YnabApiClient;
};

function normalize(value?: string | null): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : undefined;
}

function parseBool(value?: string | null): boolean {
  if (!value) return false;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function parseTokens(value?: string | null): string[] | undefined {
  const raw = normalize(value);
  if (!raw) return undefined;
  const tokens = raw
    .split(",")
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
  return tokens.length ? tokens : undefined;
}

export async function createAppContext(options: AppContextOptions = {}): Promise<AppContext> {
  const env = options.env ?? process.env;
  const configStore = options.configStore ?? new ConfigStore();
  const config = await configStore.load();
  const createDb = options.createDb ?? true;
  const db = createDb ? await openJournalDb(options.dbPath) : undefined;

  const tokens = parseTokens(env.NAB_TOKENS) ?? config.tokens;
  const budgetId =
    normalize(options.argv?.["budget-id"] ?? options.argv?.budgetId) ??
    normalize(env.NAB_BUDGET_ID) ??
    config.budgetId;

  const requireToken = options.requireToken ?? true;
  const requireBudgetId = options.requireBudgetId ?? true;

  if (requireToken && (!tokens || tokens.length === 0)) {
    throw new MissingTokenError();
  }
  if (requireBudgetId && !budgetId) {
    throw new MissingBudgetIdError();
  }

  const tokenTrace = parseBool(env.NAB_TOKEN_TRACE)
    ? (event: { token: string; action: string; reason?: string }) => {
        const parts = [`[nab] token ${event.action}`, event.token];
        if (event.reason) parts.push(`(${event.reason})`);
        console.error(parts.join(" "));
      }
    : undefined;

  const ynab =
    options.ynab ??
    (tokens && tokens.length > 0 ? new YnabClient(tokens, undefined, { tokenTrace }) : undefined);

  return {
    configStore,
    config,
    db,
    tokens,
    budgetId,
    ynab,
  };
}
