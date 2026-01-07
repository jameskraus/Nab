#!/usr/bin/env bun

import { createCli } from "./root";

await createCli(process.argv.slice(2)).parseAsync();
