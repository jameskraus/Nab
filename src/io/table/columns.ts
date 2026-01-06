export type ColumnAlign = "left" | "right";

export type TableColumn<T> = {
  header: string;
  getValue: (row: T) => unknown;
  align?: ColumnAlign;
  format?: (value: unknown, row: T) => string;
};

export function column<T>(
  header: string,
  getValue: (row: T) => unknown,
  options: { align?: ColumnAlign; format?: (value: unknown, row: T) => string } = {},
): TableColumn<T> {
  return {
    header,
    getValue,
    align: options.align,
    format: options.format,
  };
}

export function fieldColumn<T extends Record<string, unknown>>(
  key: keyof T & string,
  options: {
    header?: string;
    align?: ColumnAlign;
    format?: (value: unknown, row: T) => string;
  } = {},
): TableColumn<T> {
  return {
    header: options.header ?? key,
    getValue: (row) => row[key],
    align: options.align,
    format: options.format,
  };
}
