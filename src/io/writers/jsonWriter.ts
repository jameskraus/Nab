import type { OutputWriter, OutputWriterOptions } from "../outputWriter";

export class JsonWriter implements OutputWriter<unknown> {
  public readonly format = "json" as const;
  private readonly stdout: NodeJS.WritableStream;

  constructor(options: OutputWriterOptions = {}) {
    this.stdout = options.stdout ?? process.stdout;
  }

  write(value: unknown): void {
    const payload = `${JSON.stringify(value, null, 2)}\n`;
    this.stdout.write(payload);
  }
}
