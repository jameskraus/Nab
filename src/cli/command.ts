import type { Database } from "bun:sqlite";
import type { Logger } from "pino";
import type { ArgumentsCamelCase, Argv, CommandModule } from "yargs";

import type { YnabApiClient } from "@/api/YnabClient";
import { type AppContext, createAppContext } from "@/app/createAppContext";
import type { AuthArgs, BudgetArgs, MutationArgs, OutputArgs } from "./options";
import {
  withAuthOptions,
  withBudgetOptions,
  withMutationOptions,
  withOutputOptions,
} from "./options";

export type BudgetRequirement = "required" | "optional";

export type CommandRequirements = {
  auth?: boolean;
  budget?: BudgetRequirement;
  db?: boolean;
  mutation?: boolean;
  output?: boolean;
};

type LoggerArgs = { logger?: Logger };

type NeedsContext<R extends CommandRequirements> = R["auth"] extends true
  ? true
  : R["budget"] extends "required"
    ? true
    : R["db"] extends true
      ? true
      : false;

type EmptyObject = Record<string, never>;

type ContextFor<R extends CommandRequirements> = NeedsContext<R> extends true
  ? AppContext &
      (R["auth"] extends true ? { ynab: YnabApiClient } : EmptyObject) &
      (R["budget"] extends "required" ? { budgetId: string } : EmptyObject) &
      (R["db"] extends true ? { db: Database } : EmptyObject)
  : undefined;

type ArgsFor<R extends CommandRequirements> = LoggerArgs &
  (R["auth"] extends true ? AuthArgs : EmptyObject) &
  (R["budget"] extends BudgetRequirement ? BudgetArgs : EmptyObject) &
  (R["mutation"] extends true ? MutationArgs : EmptyObject) &
  (R["output"] extends false ? EmptyObject : OutputArgs);

export type CommandHandler<R extends CommandRequirements, A extends object> = (
  argv: ArgumentsCamelCase<A & ArgsFor<R>>,
  ctx: ContextFor<R>,
) => void | Promise<void>;

export function defineCommand<
  R extends CommandRequirements,
  A extends object = Record<string, never>,
>(spec: {
  command: string;
  describe?: string;
  requirements?: R;
  builder?: (y: Argv<Record<string, unknown>>) => Argv<Record<string, unknown>>;
  handler: CommandHandler<R, A>;
}): CommandModule<Record<string, unknown>, Record<string, unknown>> {
  const requirements = spec.requirements ?? ({} as R);
  const outputEnabled = requirements.output !== false;

  return {
    command: spec.command,
    describe: spec.describe,
    builder: (y) => {
      let builder: Argv<Record<string, unknown>> = y as Argv<Record<string, unknown>>;
      if (requirements.auth) builder = withAuthOptions(builder);
      if (requirements.budget) builder = withBudgetOptions(builder);
      if (requirements.mutation) builder = withMutationOptions(builder);
      if (outputEnabled) builder = withOutputOptions(builder);
      if (spec.builder) builder = spec.builder(builder);
      return builder;
    },
    handler: async (argv) => {
      const needsContext = Boolean(
        requirements.auth || requirements.budget === "required" || requirements.db,
      );
      let ctx: AppContext | undefined;

      if (needsContext) {
        const logger = (argv as { logger?: Logger }).logger;
        if (!logger) {
          throw new Error("Command logger is not available.");
        }

        ctx = await createAppContext({
          argv: argv as { auth?: string; budgetId?: string },
          requireToken: Boolean(requirements.auth),
          requireBudgetId: requirements.budget === "required",
          createDb: Boolean(requirements.db),
          logger,
        });
      }

      await spec.handler(argv as ArgumentsCamelCase<A & ArgsFor<R>>, ctx as ContextFor<R>);
    },
  };
}
