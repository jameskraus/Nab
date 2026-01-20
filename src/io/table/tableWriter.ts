import type { OutputWriter, OutputWriterOptions } from "../outputWriter";
import type { ColumnAlign, TableColumn } from "./columns";

export type TableSpec<T> = {
  columns: TableColumn<T>[];
  rows: T[];
};

const COLUMN_GAP = "  ";

const ANSI_PATTERN =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escapes use control characters.
  /[\u001b\u009b][[\]()#;?]*(?:\d{1,4}(?:;\d{0,4})*)?[0-9A-ORZcf-nqry=><]/g;

function stripAnsi(value: string): string {
  return value.replace(ANSI_PATTERN, "");
}

function normalizeCell(value: unknown, stripColors: boolean): string {
  if (value === null || value === undefined) return "";
  const raw =
    typeof value === "string" || typeof value === "number" || typeof value === "boolean"
      ? String(value)
      : JSON.stringify(value);
  const normalized = raw.replaceAll("\t", " ").replaceAll("\n", " ");
  return stripColors ? stripAnsi(normalized) : normalized;
}

function pad(value: string, width: number, align: ColumnAlign = "left"): string {
  return align === "right" ? value.padStart(width) : value.padEnd(width);
}

export class TableWriter<T = unknown> implements OutputWriter<TableSpec<T>> {
  public readonly format = "table" as const;
  private readonly stdout: NodeJS.WritableStream;
  private readonly stripColors: boolean;

  constructor(options: OutputWriterOptions = {}) {
    this.stdout = options.stdout ?? process.stdout;
    this.stripColors = Boolean(options.noColor);
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
        const formatted = col.format ? col.format(raw, row) : normalizeCell(raw, this.stripColors);
        const safe = this.stripColors ? stripAnsi(formatted) : formatted;
        widths[index] = Math.max(widths[index], safe.length);
        return safe;
      }),
    );

    const header = columns
      .map((col, index) => pad(col.header, widths[index], col.align))
      .join(COLUMN_GAP);
    const divider = columns.map((_, index) => "-".repeat(widths[index])).join(COLUMN_GAP);

    const lines = [
      this.stripColors ? stripAnsi(header) : header,
      this.stripColors ? stripAnsi(divider) : divider,
    ];
    for (const row of formattedRows) {
      const line = row
        .map((cell, index) => pad(cell, widths[index], columns[index].align))
        .join(COLUMN_GAP);
      lines.push(line);
    }

    this.stdout.write(`${lines.join("\n")}\n`);
  }
}
