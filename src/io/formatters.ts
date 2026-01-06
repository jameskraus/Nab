export function formatDate(value: string | Date | null | undefined): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  return value.toISOString().slice(0, 10);
}
