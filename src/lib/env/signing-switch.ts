/**
 * SIGNING_ENABLED: BankID document signing (signing requests, the /signera
 * page and their API and MCP doors). Unset = off.
 *
 * It rolls out per company, like AUTOGIRO_COMPANY_IDS: `1`, `true` or `*`
 * opens it for every company, a comma-separated list of company ids for
 * those only.
 *
 * SIGNING_ARSREDOVISNING_ENABLED is the same for the board's BankID
 * signatures on a locked årsredovisning, on top of SIGNING_ENABLED: it waits
 * for Bolagsverket's answer on the signature form.
 *
 * The switch only opens the doors; signing also needs a BankID provider
 * (lib/signing/bankid-provider.ts), which is hosted-only, and the company's
 * paid capability (lib/signing/requests.ts). What the switch never stops:
 * signing a request already sent, and reading a request or its signed copy
 * and evidence package, which are the company's records once a signature
 * exists.
 */
type Env = Record<string, string | undefined>

export type SigningRollout = 'all' | readonly string[]

function rollout(raw: string | undefined): SigningRollout {
  const value = raw?.trim()
  if (!value) return []
  const lower = value.toLowerCase()
  if (lower === '1' || lower === 'true' || lower === '*') return 'all'
  return [...new Set(lower.split(',').map((s) => s.trim()).filter(Boolean))]
}

function opens(scope: SigningRollout, companyId: string | null | undefined): boolean {
  if (scope === 'all') return true
  return Boolean(companyId) && scope.includes(companyId!.toLowerCase())
}

export function signingRollout(env: Env = process.env): SigningRollout {
  return rollout(env.SIGNING_ENABLED)
}

/** Whether signing is switched on for this company. */
export function signingEnabledFor(companyId: string | null | undefined, env: Env = process.env): boolean {
  return opens(signingRollout(env), companyId)
}

/** Whether the board's BankID signing of the årsredovisning is switched on for this company. */
export function arsredovisningSigningEnabledFor(companyId: string | null | undefined, env: Env = process.env): boolean {
  return signingEnabledFor(companyId, env) && opens(rollout(env.SIGNING_ARSREDOVISNING_ENABLED), companyId)
}
