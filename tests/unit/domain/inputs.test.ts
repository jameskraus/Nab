import { expect, test } from "bun:test";

import {
  parseAmountToMilliunits,
  parseClearedStatus,
  parseDateOnly,
  parseFlagColor,
} from "@/domain/inputs";

test("parseAmountToMilliunits parses positive and negative amounts", () => {
  expect(parseAmountToMilliunits("12")).toBe(12000);
  expect(parseAmountToMilliunits("12.3")).toBe(12300);
  expect(parseAmountToMilliunits("12.345")).toBe(12345);
  expect(parseAmountToMilliunits("-0.5")).toBe(-500);
});

test("parseAmountToMilliunits rejects invalid input", () => {
  expect(() => parseAmountToMilliunits("12.3456")).toThrow();
  expect(() => parseAmountToMilliunits("abc")).toThrow();
});

test("parseDateOnly validates calendar dates", () => {
  expect(parseDateOnly("2026-01-05")).toBe("2026-01-05");
  expect(() => parseDateOnly("2026-13-01")).toThrow();
  expect(() => parseDateOnly("2026-02-30")).toThrow();
});

test("parseClearedStatus validates cleared status", () => {
  expect(parseClearedStatus("cleared")).toBe("cleared");
  expect(() => parseClearedStatus("pending")).toThrow();
});

test("parseFlagColor validates flag colors", () => {
  expect(parseFlagColor("red")).toBe("red");
  expect(() => parseFlagColor("pink")).toThrow();
});
