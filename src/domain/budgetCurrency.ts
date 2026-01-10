import type { BudgetSummary, CurrencyFormat } from "ynab";

import type { AppContext } from "@/app/createAppContext";
import type { Config } from "@/config/schema";

function mergeCurrencyFormats(
  existing: Record<string, CurrencyFormat> | undefined,
  updates: Record<string, CurrencyFormat>,
): Record<string, CurrencyFormat> {
  return {
    ...(existing ?? {}),
    ...updates,
  };
}

export async function cacheBudgetCurrencyFormats(
  ctx: AppContext,
  budgets: BudgetSummary[],
): Promise<Config> {
  const updates: Record<string, CurrencyFormat> = {};
  for (const budget of budgets) {
    if (budget.currency_format) {
      updates[budget.id] = budget.currency_format;
    }
  }

  if (Object.keys(updates).length === 0) {
    return ctx.config;
  }

  const next = await ctx.configStore.save({
    budgetCurrencyFormats: mergeCurrencyFormats(ctx.config.budgetCurrencyFormats, updates),
  });
  ctx.config = next;
  return next;
}

export async function resolveBudgetCurrencyFormat(
  ctx: AppContext,
  budgetId: string,
  options: { refresh?: boolean } = {},
): Promise<CurrencyFormat> {
  const cached = ctx.config.budgetCurrencyFormats?.[budgetId];
  if (cached && !options.refresh) {
    return cached;
  }

  if (!ctx.ynab) {
    throw new Error("Missing YNAB client to load budget currency format.");
  }

  const settings = await ctx.ynab.getBudgetSettings(budgetId);
  const format = settings.currency_format;
  if (!format) {
    throw new Error(`Budget ${budgetId} does not provide a currency format.`);
  }

  const next = await ctx.configStore.save({
    budgetCurrencyFormats: mergeCurrencyFormats(ctx.config.budgetCurrencyFormats, {
      [budgetId]: format,
    }),
  });
  ctx.config = next;
  return format;
}

export async function setBudgetCurrencyFormat(
  ctx: AppContext,
  budgetId: string,
  format: CurrencyFormat,
): Promise<Config> {
  const next = await ctx.configStore.save({
    budgetCurrencyFormats: mergeCurrencyFormats(ctx.config.budgetCurrencyFormats, {
      [budgetId]: format,
    }),
  });
  ctx.config = next;
  return next;
}
