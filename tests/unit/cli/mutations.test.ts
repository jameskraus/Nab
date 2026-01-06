import { expect, test } from "bun:test";

import { normalizeIds, requireApplyConfirmation } from "@/cli/mutations";

test("normalizeIds trims, dedupes, and drops blanks", () => {
  expect(normalizeIds([" a ", "", "b", "a"])).toEqual(["a", "b"]);
});

test("requireApplyConfirmation allows dry-run without yes", () => {
  expect(() => requireApplyConfirmation(true, false, false)).not.toThrow();
});

test("requireApplyConfirmation requires yes in non-tty", () => {
  expect(() => requireApplyConfirmation(false, false, false)).toThrow();
});

test("requireApplyConfirmation allows yes in non-tty", () => {
  expect(() => requireApplyConfirmation(false, true, false)).not.toThrow();
});
