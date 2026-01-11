import {
  MissingOAuthClientIdError,
  MissingOAuthClientSecretError,
  MissingOAuthRefreshTokenError,
  MissingOAuthTokenError,
} from "@/app/errors";
import { runOAuthLogin } from "@/auth/oauthFlow";
import { type OAuthScope, refreshOAuthToken } from "@/auth/ynabOAuth";
import { isInteractive, promptSecret, promptText } from "@/cli/prompts";
import { ConfigStore } from "@/config/ConfigStore";
import { createOutputWriter, parseOutputFormat } from "@/io";
import { fieldColumn } from "@/io/table/columns";
import type { CommandModule } from "yargs";

const DEFAULT_REDIRECT_URI = "http://127.0.0.1:53682/oauth/callback";

type KeyValueRow = { key: string; value: string };

function normalize(value?: string | null): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : undefined;
}

function normalizeScope(value?: string | null): OAuthScope | undefined {
  if (!value) return undefined;
  const trimmed = value.trim().toLowerCase();
  if (trimmed === "read-only") return "read-only";
  if (trimmed === "full") return "full";
  return undefined;
}

function formatKeyValues(rows: KeyValueRow[], rawFormat?: string): void {
  const format = parseOutputFormat(rawFormat, "table");

  if (format === "json") {
    const payload = rows.reduce<Record<string, string>>((acc, row) => {
      acc[row.key] = row.value;
      return acc;
    }, {});
    createOutputWriter("json").write(payload);
    return;
  }

  if (format === "ids") {
    createOutputWriter("ids").write(rows.map((row) => row.value));
    return;
  }

  if (format === "tsv") {
    createOutputWriter("tsv").write(rows);
    return;
  }

  createOutputWriter("table").write({
    columns: [fieldColumn("key", { header: "Key" }), fieldColumn("value", { header: "Value" })],
    rows,
  });
}

function resolveClientId(
  args: { clientId?: string },
  env: NodeJS.ProcessEnv,
  config: { clientId?: string },
): string | undefined {
  return (
    normalize(args.clientId) ?? normalize(env.NAB_OAUTH_CLIENT_ID) ?? normalize(config.clientId)
  );
}

function resolveScope(
  args: { scope?: string },
  env: NodeJS.ProcessEnv,
  config: { scope?: OAuthScope },
): OAuthScope | undefined {
  return normalizeScope(args.scope) ?? normalizeScope(env.NAB_OAUTH_SCOPE) ?? config.scope;
}

function formatOauthConfig(config: {
  clientId?: string;
  redirectUri?: string;
  scope?: OAuthScope;
  hasClientSecret: boolean;
  hasToken: boolean;
}): KeyValueRow[] {
  return [
    { key: "clientId", value: config.clientId ?? "" },
    { key: "redirectUri", value: config.redirectUri ?? "" },
    { key: "scope", value: config.scope ?? "" },
    { key: "hasClientSecret", value: config.hasClientSecret ? "true" : "false" },
    { key: "hasToken", value: config.hasToken ? "true" : "false" },
  ];
}

export const authOauthCommand: CommandModule = {
  command: "oauth <command>",
  describe: "Manage OAuth authentication",
  builder: (yy) =>
    yy
      .usage(
        [
          "$0 auth oauth <command> [options]",
          "",
          "OAuth setup:",
          "- Create an OAuth app in YNAB Developer Settings: https://app.ynab.com/settings/developer",
          "- Run `nab auth oauth init` to save your client id/secret and see the redirect URI",
          "- Run `nab auth oauth login` to authenticate",
        ].join("\n"),
      )
      .command({
        command: "init",
        describe: "Guide OAuth setup and store client credentials",
        handler: async (argv) => {
          const args = argv as { format?: string; quiet?: boolean };
          if (!isInteractive()) {
            throw new Error("OAuth init requires an interactive terminal.");
          }

          if (!args.quiet) {
            process.stderr.write("YNAB OAuth setup:\n");
            process.stderr.write(
              "1) Create an OAuth app in YNAB Developer Settings: https://app.ynab.com/settings/developer\n",
            );
            process.stderr.write(`2) Add this Redirect URI: ${DEFAULT_REDIRECT_URI}\n`);
            process.stderr.write("3) Enter your client id and secret below\n");
          }

          const clientId = normalize(await promptText("Client ID: "));
          if (!clientId) throw new MissingOAuthClientIdError();

          const clientSecret = normalize(await promptSecret("Client secret: "));
          if (!clientSecret) throw new MissingOAuthClientSecretError();

          const scopeResponse = await promptText("Scope (full/read-only) [full]: ");
          const scope = normalizeScope(scopeResponse) ?? "full";

          const store = new ConfigStore();
          const config = await store.load();
          const next = await store.save({
            oauth: {
              ...(config.oauth ?? {}),
              clientId,
              clientSecret,
              redirectUri: DEFAULT_REDIRECT_URI,
              scope,
            },
            authMethod: "oauth",
          });

          const redacted = store.redact(next);
          formatKeyValues(
            formatOauthConfig({
              clientId: redacted.oauth?.clientId,
              redirectUri: redacted.oauth?.redirectUri,
              scope: redacted.oauth?.scope,
              hasClientSecret: Boolean(redacted.oauth?.clientSecret),
              hasToken: Boolean(redacted.oauth?.token),
            }),
            args.format,
          );
        },
      })
      .command({
        command: "configure",
        describe: "Configure OAuth client settings",
        builder: (yyy) =>
          yyy
            .option("client-id", {
              type: "string",
              describe: "YNAB OAuth client id",
            })
            .option("client-secret", {
              type: "string",
              describe: "YNAB OAuth client secret",
            })
            .option("prompt-secret", {
              type: "boolean",
              describe: "Prompt for client secret (TTY only)",
            })
            .option("store-secret", {
              type: "boolean",
              default: false,
              describe: "Persist client secret in config (explicit opt-in)",
            })
            .option("scope", {
              type: "string",
              choices: ["full", "read-only"] as const,
              describe: "OAuth scope",
            }),
        handler: async (argv) => {
          const args = argv as {
            format?: string;
            "client-id"?: string;
            "client-secret"?: string;
            "prompt-secret"?: boolean;
            "store-secret"?: boolean;
            scope?: string;
          };

          const store = new ConfigStore();
          const config = await store.load();
          let clientId = resolveClientId({ clientId: args["client-id"] }, process.env, {
            clientId: config.oauth?.clientId,
          });
          if (!clientId && isInteractive()) {
            clientId = await promptText("Client ID: ");
          }
          if (!clientId) throw new MissingOAuthClientIdError();

          const redirectUri = DEFAULT_REDIRECT_URI;

          let scope = resolveScope({ scope: args.scope }, process.env, {
            scope: config.oauth?.scope,
          });
          if (!scope && isInteractive()) {
            const response = await promptText("Scope (full/read-only) [full]: ");
            scope = normalizeScope(response) ?? "full";
          }

          if (args["client-secret"] && !args["store-secret"]) {
            throw new Error("Use --store-secret to persist the client secret.");
          }

          let clientSecret: string | undefined;
          if (args["store-secret"]) {
            const shouldPromptSecret =
              args["prompt-secret"] ?? (process.stdin.isTTY && !args["client-secret"]);
            clientSecret =
              normalize(args["client-secret"]) ??
              normalize(process.env.NAB_OAUTH_CLIENT_SECRET) ??
              (shouldPromptSecret ? normalize(await promptSecret("Client secret: ")) : undefined) ??
              normalize(config.oauth?.clientSecret);

            if (!clientSecret) throw new MissingOAuthClientSecretError();
          }

          const nextOauth = {
            ...(config.oauth ?? {}),
            clientId,
            redirectUri,
            scope,
            token: config.oauth?.token,
            clientSecret: args["store-secret"] ? clientSecret : config.oauth?.clientSecret,
          };

          const next = await store.save({ oauth: nextOauth });
          const redacted = store.redact(next);
          formatKeyValues(
            formatOauthConfig({
              clientId: redacted.oauth?.clientId,
              redirectUri: redacted.oauth?.redirectUri,
              scope: redacted.oauth?.scope,
              hasClientSecret: Boolean(redacted.oauth?.clientSecret),
              hasToken: Boolean(redacted.oauth?.token),
            }),
            args.format,
          );
        },
      })
      .command({
        command: "login",
        describe: "Authenticate with OAuth (authorization code flow)",
        builder: (yyy) =>
          yyy
            .option("client-id", {
              type: "string",
              describe: "YNAB OAuth client id",
            })
            .option("client-secret", {
              type: "string",
              describe: "YNAB OAuth client secret",
            })
            .option("scope", {
              type: "string",
              choices: ["full", "read-only"] as const,
              describe: "OAuth scope",
            })
            .option("timeout", {
              type: "number",
              default: 180,
              describe: "Timeout in seconds while waiting for OAuth redirect",
            })
            .option("open", {
              type: "boolean",
              describe: "Open the authorization URL in a browser",
            })
            .option("set-default-auth", {
              type: "boolean",
              default: true,
              describe: "Set OAuth as the default auth method",
            }),
        handler: async (argv) => {
          const args = argv as {
            format?: string;
            quiet?: boolean;
            "client-id"?: string;
            "client-secret"?: string;
            scope?: string;
            timeout?: number;
            open?: boolean;
            "set-default-auth"?: boolean;
          };

          const store = new ConfigStore();
          const config = await store.load();
          const clientId = resolveClientId({ clientId: args["client-id"] }, process.env, {
            clientId: config.oauth?.clientId,
          });

          const clientSecret =
            normalize(args["client-secret"]) ??
            normalize(process.env.NAB_OAUTH_CLIENT_SECRET) ??
            normalize(config.oauth?.clientSecret);

          if (!clientId || !clientSecret) {
            throw new Error("OAuth client not configured. Run `nab auth oauth init`.");
          }

          const redirectUri = DEFAULT_REDIRECT_URI;

          const scope =
            resolveScope({ scope: args.scope }, process.env, {
              scope: config.oauth?.scope,
            }) ?? "full";

          const open = typeof args.open === "boolean" ? args.open : process.stdout.isTTY;
          const timeoutMs = Math.max(5, args.timeout ?? 180) * 1000;

          const token = await runOAuthLogin({
            clientId,
            clientSecret,
            redirectUri,
            scope,
            timeoutMs,
            open,
            onAuthorizeUrl: (url) => {
              if (!args.quiet || open === false) {
                process.stderr.write(`Open this URL to authenticate:\n${url}\n`);
              }
            },
          });

          const nextOauth = {
            ...(config.oauth ?? {}),
            clientId,
            redirectUri,
            scope,
            token,
            clientSecret: config.oauth?.clientSecret,
          };

          const next = await store.save({
            oauth: nextOauth,
            authMethod: args["set-default-auth"] ? "oauth" : config.authMethod,
          });

          const redacted = store.redact(next);
          formatKeyValues(
            formatOauthConfig({
              clientId: redacted.oauth?.clientId,
              redirectUri: redacted.oauth?.redirectUri,
              scope: redacted.oauth?.scope,
              hasClientSecret: Boolean(redacted.oauth?.clientSecret),
              hasToken: Boolean(redacted.oauth?.token),
            }),
            args.format,
          );
        },
      })
      .command({
        command: "status",
        describe: "Show OAuth status",
        handler: async (argv) => {
          const args = argv as { format?: string };
          const store = new ConfigStore();
          const config = await store.load();
          const env = process.env;

          const clientId = resolveClientId({ clientId: undefined }, env, {
            clientId: config.oauth?.clientId,
          });
          const redirectUri = config.oauth?.redirectUri ?? DEFAULT_REDIRECT_URI;
          const scope = resolveScope({ scope: undefined }, env, {
            scope: config.oauth?.scope,
          });
          const hasClientSecret = Boolean(
            normalize(env.NAB_OAUTH_CLIENT_SECRET) ?? config.oauth?.clientSecret,
          );

          const token = config.oauth?.token;
          const rows: KeyValueRow[] = [
            { key: "loggedIn", value: token?.accessToken ? "true" : "false" },
            { key: "expiresAt", value: token?.expiresAt ?? "" },
            { key: "scope", value: scope ?? "" },
            { key: "clientId", value: clientId ?? "" },
            { key: "redirectUri", value: redirectUri ?? "" },
            { key: "hasClientSecret", value: hasClientSecret ? "true" : "false" },
            { key: "authMethod", value: config.authMethod ?? "" },
          ];

          formatKeyValues(rows, args.format);
        },
      })
      .command({
        command: "refresh",
        describe: "Refresh OAuth access token",
        handler: async (argv) => {
          const args = argv as { format?: string };
          const store = new ConfigStore();
          const config = await store.load();

          const clientId = resolveClientId({ clientId: undefined }, process.env, {
            clientId: config.oauth?.clientId,
          });
          if (!clientId) throw new MissingOAuthClientIdError();

          const clientSecret =
            normalize(process.env.NAB_OAUTH_CLIENT_SECRET) ?? config.oauth?.clientSecret;
          if (!clientSecret) throw new MissingOAuthClientSecretError();

          const refreshToken = config.oauth?.token?.refreshToken;
          if (!refreshToken) throw new MissingOAuthRefreshTokenError();

          const token = await refreshOAuthToken({
            clientId,
            clientSecret,
            refreshToken,
          });

          const next = await store.save({
            oauth: {
              ...(config.oauth ?? {}),
              clientId,
              token,
            },
          });

          const redacted = store.redact(next);
          formatKeyValues(
            formatOauthConfig({
              clientId: redacted.oauth?.clientId,
              redirectUri: redacted.oauth?.redirectUri,
              scope: redacted.oauth?.scope,
              hasClientSecret: Boolean(redacted.oauth?.clientSecret),
              hasToken: Boolean(redacted.oauth?.token),
            }),
            args.format,
          );
        },
      })
      .command({
        command: "logout",
        describe: "Clear stored OAuth tokens",
        builder: (yyy) =>
          yyy.option("all", {
            type: "boolean",
            default: false,
            describe: "Clear OAuth client settings as well",
          }),
        handler: async (argv) => {
          const args = argv as { format?: string; all?: boolean };
          const store = new ConfigStore();
          const config = await store.load();

          if (!config.oauth) {
            throw new MissingOAuthTokenError();
          }

          if (args.all) {
            await store.save({
              oauth: undefined,
              authMethod: config.authMethod === "oauth" ? undefined : config.authMethod,
            });
          } else {
            await store.save({
              oauth: { ...config.oauth, token: undefined },
            });
          }

          formatKeyValues(
            formatOauthConfig({
              clientId: config.oauth?.clientId,
              redirectUri: config.oauth?.redirectUri,
              scope: config.oauth?.scope,
              hasClientSecret: Boolean(config.oauth?.clientSecret),
              hasToken: false,
            }),
            args.format,
          );
        },
      })
      .demandCommand(1, "Specify an OAuth subcommand")
      .strict(),
  handler: () => {},
};
