import { expect, test } from "bun:test";

import { normalizeArgv } from "@/journal/argv";

test("normalizeArgv removes internal keys and undefined values", () => {
  const normalized = normalizeArgv({
    _: ["tx", "memo", "set"],
    $0: "nab",
    appContext: { tokens: ["secret"] },
    id: ["t1"],
    memo: "hello",
    extra: undefined,
  });

  expect(normalized).toEqual({ id: ["t1"], memo: "hello" });
});
