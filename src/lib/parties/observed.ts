import type { SupabaseClient } from '@supabase/supabase-js'
import { classifyKey, type PartyLabel } from './classify'

/**
 * Observed parties: counterparts derived from posted vouchers, never stored.
 * Backed by the get_observed_parties RPC (migration 20260902170000), the
 * description-keyed twin of get_ledger_deep_context for companies whose
 * history arrived by SIE import rather than bank feed.
 *
 * Each row is classified by the deterministic pre-classifier so callers can
 * route it: parties go to the register and the resolver, categories to the
 * "utan namn i texten" band, payroll and adjustments nowhere.
 */
export interface ObservedPartyRow {
  key: string
  name: string
  variants: string[]
  variant_count: number
  occurrences: number
  expense_sek: number
  revenue_sek: number
  first_seen: string
  last_seen: string
  cadence_days: number | null
  dominant_account_number: string | null
  dominant_account_share: number | null
  dominant_account_count: number | null
  dominant_account_total: number | null
}

export interface ObservedParty extends ObservedPartyRow {
  label: PartyLabel
  /** Rough rhythm bucket derived from the median gap, for display. */
  rhythm: 'weekly' | 'monthly' | 'quarterly' | 'yearly' | 'irregular' | null
}

export function rhythmFromCadence(cadenceDays: number | null): ObservedParty['rhythm'] {
  if (cadenceDays === null) return null
  if (cadenceDays >= 5 && cadenceDays <= 9) return 'weekly'
  if (cadenceDays >= 25 && cadenceDays <= 35) return 'monthly'
  if (cadenceDays >= 80 && cadenceDays <= 100) return 'quarterly'
  if (cadenceDays >= 340 && cadenceDays <= 390) return 'yearly'
  return 'irregular'
}

export async function getObservedParties(
  supabase: SupabaseClient,
  companyId: string,
  options: { fromDate?: string | null; limit?: number; labels?: PartyLabel[] } = {},
): Promise<ObservedParty[]> {
  const { data, error } = await supabase.rpc('get_observed_parties', {
    p_company_id: companyId,
    p_from_date: options.fromDate ?? null,
    p_limit: options.limit ?? 200,
  })
  if (error) throw new Error(`get_observed_parties failed: ${error.message}`)
  const rows = (Array.isArray(data) ? data : []) as ObservedPartyRow[]
  const wanted = options.labels ? new Set(options.labels) : null
  const out: ObservedParty[] = []
  for (const row of rows) {
    const label = classifyKey({ key: row.key, acct: row.dominant_account_number })
    if (wanted && !wanted.has(label)) continue
    out.push({ ...row, label, rhythm: rhythmFromCadence(row.cadence_days) })
  }
  return out
}
