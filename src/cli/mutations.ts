export function normalizeIds(ids: string[] | string | undefined): string[] {
  if (!ids) return [];
  const values = Array.isArray(ids) ? ids : [ids];
  const cleaned = values.map((value) => value.trim()).filter((value) => value.length > 0);
  return Array.from(new Set(cleaned));
}

export function requireApplyConfirmation(
  dryRun: boolean,
  yes: boolean,
  isTty: boolean = Boolean(process.stdin.isTTY),
): void {
  if (!dryRun && !yes && !isTty) {
    throw new Error("Pass --yes to apply changes in non-interactive sessions.");
  }
}
