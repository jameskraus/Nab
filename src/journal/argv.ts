export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

const OMIT_KEYS = new Set(["_", "$0", "appContext"]);

function normalizeValue(value: unknown): JsonValue | undefined {
  if (value === undefined || typeof value === "function") return undefined;
  if (value === null) return null;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value)) {
    const items = value
      .map((item) => normalizeValue(item))
      .filter((item): item is JsonValue => item !== undefined);
    return items;
  }
  if (typeof value === "object") {
    return normalizeArgv(value as Record<string, unknown>);
  }
  return undefined;
}

export function normalizeArgv(argv: Record<string, unknown>): Record<string, JsonValue> {
  const normalized: Record<string, JsonValue> = {};
  const keys = Object.keys(argv).sort();
  for (const key of keys) {
    if (OMIT_KEYS.has(key)) continue;
    const value = normalizeValue(argv[key]);
    if (value === undefined) continue;
    normalized[key] = value;
  }
  return normalized;
}
