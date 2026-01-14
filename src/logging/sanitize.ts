const REDACTED = "[REDACTED]";

// YNAB Personal Access Tokens are typically 64 hex chars.
const PAT_TOKEN_RE = /(^|[^0-9a-fA-F])([0-9a-fA-F]{64})(?=[^0-9a-fA-F]|$)/g;

// YNAB OAuth access/refresh tokens are base64url with a fixed length.
// Update the length if real tokens differ.
const OAUTH_TOKEN_RE = /(^|[^A-Za-z0-9_-])([A-Za-z0-9_-]{64})(?=[^A-Za-z0-9_-]|$)/g;

function redactTokenShapes(value: string): string {
  return value.replace(PAT_TOKEN_RE, `$1${REDACTED}`).replace(OAUTH_TOKEN_RE, `$1${REDACTED}`);
}

export function sanitizeArgvForLogs(argv: string[]): string[] {
  return argv.map((arg) => redactTokenShapes(String(arg)));
}

export function sanitizeStringForLogs(value: string): string {
  return redactTokenShapes(value);
}
