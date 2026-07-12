import { createLogger } from '@/lib/logger'
import { getSystemAuthTransport } from './transport'
import { getSystemScopes, isSystemAuthConfigured } from './config'

const log = createLogger('skatteverket-system-auth')

/**
 * System token cache: ONE token per environment for the whole tenant, never
 * per company (the org certificate identifies Accounted; the company is
 * addressed per request via its org number in the path). CCG has no refresh
 * token: an expired or invalidated token is simply minted again.
 *
 * Errors here are plain SystemAuthUnavailableError, not SkatteverketAuthError:
 * api-client.ts wraps them (avoids a circular import) and maps them to the
 * SYSTEM_AUTH_FAILED code.
 */

const REFRESH_MARGIN_MS = 5 * 60 * 1000

export class SystemAuthUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SystemAuthUnavailableError'
  }
}

let cached: { token: string; expiresAt: number } | null = null
let inFlight: Promise<string> | null = null

export async function getSystemAccessToken(): Promise<string> {
  if (!isSystemAuthConfigured()) {
    throw new SystemAuthUnavailableError(
      'Systemautentiseringen mot Skatteverket är inte konfigurerad i denna miljö.'
    )
  }

  if (cached && cached.expiresAt > Date.now() + REFRESH_MARGIN_MS) {
    return cached.token
  }

  // Coalesce concurrent mints: crons fan out per company and must not
  // hammer the token endpoint with parallel identical requests.
  if (inFlight) return inFlight

  inFlight = (async () => {
    try {
      const result = await getSystemAuthTransport().fetchToken(getSystemScopes())
      cached = { token: result.accessToken, expiresAt: result.expiresAt }
      return result.accessToken
    } catch (err) {
      log.warn('system token minting failed', {
        error: err instanceof Error ? err.message : String(err),
      })
      throw err instanceof SystemAuthUnavailableError
        ? err
        : new SystemAuthUnavailableError(
            err instanceof Error ? err.message : 'Systemtoken kunde inte hämtas.'
          )
    } finally {
      inFlight = null
    }
  })()

  return inFlight
}

/** Drop the cached token (called after a 401 on a system-mode request). */
export function invalidateSystemToken(): void {
  cached = null
}

/** Test hook: reset module state between tests. */
export function __resetSystemTokenCacheForTests(): void {
  cached = null
  inFlight = null
}
