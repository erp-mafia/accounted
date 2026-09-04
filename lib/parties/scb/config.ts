/**
 * SCB:s allmänna företagsregister, the free API (SokPaVar layout Je).
 *
 * Access is a client certificate SCB issues per user plus its password; both
 * live in env vars only, never in settings or the repository:
 *   SCB_API_CERT_PFX_BASE64   the .pfx SCB mailed, base64-encoded
 *   SCB_API_CERT_PASSWORD     the password SCB mailed separately
 *   SCB_API_BASE_URL          optional override (default: the current API)
 *
 * SCB replaces this API with an API-key one from September 2026 and keeps
 * the current one for a transition period; everything that knows the wire
 * format sits in client.ts so the swap is one file.
 */

export interface ScbConfig {
  baseUrl: string
  pfx: Buffer
  passphrase: string
  timeoutMs: number
}

export const SCB_DEFAULT_BASE_URL = 'https://privateapi.scb.se/nv0101/v1/sokpavar'

/** True when the hosted environment carries SCB credentials: gates the button. */
export function isScbConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.SCB_API_CERT_PFX_BASE64 && env.SCB_API_CERT_PASSWORD)
}

export function scbConfigFromEnv(env: NodeJS.ProcessEnv = process.env): ScbConfig {
  const pfx = env.SCB_API_CERT_PFX_BASE64
  const passphrase = env.SCB_API_CERT_PASSWORD
  if (!pfx || !passphrase) {
    throw new Error('SCB är inte konfigurerat: SCB_API_CERT_PFX_BASE64 och SCB_API_CERT_PASSWORD saknas.')
  }
  return {
    baseUrl: (env.SCB_API_BASE_URL ?? SCB_DEFAULT_BASE_URL).replace(/\/+$/, ''),
    pfx: Buffer.from(pfx, 'base64'),
    passphrase,
    timeoutMs: 20_000,
  }
}
