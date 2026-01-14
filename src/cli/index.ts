#!/usr/bin/env bun

import { createRunLogger } from "@/logging";
import { createCli } from "./root";

const argv = process.argv.slice(2);
const startMs = Date.now();

const { logger, close } = createRunLogger({ argv });

process.on("exit", (code) => {
  logger.info({ event: "run_end", code, durationMs: Date.now() - startMs });
  close();
});

process.on("uncaughtException", (err) => {
  logger.fatal({ event: "uncaught_exception", err });
  close();
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  logger.error({ event: "unhandled_rejection", err: reason });
});

await createCli(argv, { logger }).parseAsync();
