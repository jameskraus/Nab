import type { OutputWriter, OutputWriterOptions } from "../outputWriter";

export class IdsWriter implements OutputWriter<string[]> {
  public readonly format = "ids" as const;
  private readonly stdout: NodeJS.WritableStream;

  constructor(options: OutputWriterOptions = {}) {
    this.stdout = options.stdout ?? process.stdout;
  }

  write(ids: string[]): void {
    if (!Array.isArray(ids)) {
      throw new Error("IdsWriter expects an array of strings.");
    }
    const payload = ids.join("\n");
    this.stdout.write(payload ? `${payload}\n` : "");
  }
}
