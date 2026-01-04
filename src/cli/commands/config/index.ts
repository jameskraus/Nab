import type { CommandModule } from "yargs";

import { ConfigStore } from "@/config/ConfigStore";
import { getConfigDir, getConfigFilePath } from "@/config/paths";

type Args = {
  token?: string;
  budgetId?: string;
  all?: boolean;
};

export const configCommand: CommandModule<{}, Args> = {
  command: "config <command>",
  describe: "Manage local ynac configuration",
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
        describe: "Print the ynac config directory",
        handler: () => {
          console.log(getConfigDir());
        },
      })
      .command({
        command: "show",
        describe: "Show current config (token is redacted)",
        handler: async () => {
          const store = new ConfigStore();
          const config = store.redact(await store.load());
          console.log(JSON.stringify(config, null, 2));
        },
      })
      .command({
        command: "set",
        describe: "Set config values",
        builder: (yy) =>
          yy
            .option("token", {
              type: "string",
              describe: "YNAB Personal Access Token",
            })
            .option("budget-id", {
              type: "string",
              describe: "Default budget id",
            })
            .check((argv) => {
              if (!argv.token && !argv.budgetId) {
                throw new Error("Provide at least one of --token or --budget-id");
              }
              return true;
            }),
        handler: async (argv) => {
          const store = new ConfigStore();
          const next = await store.save({
            token: argv.token,
            budgetId: argv.budgetId,
          });
          console.log(JSON.stringify(store.redact(next), null, 2));
        },
      })
      .command({
        command: "clear",
        describe: "Clear config values",
        builder: (yy) =>
          yy
            .option("token", {
              type: "boolean",
              default: false,
              describe: "Clear token",
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
          if (argv.all || (!argv.token && !argv.budgetId)) {
            await store.clear("all");
            return;
          }

          const keys: ("token" | "budgetId")[] = [];
          if (argv.token) keys.push("token");
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
