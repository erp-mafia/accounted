/**
 * Peppol access follows the company's plan.
 *
 * A company that can be a Peppol participant (an organisationsnummer and a
 * name, never a sole trader's personnummer) and pays gets Peppol the moment
 * it asks: sending, capped at PEPPOL_MONTHLY_SENDS transmissions a calendar
 * month, and receiving when it chose to. A company that does not pay keeps
 * its request, is told that Peppol needs a paid plan, and is switched on by
 * the first run after it starts paying.
 *
 * A company whose plan ends is paused, not removed: its row goes back to
 * `requested` with `disabled_at` stamped, the inbound cron withdraws its
 * receiving id (withdrawRevokedPeppolRegistrations reads any status but
 * `enabled` as revoked), and paying again switches it back on with the cap
 * and receiving choice it had. A row the operators set to `disabled` is never
 * touched.
 *
 * Applied in two places: right after a request (requestPeppolAccessForCompany)
 * and on every inbound cron run, every ten minutes, which catches a plan that
 * starts or ends, an agreement granted by hand, and requests made before the
 * rule existed.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { getCompanyIdsWithCapability } from '@/lib/entitlements/has-capability'
import { CAPABILITY } from '@/lib/entitlements/keys'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import type { PeppolAccessRow } from './peppol-access'
import { preparePeppolParticipant } from './peppol-registration'

/** Transmissions a paying company may send per calendar month (Europe/Stockholm). */
export const PEPPOL_MONTHLY_SENDS = 10

/** `enabled_by` on a row this rule switched on; the daily report finds them by it. */
export const PEPPOL_PLAN_RULE_ACTOR = 'automatic: paid plan'

/**
 * How a request made before the receiving choice had a column carried it: as
 * a marker in the note. Read so those requests get what they asked for.
 */
const LEGACY_RECEIVING_MARKER = '[vill ta emot e-fakturor]'

const IN_CHUNK = 100

/**
 * Which of these companies pay: an unexpired grant that is not the seeded
 * 30-day trial. That is a Stripe subscription (active, past due, or trialing
 * with a card on file), a manual or comp grant, or a byrå agreement on the
 * company's team. Archived companies never count. Every transmission costs
 * Accounted per document, so the trial does not open Peppol, the same way it
 * does not open bank payments (lib/payments/orders/pilot.ts). email_send
 * stands for the plan: every paid source grants it with the other paid keys,
 * and no company switch turns it off.
 */
export async function peppolPaidCompanyIds(
  service: SupabaseClient,
  companyIds: readonly string[],
): Promise<Set<string>> {
  return getCompanyIdsWithCapability(service, companyIds, CAPABILITY.email_send, { excludeTrial: true })
}

/** Whether one company pays, as peppolPaidCompanyIds decides it. */
export async function peppolCompanyPays(service: SupabaseClient, companyId: string): Promise<boolean> {
  return (await peppolPaidCompanyIds(service, [companyId])).has(companyId)
}

export interface PeppolPlanRuleResult {
  enabled: string[]
  paused: string[]
  failed: Array<{ companyId: string; reason: string }>
}

type RuleRow = Pick<PeppolAccessRow, 'company_id' | 'status' | 'max_sends' | 'receive_enabled' | 'request_note' | 'enabled_at'>

const RULE_COLUMNS = 'company_id, status, max_sends, receive_enabled, request_note, enabled_at'

async function readRuleRows(service: SupabaseClient, companyIds?: readonly string[]): Promise<RuleRow[]> {
  if (!companyIds) {
    return fetchAllRows<RuleRow>(({ from, to }) =>
      service
        .from('peppol_access')
        .select(RULE_COLUMNS)
        .in('status', ['requested', 'enabled'])
        .order('company_id', { ascending: true })
        .range(from, to),
    )
  }
  const rows: RuleRow[] = []
  for (let i = 0; i < companyIds.length; i += IN_CHUNK) {
    const { data, error } = await service
      .from('peppol_access')
      .select(RULE_COLUMNS)
      .in('status', ['requested', 'enabled'])
      .in('company_id', companyIds.slice(i, i + IN_CHUNK))
    if (error) throw new Error(`Failed to read Peppol access: ${error.message}`)
    rows.push(...((data ?? []) as RuleRow[]))
  }
  return rows
}

/** The companies that can be a Peppol participant, as the registration itself decides it. */
async function participantCompanyIds(service: SupabaseClient, companyIds: readonly string[]): Promise<Set<string>> {
  const ok = new Set<string>()
  for (let i = 0; i < companyIds.length; i += IN_CHUNK) {
    const { data, error } = await service
      .from('company_settings')
      .select('company_id, org_number, company_name, vat_number, city, country, entity_type, is_sandbox')
      .in('company_id', companyIds.slice(i, i + IN_CHUNK))
    if (error) throw new Error(`Failed to read company settings: ${error.message}`)
    for (const row of (data ?? []) as Array<Parameters<typeof preparePeppolParticipant>[0] & { company_id: string; is_sandbox: boolean | null }>) {
      if (!row.is_sandbox && preparePeppolParticipant(row).ok) ok.add(row.company_id)
    }
  }
  return ok
}

/**
 * A row that was on before (paused, now paying again) keeps the receiving
 * choice it had, an operator's send-only grant included; only a first
 * switch-on reads the legacy marker.
 */
function wantsReceiving(row: RuleRow): boolean {
  if (row.enabled_at !== null) return row.receive_enabled
  return row.receive_enabled || (row.request_note ?? '').includes(LEGACY_RECEIVING_MARKER)
}

/**
 * Apply the rule to these companies' rows, or to every open row when no ids
 * are given. Each write is guarded on the status it read, so an operator's
 * change in between wins. A failed write is reported and the rest go on; the
 * next run tries it again.
 */
export async function applyPeppolPlanRule(args: {
  service: SupabaseClient
  companyIds?: readonly string[]
  now?: Date
}): Promise<PeppolPlanRuleResult> {
  const { service } = args
  const result: PeppolPlanRuleResult = { enabled: [], paused: [], failed: [] }
  const rows = await readRuleRows(service, args.companyIds)
  if (rows.length === 0) return result

  const paid = await peppolPaidCompanyIds(service, rows.map((row) => row.company_id))
  const waiting = rows.filter((row) => row.status === 'requested' && paid.has(row.company_id))
  const lapsed = rows.filter((row) => row.status === 'enabled' && !paid.has(row.company_id))
  const participants = waiting.length > 0
    ? await participantCompanyIds(service, waiting.map((row) => row.company_id))
    : new Set<string>()
  const now = (args.now ?? new Date()).toISOString()

  for (const row of waiting) {
    if (!participants.has(row.company_id)) continue
    // A first switch-on gets the standard cap; a paused company comes back
    // with the cap it had, an operator's unlimited (null) included.
    const firstTime = row.enabled_at === null
    const { data, error } = await service
      .from('peppol_access')
      .update({
        status: 'enabled',
        enabled_at: now,
        enabled_by: PEPPOL_PLAN_RULE_ACTOR,
        disabled_at: null,
        receive_enabled: wantsReceiving(row),
        ...(firstTime ? { max_sends: row.max_sends ?? PEPPOL_MONTHLY_SENDS } : {}),
      })
      .eq('company_id', row.company_id)
      .eq('status', 'requested')
      .select('company_id')
    if (error) result.failed.push({ companyId: row.company_id, reason: error.message })
    else if ((data ?? []).length > 0) result.enabled.push(row.company_id)
  }

  for (const row of lapsed) {
    const { data, error } = await service
      .from('peppol_access')
      .update({ status: 'requested', disabled_at: now })
      .eq('company_id', row.company_id)
      .eq('status', 'enabled')
      .select('company_id')
    if (error) result.failed.push({ companyId: row.company_id, reason: error.message })
    else if ((data ?? []).length > 0) result.paused.push(row.company_id)
  }
  return result
}
