import type { CliGlobalArgs } from "@/cli/types";
import { ConfigStore } from "@/config/ConfigStore";
import { getConfigDir, getConfigFilePath } from "@/config/paths";
import { createOutputWriter, parseOutputFormat } from "@/io";
import { fieldColumn } from "@/io/table/columns";
import type { CommandModule } from "yargs";

type Args = {
  tokens?: string;
  budgetId?: string;
  all?: boolean;
};

type ConfigView = {
  tokens?: string[];
  budgetId?: string;
};

function configRows(config: ConfigView) {
  return [
    { key: "tokens", value: config.tokens ? config.tokens.join(", ") : "" },
    { key: "budgetId", value: config.budgetId ?? "" },
  ];
}

function writeConfig(config: ConfigView, rawFormat?: string) {
  const format = parseOutputFormat(rawFormat, "table");

  if (format === "json") {
    const writer = createOutputWriter("json");
    writer.write(config);
    return;
  }

  if (format === "ids") {
    const writer = createOutputWriter("ids");
    writer.write(config.budgetId ? [config.budgetId] : []);
    return;
  }

  const rows = configRows(config);

  if (format === "tsv") {
    const writer = createOutputWriter("tsv");
    writer.write(rows);
    return;
  }

  const writer = createOutputWriter("table");
  writer.write({
    columns: [fieldColumn("key", { header: "Key" }), fieldColumn("value", { header: "Value" })],
    rows,
  });
}

export const configCommand: CommandModule<CliGlobalArgs, Args> = {
  command: "config <command>",
  describe: "Manage local nab configuration",
  builder: (y) =>
    y
      .command({
        command: "path",
        describe: "Print the config file path",
        handler: () => {
          console.log(getConfigFilePath());
        },
      })
      .command({
        command: "dir",
        describe: "Print the nab config directory",
        handler: () => {
          console.log(getConfigDir());
        },
      })
      .command({
        command: "show",
        describe: "Show current config (tokens are redacted)",
        handler: async (argv) => {
          const store = new ConfigStore();
          const config = store.redact(await store.load());
          writeConfig(config, argv.format);
        },
      })
      .command({
        command: "set",
        describe: "Set config values",
        builder: (yy) =>
          yy
            .option("tokens", {
              type: "string",
              describe: "Comma-separated YNAB Personal Access Tokens",
            })
            .option("budget-id", {
              type: "string",
              describe: "Default budget id",
            })
            .check((argv) => {
              if (!argv.tokens && !argv.budgetId) {
                throw new Error("Provide at least one of --tokens or --budget-id");
              }
              return true;
            }),
        handler: async (argv) => {
          const store = new ConfigStore();
          const tokens = argv.tokens
            ? argv.tokens
                .split(",")
                .map((token) => token.trim())
                .filter((token) => token.length > 0)
            : undefined;
          if (argv.tokens && (!tokens || tokens.length === 0)) {
            throw new Error("Provide at least one non-empty token in --tokens");
          }
          const next = await store.save({
            tokens,
            budgetId: argv.budgetId,
          });
          writeConfig(store.redact(next), argv.format);
        },
      })
      .command({
        command: "clear",
        describe: "Clear config values",
        builder: (yy) =>
          yy
            .option("tokens", {
              type: "boolean",
              default: false,
              describe: "Clear tokens",
            })
            .option("budget-id", {
              type: "boolean",
              default: false,
              describe: "Clear default budget id",
            })
            .option("all", {
              type: "boolean",
              default: false,
              describe: "Clear all config",
            }),
        handler: async (argv) => {
          const store = new ConfigStore();
          if (argv.all || (!argv.tokens && !argv.budgetId)) {
            await store.clear("all");
            return;
          }

          const keys: ("tokens" | "budgetId")[] = [];
          if (argv.tokens) keys.push("tokens");
          if (argv.budgetId) keys.push("budgetId");
          await store.clear(keys);
        },
      })
      .demandCommand(1, "Specify a config subcommand")
      .strict(),
  handler: () => {
    // no-op: yargs will route to subcommands
  },
};
