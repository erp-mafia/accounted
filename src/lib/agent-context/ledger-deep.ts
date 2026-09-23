import type { SupabaseClient } from '@supabase/supabase-js'

// Deep, entity-resolved analysis behind the "Vad din agent vet" page. Merges
// counterparties across name variants, mines the booked verifikat for real
// spend, and detects recurrence. Backed by the get_ledger_deep_context RPC
// (full history, deterministic). See migration 20260708130000.

export interface DeepEntity {
  /** Display label (the modal raw variant). */
  name: string
  /** Identity key: normalized counterparty key, or supplier id. */
  key: string
  /** Up to 8 distinct raw labels that merged into this entity. */
  variants: string[]
  /** True count of distinct raw labels merged. */
  variant_count: number
  /** Number of bookings. */
  occurrences: number
  /** Total paid, gross SEK (abs bank amount / invoice total). */
  total_amount: number
  first_seen: string
  last_seen: string
  /** Median gap between distinct booking dates, days. null if < 2 dates. */
  cadence_days: number | null
  dominant_account_number: string | null
  /**
   * Laplace-smoothed consistency (cnt+1)/(total+2), 0..1: sample-size-honest,
   * so a single booking reads 0.67, never 1.0 (migration 20260710090000).
   */
  dominant_account_share: number | null
  /** Raw evidence: bookings on the dominant account. */
  dominant_account_count: number | null
  /** Raw evidence: all counted contra lines for the entity. */
  dominant_account_total: number | null
  dominant_vat?: string | null
  kind: 'counterparty' | 'supplier'
}

export interface DeepLedgerContext {
  counterparty_entities: DeepEntity[]
  supplier_entities: DeepEntity[]
}

interface DeepRow {
  counterparty_entities: Omit<DeepEntity, 'kind'>[]
  supplier_entities: Omit<DeepEntity, 'kind'>[]
}

/**
 * Full-history deep analysis. `fromDate = null` means all history; pass a date
 * to bound the lookback on large tenants (the cache layer is deferred).
 */
export async function buildDeepEntities(
  supabase: SupabaseClient,
  companyId: string,
  fromDate: string | null = null,
): Promise<DeepLedgerContext> {
  const { data, error } = await supabase.rpc('get_ledger_deep_context', {
    p_company_id: companyId,
    p_from_date: fromDate,
  })
  if (error) {
    throw new Error(`ledger deep context failed: ${error.message}`)
  }
  const row = (data ?? { counterparty_entities: [], supplier_entities: [] }) as DeepRow
  return {
    counterparty_entities: (row.counterparty_entities ?? []).map((e) => ({ ...e, kind: 'counterparty' as const })),
    supplier_entities: (row.supplier_entities ?? []).map((e) => ({ ...e, kind: 'supplier' as const })),
  }
}
