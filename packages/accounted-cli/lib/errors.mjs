/**
 * Error classes, one per exit code. The CLI's contract with agents is the
 * exit code, so every failure is thrown as one of these and mapped in one
 * place (cli.mjs).
 */

export const EXIT = {
  OK: 0,
  TOOL_ERROR: 1,
  USAGE: 2,
  AUTH: 3,
  UNAVAILABLE: 4,
}

/** Bad command line, bad arguments, bad configuration. Exit 2. */
export class UsageError extends Error {}

/** Not signed in, sign-in rejected or ended. Exit 3. */
export class AuthError extends Error {}

/** Network failure, server error, rate limit, or an unexpected answer. Exit 4. */
export class UnavailableError extends Error {
  /** @param {string} message @param {{ retryAfterSeconds?: number }} [extra] */
  constructor(message, extra = {}) {
    super(message)
    this.retryAfterSeconds = extra.retryAfterSeconds
  }
}
