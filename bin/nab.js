#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const platform = process.platform;
const arch = process.arch;

const target = `${platform}-${arch}`;
const binaryName = platform === "win32" ? `nab-${target}.exe` : `nab-${target}`;
const binaryPath = join(__dirname, "..", "dist", binaryName);

if (!existsSync(binaryPath)) {
  const supported = ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64", "win32-x64"];
  const buildScript = {
    "darwin-arm64": "build:dist:darwin-arm64",
    "darwin-x64": "build:dist:darwin-x64",
    "linux-x64": "build:dist:linux-x64",
    "linux-arm64": "build:dist:linux-arm64",
    "win32-x64": "build:dist:win32-x64",
  }[target];
  const message = [
    "nab: no prebuilt binary found for this platform.",
    `Detected: ${target}`,
    `Expected: dist/nab-${target}${platform === "win32" ? ".exe" : ""}`,
    `Supported targets: ${supported.join(", ")}`,
    "",
    "If you are running from source, build the binaries with:",
    "  bun run build:dist",
  ];
  if (buildScript) {
    message.push("Or build just this target:", `  bun run ${buildScript}`);
  }
  console.error(message.join("\n"));
  process.exit(1);
}

const child = spawn(binaryPath, process.argv.slice(2), { stdio: "inherit" });
child.on("error", (error) => {
  console.error(`nab: failed to launch ${binaryName}: ${error.message}`);
  process.exit(1);
});
child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
