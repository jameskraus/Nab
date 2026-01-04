import type { CommandModule } from "yargs";

function notImplemented() {
  throw new Error("Not implemented yet (see docs/BEADS.md)");
}

export const txCommand: CommandModule = {
  command: "tx <command>",
  describe: "Query and mutate transactions",
  builder: (y) =>
    y
      .command({
        command: "list",
        describe: "List transactions",
        builder: (yy) =>
          yy
            .option("account-id", {
              type: "string",
              describe: "Filter by account id",
            })
            .option("since-date", {
              type: "string",
              describe: "Only include transactions on/after this date (YYYY-MM-DD)",
            })
            .option("uncategorized", {
              type: "boolean",
              default: false,
              describe: "Only show uncategorized transactions",
            }),
        handler: notImplemented,
      })
      .command({
        command: "get",
        describe: "Get a single transaction",
        builder: (yy) => yy.option("id", { type: "string", demandOption: true, describe: "Transaction id" }),
        handler: notImplemented,
      })

      // Approval
      .command({
        command: "approve",
        describe: "Approve one or more transactions",
        builder: (yy) =>
          yy.option("id", {
            type: "string",
            array: true,
            demandOption: true,
            describe: "Transaction id (repeatable)",
          }),
        handler: notImplemented,
      })
      .command({
        command: "unapprove",
        describe: "Unapprove one or more transactions",
        builder: (yy) =>
          yy.option("id", {
            type: "string",
            array: true,
            demandOption: true,
            describe: "Transaction id (repeatable)",
          }),
        handler: notImplemented,
      })

      // Deletion ("reject")
      .command({
        command: "delete",
        describe: "Delete one or more transactions",
        builder: (yy) =>
          yy.option("id", {
            type: "string",
            array: true,
            demandOption: true,
            describe: "Transaction id (repeatable)",
          }),
        handler: notImplemented,
      })

      // Category
      .command({
        command: "category set",
        describe: "Set category on one or more transactions",
        builder: (yy) =>
          yy
            .option("id", {
              type: "string",
              array: true,
              demandOption: true,
              describe: "Transaction id (repeatable)",
            })
            .option("category-id", {
              type: "string",
              describe: "Category id",
            })
            .option("category-name", {
              type: "string",
              describe: "Category name (must resolve unambiguously)",
            })
            .check((argv) => {
              if (!argv.categoryId && !argv.categoryName) {
                throw new Error("Provide --category-id or --category-name");
              }
              return true;
            }),
        handler: notImplemented,
      })
      .command({
        command: "category clear",
        describe: "Clear category on one or more transactions (set to null)",
        builder: (yy) =>
          yy.option("id", {
            type: "string",
            array: true,
            demandOption: true,
            describe: "Transaction id (repeatable)",
          }),
        handler: notImplemented,
      })

      // Memo
      .command({
        command: "memo get",
        describe: "Get memo for a transaction",
        builder: (yy) => yy.option("id", { type: "string", demandOption: true, describe: "Transaction id" }),
        handler: notImplemented,
      })
      .command({
        command: "memo set",
        describe: "Set memo for one or more transactions",
        builder: (yy) =>
          yy
            .option("id", {
              type: "string",
              array: true,
              demandOption: true,
              describe: "Transaction id (repeatable)",
            })
            .option("memo", {
              type: "string",
              demandOption: true,
              describe: "Memo text",
            }),
        handler: notImplemented,
      })
      .command({
        command: "memo clear",
        describe: "Clear memo for one or more transactions",
        builder: (yy) =>
          yy.option("id", {
            type: "string",
            array: true,
            demandOption: true,
            describe: "Transaction id (repeatable)",
          }),
        handler: notImplemented,
      })

      // Flag
      .command({
        command: "flag set",
        describe: "Set flag color on one or more transactions",
        builder: (yy) =>
          yy
            .option("id", {
              type: "string",
              array: true,
              demandOption: true,
              describe: "Transaction id (repeatable)",
            })
            .option("color", {
              type: "string",
              demandOption: true,
              choices: ["red", "orange", "yellow", "green", "blue", "purple"] as const,
              describe: "Flag color",
            }),
        handler: notImplemented,
      })
      .command({
        command: "flag clear",
        describe: "Clear flag on one or more transactions",
        builder: (yy) =>
          yy.option("id", {
            type: "string",
            array: true,
            demandOption: true,
            describe: "Transaction id (repeatable)",
          }),
        handler: notImplemented,
      })

      // Cleared
      .command({
        command: "cleared set",
        describe: "Set cleared status on one or more transactions",
        builder: (yy) =>
          yy
            .option("id", {
              type: "string",
              array: true,
              demandOption: true,
              describe: "Transaction id (repeatable)",
            })
            .option("status", {
              type: "string",
              demandOption: true,
              choices: ["cleared", "uncleared", "reconciled"] as const,
              describe: "Cleared status",
            }),
        handler: notImplemented,
      })

      // Date
      .command({
        command: "date set <date>",
        describe: "Set date (YYYY-MM-DD) on one or more transactions",
        builder: (yy) =>
          yy
            .positional("date", {
              type: "string",
              describe: "New date (YYYY-MM-DD)",
            })
            .option("id", {
              type: "string",
              array: true,
              demandOption: true,
              describe: "Transaction id (repeatable)",
            }),
        handler: notImplemented,
      })

      // Payee
      .command({
        command: "payee set",
        describe: "Set payee on one or more transactions",
        builder: (yy) =>
          yy
            .option("id", {
              type: "string",
              array: true,
              demandOption: true,
              describe: "Transaction id (repeatable)",
            })
            .option("payee-id", {
              type: "string",
              describe: "Payee id",
            })
            .option("payee-name", {
              type: "string",
              describe: "Payee name (must resolve unambiguously)",
            })
            .check((argv) => {
              if (!argv.payeeId && !argv.payeeName) {
                throw new Error("Provide --payee-id or --payee-name");
              }
              return true;
            }),
        handler: notImplemented,
      })

      // Amount
      .command({
        command: "amount set",
        describe: "Set transaction amount (single transaction only)",
        builder: (yy) =>
          yy
            .option("id", {
              type: "string",
              demandOption: true,
              describe: "Transaction id",
            })
            .option("amount", {
              type: "string",
              demandOption: true,
              describe: "Amount (e.g. -12.34 or 12.34)",
            }),
        handler: notImplemented,
      })

      // Account
      .command({
        command: "account set",
        describe: "Move a transaction to another account (non-transfer only)",
        builder: (yy) =>
          yy
            .option("id", {
              type: "string",
              array: true,
              demandOption: true,
              describe: "Transaction id (repeatable)",
            })
            .option("account-id", {
              type: "string",
              describe: "Destination account id",
            })
            .option("account-name", {
              type: "string",
              describe: "Destination account name (must resolve unambiguously)",
            })
            .check((argv) => {
              if (!argv.accountId && !argv.accountName) {
                throw new Error("Provide --account-id or --account-name");
              }
              return true;
            }),
        handler: notImplemented,
      })

      .demandCommand(1, "Specify a tx subcommand")
      .strict(),
  handler: () => {},
};
