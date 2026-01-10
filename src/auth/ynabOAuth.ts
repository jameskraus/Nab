import { OAuthTokenExchangeError } from "@/app/errors";

export type OAuthScope = "full" | "read-only";

export type OAuthToken = {
  accessToken: string;
  refreshToken: string;
  tokenType?: string;
  expiresAt: string;
};

const AUTHORIZE_URL = "https://app.ynab.com/oauth/authorize";
const TOKEN_URL = "https://app.ynab.com/oauth/token";

type TokenPayload = {
  access_token: string;
  refresh_token: string;
  token_type?: string;
  expires_in: number;
};

function buildExpiresAt(expiresInSeconds: number): string {
  return new Date(Date.now() + expiresInSeconds * 1000).toISOString();
}

function parseTokenPayload(payload: unknown): OAuthToken {
  if (!payload || typeof payload !== "object") {
    throw new OAuthTokenExchangeError("Invalid OAuth token response.");
  }
  const record = payload as Record<string, unknown>;
  const accessToken = record.access_token;
  const refreshToken = record.refresh_token;
  const tokenType = record.token_type;
  const expiresIn = record.expires_in;

  if (typeof accessToken !== "string" || accessToken.trim().length === 0) {
    throw new OAuthTokenExchangeError("OAuth response missing access_token.");
  }
  if (typeof refreshToken !== "string" || refreshToken.trim().length === 0) {
    throw new OAuthTokenExchangeError("OAuth response missing refresh_token.");
  }
  if (typeof expiresIn !== "number" || !Number.isFinite(expiresIn)) {
    throw new OAuthTokenExchangeError("OAuth response missing expires_in.");
  }

  return {
    accessToken,
    refreshToken,
    tokenType: typeof tokenType === "string" ? tokenType : undefined,
    expiresAt: buildExpiresAt(expiresIn),
  };
}

async function readErrorDetail(response: Response): Promise<string | undefined> {
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    try {
      const payload = (await response.clone().json()) as {
        error?: { detail?: string; name?: string };
      };
      const detail = payload?.error?.detail ?? payload?.error?.name;
      if (typeof detail === "string" && detail.trim().length > 0) return detail.trim();
    } catch {
      // ignore JSON parse errors
    }
  }

  try {
    const text = await response.text();
    if (text.trim().length > 0) return text.trim();
  } catch {
    // ignore body parsing errors
  }

  return undefined;
}

export function buildAuthorizeUrl(options: {
  clientId: string;
  redirectUri: string;
  scope?: OAuthScope;
  state?: string;
}): string {
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("client_id", options.clientId);
  url.searchParams.set("redirect_uri", options.redirectUri);
  url.searchParams.set("response_type", "code");
  if (options.scope === "read-only") {
    url.searchParams.set("scope", "read-only");
  }
  if (options.state) {
    url.searchParams.set("state", options.state);
  }
  return url.toString();
}

async function postTokenRequest(body: URLSearchParams): Promise<OAuthToken> {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
  });

  if (!response.ok) {
    const detail = await readErrorDetail(response);
    const message = detail
      ? `OAuth token exchange failed: ${detail}`
      : "OAuth token exchange failed.";
    throw new OAuthTokenExchangeError(`${message} (HTTP ${response.status})`);
  }

  const payload = (await response.json()) as TokenPayload;
  return parseTokenPayload(payload);
}

export async function exchangeCodeForToken(options: {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  code: string;
}): Promise<OAuthToken> {
  const body = new URLSearchParams({
    client_id: options.clientId,
    client_secret: options.clientSecret,
    redirect_uri: options.redirectUri,
    grant_type: "authorization_code",
    code: options.code,
  });
  return postTokenRequest(body);
}

export async function refreshOAuthToken(options: {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}): Promise<OAuthToken> {
  const body = new URLSearchParams({
    client_id: options.clientId,
    client_secret: options.clientSecret,
    grant_type: "refresh_token",
    refresh_token: options.refreshToken,
  });
  return postTokenRequest(body);
}
