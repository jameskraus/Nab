import type { OutputFormat } from "./outputFormat";
import { TableWriter } from "./table/tableWriter";
import { IdsWriter } from "./writers/idsWriter";
import { JsonWriter } from "./writers/jsonWriter";
import { TsvWriter } from "./writers/tsvWriter";

export interface OutputWriter<T = unknown> {
  format: OutputFormat;
  write(value: T): void;
}

export type OutputWriterOptions = {
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
};

export type OutputWriterFactory = (options?: OutputWriterOptions) => OutputWriter;

class UnimplementedOutputWriter implements OutputWriter {
  constructor(public readonly format: OutputFormat) {}

  write(): void {
    throw new Error(`Output writer for format "${this.format}" is not implemented yet.`);
  }
}

const defaultFactories: Record<OutputFormat, OutputWriterFactory> = {
  table: (options) => new TableWriter(options),
  json: (options) => new JsonWriter(options),
  tsv: (options) => new TsvWriter(options),
  ids: (options) => new IdsWriter(options),
};

export function createOutputWriter(
  format: OutputFormat,
  options?: OutputWriterOptions,
  factories: Partial<Record<OutputFormat, OutputWriterFactory>> = {},
): OutputWriter {
  const factory = factories[format] ?? defaultFactories[format];
  return factory(options);
}
