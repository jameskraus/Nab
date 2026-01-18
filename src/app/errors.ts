export class MissingTokenError extends Error {
  constructor() {
    super(
      "Missing auth. Use `nab auth oauth login` or `nab auth token add <PAT>` (or set NAB_TOKENS). Create tokens at https://app.ynab.com/settings/developer.",
    );
    this.name = "MissingTokenError";
  }
}

export class MissingBudgetIdError extends Error {
  constructor() {
    super(
      "Missing NAB_BUDGET_ID. Set it via `nab budget set-default --id <ID>`, the NAB_BUDGET_ID environment variable, or --budget-id.",
    );
    this.name = "MissingBudgetIdError";
  }
}

export class MissingOAuthTokenError extends Error {
  constructor() {
    super("Missing OAuth token. Run `nab auth oauth login`.");
    this.name = "MissingOAuthTokenError";
  }
}

export class MissingOAuthClientIdError extends Error {
  constructor() {
    super(
      "Missing OAuth client id. Set NAB_OAUTH_CLIENT_ID or run `nab auth oauth configure --client-id <ID>`.",
    );
    this.name = "MissingOAuthClientIdError";
  }
}

export class MissingOAuthClientSecretError extends Error {
  constructor() {
    super(
      "Missing OAuth client secret. Set NAB_OAUTH_CLIENT_SECRET or run `nab auth oauth configure --store-secret`.",
    );
    this.name = "MissingOAuthClientSecretError";
  }
}

export class MissingOAuthRefreshTokenError extends Error {
  constructor() {
    super("Missing OAuth refresh token. Run `nab auth oauth login` again.");
    this.name = "MissingOAuthRefreshTokenError";
  }
}

export class OAuthStateMismatchError extends Error {
  constructor() {
    super("OAuth state mismatch. Please retry the login flow.");
    this.name = "OAuthStateMismatchError";
  }
}

export class OAuthTimeoutError extends Error {
  constructor() {
    super("OAuth login timed out waiting for the redirect.");
    this.name = "OAuthTimeoutError";
  }
}

export class OAuthTokenExchangeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OAuthTokenExchangeError";
  }
}
