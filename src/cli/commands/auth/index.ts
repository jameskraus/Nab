import type { Argv } from "yargs";

import { defineCommand } from "@/cli/command";
import { getOutputWriterOptions } from "@/cli/outputOptions";
import { ConfigStore } from "@/config/ConfigStore";
import { type OutputWriterOptions, createOutputWriter, parseOutputFormat } from "@/io";
import { fieldColumn } from "@/io/table/columns";

import { authOauthCommand } from "./oauth";
import { authTokenCommand } from "./token";

type KeyValueRow = { key: string; value: string };

function formatKeyValues(
  rows: KeyValueRow[],
  rawFormat?: string,
  options?: OutputWriterOptions,
): void {
  const format = parseOutputFormat(rawFormat, "table");

  if (format === "json") {
    const payload = rows.reduce<Record<string, string>>((acc, row) => {
      acc[row.key] = row.value;
      return acc;
    }, {});
    createOutputWriter("json", options).write(payload);
    return;
  }

  if (format === "ids") {
    createOutputWriter("ids", options).write(rows.map((row) => row.value));
    return;
  }

  if (format === "tsv") {
    createOutputWriter("tsv", options).write(rows);
    return;
  }

  createOutputWriter("table", options).write({
    columns: [fieldColumn("key", { header: "Key" }), fieldColumn("value", { header: "Value" })],
    rows,
  });
}

export const authCommand = {
  command: "auth <command>",
  describe: "Manage authentication tokens",
  builder: (y: Argv<Record<string, unknown>>) =>
    y
      .command(authTokenCommand)
      .command(authOauthCommand)
      .command(
        defineCommand({
          command: "use <method>",
          describe: "Set preferred auth method",
          builder: (yy) =>
            yy.positional("method", {
              type: "string",
              choices: ["pat", "oauth"] as const,
              describe: "Auth method to prefer by default",
            }),
          handler: async (argv) => {
            const args = argv as { method?: string; format?: string };
            const method = args.method;
            if (method !== "pat" && method !== "oauth") {
              throw new Error("Provide an auth method: pat or oauth.");
            }
            const store = new ConfigStore();
            const next = await store.save({ authMethod: method });
            formatKeyValues(
              [
                { key: "authMethod", value: next.authMethod ?? "" },
                { key: "tokens", value: next.tokens ? String(next.tokens.length) : "0" },
                { key: "hasOAuth", value: next.oauth?.token ? "true" : "false" },
              ],
              args.format,
              getOutputWriterOptions(argv),
            );
          },
        }),
      )
      .demandCommand(1, "Specify an auth subcommand")
      .strict(),
  handler: () => {},
} as const;
