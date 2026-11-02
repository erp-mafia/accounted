/**
 * A company's acceptance that use above what a month includes costs money
 * (usage_consents). When a company reaches the included amount of a priced
 * kind, the paid action stops until a person with the admin role accepts
 * the unit price; the acceptance holds, month after month, until someone
 * turns it off. Nothing above the included amount is billed without it.
 *
 * An acceptance covers the price it was given at or lower: a price raised
 * since needs a new acceptance. Agents never accept: the route is a session
 * route for admins only.
 *
 * Imports only the registry, so the payments cap (lib/payments/usage.ts) can
 * read it without a cycle.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { isUsageKind, USAGE_PRICES, type UsageKind } from './kinds'

export interface UsageConsent {
  kind: UsageKind
  unit_price_ore: number
  included: number
  accepted_by: string | null
  accepted_at: string
}

const CONSENT_COLUMNS = 'company_id, kind, unit_price_ore, included, accepted_by, accepted_at'

type ConsentRow = UsageConsent & { company_id: string }

/** The table not there yet (a deploy a moment before its migration): read as no acceptance. */
const MISSING_TABLE_CODES = new Set(['42P01', 'PGRST205'])

function rowsOf(data: unknown): ConsentRow[] {
  return ((data ?? []) as ConsentRow[]).filter((row) => isUsageKind(row.kind))
}

/** The company's open acceptances, by kind. Throws on a failed read. */
export async function readOpenConsents(db: SupabaseClient, companyId: string): Promise<Map<UsageKind, UsageConsent>> {
  const { data, error } = await db.from('usage_consents').select(CONSENT_COLUMNS).eq('company_id', companyId).is('revoked_at', null)
  if (error && MISSING_TABLE_CODES.has((error as { code?: string }).code ?? '')) return new Map()
  if (error) throw new Error(`usage_consents read failed: ${error.message}`)
  return new Map(rowsOf(data).map((row) => [row.kind, row]))
}

/** Open acceptances for many companies (the monthly statements), by company. */
export async function readOpenConsentsByCompany(db: SupabaseClient, companyIds: string[]): Promise<Map<string, Map<UsageKind, UsageConsent>>> {
  const out = new Map<string, Map<UsageKind, UsageConsent>>()
  for (let i = 0; i < companyIds.length; i += 100) {
    const ids = companyIds.slice(i, i + 100)
    const { data, error } = await db.from('usage_consents').select(CONSENT_COLUMNS).in('company_id', ids).is('revoked_at', null)
    if (error) throw new Error(`usage_consents read failed: ${error.message}`)
    for (const row of rowsOf(data)) {
      const byKind = out.get(row.company_id) ?? new Map<UsageKind, UsageConsent>()
      byKind.set(row.kind, row)
      out.set(row.company_id, byKind)
    }
  }
  return out
}

/** Whether an acceptance covers the kind at today's price. */
export function consentCovers(consent: UsageConsent | undefined, kind: UsageKind): boolean {
  const price = USAGE_PRICES[kind].unitPriceOre
  return !!consent && price !== null && price > 0 && consent.unit_price_ore >= price
}

/**
 * Record an admin's acceptance at today's price and included amount. An open
 * acceptance at the same price is kept as it is; one at a lower price is
 * closed and replaced. The caller has checked that the kind is offered.
 */
export async function acceptUsageCharges(
  service: SupabaseClient,
  input: { companyId: string; kind: UsageKind; userId: string; included: number },
): Promise<UsageConsent> {
  const price = USAGE_PRICES[input.kind].unitPriceOre
  if (price === null || price <= 0) throw new Error(`usage kind ${input.kind} has no price to accept`)
  const open = (await readOpenConsents(service, input.companyId)).get(input.kind)
  if (consentCovers(open, input.kind)) return open!
  if (open) await revokeUsageCharges(service, { companyId: input.companyId, kind: input.kind, userId: input.userId })

  const { data, error } = await service
    .from('usage_consents')
    .insert({ company_id: input.companyId, kind: input.kind, unit_price_ore: price, included: input.included, accepted_by: input.userId })
    .select(CONSENT_COLUMNS)
    .single()
  if (error) throw new Error(`usage_consents write failed: ${error.message}`)
  return data as UsageConsent
}

/** Turn the charge off: the kind stops at the included amount again from the next action. */
export async function revokeUsageCharges(service: SupabaseClient, input: { companyId: string; kind: UsageKind; userId: string }): Promise<void> {
  const { error } = await service
    .from('usage_consents')
    .update({ revoked_at: new Date().toISOString(), revoked_by: input.userId })
    .eq('company_id', input.companyId)
    .eq('kind', input.kind)
    .is('revoked_at', null)
  if (error) throw new Error(`usage_consents write failed: ${error.message}`)
}
