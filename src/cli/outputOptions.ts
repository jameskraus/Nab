import type { OutputWriterOptions } from "@/io";

export function getOutputWriterOptions(argv: {
  quiet?: boolean;
  noColor?: boolean;
}): OutputWriterOptions {
  return {
    quiet: Boolean(argv.quiet),
    noColor: Boolean(argv.noColor),
  };
}
