/**
 * Every failure the interface shows: the service's own code and message, or a
 * code of the client's when the service said nothing (`unknown`, `unreachable`,
 * `timeout`). `retryAfterSeconds` is the service's `retry-after`, when it sent
 * one.
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}
