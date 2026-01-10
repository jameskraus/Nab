import { OAuthStateMismatchError, OAuthTimeoutError } from "@/app/errors";

export type LoopbackResult = {
  code: string;
  state?: string;
};

export type LoopbackServerHandle = {
  waitForCode: Promise<LoopbackResult>;
  close: () => void;
};

const SUCCESS_HTML = `<!doctype html>
<html>
  <head><meta charset="utf-8" /></head>
  <body>
    <h1>Authentication complete</h1>
    <p>You can close this window and return to the terminal.</p>
  </body>
</html>`;

const ERROR_HTML = `<!doctype html>
<html>
  <head><meta charset="utf-8" /></head>
  <body>
    <h1>Authentication failed</h1>
    <p>Return to the terminal for details.</p>
  </body>
</html>`;

export function startLoopbackAuthServer(options: {
  redirectUri: string;
  expectedState?: string;
  timeoutMs: number;
}): LoopbackServerHandle {
  const url = new URL(options.redirectUri);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Unsupported redirect URI protocol: ${url.protocol}`);
  }

  const hostname = url.hostname;
  const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
  if (!Number.isFinite(port) || port <= 0) {
    throw new Error(`Invalid redirect URI port: ${url.port}`);
  }
  const path = url.pathname || "/";
  let settled = false;
  let resolvePromise: (value: LoopbackResult) => void;
  let rejectPromise: (reason?: Error) => void;

  const waitForCode = new Promise<LoopbackResult>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });

  const server = Bun.serve({
    hostname,
    port,
    fetch: (request) => {
      const requestUrl = new URL(request.url);
      if (requestUrl.pathname !== path) {
        return new Response("Not Found", { status: 404 });
      }

      const error = requestUrl.searchParams.get("error");
      const code = requestUrl.searchParams.get("code");
      const state = requestUrl.searchParams.get("state") ?? undefined;

      if (error) {
        finishReject(new Error(`OAuth error: ${error}`));
        return new Response(ERROR_HTML, {
          status: 400,
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }

      if (!code) {
        finishReject(new Error("Missing OAuth code in redirect."));
        return new Response(ERROR_HTML, {
          status: 400,
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }

      if (options.expectedState && state !== options.expectedState) {
        finishReject(new OAuthStateMismatchError());
        return new Response(ERROR_HTML, {
          status: 400,
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }

      finishResolve({ code, state });
      return new Response(SUCCESS_HTML, {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    },
  });

  const timeout = setTimeout(() => {
    finishReject(new OAuthTimeoutError());
  }, options.timeoutMs);

  function finishResolve(result: LoopbackResult) {
    if (settled) return;
    settled = true;
    clearTimeout(timeout);
    server.stop();
    resolvePromise(result);
  }

  function finishReject(err: Error) {
    if (settled) return;
    settled = true;
    clearTimeout(timeout);
    server.stop();
    rejectPromise(err);
  }

  return {
    waitForCode,
    close: () => finishReject(new Error("OAuth login cancelled.")),
  };
}
