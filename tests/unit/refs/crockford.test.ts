import { expect, test } from "bun:test";

import { decodeCrockfordBase32, encodeCrockfordBase32, normalizeRefInput } from "@/refs/crockford";

test("encode/decode round-trip", () => {
  const values = [0, 1, 10, 31, 32, 1000, 32767, 32768];
  for (const value of values) {
    const encoded = encodeCrockfordBase32(value);
    expect(decodeCrockfordBase32(encoded)).toBe(value);
  }
});

test("encode uses Crockford alphabet", () => {
  expect(encodeCrockfordBase32(0)).toBe("0");
  expect(encodeCrockfordBase32(1)).toBe("1");
  expect(encodeCrockfordBase32(31)).toBe("Z");
  expect(encodeCrockfordBase32(32)).toBe("10");
});

test("normalizeRefInput accepts O/I/L aliases", () => {
  expect(normalizeRefInput("oIl")).toBe("011");
});

test("decode rejects invalid characters", () => {
  expect(() => decodeCrockfordBase32("*")).toThrow("Invalid ref character");
});

test("encode rejects non-integers", () => {
  expect(() => encodeCrockfordBase32(-1)).toThrow("non-negative");
  expect(() => encodeCrockfordBase32(1.5)).toThrow("safe integer");
});

test("decode rejects overflow", () => {
  expect(() => decodeCrockfordBase32("ZZZZZZZZZZZZZZ")).toThrow("exceeds max safe");
});
