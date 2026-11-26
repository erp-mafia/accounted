/**
 * Whether a company already has a company mailbox at Kivra, asked before it
 * connects Kivra for receiving. Kivra's company match answers which of the
 * VAT numbers sent are companies with a mailbox; the match is made under the
 * tenant key in KIVRA_MATCH_TENANT_KEY.
 *
 * `unknown` is the answer whenever the question cannot be put or answered
 * (no tenant key, Kivra not carried, no usable organisationsnummer, a sole
 * trader, a failed or slow call), and the callers then show what they showed
 * before the question existed.
 *
 * An answer is kept per company (the shared store when the deployment has
 * one, else this process), so loading the list again does not ask Kivra
 * again, and a company's calls to Kivra are capped per hour on top of that.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { checkRateLimit, getRedis } from '@/lib/auth/rate-limit-http'
import { isLegalPersonOrgNumber } from '@/lib/invariants/org-number'
import { createLogger } from '@/lib/logger'
import { loadCompanyIdentity, type CompanyIdentity } from './connect'
import type { ConnectionSummary } from './connections'
import type { KivraProvider } from './kivra'
import { digitalMailboxAvailability, getDigitalMailboxProviders } from './providers'

const log = createLogger('digital-mailbox-company-match')

export type CompanyMailboxMatch = 'has' | 'none' | 'unknown'

/**
 * How long an answer is kept, in seconds: a mailbox that is there stays
 * there, one that is missing may be created the same afternoon, and a call
 * that failed is not repeated at once.
 */
const KEEP_SECONDS: Record<CompanyMailboxMatch, number> = { has: 6 * 60 * 60, none: 10 * 60, unknown: 5 * 60 }
/** The most calls to Kivra one company can cause in an hour, whatever the kept answers do. */
const MAX_CALLS_PER_HOUR = 12
const KEPT_PREFIX = 'kivra-company-mailbox:'

const keptInProcess = new Map<string, { answer: CompanyMailboxMatch; until: number }>()
const asking = new Map<string, Promise<CompanyMailboxMatch>>()

function isAnswer(value: unknown): value is CompanyMailboxMatch {
  return value === 'has' || value === 'none' || value === 'unknown'
}

/** The answer kept for the company, or null when none is kept or it has run out. */
async function keptAnswer(companyId: string): Promise<CompanyMailboxMatch | null> {
  const kept = keptInProcess.get(companyId)
  if (kept) {
    if (kept.until > Date.now()) return kept.answer
    keptInProcess.delete(companyId)
  }
  const redis = getRedis()
  if (!redis) return null
  try {
    const value = await redis.get<string>(`${KEPT_PREFIX}${companyId}`)
    return isAnswer(value) ? value : null
  } catch (err) {
    log.warn('kept company match answer could not be read', { error: err instanceof Error ? err.message : String(err) })
    return null
  }
}

async function keepAnswer(companyId: string, answer: CompanyMailboxMatch): Promise<void> {
  const seconds = KEEP_SECONDS[answer]
  keptInProcess.set(companyId, { answer, until: Date.now() + seconds * 1000 })
  const redis = getRedis()
  if (!redis) return
  try {
    await redis.set(`${KEPT_PREFIX}${companyId}`, answer, { ex: seconds })
  } catch (err) {
    log.warn('company match answer could not be kept', { error: err instanceof Error ? err.message : String(err) })
  }
}

/**
 * The kept answer, or one call of `ask` whose answer is then kept. Calls for
 * the same company that arrive while one is out share its answer, and a
 * company past its hourly cap gets unknown without a call.
 */
async function keptOrAsked(companyId: string, ask: () => Promise<CompanyMailboxMatch>): Promise<CompanyMailboxMatch> {
  const kept = await keptAnswer(companyId)
  if (kept) return kept
  const running = asking.get(companyId)
  if (running) return running
  const call = (async () => {
    const allowed = await checkRateLimit({ prefix: 'kivra-company-match', identifier: companyId, maxRequests: MAX_CALLS_PER_HOUR, windowMs: 60 * 60 * 1000 })
    const answer = allowed.ok ? await ask() : 'unknown'
    await keepAnswer(companyId, answer)
    return answer
  })().finally(() => asking.delete(companyId))
  asking.set(companyId, call)
  return call
}

/** Forgets every answer kept in this process. For tests. */
export function resetKeptCompanyMailboxAnswers(): void {
  keptInProcess.clear()
  asking.clear()
}

/** The tenant key the company match is made under; null while the setting is unset or empty. */
export function readKivraMatchTenantKey(env: Record<string, string | undefined> = process.env): string | null {
  return env.KIVRA_MATCH_TENANT_KEY?.trim() || null
}

/** One company match for the organisationsnummer: has, none, or unknown when it cannot be asked or answered. */
export async function kivraCompanyMailboxMatch(input: {
  kivra: Pick<KivraProvider, 'sender'> | null
  tenantKey: string | null
  orgNumber: string | null | undefined
}): Promise<CompanyMailboxMatch> {
  const { kivra, tenantKey, orgNumber } = input
  if (!tenantKey || !kivra?.sender) return 'unknown'
  if (!isLegalPersonOrgNumber(orgNumber)) return 'unknown'
  try {
    return (await kivra.sender.hasCompanyMailbox(tenantKey, orgNumber)) ? 'has' : 'none'
  } catch (err) {
    log.warn('kivra company match failed', { error: err instanceof Error ? err.message : String(err) })
    return 'unknown'
  }
}

/**
 * The answer for the active company while it has not connected Kivra for
 * receiving; null when the question is moot (connected, or waiting for the
 * activation) or Kivra is not open to the company, in which case nothing is
 * asked of the provider. At most one provider call per call of this function,
 * and none while an answer for the company is kept.
 */
export async function kivraCompanyMailboxForCompany(
  supabase: SupabaseClient,
  companyId: string,
  connection: Pick<ConnectionSummary, 'receive_state'> | null,
  env: Record<string, string | undefined> = process.env,
): Promise<CompanyMailboxMatch | null> {
  if (connection?.receive_state === 'active' || connection?.receive_state === 'pending') return null
  if (!digitalMailboxAvailability(companyId).kivra.receive) return null
  const tenantKey = readKivraMatchTenantKey(env)
  if (!tenantKey) return 'unknown'
  let identity: CompanyIdentity | null
  try {
    identity = await loadCompanyIdentity(supabase, companyId)
  } catch (err) {
    log.warn('company identity read failed', { error: err instanceof Error ? err.message : String(err) })
    return 'unknown'
  }
  // The demo company never reaches a provider.
  if (!identity || identity.isSandbox) return 'unknown'
  // What can never be asked is answered here, so nothing is kept or counted for it.
  const kivra = getDigitalMailboxProviders().kivra
  const orgNumber = identity.orgNumber
  if (!kivra?.sender || !isLegalPersonOrgNumber(orgNumber)) return 'unknown'
  return keptOrAsked(companyId, () => kivraCompanyMailboxMatch({ kivra, tenantKey, orgNumber }))
}
