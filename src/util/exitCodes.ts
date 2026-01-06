// Exit codes follow common CLI conventions.
// Keep within 0..255.

import {
  NetworkError,
  NotFoundError,
  RateLimitedError,
  UnauthorizedError,
  YnabApiError,
} from "@/api/errors";

export enum ExitCode {
  Success = 0,
  Failure = 1,
}

export function exitCodeForError(err: unknown): ExitCode {
  if (
    err instanceof UnauthorizedError ||
    err instanceof NotFoundError ||
    err instanceof RateLimitedError ||
    err instanceof NetworkError ||
    err instanceof YnabApiError
  ) {
    return ExitCode.Failure;
  }
  return ExitCode.Failure;
}
