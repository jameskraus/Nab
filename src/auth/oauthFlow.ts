import { randomBytes } from "node:crypto";

import { startLoopbackAuthServer } from "./loopbackServer";
import { openBrowser } from "./openBrowser";
import {
  type OAuthScope,
  type OAuthToken,
  buildAuthorizeUrl,
  exchangeCodeForToken,
} from "./ynabOAuth";

export type OAuthLoginOptions = {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  scope?: OAuthScope;
  timeoutMs?: number;
  open?: boolean;
  state?: string;
  onAuthorizeUrl?: (url: string) => void;
};

function buildState(): string {
  return randomBytes(32).toString("base64url");
}

export async function runOAuthLogin(options: OAuthLoginOptions): Promise<OAuthToken> {
  const state = options.state ?? buildState();
  const timeoutMs = options.timeoutMs ?? 180_000;

  const server = startLoopbackAuthServer({
    redirectUri: options.redirectUri,
    expectedState: state,
    timeoutMs,
  });

  const authorizeUrl = buildAuthorizeUrl({
    clientId: options.clientId,
    redirectUri: options.redirectUri,
    scope: options.scope,
    state,
  });

  options.onAuthorizeUrl?.(authorizeUrl);

  if (options.open !== false) {
    openBrowser(authorizeUrl).catch(() => {
      // Best effort only; URL is always printed by the caller.
    });
  }

  const { code } = await server.waitForCode;
  return exchangeCodeForToken({
    clientId: options.clientId,
    clientSecret: options.clientSecret,
    redirectUri: options.redirectUri,
    code,
  });
}
