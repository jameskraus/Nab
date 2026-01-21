import type { OutputWriter, OutputWriterOptions } from "../outputWriter";

export type TsvRow = Record<string, unknown>;

function sanitizeCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const raw =
    typeof value === "string" || typeof value === "number" || typeof value === "boolean"
      ? String(value)
      : JSON.stringify(value);
  return raw.replaceAll("\t", " ").replaceAll("\n", " ");
}

function collectColumns(rows: TsvRow[]): string[] {
  const columns = new Set<string>();
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      columns.add(key);
    }
  }
  const ordered = Array.from(columns).sort();
  const refIndex = ordered.indexOf("ref");
  if (refIndex > 0) {
    ordered.splice(refIndex, 1);
    ordered.unshift("ref");
  }
  return ordered;
}

export class TsvWriter implements OutputWriter<TsvRow[]> {
  public readonly format = "tsv" as const;
  private readonly stdout: NodeJS.WritableStream;

  constructor(options: OutputWriterOptions = {}) {
    this.stdout = options.stdout ?? process.stdout;
  }

  write(rows: TsvRow[]): void {
    if (!Array.isArray(rows)) {
      throw new Error("TsvWriter expects an array of row objects.");
    }
    if (rows.length === 0) return;

    const columns = collectColumns(rows);
    const lines = [columns.join("\t")];

    for (const row of rows) {
      const line = columns.map((col) => sanitizeCell(row[col])).join("\t");
      lines.push(line);
    }

    this.stdout.write(`${lines.join("\n")}\n`);
  }
}
