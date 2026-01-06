import type { OutputWriter, OutputWriterOptions } from "../outputWriter";
import type { ColumnAlign, TableColumn } from "./columns";

export type TableSpec<T> = {
  columns: TableColumn<T>[];
  rows: T[];
};

const COLUMN_GAP = "  ";

function normalizeCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const raw =
    typeof value === "string" || typeof value === "number" || typeof value === "boolean"
      ? String(value)
      : JSON.stringify(value);
  return raw.replaceAll("\t", " ").replaceAll("\n", " ");
}

function pad(value: string, width: number, align: ColumnAlign = "left"): string {
  return align === "right" ? value.padStart(width) : value.padEnd(width);
}

export class TableWriter<T = unknown> implements OutputWriter<TableSpec<T>> {
  public readonly format = "table" as const;
  private readonly stdout: NodeJS.WritableStream;

  constructor(options: OutputWriterOptions = {}) {
    this.stdout = options.stdout ?? process.stdout;
  }

  write(spec: TableSpec<T>): void {
    if (!spec || !Array.isArray(spec.columns) || !Array.isArray(spec.rows)) {
      throw new Error("TableWriter expects { columns, rows }.");
    }
    if (spec.columns.length === 0) return;

    const rows = spec.rows;
    const columns = spec.columns;
    const widths = columns.map((col) => col.header.length);

    const formattedRows = rows.map((row) =>
      columns.map((col, index) => {
        const raw = col.getValue(row);
        const formatted = col.format ? col.format(raw, row) : normalizeCell(raw);
        widths[index] = Math.max(widths[index], formatted.length);
        return formatted;
      }),
    );

    const header = columns
      .map((col, index) => pad(col.header, widths[index], col.align))
      .join(COLUMN_GAP);
    const divider = columns.map((_, index) => "-".repeat(widths[index])).join(COLUMN_GAP);

    const lines = [header, divider];
    for (const row of formattedRows) {
      const line = row
        .map((cell, index) => pad(cell, widths[index], columns[index].align))
        .join(COLUMN_GAP);
      lines.push(line);
    }

    this.stdout.write(`${lines.join("\n")}\n`);
  }
}
