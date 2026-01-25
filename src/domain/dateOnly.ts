const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 24 * 60 * 60 * 1000;

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

export function dateOnlyToUtcMs(value: string): number | null {
  try {
    const normalized = parseDateOnly(value);
    const [year, month, day] = normalized.split("-").map(Number);
    const ms = Date.UTC(year, month - 1, day);
    return Number.isFinite(ms) ? ms : null;
  } catch {
    return null;
  }
}

export function withinDayDelta(a: string, b: string, maxDays: number): boolean {
  const aMs = dateOnlyToUtcMs(a);
  const bMs = dateOnlyToUtcMs(b);
  if (aMs === null || bMs === null) return false;
  return Math.abs(aMs - bMs) / DAY_MS <= maxDays;
}

export function daysAgoUtc(days: number, nowMs: number = Date.now()): string {
  if (!Number.isFinite(days)) {
    throw new Error("Days must be a finite number.");
  }
  const ms = nowMs - days * DAY_MS;
  return new Date(ms).toISOString().slice(0, 10);
}

export function defaultSinceDate(days = 30, nowMs: number = Date.now()): string {
  return daysAgoUtc(days, nowMs);
}
