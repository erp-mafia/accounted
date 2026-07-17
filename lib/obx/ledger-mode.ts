/**
 * Deployment ledger mode (ADR 013).
 * hosted = this instance is SoR; hybrid = workshop publishing to hosted; local = installer SoR.
 */

export type OmbraLedgerMode = 'hosted' | 'hybrid' | 'local'

const VALID: ReadonlySet<string> = new Set(['hosted', 'hybrid', 'local'])

/**
 * Resolve OMBRA_LEDGER_MODE with safe defaults:
 * - explicit env wins
 * - self-hosted without hybrid config → local
 * - otherwise → hosted
 */
export function getLedgerMode(
  env: NodeJS.ProcessEnv = process.env,
): OmbraLedgerMode {
  const raw = (env.OMBRA_LEDGER_MODE ?? '').trim().toLowerCase()
  if (VALID.has(raw)) return raw as OmbraLedgerMode

  if (env.NEXT_PUBLIC_SELF_HOSTED === 'true') return 'local'
  return 'hosted'
}

export function isHybridLedgerMode(mode: OmbraLedgerMode = getLedgerMode()): boolean {
  return mode === 'hybrid'
}

export function isHostedLedgerMode(mode: OmbraLedgerMode = getLedgerMode()): boolean {
  return mode === 'hosted'
}

export function isLocalLedgerMode(mode: OmbraLedgerMode = getLedgerMode()): boolean {
  return mode === 'local'
}

/** True when this deployment may publish a year-seal to a hosted SoR. */
export function canPublishToHosted(env: NodeJS.ProcessEnv = process.env): boolean {
  if (getLedgerMode(env) !== 'hybrid') return false
  const url = (env.OMBRA_HOSTED_BOOKS_URL ?? '').trim()
  const key = (env.OMBRA_HOSTED_API_KEY ?? '').trim()
  return url.length > 0 && key.length > 0
}

export function getHostedPublishConfig(env: NodeJS.ProcessEnv = process.env): {
  baseUrl: string
  apiKey: string
  companyId: string | null
} | null {
  if (!canPublishToHosted(env)) return null
  return {
    baseUrl: env.OMBRA_HOSTED_BOOKS_URL!.replace(/\/$/, ''),
    apiKey: env.OMBRA_HOSTED_API_KEY!,
    companyId: (env.OMBRA_HOSTED_COMPANY_ID ?? '').trim() || null,
  }
}
