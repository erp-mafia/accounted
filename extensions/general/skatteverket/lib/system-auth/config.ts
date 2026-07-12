import crypto from 'crypto'

/**
 * Configuration for the system (organization certificate) auth flow.
 *
 * Unlike the personal BankID flow, the system flow authenticates Accounted
 * itself with an organisationscertifikat via the OAuth2 Client Credentials
 * Grant: one token for the whole tenant, no per-user session, no 65-minute
 * refresh treadmill. Companies authorize it once by granting Accounted's org
 * number a behorighet ("Juridiskt lasombud", "Momsdeklaration, ombud") in
 * Skatteverket's Ombud och behorigheter e-service.
 *
 * The exact token-endpoint mechanics (mTLS vs private_key_jwt, scope names)
 * are pending Skatteverket's CCG documentation: everything here is behind
 * SKATTEVERKET_SYSTEM_AUTH_MODE (default 'off') and the transport seam in
 * transport.ts, so the mechanism can be finalized without touching callers.
 *
 * Modes:
 *   off    : system auth never used (default; behavior identical to before)
 *   shadow : crons log whether a verified grant exists but keep using user
 *            tokens (rollout confidence signal, zero behavior change)
 *   on     : background reads prefer system credentials for companies with a
 *            verified grant; user tokens remain the fallback
 */

export type SystemAuthMode = 'off' | 'shadow' | 'on'
export type SystemAuthMechanism = 'mtls' | 'private_key_jwt' | 'stub'

export function getSystemAuthMode(): SystemAuthMode {
  const raw = (process.env.SKATTEVERKET_SYSTEM_AUTH_MODE ?? 'off').toLowerCase()
  return raw === 'on' || raw === 'shadow' ? raw : 'off'
}

export function getSystemAuthMechanism(): SystemAuthMechanism {
  const raw = (process.env.SKATTEVERKET_SYSTEM_AUTH_MECHANISM ?? '').toLowerCase()
  if (raw === 'mtls' || raw === 'private_key_jwt' || raw === 'stub') return raw
  return 'mtls'
}

export function getSystemTokenUrl(): string | null {
  return process.env.SKATTEVERKET_SYSTEM_OAUTH_TOKEN_URL ?? null
}

export function getSystemClientId(): string | null {
  return process.env.SKATTEVERKET_SYSTEM_CLIENT_ID ?? null
}

/**
 * Default scopes for the system token. The real scope names for the org
 * flow are pending SKV docs; override via env when they land.
 */
export function getSystemScopes(): string[] {
  const raw = process.env.SKATTEVERKET_SYSTEM_SCOPES ?? 'skattekonto agd:lasa momsdeklaration'
  return raw.split(/\s+/).filter(Boolean)
}

/** Accounted's own org number: what the end company grants behorighet to. */
export function getOmbudOrgNumber(): string | null {
  return process.env.SKATTEVERKET_OMBUD_ORG_NUMBER ?? null
}

/**
 * PEM material arrives base64-wrapped: env var UIs (Vercel included) mangle
 * raw newlines, so the PEM is base64-encoded once more for transport.
 */
function decodePemEnv(name: string): string | null {
  const raw = process.env[name]
  if (!raw) return null
  try {
    const decoded = Buffer.from(raw, 'base64').toString('utf8')
    return decoded.includes('-----BEGIN') ? decoded : null
  } catch {
    return null
  }
}

export function getSystemCertPem(): string | null {
  return decodePemEnv('SKATTEVERKET_SYSTEM_CERT_PEM_B64')
}

export function getSystemKeyPem(): string | null {
  return decodePemEnv('SKATTEVERKET_SYSTEM_KEY_PEM_B64')
}

export function getSystemKeyPassphrase(): string | null {
  return process.env.SKATTEVERKET_SYSTEM_KEY_PASSPHRASE ?? null
}

export function getSystemCaPem(): string | null {
  return decodePemEnv('SKATTEVERKET_SYSTEM_CA_PEM_B64')
}

/**
 * True when enough configuration exists for the system flow to mint tokens.
 * The stub mechanism needs no certificate (tests and local development).
 */
export function isSystemAuthConfigured(): boolean {
  if (getSystemAuthMode() === 'off') return false
  if (getSystemAuthMechanism() === 'stub') return true
  return Boolean(getSystemTokenUrl() && getSystemCertPem() && getSystemKeyPem())
}

export interface SystemCertInfo {
  subject: string
  notAfter: string
  daysUntilExpiry: number
  expiresSoon: boolean
}

const CERT_EXPIRY_WARNING_DAYS = 30

/**
 * Parse the configured certificate for expiry surfacing in the status
 * endpoint. Returns null when no certificate is configured or it cannot be
 * parsed (a parse failure will surface at token minting anyway).
 */
export function getSystemCertInfo(): SystemCertInfo | null {
  const pem = getSystemCertPem()
  if (!pem) return null
  try {
    const cert = new crypto.X509Certificate(pem)
    const notAfterMs = new Date(cert.validTo).getTime()
    const daysUntilExpiry = Math.floor((notAfterMs - Date.now()) / (24 * 60 * 60 * 1000))
    return {
      subject: cert.subject,
      notAfter: new Date(notAfterMs).toISOString(),
      daysUntilExpiry,
      expiresSoon: daysUntilExpiry <= CERT_EXPIRY_WARNING_DAYS,
    }
  } catch {
    return null
  }
}
