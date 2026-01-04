// Exit codes follow common CLI conventions.
// Keep within 0..255.

export enum ExitCode {
  Success = 0,
  Failure = 1,
  Usage = 2,
  Unauthorized = 3,
  NotFound = 4,
  Conflict = 5,
  RateLimited = 6,
  Network = 7,
  Software = 70
}
