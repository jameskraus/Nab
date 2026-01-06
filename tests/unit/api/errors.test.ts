import { expect, test } from "bun:test";
import { ResponseError } from "ynab";

import { NotFoundError, RateLimitedError, UnauthorizedError, mapYnabError } from "@/api/errors";

test("mapYnabError maps 401 to UnauthorizedError", async () => {
  const response = new Response(
    JSON.stringify({ error: { id: "401", name: "unauthorized", detail: "Unauthorized" } }),
    { status: 401, headers: { "content-type": "application/json" } },
  );
  const err = new ResponseError(response);

  const mapped = await mapYnabError(err);

  expect(mapped).toBeInstanceOf(UnauthorizedError);
  expect(mapped.info.status).toBe(401);
});

test("mapYnabError maps 404 to NotFoundError", async () => {
  const response = new Response(
    JSON.stringify({ error: { id: "404", name: "not_found", detail: "Not Found" } }),
    { status: 404, headers: { "content-type": "application/json" } },
  );
  const err = new ResponseError(response);

  const mapped = await mapYnabError(err);

  expect(mapped).toBeInstanceOf(NotFoundError);
  expect(mapped.info.status).toBe(404);
});

test("mapYnabError maps 429 to RateLimitedError", async () => {
  const response = new Response(
    JSON.stringify({ error: { id: "429", name: "rate_limited", detail: "Rate limited" } }),
    { status: 429, headers: { "content-type": "application/json" } },
  );
  const err = new ResponseError(response);

  const mapped = await mapYnabError(err);

  expect(mapped).toBeInstanceOf(RateLimitedError);
  expect(mapped.info.status).toBe(429);
});

test("mapYnabError maps plain error payloads to RateLimitedError", async () => {
  const mapped = await mapYnabError({
    error: { id: "429", name: "too_many_requests", detail: "Too many requests" },
  });

  expect(mapped).toBeInstanceOf(RateLimitedError);
  expect(mapped.info.id).toBe("429");
});
