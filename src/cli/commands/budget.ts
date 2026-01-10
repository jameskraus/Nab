import type { CommandModule } from "yargs";
import type { BudgetSummary, CurrencyFormat } from "ynab";

import type { AppContext } from "@/app/createAppContext";
import { MissingBudgetIdError } from "@/app/errors";
import type { CliGlobalArgs } from "@/cli/types";
import {
  cacheBudgetCurrencyFormats,
  resolveBudgetCurrencyFormat,
  setBudgetCurrencyFormat,
} from "@/domain/budgetCurrency";
import {
  type OutputWriterOptions,
  createOutputWriter,
  fieldColumn,
  formatCurrency,
  formatDate,
  parseOutputFormat,
} from "@/io";

type BudgetListRow = {
  id: string;
  name: string;
  lastModified: string;
  firstMonth: string;
  lastMonth: string;
};

type BudgetCurrentRow = {
  id: string;
};

type CliArgs = CliGlobalArgs & { appContext?: AppContext };

type CurrencyRow = {
  key: string;
  value: string;
};

type BudgetCurrencyPayload = {
  budgetId: string;
  currency_format: CurrencyFormat;
};

function budgetRows(budgets: BudgetSummary[]): BudgetListRow[] {
  return budgets.map((budget) => ({
    id: budget.id,
    name: budget.name,
    lastModified: formatDate(budget.last_modified_on),
    firstMonth: formatDate(budget.first_month),
    lastMonth: formatDate(budget.last_month),
  }));
}

export function writeBudgetList(
  budgets: BudgetSummary[],
  rawFormat?: string,
  options?: OutputWriterOptions,
): void {
  const format = parseOutputFormat(rawFormat, "table");

  if (format === "json") {
    createOutputWriter("json", options).write(budgets);
    return;
  }

  if (format === "ids") {
    createOutputWriter("ids", options).write(budgets.map((budget) => budget.id));
    return;
  }

  const rows = budgetRows(budgets);

  if (format === "tsv") {
    createOutputWriter("tsv", options).write(rows);
    return;
  }

  createOutputWriter("table", options).write({
    columns: [
      fieldColumn("name", { header: "Name" }),
      fieldColumn("id", { header: "Id" }),
      fieldColumn("lastModified", { header: "Last Modified" }),
      fieldColumn("firstMonth", { header: "First Month" }),
      fieldColumn("lastMonth", { header: "Last Month" }),
    ],
    rows,
  });
}

export function writeBudgetCurrent(
  budgetId: string,
  rawFormat?: string,
  options?: OutputWriterOptions,
): void {
  const format = parseOutputFormat(rawFormat, "table");
  const row: BudgetCurrentRow = { id: budgetId };

  if (format === "json") {
    createOutputWriter("json", options).write(row);
    return;
  }

  if (format === "ids") {
    createOutputWriter("ids", options).write([budgetId]);
    return;
  }

  if (format === "tsv") {
    createOutputWriter("tsv", options).write([row]);
    return;
  }

  createOutputWriter("table", options).write({
    columns: [fieldColumn("id", { header: "Id" })],
    rows: [row],
  });
}

function currencyRows(format: CurrencyFormat, budgetId: string): CurrencyRow[] {
  return [
    { key: "budgetId", value: budgetId },
    { key: "iso_code", value: format.iso_code },
    { key: "example_format", value: format.example_format },
    { key: "decimal_digits", value: String(format.decimal_digits) },
    { key: "decimal_separator", value: format.decimal_separator },
    { key: "symbol_first", value: String(format.symbol_first) },
    { key: "group_separator", value: format.group_separator },
    { key: "currency_symbol", value: format.currency_symbol },
    { key: "display_symbol", value: String(format.display_symbol) },
  ];
}

export function writeBudgetCurrency(
  budgetId: string,
  currencyFormat: CurrencyFormat,
  rawFormat?: string,
  options?: OutputWriterOptions,
): void {
  const format = parseOutputFormat(rawFormat, "table");
  const payload: BudgetCurrencyPayload = { budgetId, currency_format: currencyFormat };

  if (format === "json") {
    createOutputWriter("json", options).write(payload);
    return;
  }

  if (format === "ids") {
    createOutputWriter("ids", options).write([currencyFormat.iso_code]);
    return;
  }

  const rows = currencyRows(currencyFormat, budgetId);

  if (format === "tsv") {
    createOutputWriter("tsv", options).write(rows);
    return;
  }

  createOutputWriter("table", options).write({
    columns: [fieldColumn("key", { header: "Key" }), fieldColumn("value", { header: "Value" })],
    rows,
  });
}

export const budgetCommand: CommandModule<CliGlobalArgs> = {
  command: "budget <command>",
  describe: "Budgets",
  builder: (y) =>
    y
      .command({
        command: "list",
        describe: "List budgets available to the token",
        handler: async (argv) => {
          const { appContext, format } = argv as unknown as CliArgs;
          const ctx = appContext;
          if (!ctx?.ynab) {
            throw new Error("Missing YNAB client in app context.");
          }
          const budgets = await ctx.ynab.listBudgets();
          await cacheBudgetCurrencyFormats(ctx, budgets);
          writeBudgetList(budgets, format);
        },
      })
      .command({
        command: "current",
        describe: "Show the effective budget (from --budget-id or config)",
        handler: (argv) => {
          const { appContext, format } = argv as unknown as CliArgs;
          const ctx = appContext;
          if (!ctx?.budgetId) {
            throw new MissingBudgetIdError();
          }
          writeBudgetCurrent(ctx.budgetId, format);
        },
      })
      .command({
        command: "currency <command>",
        describe: "Manage budget currency format",
        builder: (yy) =>
          yy
            .command({
              command: "show",
              describe: "Show the cached budget currency format",
              handler: async (argv) => {
                const { appContext, format } = argv as unknown as CliArgs;
                const ctx = appContext;
                if (!ctx?.budgetId) {
                  throw new MissingBudgetIdError();
                }
                const currencyFormat = await resolveBudgetCurrencyFormat(ctx, ctx.budgetId);
                writeBudgetCurrency(ctx.budgetId, currencyFormat, format);
              },
            })
            .command({
              command: "refresh",
              describe: "Refresh the budget currency format from YNAB",
              handler: async (argv) => {
                const { appContext, format } = argv as unknown as CliArgs;
                const ctx = appContext;
                if (!ctx?.budgetId) {
                  throw new MissingBudgetIdError();
                }
                const currencyFormat = await resolveBudgetCurrencyFormat(ctx, ctx.budgetId, {
                  refresh: true,
                });
                writeBudgetCurrency(ctx.budgetId, currencyFormat, format);
              },
            })
            .command({
              command: "set",
              describe: "Override the cached budget currency format",
              builder: (yyy) =>
                yyy
                  .option("iso-code", {
                    type: "string",
                    demandOption: true,
                    describe: "ISO currency code (e.g. USD)",
                  })
                  .option("decimal-digits", {
                    type: "number",
                    demandOption: true,
                    describe: "Decimal digits (0-3)",
                  })
                  .option("decimal-separator", {
                    type: "string",
                    demandOption: true,
                    describe: "Decimal separator",
                  })
                  .option("group-separator", {
                    type: "string",
                    demandOption: true,
                    describe: "Group/thousands separator",
                  })
                  .option("currency-symbol", {
                    type: "string",
                    demandOption: true,
                    describe: "Currency symbol",
                  })
                  .option("symbol-first", {
                    type: "boolean",
                    default: true,
                    describe: "Place currency symbol before amount",
                  })
                  .option("display-symbol", {
                    type: "boolean",
                    default: true,
                    describe: "Include currency symbol in formatted output",
                  })
                  .option("example-format", {
                    type: "string",
                    describe: "Example format (optional)",
                  })
                  .check((argv) => {
                    if (typeof argv["decimal-digits"] === "number") {
                      if (argv["decimal-digits"] < 0 || argv["decimal-digits"] > 3) {
                        throw new Error("Provide --decimal-digits between 0 and 3.");
                      }
                    }
                    return true;
                  }),
              handler: async (argv) => {
                const args = argv as unknown as CliArgs & {
                  "iso-code": string;
                  "decimal-digits": number;
                  "decimal-separator": string;
                  "group-separator": string;
                  "currency-symbol": string;
                  "symbol-first": boolean;
                  "display-symbol": boolean;
                  "example-format"?: string;
                };
                const { appContext, format } = args;
                const ctx = appContext;
                if (!ctx?.budgetId) {
                  throw new MissingBudgetIdError();
                }

                const currencyFormat: CurrencyFormat = {
                  iso_code: args["iso-code"],
                  decimal_digits: args["decimal-digits"],
                  decimal_separator: args["decimal-separator"],
                  group_separator: args["group-separator"],
                  currency_symbol: args["currency-symbol"],
                  symbol_first: Boolean(args["symbol-first"]),
                  display_symbol: Boolean(args["display-symbol"]),
                  example_format:
                    args["example-format"] ??
                    formatCurrency(1234567, {
                      iso_code: args["iso-code"],
                      decimal_digits: args["decimal-digits"],
                      decimal_separator: args["decimal-separator"],
                      group_separator: args["group-separator"],
                      currency_symbol: args["currency-symbol"],
                      symbol_first: Boolean(args["symbol-first"]),
                      display_symbol: Boolean(args["display-symbol"]),
                      example_format: "sample",
                    }),
                };

                await setBudgetCurrencyFormat(ctx, ctx.budgetId, currencyFormat);
                writeBudgetCurrency(ctx.budgetId, currencyFormat, format);
              },
            })
            .demandCommand(1, "Specify a currency subcommand")
            .strict(),
        handler: () => {},
      })
      .demandCommand(1, "Specify a budget subcommand")
      .strict(),
  handler: () => {},
};
