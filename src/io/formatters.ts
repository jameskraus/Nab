import type { CurrencyFormat } from "ynab";

export function formatDate(value: string | Date | null | undefined): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  return value.toISOString().slice(0, 10);
}

function clampDecimalDigits(value: number): number {
  if (!Number.isFinite(value)) return 2;
  return Math.max(0, Math.min(3, Math.trunc(value)));
}

function groupDigits(value: string, separator: string): string {
  if (!separator) return value;
  return value.replace(/\B(?=(\d{3})+(?!\d))/g, separator);
}

function roundMilliunits(value: number, decimals: number): number {
  const scale = 10 ** (3 - decimals);
  return Math.round(value / scale) * scale;
}

export function formatCurrency(
  value: number | null | undefined,
  format?: CurrencyFormat | null,
): string {
  if (value === null || value === undefined) return "";
  if (!format) return String(value);

  const decimals = clampDecimalDigits(format.decimal_digits);
  const rounded = roundMilliunits(value, decimals);
  const sign = rounded < 0 ? "-" : "";
  const abs = Math.abs(rounded);

  const integerPart = Math.floor(abs / 1000);
  const fractionalMilli = abs % 1000;
  const fractionalScale = 10 ** (3 - decimals);
  const fractionalValue = decimals > 0 ? Math.round(fractionalMilli / fractionalScale) : 0;

  const groupedInteger = groupDigits(String(integerPart), format.group_separator);
  const fractional =
    decimals > 0
      ? `${format.decimal_separator}${String(fractionalValue).padStart(decimals, "0")}`
      : "";
  const number = `${groupedInteger}${fractional}`;

  const withSymbol =
    format.display_symbol && format.currency_symbol
      ? format.symbol_first
        ? `${format.currency_symbol}${number}`
        : `${number}${format.currency_symbol}`
      : number;

  return `${sign}${withSymbol}`;
}
