import { createInterface } from "node:readline/promises";

export function isInteractive(): boolean {
  return Boolean(process.stdin.isTTY || process.stdout.isTTY);
}

export async function promptText(question: string): Promise<string> {
  if (!isInteractive()) {
    throw new Error("Cannot prompt in a non-interactive session.");
  }
  const rl = createInterface({
    input: process.stdin,
    output: process.stderr,
  });
  try {
    const answer = await rl.question(question);
    return answer.trim();
  } finally {
    rl.close();
  }
}

export async function promptSecret(prompt: string): Promise<string> {
  if (!isInteractive()) {
    throw new Error("Cannot prompt for secrets in a non-interactive session.");
  }

  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    const stderr = process.stderr;
    let secret = "";

    const cleanup = () => {
      stdin.setRawMode?.(false);
      stdin.pause();
      stdin.off("data", onData);
    };

    const onData = (data: Buffer) => {
      const char = data.toString("utf8");
      if (char === "\r" || char === "\n") {
        stderr.write("\n");
        cleanup();
        resolve(secret);
        return;
      }
      if (char === "\u0003") {
        cleanup();
        reject(new Error("Secret input cancelled."));
        return;
      }
      if (char === "\u007f") {
        secret = secret.slice(0, -1);
        return;
      }
      secret += char;
    };

    stderr.write(prompt);
    stdin.setRawMode?.(true);
    stdin.resume();
    stdin.on("data", onData);
  });
}
