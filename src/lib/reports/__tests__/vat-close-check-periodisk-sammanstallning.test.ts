/**
 * gnubok_vat_close_check against the periodisk sammanställning (crm#1362).
 *
 * The reported case: a quarterly filer with one EU service sale in ruta 39
 * that no invoice names a buyer for (a bank-booked sale corrected onto 3308).
 * The PS reported it, yet the close check answered ready_to_close with no
 * finding at all, because it never read the PS. It now reads the PS's own
 * UNATTRIBUTED_EU_SALE findings for the momsperiod, with the PS's severity:
 * ruta 35/38 block, ruta 39 warns.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/reconciliation/bank-reconciliation', () => ({
  getReconciliationStatus: vi.fn(async () => ({
    is_reconciled: true,
    difference: 0,
    unmatched_transaction_count: 0,
    unmatched_gl_line_count: 0,
  })),
}))

const findUnattributedEuSales = vi.hoisted(() => vi.fn())
vi.mock('@/lib/reports/periodisk-sammanstallning', async (orig) => ({
  ...(await orig<typeof import('@/lib/reports/periodisk-sammanstallning')>()),
  findUnattributedEuSales,
}))

import { computeVatCloseCheck, UNATTRIBUTED_EU_SALE_HINT } from '@/lib/reports/vat-close-check'
import type { PsWarning } from '@/lib/reports/periodisk-sammanstallning'

type Totals = Array<{ account_number: string; debit: number; credit: number }>

function mockSupabase(settings: Record<string, unknown>, totals: Totals) {
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
    from: (table: string) => {
      if (table === 'company_settings') return makeChain([settings])
      if (table === 'fiscal_periods') return makeChain([{ period_start: '2025-10-01', period_end: '2026-09-30' }])
      return makeChain([])
    },
    rpc: (fn: string) => {
      if (fn === 'get_vat_declaration_totals') {
        return Promise.resolve({
          data: { totals, settlement_shaped_entries: [], source_type_counts: {} },
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

const QUARTERLY = { moms_period: 'quarterly', vat_taxable_base_over_40m: false, entity_type: 'enskild_firma' }
const Q3 = { period_type: 'quarterly', year: 2026, period: 3 }
const EU_SERVICE_SALE: Totals = [{ account_number: '3308', debit: 0, credit: 1501.71 }]
const EU_GOODS_SALES: Totals = [{ account_number: '3108', debit: 0, credit: 7000 }]

function sale(level: PsWarning['level'], journalEntryId: string, amount: number, message: string): PsWarning {
  return { level, code: 'UNATTRIBUTED_EU_SALE', journalEntryId, amount, message }
}

beforeEach(() => {
  findUnattributedEuSales.mockReset()
})

describe('gnubok_vat_close_check: EU sales the periodisk sammanställning has no buyer for (crm#1362)', () => {
  it('the reported case: a ruta 39 sale without a buyer is a warning, and the summary says so', async () => {
    const message = 'Verifikat A210 (2026-07-22) bokför 1 501,71 kr på konto 3308 (ruta 39) utan någon kundfaktura som anger köparens VAT-nummer, så sammanställningen kan vara ofullständig.'
    findUnattributedEuSales.mockResolvedValue([sale('warning', 'je-a210', 1501.71, message)])
    const supabase = mockSupabase(QUARTERLY, EU_SERVICE_SALE)

    const result = await computeVatCloseCheck(Q3, 'company-1', supabase)

    // Read for exactly the momsperiod the declaration was computed for.
    expect(findUnattributedEuSales).toHaveBeenCalledWith(supabase, 'company-1', '2026-07-01', '2026-09-30')
    const finding = result.blockers.find((b) => b.kind === 'unattributed_eu_sale')
    expect(finding).toEqual({
      kind: 'unattributed_eu_sale',
      severity: 'medium',
      count: 1,
      message,
      hint: UNATTRIBUTED_EU_SALE_HINT,
      eu_sales: [{ journal_entry_id: 'je-a210', amount: 1501.71, message }],
    })
    // A service is owed a PS row only when the buyer has a VAT number and it
    // is taxed in the buyer's country: the close is not stopped...
    expect(result.ready_to_close).toBe(true)
    // ...but "klart" no longer reads as "nothing for the PS".
    expect(result.summary).toContain('Periodisk sammanställning: 1 EU-försäljning i ruta 39 saknar köpare.')
  })

  it('ruta 35/38 sales without a buyer block the close, summed in one finding with every verifikat listed', async () => {
    findUnattributedEuSales.mockResolvedValue([
      sale('error', 'je-a9', 2500, 'Verifikat A9 ...'),
      sale('error', 'je-a10', 4500, 'Verifikat A10 ...'),
    ])

    const result = await computeVatCloseCheck(
      { period_type: 'monthly', year: 2026, period: 9 },
      'company-1',
      mockSupabase({ ...QUARTERLY, moms_period: 'monthly' }, EU_GOODS_SALES),
    )

    const finding = result.blockers.find((b) => b.kind === 'unattributed_eu_sale')
    expect(finding).toMatchObject({ severity: 'high', count: 2 })
    expect(finding?.message).toContain('2 verifikat bokför EU-försäljning av varor eller trepartshandel (ruta 35/38)')
    expect(finding?.message).toMatch(/sammanlagt 7\s000\s*kr/)
    expect(finding?.message).toContain('ska alltid redovisas per köpare')
    expect(finding?.eu_sales?.map((s) => s.journal_entry_id)).toEqual(['je-a9', 'je-a10'])
    expect(result.ready_to_close).toBe(false)
    expect(result.summary).not.toContain('Klart för stängning')
  })

  it('a period with no EU sales in rutor 35/38/39 does not read the PS', async () => {
    const result = await computeVatCloseCheck(
      Q3,
      'company-1',
      mockSupabase(QUARTERLY, [{ account_number: '3001', debit: 0, credit: 1000 }, { account_number: '2611', debit: 0, credit: 250 }]),
    )

    expect(findUnattributedEuSales).not.toHaveBeenCalled()
    expect(result.blockers.find((b) => b.kind === 'unattributed_eu_sale')).toBeUndefined()
  })

  it('every EU sale filed under a buyer: no finding', async () => {
    findUnattributedEuSales.mockResolvedValue([])

    const result = await computeVatCloseCheck(Q3, 'company-1', mockSupabase(QUARTERLY, EU_SERVICE_SALE))

    expect(findUnattributedEuSales).toHaveBeenCalledTimes(1)
    expect(result.blockers.find((b) => b.kind === 'unattributed_eu_sale')).toBeUndefined()
    expect(result.summary).not.toContain('Periodisk sammanställning')
  })

  it('a failed PS read is said, never read as "every sale has a buyer"', async () => {
    findUnattributedEuSales.mockRejectedValue(new Error('get_vat_ruta_source_lines failed: boom'))

    const result = await computeVatCloseCheck(Q3, 'company-1', mockSupabase(QUARTERLY, EU_SERVICE_SALE))

    const finding = result.blockers.find((b) => b.kind === 'unattributed_eu_sale')
    expect(finding).toMatchObject({ severity: 'medium', count: 0 })
    expect(finding?.message).toContain('kunde inte stämmas av mot rutorna 35, 38 och 39')
    expect(result.ready_to_close).toBe(true)
    expect(result.summary).toContain('Periodisk sammanställning kunde inte stämmas av.')
  })
})
