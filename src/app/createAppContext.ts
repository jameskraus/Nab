import type { Logger } from "pino";

import type { RequestTraceEvent, TokenTraceEvent, YnabApiClient } from "@/api/YnabClient";
import { YnabClient } from "@/api/YnabClient";
import { refreshOAuthToken } from "@/auth/ynabOAuth";
import { ConfigStore } from "@/config/ConfigStore";
import type { Config } from "@/config/schema";
import { openJournalDb } from "@/journal/db";
import {
  MissingBudgetIdError,
  MissingOAuthClientIdError,
  MissingOAuthClientSecretError,
  MissingOAuthRefreshTokenError,
  MissingOAuthTokenError,
  MissingTokenError,
} from "./errors";

export type AppContext = {
  configStore: ConfigStore;
  config: Config;
  db: Awaited<ReturnType<typeof openJournalDb>> | undefined;
  logger: Logger;
  tokens?: string[];
  budgetId?: string;
  ynab?: YnabApiClient;
  authMethod?: "pat" | "oauth";
};

export type AppContextOptions = {
  argv?: {
    auth?: string;
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
  logger: Logger;
};

function normalize(value?: string | null): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : undefined;
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

function normalizeAuthMethod(value?: string | null): "pat" | "oauth" | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === "pat" || normalized === "oauth") return normalized;
  return undefined;
}

function isTokenExpiring(expiresAt?: string, skewMs = 60_000): boolean {
  if (!expiresAt) return true;
  const parsed = Date.parse(expiresAt);
  if (!Number.isFinite(parsed)) return true;
  return parsed - Date.now() <= skewMs;
}

export async function createAppContext(options: AppContextOptions): Promise<AppContext> {
  const env = options.env ?? process.env;
  const configStore = options.configStore ?? new ConfigStore();
  const config = await configStore.load();
  const createDb = options.createDb ?? true;
  const db = createDb ? await openJournalDb(options.dbPath) : undefined;
  if (!options.logger) {
    throw new Error("createAppContext requires a logger.");
  }
  const logger = options.logger;

  const envTokens = parseTokens(env.NAB_TOKENS);
  const configTokens = config.tokens;
  const budgetId =
    normalize(options.argv?.["budget-id"] ?? options.argv?.budgetId) ??
    normalize(env.NAB_BUDGET_ID) ??
    config.budgetId;

  const requireToken = options.requireToken ?? true;
  const requireBudgetId = options.requireBudgetId ?? true;

  const cliAuth = normalizeAuthMethod(options.argv?.auth);
  const envAuth = normalizeAuthMethod(env.NAB_AUTH_METHOD);
  const configAuth = normalizeAuthMethod(config.authMethod);
  const authMethod =
    cliAuth ??
    envAuth ??
    (envTokens ? "pat" : undefined) ??
    configAuth ??
    (config.oauth?.token?.accessToken ? "oauth" : configTokens ? "pat" : undefined);

  let tokens: string[] | undefined;
  let oauthToken = config.oauth?.token;

  if (authMethod === "oauth") {
    if (!oauthToken?.accessToken) {
      if (requireToken) throw new MissingOAuthTokenError();
    } else if (requireToken && isTokenExpiring(oauthToken.expiresAt)) {
      const clientId = normalize(env.NAB_OAUTH_CLIENT_ID) ?? normalize(config.oauth?.clientId);
      const clientSecret =
        normalize(env.NAB_OAUTH_CLIENT_SECRET) ?? normalize(config.oauth?.clientSecret);
      const refreshToken = oauthToken.refreshToken;

      if (!clientId) throw new MissingOAuthClientIdError();
      if (!clientSecret) throw new MissingOAuthClientSecretError();
      if (!refreshToken) throw new MissingOAuthRefreshTokenError();

      try {
        const refreshed = await refreshOAuthToken({
          clientId,
          clientSecret,
          refreshToken,
        });
        oauthToken = refreshed;
        await configStore.save({
          oauth: {
            ...(config.oauth ?? {}),
            clientId: config.oauth?.clientId ?? clientId,
            clientSecret: config.oauth?.clientSecret,
            token: refreshed,
          },
        });
      } catch (err) {
        const latest = await configStore.load();
        const latestToken = latest.oauth?.token;
        if (latestToken && !isTokenExpiring(latestToken.expiresAt)) {
          oauthToken = latestToken;
        } else {
          throw err;
        }
      }
    }

    if (oauthToken?.accessToken) {
      tokens = [oauthToken.accessToken];
    }
  } else {
    tokens = envTokens ?? configTokens;
  }

  if (requireToken && (!tokens || tokens.length === 0)) {
    if (authMethod === "oauth") {
      throw new MissingOAuthTokenError();
    }
    throw new MissingTokenError();
  }

  if (requireBudgetId && !budgetId) {
    throw new MissingBudgetIdError();
  }

  const tokenTrace = (event: TokenTraceEvent) => {
    const payload = {
      event: "ynab.token",
      action: event.action,
      reason: event.reason,
      token: event.token,
    };
    if (event.action === "disable" || event.action === "cooldown") {
      logger.warn(payload);
      return;
    }
    logger.debug(payload);
  };

  const requestTrace = (event: RequestTraceEvent) => {
    const payload = {
      event: "ynab.request",
      name: event.name,
      phase: event.phase,
      requestId: event.requestId,
      startTime: event.startTime,
      durationMs: event.durationMs,
      meta: event.meta,
      summary: event.summary,
      status: event.status,
    };

    if (event.phase === "error") {
      logger.error({ ...payload, err: event.error });
      return;
    }

    logger.debug(payload);
  };

  const ynab =
    options.ynab ??
    (tokens && tokens.length > 0
      ? new YnabClient(tokens, undefined, { tokenTrace, trace: requestTrace })
      : undefined);

  logger.info({
    event: "context",
    authMethod,
    tokenCount: tokens?.length ?? 0,
    hasBudgetId: Boolean(budgetId),
    dbEnabled: Boolean(db),
  });

  return {
    configStore,
    config,
    db,
    logger,
    tokens,
    budgetId,
    ynab,
    authMethod,
  };
}
