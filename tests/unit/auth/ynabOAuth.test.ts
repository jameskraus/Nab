import { expect, test } from "bun:test";

import { buildAuthorizeUrl } from "@/auth/ynabOAuth";

test("buildAuthorizeUrl includes required params", () => {
  const url = buildAuthorizeUrl({
    clientId: "client123",
    redirectUri: "http://127.0.0.1:53682/oauth/callback",
    scope: "read-only",
    state: "state123",
  });

  const parsed = new URL(url);
  expect(parsed.origin).toBe("https://app.ynab.com");
  expect(parsed.pathname).toBe("/oauth/authorize");
  expect(parsed.searchParams.get("client_id")).toBe("client123");
  expect(parsed.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:53682/oauth/callback");
  expect(parsed.searchParams.get("response_type")).toBe("code");
  expect(parsed.searchParams.get("scope")).toBe("read-only");
  expect(parsed.searchParams.get("state")).toBe("state123");
});
