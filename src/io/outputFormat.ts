export const OUTPUT_FORMATS = ["table", "json", "tsv", "ids"] as const;

export type OutputFormat = (typeof OUTPUT_FORMATS)[number];

export function isOutputFormat(value: string): value is OutputFormat {
  return (OUTPUT_FORMATS as readonly string[]).includes(value);
}

export function parseOutputFormat(
  value: string | undefined,
  fallback: OutputFormat = "table",
): OutputFormat {
  if (!value) return fallback;
  const normalized = value.trim().toLowerCase();
  if (isOutputFormat(normalized)) return normalized;
  throw new Error(`Unsupported format: ${value}. Expected one of: ${OUTPUT_FORMATS.join(", ")}`);
}
