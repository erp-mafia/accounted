/**
 * The charge for use above what a month includes, open for one company
 * (usage_consents). When a company reaches the included amount of a priced
 * kind, the paid action stops; the company asks for more (requests.ts) and an
 * operator opens the charge by writing the company's row at today's price and
 * included amount. It holds, month after month, until an operator closes it
 * (revoked_at). Nothing above the included amount is billed without it.
 *
 *   insert into usage_consents (company_id, kind, unit_price_ore, included, accepted_by)
 *   values ('<company>', '<kind>', <price in öre>, <included>, '<operator user id>');
 *
 * An open row covers the price it was given at or lower: a price raised
 * since needs a new row. No route writes it: neither the company nor an
 * agent opens a charge itself.
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
