import { ConfigStore } from "@/config/ConfigStore";
import { createOutputWriter, parseOutputFormat } from "@/io";
import { fieldColumn } from "@/io/table/columns";
import type { CommandModule } from "yargs";

const YNAB_API_BASE = "https://api.ynab.com/v1";

type CliArgs = {
  token?: string;
  index?: number;
};

type TokenCheckStatus = "ok" | "unauthorized" | "rate_limited" | "error";

type TokenCheckRow = {
  index: number;
  token: string;
  status: TokenCheckStatus;
  detail?: string;
  retryAfterSeconds?: number;
};

function writeTokens(tokens: string[], rawFormat?: string): void {
  const format = parseOutputFormat(rawFormat, "table");
  const values = tokens;

  if (format === "json") {
    const writer = createOutputWriter("json");
    writer.write(values.map((token, index) => ({ index: index + 1, token })));
    return;
  }

  if (format === "ids") {
    const writer = createOutputWriter("ids");
    writer.write(values);
    return;
  }

  const rows = values.map((token, index) => ({ index: index + 1, token }));

  if (format === "tsv") {
    const writer = createOutputWriter("tsv");
    writer.write(rows);
    return;
  }

  const writer = createOutputWriter("table");
  writer.write({
    columns: [fieldColumn("index", { header: "Index" }), fieldColumn("token", { header: "Token" })],
    rows,
  });
}

function writeTokenChecks(rows: TokenCheckRow[], rawFormat?: string): void {
  const format = parseOutputFormat(rawFormat, "table");

  if (format === "json") {
    const writer = createOutputWriter("json");
    writer.write(rows);
    return;
  }

  if (format === "ids") {
    const writer = createOutputWriter("ids");
    writer.write(rows.map((row) => row.token));
    return;
  }

  const outputRows = rows.map((row) => ({
    index: row.index,
    token: row.token,
    status: row.status,
    retryAfterSeconds: row.retryAfterSeconds ?? "",
    detail: row.detail ?? "",
  }));

  if (format === "tsv") {
    const writer = createOutputWriter("tsv");
    writer.write(outputRows);
    return;
  }

  const writer = createOutputWriter("table");
  writer.write({
    columns: [
      fieldColumn("index", { header: "Index" }),
      fieldColumn("token", { header: "Token" }),
      fieldColumn("status", { header: "Status" }),
      fieldColumn("retryAfterSeconds", { header: "Retry After (s)" }),
      fieldColumn("detail", { header: "Detail" }),
    ],
    rows: outputRows,
  });
}

async function readErrorDetail(response: Response): Promise<string | undefined> {
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    try {
      const payload = (await response.clone().json()) as {
        error?: { detail?: string; name?: string };
      };
      const detail = payload?.error?.detail ?? payload?.error?.name;
      if (typeof detail === "string" && detail.trim().length > 0) return detail.trim();
    } catch {
      // fall through to text parsing
    }
  }

  try {
    const text = await response.text();
    if (text.trim().length > 0) return text.trim();
  } catch {
    // ignore unreadable body
  }

  return undefined;
}

async function checkToken(token: string): Promise<Omit<TokenCheckRow, "index" | "token">> {
  try {
    const response = await fetch(`${YNAB_API_BASE}/user`, {
      headers: {
        accept: "application/json",
        authorization: `Bearer ${token}`,
      },
    });

    if (response.ok) return { status: "ok" };

    const retryAfterHeader = response.headers.get("retry-after");
    const retryAfterSeconds =
      retryAfterHeader && Number.isFinite(Number(retryAfterHeader))
        ? Number(retryAfterHeader)
        : undefined;
    const detail = await readErrorDetail(response);

    if (response.status === 401) {
      return { status: "unauthorized", detail };
    }

    if (response.status === 429) {
      return { status: "rate_limited", detail, retryAfterSeconds };
    }

    return {
      status: "error",
      detail: detail ?? `HTTP ${response.status}`,
    };
  } catch (err) {
    return { status: "error", detail: err instanceof Error ? err.message : String(err) };
  }
}

export const authCommand: CommandModule = {
  command: "auth <command>",
  describe: "Manage authentication tokens",
  builder: (y) =>
    y
      .command({
        command: "token <command>",
        describe: "Manage YNAB tokens",
        builder: (yy) =>
          yy
            .command({
              command: "add <token>",
              describe: "Add a YNAB token",
              builder: (yyy) =>
                yyy.positional("token", {
                  type: "string",
                  describe: "YNAB Personal Access Token",
                }),
              handler: async (argv) => {
                const args = argv as CliArgs & { format?: string };
                const token = args.token?.trim();
                if (!token) throw new Error("Provide a non-empty token value");
                const store = new ConfigStore();
                const config = await store.load();
                const tokens = config.tokens ?? [];
                const next = tokens.includes(token) ? tokens : [...tokens, token];
                await store.save({ tokens: next });
                writeTokens(next, args.format);
              },
            })
            .command({
              command: "list",
              describe: "List configured tokens",
              handler: async (argv) => {
                const args = argv as { format?: string };
                const store = new ConfigStore();
                const config = await store.load();
                writeTokens(config.tokens ?? [], args.format);
              },
            })
            .command({
              command: "check",
              describe: "Check configured tokens against the YNAB API",
              handler: async (argv) => {
                const args = argv as { format?: string };
                const store = new ConfigStore();
                const config = await store.load();
                const tokens = config.tokens ?? [];

                if (tokens.length === 0) {
                  throw new Error("No tokens configured. Add one with `nab auth token add <PAT>`.");
                }

                const results: TokenCheckRow[] = [];
                for (const [index, token] of tokens.entries()) {
                  const outcome = await checkToken(token);
                  results.push({ index: index + 1, token, ...outcome });
                }

                writeTokenChecks(results, args.format);
              },
            })
            .command({
              command: "remove",
              describe: "Remove a token by index or value",
              builder: (yyy) =>
                yyy
                  .option("token", {
                    type: "string",
                    describe: "Exact token value to remove",
                  })
                  .option("index", {
                    type: "number",
                    describe: "1-based index of token to remove",
                  })
                  .check((argv) => {
                    const hasToken = typeof argv.token === "string" && argv.token.trim().length > 0;
                    const hasIndex = typeof argv.index === "number";
                    if ((hasToken && hasIndex) || (!hasToken && !hasIndex)) {
                      throw new Error("Provide either --token or --index");
                    }
                    return true;
                  }),
              handler: async (argv) => {
                const args = argv as CliArgs & { format?: string };
                const store = new ConfigStore();
                const config = await store.load();
                const tokens = config.tokens ?? [];

                let next: string[] = tokens;

                if (typeof args.index === "number") {
                  if (!Number.isFinite(args.index)) throw new Error("Provide a valid --index");
                  const index = Math.trunc(args.index);
                  if (index < 1 || index > tokens.length) {
                    throw new Error(`Index out of range: ${index}`);
                  }
                  next = tokens.filter((_, i) => i !== index - 1);
                } else if (args.token) {
                  const value = args.token.trim();
                  next = tokens.filter((token) => token !== value);
                  if (next.length === tokens.length) {
                    throw new Error("Token not found in config");
                  }
                }

                const stored = next.length > 0 ? next : undefined;
                await store.save({ tokens: stored });
                writeTokens(next, args.format);
              },
            })
            .demandCommand(1, "Specify an auth token subcommand")
            .strict(),
        handler: () => {},
      })
      .demandCommand(1, "Specify an auth subcommand")
      .strict(),
  handler: () => {},
};
