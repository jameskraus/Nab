const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const BASE = 32n;
const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);

const CHAR_TO_VALUE = new Map<string, number>([...ALPHABET].map((char, index) => [char, index]));

function toSafeBigInt(value: number | bigint): bigint {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error("Value must be a non-negative safe integer.");
    }
    return BigInt(value);
  }

  if (value < 0n) {
    throw new Error("Value must be a non-negative integer.");
  }

  if (value > MAX_SAFE_BIGINT) {
    throw new Error("Value exceeds max safe integer.");
  }

  return value;
}

export function encodeCrockfordBase32(value: number | bigint): string {
  let n = toSafeBigInt(value);
  if (n === 0n) return "0";

  let out = "";
  while (n > 0n) {
    const digit = Number(n % BASE);
    out = ALPHABET[digit] + out;
    n /= BASE;
  }
  return out;
}

export function normalizeRefInput(input: string): string {
  const trimmed = input.trim().toUpperCase();
  if (!trimmed) {
    throw new Error("Ref must not be empty.");
  }

  let normalized = "";
  for (const raw of trimmed) {
    let char = raw;
    if (char === "O") char = "0";
    if (char === "I" || char === "L") char = "1";

    if (!CHAR_TO_VALUE.has(char)) {
      throw new Error(`Invalid ref character: ${raw}`);
    }

    normalized += char;
  }

  return normalized;
}

export function decodeCrockfordBase32(input: string): number {
  const normalized = normalizeRefInput(input);
  let value = 0n;

  for (const char of normalized) {
    const digit = CHAR_TO_VALUE.get(char);
    if (digit === undefined) {
      throw new Error(`Invalid ref character: ${char}`);
    }
    value = value * BASE + BigInt(digit);
  }

  if (value > MAX_SAFE_BIGINT) {
    throw new Error("Ref value exceeds max safe integer.");
  }

  return Number(value);
}
