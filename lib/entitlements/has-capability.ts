import type { SupabaseClient } from '@supabase/supabase-js'
import { NextResponse } from 'next/server'
import { PAID_CAPABILITIES, type CapabilityKey } from './keys'

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

/** Self-hosted deployments are all-on: the gate never withholds anything. */
function isSelfHosted(): boolean {
  return process.env.NEXT_PUBLIC_SELF_HOSTED === 'true'
}

/**
 * Local development is all-on so every gated feature is testable without a
 * subscription. Two triggers, both fail-safe for prod:
 *   - NODE_ENV === 'development' (i.e. `npm run dev`). NOT 'test': the
 *     entitlement suite must still exercise the real gate, and NOT
 *     'production'.
 *   - DISABLE_PAYWALL === 'true': explicit escape hatch for a local
 *     production build. Never set this in a hosted environment.
 */
function isPaywallBypassed(): boolean {
  // Self-hosted is genuinely all-on: never gate it.
  if (isSelfHosted()) return true
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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/**
 * Only server-resolved UUIDs may be interpolated into the PostgREST `.or()`
 * filter below: commas/dots/parens are filter syntax. companyId/teamId always
 * come from the DB, but we validate at this boundary as defense in depth.
 */
function isUuid(v: string): boolean {
  return UUID_RE.test(v)
}

export async function hasCapability(
  supabase: SupabaseClient,
  companyId: string,
  key: CapabilityKey,
): Promise<boolean> {
  if (isPaywallBypassed()) return true
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
  const { data: grants, error: grantsError } = await supabase
    .from('capability_grants')
    .select('expires_at')
    .eq('capability_key', key)
    .or(scopeFilter)

  if (grantsError) return false // fail-closed on any read error
  const now = Date.now()
  const entitled = (grants ?? []).some((g) => {
    const exp = (g as { expires_at: string | null }).expires_at
    return exp === null || new Date(exp).getTime() > now
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
 * Standard bilingual 403 for a capability-blocked endpoint. Matches the
 * sandbox/guard envelope so the UI surfaces the upsell consistently.
 */
export function capabilityBlockedResponse(key: CapabilityKey): NextResponse {
  return NextResponse.json(
    {
      error: CAPABILITY_BLOCKED_MESSAGE_SV,
      error_en: CAPABILITY_BLOCKED_MESSAGE_EN,
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
    message_sv: CAPABILITY_BLOCKED_MESSAGE_SV,
    message_en: CAPABILITY_BLOCKED_MESSAGE_EN,
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

export interface CompanyEntitlements {
  capabilities: CapabilityKey[]
  /**
   * Expiry of the company's trial, present only while the trial is the SOLE
   * source of paid access: null once any non-trial grant (stripe/comp/team)
   * is active, and null after the trial has lapsed. Drives the trial
   * countdown touchpoint in the dashboard chrome.
   */
  trialEndsAt: string | null
}

/**
 * Resolve which PAID capabilities a company currently holds (entitled AND
 * enabled) plus its trial state, in two queries. Used to seed the client
 * CompanyContext so the UI can hide/disable/upsell gated features.
 * Self-hosted holds everything.
 */
export async function getCompanyEntitlements(
  supabase: SupabaseClient,
  companyId: string,
): Promise<CompanyEntitlements> {
  if (isPaywallBypassed()) return { capabilities: [...PAID_CAPABILITIES], trialEndsAt: null }
  if (!isUuid(companyId)) return { capabilities: [], trialEndsAt: null } // fail-closed: never interpolate a non-UUID

  // The disabled-config subtraction only needs companyId, so it runs in
  // parallel with the team lookup — this function sits on the dashboard
  // layout's critical path, where each serialized round-trip is latency.
  const [{ data: company }, { data: configs }] = await Promise.all([
    supabase.from('companies').select('team_id').eq('id', companyId).maybeSingle(),
    supabase
      .from('company_capability_config')
      .select('capability_key, enabled')
      .eq('company_id', companyId)
      .eq('enabled', false),
  ])
  const rawTeamId = (company as { team_id: string | null } | null)?.team_id ?? null
  const teamId = rawTeamId && isUuid(rawTeamId) ? rawTeamId : null

  const scopeFilter = teamId
    ? `company_id.eq.${companyId},team_id.eq.${teamId}`
    : `company_id.eq.${companyId}`
  const { data: grants } = await supabase
    .from('capability_grants')
    .select('capability_key, expires_at, source')
    .in('capability_key', PAID_CAPABILITIES as unknown as string[])
    .or(scopeFilter)

  const now = Date.now()
  const entitled = new Set<string>()
  let trialEndsAt: string | null = null
  let hasActiveNonTrialGrant = false
  for (const g of grants ?? []) {
    const row = g as { capability_key: string; expires_at: string | null; source: string | null }
    const active = row.expires_at === null || new Date(row.expires_at).getTime() > now
    if (!active) continue
    entitled.add(row.capability_key)
    if (row.source === 'trial') {
      // Latest trial expiry (ISO strings from the same column compare lexically).
      if (row.expires_at && (!trialEndsAt || row.expires_at > trialEndsAt)) {
        trialEndsAt = row.expires_at
      }
    } else {
      hasActiveNonTrialGrant = true
    }
  }
  // Paying/comped companies are not "on trial" even if the seeded trial rows
  // haven't expired yet: the countdown would nag someone who already converted.
  if (hasActiveNonTrialGrant) trialEndsAt = null
  if (entitled.size === 0) return { capabilities: [], trialEndsAt: null }

  // Subtract any explicitly-disabled (enablement axis).
  for (const c of configs ?? []) {
    entitled.delete((c as { capability_key: string }).capability_key)
  }

  return { capabilities: PAID_CAPABILITIES.filter((k) => entitled.has(k)), trialEndsAt }
}

/** Capability list only; see getCompanyEntitlements for the full shape. */
export async function getCompanyCapabilities(
  supabase: SupabaseClient,
  companyId: string,
): Promise<CapabilityKey[]> {
  return (await getCompanyEntitlements(supabase, companyId)).capabilities
}
