import type { TransactionClearedStatus, TransactionFlagColor } from "ynab";

const AMOUNT_REGEX = /^[+-]?\d+(?:\.\d{1,3})?$/;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const CLEARED_STATUSES: TransactionClearedStatus[] = ["cleared", "uncleared", "reconciled"];
const FLAG_COLORS: TransactionFlagColor[] = ["red", "orange", "yellow", "green", "blue", "purple"];

export function parseAmountToMilliunits(input: string): number {
  const value = input.trim();
  if (!AMOUNT_REGEX.test(value)) {
    throw new Error("Amount must be a number with up to 3 decimal places.");
  }

  const match = /^([+-])?(\d+)(?:\.(\d{1,3}))?$/.exec(value);
  if (!match) {
    throw new Error("Amount must be a number with up to 3 decimal places.");
  }

  const sign = match[1] === "-" ? -1 : 1;
  const integerPart = Number(match[2]);
  const decimalPart = match[3] ?? "";
  const milliunits = integerPart * 1000 + Number(decimalPart.padEnd(3, "0"));

  return sign * milliunits;
}

export function parseDateOnly(input: string): string {
  const value = input.trim();
  if (!DATE_ONLY.test(value)) {
    throw new Error("Date must be in YYYY-MM-DD format.");
  }
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new Error("Date must be a valid calendar date.");
  }
  return value;
}

export function parseClearedStatus(input: string): TransactionClearedStatus {
  const normalized = input.trim().toLowerCase();
  if (!CLEARED_STATUSES.includes(normalized as TransactionClearedStatus)) {
    throw new Error("Status must be cleared, uncleared, or reconciled.");
  }
  return normalized as TransactionClearedStatus;
}

export function parseFlagColor(input: string): TransactionFlagColor {
  const normalized = input.trim().toLowerCase();
  if (!FLAG_COLORS.includes(normalized as TransactionFlagColor)) {
    throw new Error("Flag color must be red, orange, yellow, green, blue, or purple.");
  }
  return normalized as TransactionFlagColor;
}
