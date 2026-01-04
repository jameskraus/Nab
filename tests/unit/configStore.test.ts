import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { expect, test } from "bun:test";

import { ConfigStore } from "@/config/ConfigStore";

test("ConfigStore: load returns empty when file does not exist", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "ynac-config-test-"));
  const store = new ConfigStore(path.join(tmp, "config.json"));

  const cfg = await store.load();
  expect(cfg).toEqual({});
});

test("ConfigStore: save persists values", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "ynac-config-test-"));
  await mkdir(tmp, { recursive: true });

  const filePath = path.join(tmp, "config.json");
  const store = new ConfigStore(filePath);

  await store.save({ token: "abcd1234", budgetId: "budget" });

  const raw = await readFile(filePath, "utf8");
  expect(raw).toContain("abcd1234");
  expect(raw).toContain("budget");

  const cfg = await store.load();
  expect(cfg.token).toBe("abcd1234");
  expect(cfg.budgetId).toBe("budget");
});
