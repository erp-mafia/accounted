import type { SkatteverketAuthError } from './api-client'

export interface StructuredSkvError {
  code: string
  httpStatus: number
}

/**
 * Map a SkatteverketAuthError.code to the structured error code + HTTP status
 * used across the MCP surface (registry: lib/errors/structured-errors.ts).
 *
 * Shared by the commit-side services (extensions/general/skatteverket/index.ts)
 * and the MCP tools (extensions/general/mcp-server/server.ts) so connection
 * failures surface one consistent reconnect remediation everywhere.
 *
 * Every auth code is recoverable in the commit sense (the op is fine, the
 * connection/scope/quota isn't), so callers reconnect (or wait) and retry the
 * same operation. The three buckets collapse the nine raw SKV codes onto the
 * remediation that actually differs: reconnect with BankID, fix authorisation
 * at SKV, or back off.
 */
export function skvAuthCodeToStructured(
  code: SkatteverketAuthError['code'],
): StructuredSkvError {
  switch (code) {
    case 'NOT_CONNECTED':
    case 'SESSION_EXPIRED':
    case 'REFRESH_EXHAUSTED':
    case 'TOKEN_REVOKED':
    case 'TOKEN_CORRUPTED':
    case 'MISSING_SCOPE':
      // All resolved the same way: disconnect + reconnect with BankID to mint a
      // fresh token with the right scope.
      return { code: 'SKATTEVERKET_NOT_CONNECTED', httpStatus: 401 }
    case 'BEHORIGHET_SAKNAS':
    case 'ACCESS_DENIED':
      return { code: 'SKATTEVERKET_ACCESS_DENIED', httpStatus: 403 }
    case 'RATE_LIMITED':
      return { code: 'SKATTEVERKET_RATE_LIMITED', httpStatus: 429 }
  }
}
