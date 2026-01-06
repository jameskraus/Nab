import { FetchError, ResponseError } from "ynab";

export type YnabErrorInfo = {
  status?: number;
  id?: string;
  name?: string;
  detail?: string;
};

export class YnabApiError extends Error {
  public readonly info: YnabErrorInfo;

  constructor(message: string, info: YnabErrorInfo = {}) {
    super(message);
    this.name = "YnabApiError";
    this.info = info;
  }
}

export class UnauthorizedError extends YnabApiError {
  constructor(info: YnabErrorInfo = {}) {
    super(formatYnabErrorDetails(info) || "YNAB unauthorized", info);
    this.name = "UnauthorizedError";
  }
}

export class NotFoundError extends YnabApiError {
  constructor(info: YnabErrorInfo = {}) {
    super(formatYnabErrorDetails(info) || "YNAB not found", info);
    this.name = "NotFoundError";
  }
}

export class RateLimitedError extends YnabApiError {
  constructor(info: YnabErrorInfo = {}) {
    super(formatYnabErrorDetails(info) || "YNAB rate limited", info);
    this.name = "RateLimitedError";
  }
}

export class NetworkError extends YnabApiError {
  constructor(info: YnabErrorInfo = {}) {
    super(formatYnabErrorDetails(info) || "YNAB network error", info);
    this.name = "NetworkError";
  }
}

export function formatYnabErrorDetails(info: YnabErrorInfo): string {
  const parts: string[] = [];
  if (info.status) parts.push(String(info.status));
  if (info.name) parts.push(info.name);
  if (info.detail) parts.push(info.detail);
  return parts.join(" ").trim();
}

function normalizeStatus(info: YnabErrorInfo): number | undefined {
  if (typeof info.status === "number") return info.status;
  if (info.id) {
    const parsed = Number.parseInt(info.id, 10);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function buildInfo(
  data: { error?: { id?: string; name?: string; detail?: string } } | undefined,
  status?: number,
): YnabErrorInfo {
  return {
    status,
    id: data?.error?.id,
    name: data?.error?.name,
    detail: data?.error?.detail,
  };
}

export async function mapYnabError(err: unknown): Promise<YnabApiError> {
  const response =
    err && typeof err === "object" && "response" in err
      ? ((err as { response?: unknown }).response as Response | undefined)
      : undefined;

  if (err && typeof err === "object" && "error" in err) {
    const info = buildInfo(err as { error?: { id?: string; name?: string; detail?: string } });
    const normalizedStatus = normalizeStatus(info);
    if (normalizedStatus === 401) return new UnauthorizedError(info);
    if (normalizedStatus === 404) return new NotFoundError(info);
    if (normalizedStatus === 429) return new RateLimitedError(info);
    return new YnabApiError(formatYnabErrorDetails(info) || "YNAB API error", info);
  }

  if (err instanceof ResponseError || response instanceof Response) {
    const resolved = response ?? (err as { response: Response }).response;
    const status = resolved.status;
    let info: YnabErrorInfo = { status };

    try {
      const payload = (await resolved.clone().json()) as {
        error?: { id?: string; name?: string; detail?: string };
      };
      info = buildInfo(payload, status);
    } catch {
      // ignore JSON parse errors
    }

    const normalizedStatus = normalizeStatus(info);
    if (normalizedStatus === 401) return new UnauthorizedError(info);
    if (normalizedStatus === 404) return new NotFoundError(info);
    if (normalizedStatus === 429) return new RateLimitedError(info);
    return new YnabApiError(formatYnabErrorDetails(info) || "YNAB API error", info);
  }

  if (err instanceof FetchError) {
    return new NetworkError({ detail: err.message });
  }

  if (err instanceof Error) {
    return new YnabApiError(err.message, {});
  }

  return new YnabApiError(String(err), {});
}
