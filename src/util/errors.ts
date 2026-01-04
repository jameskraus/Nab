export function formatError(err: unknown): string {
  if (err instanceof Error) return err.message || err.name;
  return String(err);
}
