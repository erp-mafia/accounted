/**
 * gnubok_vat_close_check names the amount that reaches the skattekonto: ruta
 * 49 as filed, every ruta in whole kronor and 49 their net (buildFiledAmounts),
 * the same figure the momsverifikat books on 2650/1650 (crm#1171).
 *
 * The reported period: ruta 10 1 153,86, ruta 30 4 127,38, ruta 48 11 421,34.
 * The öre sum is -6 140,10, but filed it is 1 153 + 4 127 - 11 421 = -6 141,
 * and the close check said 6 140,10 while the settlement proposed 6 141.
 *
 * Only the bank reconciliation is mocked (same reason as the completeness
 * suite): an unreconciled bank would add an unrelated blocker.
 */
import { describe, it, expect, vi } from 'vitest'

vi.mock('@/lib/reconciliation/bank-reconciliation', () => ({
  getReconciliationStatus: vi.fn(async () => ({
    is_reconciled: true,
    difference: 0,
    unmatched_transaction_count: 0,
    unmatched_gl_line_count: 0,
  })),
}))

import { computeVatCloseCheck, computeVatReport } from '@/lib/reports/vat-close-check'

const TOTALS = [
  { account_number: '2611', debit: 0, credit: 1153.86 },
  { account_number: '2614', debit: 0, credit: 4127.38 },
  { account_number: '2641', debit: 9579.92, credit: 2285.96 },
  { account_number: '2645', debit: 4127.38, credit: 0 },
  { account_number: '4535', debit: 448.41, credit: 0 },
]

function mockSupabase(settings: Record<string, unknown>) {
  const makeChain = (rows: unknown[]): Record<string, unknown> => {
    const chain: Record<string, unknown> = {}
    const settled = { data: rows, error: null, count: rows.length }
    chain.range = () => settled
    chain.single = async () => ({ data: rows[0] ?? null, error: null })
    chain.maybeSingle = async () => ({ data: rows[0] ?? null, error: null })
    chain.then = (resolve: (v: unknown) => void) => resolve(settled)
    for (const m of [
      'order', 'lte', 'gte', 'neq', 'in', 'eq', 'is', 'select',
      'limit', 'contains', 'filter', 'not', 'or',
    ]) {
      chain[m] = () => chain
    }
    return chain
  }
  return {
    from: (table: string) => (table === 'company_settings' ? makeChain([settings]) : makeChain([])),
    rpc: (fn: string) => {
      if (fn === 'get_vat_declaration_totals') {
        return Promise.resolve({
          data: { totals: TOTALS, settlement_shaped_entries: [], source_type_counts: {} },
          error: null,
        })
      }
      if (fn === 'verifikat_without_documents') {
        return Promise.resolve({ data: { ok: true, total_count: 0, verifikat: [] }, error: null })
      }
      return makeChain([])
    },
  } as never
}

const SETTINGS = { moms_period: 'quarterly', vat_taxable_base_over_40m: false }

describe('gnubok_vat_close_check: net due is ruta 49 as filed', () => {
  it('pays out the whole-krona net of the filed rutor, not the öre sum', async () => {
    const result = await computeVatCloseCheck(
      { period_type: 'quarterly', year: 2026, period: 3 },
      'company-1',
      mockSupabase(SETTINGS),
    )

    // The öre projection stays on the rutor; the payment is what is filed.
    expect(result.rutor.ruta49).toBe(-6140.1)
    expect(result.payment.net_due).toBe(-6141)
    expect(result.payment.direction).toBe('refund')
  })

  it('the VAT report summary names the same filed amount', async () => {
    const report = await computeVatReport(
      { period_type: 'quarterly', year: 2026, period: 3 },
      'company-1',
      mockSupabase(SETTINGS),
    )
    expect(report.summary).toBe('Moms att få tillbaka: 6141 kr')
  })
})
