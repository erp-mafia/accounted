import { chunk as chunksOf } from '@/lib/utils'
import type { SupabaseClient } from '@supabase/supabase-js'
import { NextResponse } from 'next/server'
import { isSelfHosted } from '@/lib/env/public-flags'
import { CAPABILITY, PAID_CAPABILITIES, isConnectorCapability, type CapabilityKey } from './keys'
import { hasOwnCredentialsFor } from './own-credentials'
import {
  computeMultiUserState,
  type MultiUserAccess,
  type MultiUserGrantRow,
} from './multi-user-state'
import { isUuid } from '@/lib/invariants/uuid'

/**
 * Entitlement gate: the single primitive behind the paywall ("non-payer loses
 * functionality") AND the vision's modularity-out ("hide a module this company
 * doesn't need"). Both are the same question: does this company hold the
 * capability, fail-closed, resolved server-side?
 *
 * Two orthogonal axes, AND-ed together (see migration
 * 20260628140000_capability_grants_and_metered_events):
 *   ENTITLEMENT: an unexpired capability_grant on the company OR its firm/team.
 *   ENABLEMENT : not explicitly disabled in company_capability_config (absent == enabled).
 *
 * Mirrors the shape of lib/sandbox/guard.ts so it drops in at the same call
 * sites. The company is resolved by the CALLER (requireCompanyId for web, the
 * validated API key for MCP): never taken from untrusted input here.
 */

/**
 * Self-hosted deployments are all-on for everything the instance runs itself:
 * the gate never withholds a local feature. The one exception is the
 * CONNECTOR_CAPABILITIES (bank sync, Skatteverket, org lookup, migration):
 * those run on services Accounted operates, so on a self-host they fall
 * through to the normal grant lookup, where the hourly connector sync writes
 * `source = 'connector'` grants from the instance's connector key.
 *
 * Read through lib/env/public-flags: comparing process.env.NEXT_PUBLIC_* in
 * place gets constant-folded out of the Docker build, which is exactly how
 * every self-hosted install ended up running behind this paywall.
 */

/**
 * Local development is all-on so every gated feature is testable without a
 * subscription. Two triggers, both fail-safe for prod:
 *   - NODE_ENV === 'development' (i.e. `npm run dev`). NOT 'test': the
 *     entitlement suite must still exercise the real gate, and NOT
 *     'production'.
 *   - DISABLE_PAYWALL === 'true': explicit escape hatch for a local
 *     production build. Never set this in a hosted environment.
 */
function isDevBypass(): boolean {
  // Escape hatch to exercise the REAL gate in local dev, where the paywall is
  // otherwise all-on so every paid feature is testable without a subscription.
  // Set FORCE_PAYWALL=true to see the paid/non-paid UX (nav hiding, page upsells)
  // exactly as a non-payer would. Fail-safe: it can only make gating stricter, so
  // it is harmless if it ever leaks into a hosted env. Wins over the dev bypass.
  if (process.env.FORCE_PAYWALL === 'true') return false
  return (
    process.env.NODE_ENV === 'development' ||
    process.env.DISABLE_PAYWALL === 'true'
  )
}

/**
 * Whether the gate is bypassed for ONE capability.
 *
 *   hosted          : dev / DISABLE_PAYWALL bypass, FORCE_PAYWALL wins (unchanged).
 *   self-hosted     : local capabilities are always on (FORCE_PAYWALL included:
 *                     an AGPL operator's own instance is never gated on what it
 *                     runs itself); connector capabilities served from the
 *                     instance's OWN credentials count as local (the operator
 *                     runs that upstream themselves; see own-credentials.ts);
 *                     the remaining connector capabilities behave like hosted
 *                     (dev bypass, FORCE_PAYWALL, otherwise the grant lookup).
 */
function isBypassedFor(key: CapabilityKey): boolean {
  if (isSelfHosted() && (!isConnectorCapability(key) || hasOwnCredentialsFor(key))) return true
  return isDevBypass()
}

/**
 * Whether only the connector sync's own grants may unlock a capability.
 *
 * The trial-seed trigger (seed_trial_capability_grants) writes 30-day
 * source = 'trial' rows for bank_sync and skatteverket on EVERY company
 * insert, self-hosts included, and a self-host has no trial: without this
 * predicate a fresh self-host company would hold every connector capability
 * for a month with no connector key. Hosted keeps reading every source.
 */
function connectorGrantsOnly(): boolean {
  return isSelfHosted()
}

/**
 * Whether the gate is bypassed for EVERY capability at once (the bulk
 * entitlement shape). True on hosted dev; on a self-host only under the dev
 * bypass, since connector capabilities otherwise need the grant lookup.
 */
function isPaywallBypassed(): boolean {
  return isDevBypass()
}

// Only server-resolved UUIDs may be interpolated into the PostgREST `.or()`
// filter below: commas/dots/parens are filter syntax. companyId/teamId always
// come from the DB, but we validate with isUuid at this boundary as defense
// in depth.

const CAPABILITY_SCOPE_CHUNK_SIZE = 100


function grantIsActive(expiresAt: string | null, now: number): boolean {
  return expiresAt === null || new Date(expiresAt).getTime() > now
}

/**
 * Resolve a cron or batch work list before applying its processing limit.
 *
 * This is the bulk counterpart to hasCapability(): company grants and firm
 * grants both cascade, expired grants do not, and an explicit company-level
 * disable wins. Queries are chunked to keep PostgREST URLs bounded. Any query
 * failure throws so background jobs report a failed run instead of silently
 * treating every paying company as ineligible.
 */
export async function getCompanyIdsWithCapability(
  supabase: SupabaseClient,
  companyIds: readonly string[],
  key: CapabilityKey,
): Promise<Set<string>> {
  const validCompanyIds = [...new Set(companyIds.filter(isUuid))]
  if (validCompanyIds.length === 0) return new Set()
  if (isBypassedFor(key)) return new Set(validCompanyIds)

  type CompanyScope = { id: string; team_id: string | null }
  type GrantScope = {
    company_id: string | null
    team_id: string | null
    expires_at: string | null
  }
  type DisabledConfig = { company_id: string }

  const companies: CompanyScope[] = []
  const disabledConfigs: DisabledConfig[] = []

  for (const chunk of chunksOf(validCompanyIds, CAPABILITY_SCOPE_CHUNK_SIZE)) {
    const [{ data: companyRows, error: companiesError }, { data: configRows, error: configError }] =
      await Promise.all([
        supabase.from('companies').select('id, team_id').in('id', chunk),
        supabase
          .from('company_capability_config')
          .select('company_id')
          .eq('capability_key', key)
          .eq('enabled', false)
          .in('company_id', chunk),
      ])

    if (companiesError) throw new Error(`Failed to resolve capability company scopes: ${companiesError.message}`)
    if (configError) throw new Error(`Failed to resolve capability config: ${configError.message}`)
    companies.push(...((companyRows ?? []) as CompanyScope[]))
    disabledConfigs.push(...((configRows ?? []) as DisabledConfig[]))
  }

  const teamIds = [...new Set(companies.map(company => company.team_id).filter((id): id is string => !!id))]
  const grants: GrantScope[] = []
  const onlyConnectorGrants = connectorGrantsOnly()

  for (const chunk of chunksOf(validCompanyIds, CAPABILITY_SCOPE_CHUNK_SIZE)) {
    let companyGrantsQuery = supabase
      .from('capability_grants')
      .select('company_id, team_id, expires_at')
      .eq('capability_key', key)
      .in('company_id', chunk)
    if (onlyConnectorGrants) companyGrantsQuery = companyGrantsQuery.eq('source', 'connector')
    const { data, error } = await companyGrantsQuery
    if (error) throw new Error(`Failed to resolve company capability grants: ${error.message}`)
    grants.push(...((data ?? []) as GrantScope[]))
  }

  for (const chunk of chunksOf(teamIds, CAPABILITY_SCOPE_CHUNK_SIZE)) {
    let firmGrantsQuery = supabase
      .from('capability_grants')
      .select('company_id, team_id, expires_at')
      .eq('capability_key', key)
      .in('team_id', chunk)
    if (onlyConnectorGrants) firmGrantsQuery = firmGrantsQuery.eq('source', 'connector')
    const { data, error } = await firmGrantsQuery
    if (error) throw new Error(`Failed to resolve firm capability grants: ${error.message}`)
    grants.push(...((data ?? []) as GrantScope[]))
  }

  const now = Date.now()
  const activeCompanyGrants = new Set<string>()
  const activeTeamGrants = new Set<string>()
  for (const grant of grants) {
    if (!grantIsActive(grant.expires_at, now)) continue
    if (grant.company_id) activeCompanyGrants.add(grant.company_id)
    if (grant.team_id) activeTeamGrants.add(grant.team_id)
  }

  const disabledCompanyIds = new Set(disabledConfigs.map(config => config.company_id))
  return new Set(
    companies
      .filter(company =>
        !disabledCompanyIds.has(company.id) &&
        (activeCompanyGrants.has(company.id) ||
          (company.team_id !== null && activeTeamGrants.has(company.team_id))),
      )
      .map(company => company.id),
  )
}

export async function hasCapability(
  supabase: SupabaseClient,
  companyId: string,
  key: CapabilityKey,
): Promise<boolean> {
  if (isBypassedFor(key)) return true
  if (!isUuid(companyId)) return false // fail-closed: never interpolate a non-UUID

  // Resolve the company's firm/team (firm-scoped grants cascade to clients).
  const { data: company } = await supabase
    .from('companies')
    .select('team_id')
    .eq('id', companyId)
    .maybeSingle()
  const rawTeamId = (company as { team_id: string | null } | null)?.team_id ?? null
  const teamId = rawTeamId && isUuid(rawTeamId) ? rawTeamId : null

  // ENTITLEMENT axis: any unexpired grant on the company or its team.
  const scopeFilter = teamId
    ? `company_id.eq.${companyId},team_id.eq.${teamId}`
    : `company_id.eq.${companyId}`
  let grantsQuery = supabase
    .from('capability_grants')
    .select('expires_at')
    .eq('capability_key', key)
    .or(scopeFilter)
  if (connectorGrantsOnly()) grantsQuery = grantsQuery.eq('source', 'connector')
  const { data: grants, error: grantsError } = await grantsQuery

  if (grantsError) return false // fail-closed on any read error
  const now = Date.now()
  const entitled = (grants ?? []).some((g) => {
    const exp = (g as { expires_at: string | null }).expires_at
    return grantIsActive(exp, now)
  })
  if (!entitled) return false

  // ENABLEMENT axis: explicitly turned off for this company? (absence == enabled)
  const { data: config } = await supabase
    .from('company_capability_config')
    .select('enabled')
    .eq('company_id', companyId)
    .eq('capability_key', key)
    .maybeSingle()
  if ((config as { enabled: boolean } | null)?.enabled === false) return false

  return true
}

/** Bilingual paywall copy, shared by every transport (HTTP route, MCP tool, commit executor). */
export const CAPABILITY_BLOCKED_MESSAGE_SV =
  'Den här funktionen kräver en betald prenumeration. Uppgradera för att fortsätta använda externa tjänster.'
export const CAPABILITY_BLOCKED_MESSAGE_EN =
  'This feature requires a paid subscription. Upgrade to keep using external services.'

/**
 * Self-host variant: the remedy there is a connector key (or the instance's
 * own upstream credentials), never a hosted subscription, so the hosted
 * upsell copy would mislead the operator.
 */
export const CAPABILITY_BLOCKED_MESSAGE_SELF_HOSTED_SV =
  'Den här funktionen kräver en connector-nyckel från Accounted (GNUBOK_CONNECTOR_KEY) eller instansens egna API-uppgifter för tjänsten.'
export const CAPABILITY_BLOCKED_MESSAGE_SELF_HOSTED_EN =
  'This feature requires an Accounted connector key (GNUBOK_CONNECTOR_KEY) or the instance\'s own API credentials for the service.'

function blockedMessageSv(): string {
  return isSelfHosted() ? CAPABILITY_BLOCKED_MESSAGE_SELF_HOSTED_SV : CAPABILITY_BLOCKED_MESSAGE_SV
}
function blockedMessageEn(): string {
  return isSelfHosted() ? CAPABILITY_BLOCKED_MESSAGE_SELF_HOSTED_EN : CAPABILITY_BLOCKED_MESSAGE_EN
}

/**
 * Standard bilingual 403 for a capability-blocked endpoint. Matches the
 * sandbox/guard envelope so the UI surfaces the upsell consistently.
 */
export function capabilityBlockedResponse(key: CapabilityKey): NextResponse {
  return NextResponse.json(
    {
      error: blockedMessageSv(),
      error_en: blockedMessageEn(),
      capability_blocked: true,
      capability: key,
    },
    { status: 403 },
  )
}

export interface CapabilityBlockedError {
  code: 'capability_blocked'
  capability_blocked: true
  capability: CapabilityKey
  message_sv: string
  message_en: string
}

/**
 * Transport-free counterpart to capabilityBlockedResponse, for call sites that
 * don't return a NextResponse: the MCP dispatcher (folded into the JSON-RPC
 * `isError` envelope) and the pending-operation commit executor. Same copy and
 * the same `capability_blocked: true` marker so every surface upsells alike.
 */
export function capabilityBlockedError(key: CapabilityKey): CapabilityBlockedError {
  return {
    code: 'capability_blocked',
    capability_blocked: true,
    capability: key,
    message_sv: blockedMessageSv(),
    message_en: blockedMessageEn(),
  }
}

/**
 * Convenience wrapper: check + return the 403 in one call. Returns the
 * NextResponse to return from the route, or null when the company has the
 * capability and the route should proceed.
 *
 *   const blocked = await requireCapability(supabase, companyId, CAPABILITY.ai)
 *   if (blocked) return blocked
 */
export async function requireCapability(
  supabase: SupabaseClient,
  companyId: string,
  key: CapabilityKey,
): Promise<NextResponse | null> {
  if (await hasCapability(supabase, companyId, key)) return null
  return capabilityBlockedResponse(key)
}

/**
 * Where the company sits in the paid lifecycle, derived from the same grant
 * rows that produce `capabilities`:
 *   'paid'                : an active non-trial grant (stripe/comp/manual/team).
 *   'trial'               : the trial is the sole source of paid access.
 *   'lapsed_subscription' : no active grants, but a company_subscriptions row
 *                           in a non-paying status: a churned payer, so copy
 *                           says "abonnemang", not "provperiod".
 *   'trial_expired'       : no active grants, only expired trial rows.
 *   'none'                : no grant rows at all (effectively unreachable on
 *                           hosted: every company is seeded with trial rows).
 */
export type EntitlementState =
  | 'trial'
  | 'trial_expired'
  | 'lapsed_subscription'
  | 'paid'
  | 'none'

export interface CompanyEntitlements {
  capabilities: CapabilityKey[]
  /**
   * Expiry of the company's trial, present only while the trial is the SOLE
   * source of paid access: null once any non-trial grant (stripe/comp/team)
   * is active, and null after the trial has lapsed. Drives the trial
   * countdown touchpoint in the dashboard chrome.
   */
  trialEndsAt: string | null
  entitlementState: EntitlementState
  /**
   * When the lapsed trial ran out (latest trial expires_at), set only while
   * entitlementState is 'trial_expired'. Drives the expired-trial notice.
   */
  trialExpiredAt: string | null
  /**
   * Multi-user access state (entitled / grace / frozen) derived from the same
   * multi_user grant rows, with the end of the 20-day grace window while in
   * grace. Drives the countdown banner and the invite upsell; the server-side
   * dormancy enforcement recomputes it independently (lib/entitlements/
   * multi-user.ts and the resolve_active_company_gated RPC).
   */
  multiUser: MultiUserAccess
}

/** company_subscriptions.status values that count as a live subscription. */
const PAYING_SUBSCRIPTION_STATUSES = ['active', 'trialing', 'past_due']

function normalizeTeamId(raw: string | null | undefined): string | null {
  return raw && isUuid(raw) ? raw : null
}

/**
 * The grants read behind getCompanyEntitlements. `keys` is the paid-key list
 * the caller wants resolved from grants (every paid key on hosted; only the
 * connector keys on a self-host, where the local ones are held outright).
 * On a self-host only the connector sync's own rows count; see
 * connectorGrantsOnly().
 */
function readGrants(
  supabase: SupabaseClient,
  companyId: string,
  teamId: string | null,
  keys: readonly CapabilityKey[],
) {
  const scopeFilter = teamId
    ? `company_id.eq.${companyId},team_id.eq.${teamId}`
    : `company_id.eq.${companyId}`
  let grantsQuery = supabase
    .from('capability_grants')
    .select('capability_key, expires_at, source')
    .in('capability_key', keys as unknown as string[])
    .or(scopeFilter)
  if (connectorGrantsOnly()) grantsQuery = grantsQuery.eq('source', 'connector')
  return grantsQuery
}

export interface GetCompanyEntitlementsOptions {
  /**
   * The company's team_id when the caller already has it (the dashboard
   * layout reads it off the membership join): skips the companies lookup and
   * lets the grants read run in the same wave as the other two, one round
   * trip instead of two on the layout's critical path. Pass null for a
   * company without a team.
   */
  teamId?: string | null
}

/**
 * Resolve which PAID capabilities a company currently holds (entitled AND
 * enabled) plus its trial state, in two queries. Used to seed the client
 * CompanyContext so the UI can hide/disable/upsell gated features.
 * Self-hosted holds every local capability outright; the
 * CONNECTOR_CAPABILITIES are read from `source = 'connector'` grants only
 * (see connectorGrantsOnly()).
 */
export async function getCompanyEntitlements(
  supabase: SupabaseClient,
  companyId: string,
  options: GetCompanyEntitlementsOptions = {},
): Promise<CompanyEntitlements> {
  if (isPaywallBypassed()) {
    return {
      capabilities: [...PAID_CAPABILITIES],
      trialEndsAt: null,
      entitlementState: 'paid',
      trialExpiredAt: null,
      multiUser: { state: 'entitled', graceEndsAt: null },
    }
  }
  // Fail-closed: never interpolate a non-UUID.
  if (!isUuid(companyId)) {
    return {
      capabilities: [],
      trialEndsAt: null,
      entitlementState: 'none',
      trialExpiredAt: null,
      multiUser: { state: 'frozen', graceEndsAt: null },
    }
  }
  // Self-hosted: every local capability is held outright; only the connector
  // capabilities among the paid keys are read from grants (written with
  // `source = 'connector'` by the instance's connector sync). Same query
  // below, narrowed to those keys.
  const selfHosted = isSelfHosted()
  // Own-credentials connector keys count as local: the operator runs that
  // upstream themselves (see own-credentials.ts), so they are held outright
  // and never read from grants.
  const selfHostLocal = (k: CapabilityKey) => !isConnectorCapability(k) || hasOwnCredentialsFor(k)
  const localPaid = selfHosted ? PAID_CAPABILITIES.filter(selfHostLocal) : []
  const queriedKeys = selfHosted ? PAID_CAPABILITIES.filter((k) => !selfHostLocal(k)) : PAID_CAPABILITIES

  // The disabled-config subtraction and the subscription-status read only
  // need companyId, so they run in parallel with the team lookup: this
  // function sits on the dashboard layout's critical path, where each
  // serialized round-trip is latency. The subscription row (members-readable
  // per RLS) distinguishes a churned payer from an expired trial: cancelled
  // subscriptions have their stripe grants deleted, so the grants alone
  // cannot tell the two apart.
  const knownTeam = options.teamId !== undefined
  const [{ data: company }, { data: configs }, { data: subscription }, earlyGrants] = await Promise.all([
    knownTeam
      ? Promise.resolve({ data: { team_id: options.teamId } })
      : supabase.from('companies').select('team_id').eq('id', companyId).maybeSingle(),
    supabase
      .from('company_capability_config')
      .select('capability_key, enabled')
      .eq('company_id', companyId)
      .eq('enabled', false),
    supabase
      .from('company_subscriptions')
      .select('status')
      .eq('company_id', companyId)
      .maybeSingle(),
    // With the team known up front the grants read joins this wave. A
    // self-host serving every connector upstream from its own credentials has
    // nothing to read from grants: skip the query (`in.()` on an empty list
    // is not a valid PostgREST filter).
    knownTeam && queriedKeys.length > 0
      ? readGrants(supabase, companyId, normalizeTeamId(options.teamId), queriedKeys)
      : Promise.resolve(null),
  ])
  const teamId = normalizeTeamId((company as { team_id: string | null } | null)?.team_id ?? null)

  const { data: grants } =
    earlyGrants ??
    (queriedKeys.length > 0
      ? await readGrants(supabase, companyId, teamId, queriedKeys)
      : { data: [] })

  const now = Date.now()
  const entitled = new Set<string>(localPaid)
  // Latest trial expiry across ALL trial rows, expired ones included: this is
  // what tells the UI the trial ENDED (ISO strings from the same column
  // compare lexically).
  let latestTrialExpiry: string | null = null
  let hasActiveNonTrialGrant = false
  let hasActiveConnectorGrant = false
  // multi_user rows feed the derived grace/frozen state below; the rows are
  // already in this read (multi_user is a PAID key), so the state costs no
  // extra query. Self-host never reaches this (multi_user is held outright).
  const multiUserRows: MultiUserGrantRow[] = []
  for (const g of grants ?? []) {
    const row = g as { capability_key: string; expires_at: string | null; source: string | null }
    // Self-host: a trial-seeded (or any non-connector) row never unlocks a
    // connector capability; see connectorGrantsOnly().
    if (selfHosted && row.source !== 'connector') continue
    if (row.capability_key === CAPABILITY.multi_user) {
      multiUserRows.push({ expires_at: row.expires_at })
    }
    if (
      row.source === 'trial' &&
      row.expires_at &&
      (!latestTrialExpiry || row.expires_at > latestTrialExpiry)
    ) {
      latestTrialExpiry = row.expires_at
    }
    const active = row.expires_at === null || new Date(row.expires_at).getTime() > now
    if (!active) continue
    entitled.add(row.capability_key)
    if (row.source !== 'trial') hasActiveNonTrialGrant = true
    if (row.source === 'connector') hasActiveConnectorGrant = true
  }

  if (selfHosted) {
    // No trial on a self-host: 'paid' while a connector grant is active,
    // 'none' otherwise (never the hosted trial copy). Explicit disables still
    // apply.
    for (const c of configs ?? []) {
      entitled.delete((c as { capability_key: string }).capability_key)
    }
    return {
      capabilities: PAID_CAPABILITIES.filter((k) => entitled.has(k)),
      trialEndsAt: null,
      entitlementState: hasActiveConnectorGrant ? 'paid' : 'none',
      trialExpiredAt: null,
      // multi_user is a local capability: a self-host is never seat-gated.
      multiUser: { state: 'entitled', graceEndsAt: null },
    }
  }
  // Paying/comped companies are not "on trial" even if the seeded trial rows
  // haven't expired yet: the countdown would nag someone who already converted.
  const trialIsActive =
    latestTrialExpiry !== null && new Date(latestTrialExpiry).getTime() > now
  const trialEndsAt = !hasActiveNonTrialGrant && trialIsActive ? latestTrialExpiry : null

  const subscriptionStatus = (subscription as { status: string | null } | null)?.status ?? null
  let entitlementState: EntitlementState
  let trialExpiredAt: string | null = null
  if (hasActiveNonTrialGrant) {
    entitlementState = 'paid'
  } else if (trialEndsAt) {
    entitlementState = 'trial'
  } else if (subscriptionStatus && !PAYING_SUBSCRIPTION_STATUSES.includes(subscriptionStatus)) {
    entitlementState = 'lapsed_subscription'
  } else if (latestTrialExpiry) {
    entitlementState = 'trial_expired'
    trialExpiredAt = latestTrialExpiry
  } else {
    entitlementState = 'none'
  }

  const multiUser = computeMultiUserState(multiUserRows, now)

  if (entitled.size === 0) {
    return { capabilities: [], trialEndsAt: null, entitlementState, trialExpiredAt, multiUser }
  }

  // Subtract any explicitly-disabled (enablement axis). multi_user is exempt
  // from the config axis by design (see lib/entitlements/multi-user-state.ts),
  // but it is also never written to company_capability_config, so the plain
  // subtraction stays correct for the capabilities list.
  for (const c of configs ?? []) {
    entitled.delete((c as { capability_key: string }).capability_key)
  }

  return {
    capabilities: PAID_CAPABILITIES.filter((k) => entitled.has(k)),
    trialEndsAt,
    entitlementState,
    trialExpiredAt,
    multiUser,
  }
}
