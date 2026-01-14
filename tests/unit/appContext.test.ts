import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Logger } from "pino";

import { createAppContext } from "@/app/createAppContext";
import { MissingBudgetIdError, MissingOAuthTokenError, MissingTokenError } from "@/app/errors";
import { ConfigStore } from "@/config/ConfigStore";
import { createRunLogger } from "@/logging";

let logger: Logger;
let closeLogger: () => void = () => {};

beforeAll(async () => {
  const logDir = await mkdtemp(path.join(os.tmpdir(), "nab-test-logs-"));
  const runLogger = createRunLogger({
    env: { ...process.env, NAB_LOG_DIR: logDir, NAB_LOG_FILE: "nab-test.log" },
    argv: [],
  });
  logger = runLogger.logger;
  closeLogger = runLogger.close;
});

afterAll(() => {
  closeLogger();
});

async function createStore(values: {
  tokens?: string[];
  budgetId?: string;
  oauth?: {
    token?: {
      accessToken: string;
      refreshToken: string;
      expiresAt: string;
    };
  };
  authMethod?: "pat" | "oauth";
}) {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "nab-appctx-test-"));
  const store = new ConfigStore(path.join(tmp, "config.json"));
  await store.save(values);
  return store;
}

test("createAppContext: flags > env > config precedence", async () => {
  const store = await createStore({ tokens: ["config-token"], budgetId: "config-budget" });

  const ctx = await createAppContext({
    configStore: store,
    env: { NAB_TOKENS: "env-token-1,env-token-2", NAB_BUDGET_ID: "env-budget" },
    argv: { "budget-id": "flag-budget" },
    createDb: false,
    logger,
  });

  expect(ctx.tokens).toEqual(["env-token-1", "env-token-2"]);
  expect(ctx.budgetId).toBe("flag-budget");
});

test("createAppContext: falls back to config when env/flags missing", async () => {
  const store = await createStore({ tokens: ["config-token"], budgetId: "config-budget" });

  const ctx = await createAppContext({
    configStore: store,
    env: {},
    argv: {},
    createDb: false,
    logger,
  });

  expect(ctx.tokens).toEqual(["config-token"]);
  expect(ctx.budgetId).toBe("config-budget");
});

test("createAppContext: missing token throws MissingTokenError", async () => {
  const store = await createStore({});

  await expect(
    createAppContext({
      configStore: store,
      env: {},
      argv: {},
      createDb: false,
      requireBudgetId: false,
      logger,
    }),
  ).rejects.toBeInstanceOf(MissingTokenError);
});

test("createAppContext: missing budget id throws MissingBudgetIdError", async () => {
  const store = await createStore({ tokens: ["config-token"] });

  await expect(
    createAppContext({
      configStore: store,
      env: {},
      argv: {},
      createDb: false,
      requireToken: false,
      logger,
    }),
  ).rejects.toBeInstanceOf(MissingBudgetIdError);
});

test("createAppContext: oauth auth method uses access token", async () => {
  const store = await createStore({
    oauth: {
      token: {
        accessToken: "oauth-access",
        refreshToken: "oauth-refresh",
        expiresAt: "2999-01-01T00:00:00Z",
      },
    },
    authMethod: "oauth",
  });

  const ctx = await createAppContext({
    configStore: store,
    env: {},
    argv: {},
    createDb: false,
    requireBudgetId: false,
    logger,
  });

  expect(ctx.tokens).toEqual(["oauth-access"]);
  expect(ctx.authMethod).toBe("oauth");
});

test("createAppContext: env tokens override oauth by default", async () => {
  const store = await createStore({
    tokens: ["config-token"],
    oauth: {
      token: {
        accessToken: "oauth-access",
        refreshToken: "oauth-refresh",
        expiresAt: "2999-01-01T00:00:00Z",
      },
    },
  });

  const ctx = await createAppContext({
    configStore: store,
    env: { NAB_TOKENS: "env-token" },
    argv: {},
    createDb: false,
    requireBudgetId: false,
    logger,
  });

  expect(ctx.tokens).toEqual(["env-token"]);
  expect(ctx.authMethod).toBe("pat");
});

test("createAppContext: oauth auth method without token throws MissingOAuthTokenError", async () => {
  const store = await createStore({ authMethod: "oauth" });

  await expect(
    createAppContext({
      configStore: store,
      env: {},
      argv: {},
      createDb: false,
      requireBudgetId: false,
      logger,
    }),
  ).rejects.toBeInstanceOf(MissingOAuthTokenError);
});
