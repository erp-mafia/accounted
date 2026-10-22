/**
 * gnubok_vat_close_check under kontantmetoden (#88, agent feedback seq 878478).
 *
 * Kontantmetoden (bokslutsmetoden) has no attest step: ingående moms is
 * recognised when a supplier invoice is paid, and at the räkenskapsår's end
 * every invoice still unpaid at balansdagen is booked by the year-end cut-off
 * (BFL 5 kap 2 §). The check used to count unattested supplier invoices there
 * (an info line mid-year, a high blocker at the year end, both pointing at
 * gnubok_approve_supplier_invoice), so attesting cleared the year end without
 * booking anything. Now the cut-off's own finding decides: an incomplete
 * cut-off is a high blocker with the cut-off hint, and nothing else is said.
 * Faktureringsmetoden keeps the unattested-invoice blocker.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { KontantmetodCutoffVatFacts } from '@/types'

vi.mock('@/lib/reconciliation/bank-reconciliation', () => ({
  getReconciliationStatus: vi.fn(async () => ({
    is_reconciled: true,
    difference: 0,
    unmatched_transaction_count: 0,
    unmatched_gl_line_count: 0,
  })),
}))

// The cut-off assessment itself is pinned in the kontantmetod-cutoff-vat-facts
// tests; here only what the close check makes of its answer.
const fetchKontantmetodCutoffVatFacts = vi.hoisted(() =>
  vi.fn<() => Promise<KontantmetodCutoffVatFacts | undefined>>(async () => undefined),
)
vi.mock('@/lib/vat/kontantmetod-cutoff-vat-facts', () => ({ fetchKontantmetodCutoffVatFacts }))

import { computeVatCloseCheck, KONTANTMETOD_CUTOFF_HINT } from '@/lib/reports/vat-close-check'

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

/**
 * Table-routed double: two registered (unattested) supplier invoices, the
 * given settings row, everything else empty. Filter calls are recorded per
 * table.
 */
type Call = { table: string; method: string; args: unknown[] }

function mockSupabase(settings: Record<string, unknown>) {
  const calls: Call[] = []
  const makeChain = (rows: unknown[], table = ''): Record<string, unknown> => {
    const chain: Record<string, unknown> = {}
    const settled = { data: rows, error: null, count: rows.length }
    chain.range = () => settled
    chain.single = async () => ({ data: rows[0] ?? null, error: null })
    chain.maybeSingle = async () => ({ data: null, error: null })
    chain.then = (resolve: (v: unknown) => void) => resolve(settled)
    for (const m of ['order', 'lte', 'gte', 'neq', 'in', 'eq', 'is', 'select', 'limit', 'contains', 'filter', 'not', 'or']) {
      chain[m] = (...args: unknown[]) => {
        calls.push({ table, method: m, args })
        return chain
      }
    }
    return chain
  }
  const rpc = vi.fn((fn: string) => {
    if (fn === 'verifikat_without_documents') {
      return Promise.resolve({ data: { ok: true, total_count: 0, verifikat: [] }, error: null })
    }
    return makeChain([])
  })
  const client = {
    from: (table: string) => {
      if (table === 'company_settings') return makeChain([settings], table)
      if (table === 'supplier_invoices') return makeChain([{ id: 'si-1' }, { id: 'si-2' }], table)
      return makeChain([], table)
    },
    rpc,
    calls,
  }
  return client as unknown as SupabaseClient & { calls: Call[] }
}

const CASH = { moms_period: 'quarterly', vat_taxable_base_over_40m: false, accounting_method: 'cash', fiscal_year_start_month: 1 }
const ACCRUAL = { ...CASH, accounting_method: 'accrual' }
const Q3 = { period_type: 'quarterly', year: 2026, period: 3 }
const Q4 = { period_type: 'quarterly', year: 2026, period: 4 }

const INCOMPLETE_YEAR_END: KontantmetodCutoffVatFacts = {
  incompleteYearEnds: [{ fiscal_period_id: 'fp-2026', period_end: '2026-12-31' }],
  legacyCutoffPeriodEnds: [],
}
const COMPLETE: KontantmetodCutoffVatFacts = { incompleteYearEnds: [], legacyCutoffPeriodEnds: [] }

type Result = Awaited<ReturnType<typeof computeVatCloseCheck>>
const unapproved = (result: Result) => result.blockers.find((b) => b.kind === 'unapproved_supplier_invoices')
const cutoff = (result: Result) =>
  result.blockers.find((b) => (b as { check_code?: string }).check_code === 'KONTANTMETOD_CUTOFF_INCOMPLETE')
const supplierInvoiceReads = (calls: Call[]) => calls.filter((c) => c.table === 'supplier_invoices')
const pointsAtAttest = (result: Result) =>
  result.blockers.some((b) => `${b.message} ${b.hint}`.includes('gnubok_approve_supplier_invoice'))

beforeEach(() => {
  vi.clearAllMocks()
  fetchKontantmetodCutoffVatFacts.mockResolvedValue(undefined)
})

describe('gnubok_vat_close_check under kontantmetoden', () => {
  it('says nothing about unattested invoices in a period without a year end', async () => {
    fetchKontantmetodCutoffVatFacts.mockResolvedValue(COMPLETE)
    const supabase = mockSupabase(CASH)
    const result = await computeVatCloseCheck(Q3, COMPANY_ID, supabase)

    expect(unapproved(result)).toBeUndefined()
    expect(supplierInvoiceReads(supabase.calls)).toEqual([])
    expect(pointsAtAttest(result)).toBe(false)
    expect(result.ready_to_close).toBe(true)
  })

  // The regression: at the year end the blocker was "attest them", which
  // books nothing. What is required is the cut-off.
  it('blocks the year-end period on the incomplete cut-off, with the cut-off hint, not on attest', async () => {
    fetchKontantmetodCutoffVatFacts.mockResolvedValue(INCOMPLETE_YEAR_END)
    const result = await computeVatCloseCheck(Q4, COMPANY_ID, mockSupabase(CASH))

    expect(unapproved(result)).toBeUndefined()
    expect(cutoff(result)).toMatchObject({
      kind: 'declaration_incomplete',
      severity: 'high',
      hint: KONTANTMETOD_CUTOFF_HINT,
    })
    expect(cutoff(result)!.message).toMatch(/2026-12-31/)
    expect(KONTANTMETOD_CUTOFF_HINT).toMatch(/gnubok_post_kontantmetod_cutoff/)
    expect(pointsAtAttest(result)).toBe(false)
    expect(result.ready_to_close).toBe(false)
    // The filing gate is unchanged: still a WARNING there (founder decision 2026-10-03).
    expect(result.declaration_checks).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'KONTANTMETOD_CUTOFF_INCOMPLETE', status: 'WARNING' })]),
    )
  })

  it('lets the year-end period close once the cut-off is booked, unattested invoices or not', async () => {
    fetchKontantmetodCutoffVatFacts.mockResolvedValue(COMPLETE)
    const result = await computeVatCloseCheck(Q4, COMPANY_ID, mockSupabase(CASH))

    expect(unapproved(result)).toBeUndefined()
    expect(cutoff(result)).toBeUndefined()
    expect(result.blockers.filter((b) => b.severity === 'high')).toEqual([])
    expect(result.ready_to_close).toBe(true)
  })

  it('fails closed when the cut-off could not be checked', async () => {
    fetchKontantmetodCutoffVatFacts.mockResolvedValue({ incompleteYearEnds: [], legacyCutoffPeriodEnds: [], unavailable: true })
    const result = await computeVatCloseCheck(Q4, COMPANY_ID, mockSupabase(CASH))

    expect(cutoff(result)).toMatchObject({ severity: 'high' })
    expect(result.ready_to_close).toBe(false)
  })
})

describe('gnubok_vat_close_check under faktureringsmetoden', () => {
  it('still blocks on unattested supplier invoices dated in the period', async () => {
    const supabase = mockSupabase(ACCRUAL)
    const result = await computeVatCloseCheck(Q3, COMPANY_ID, supabase)

    expect(unapproved(result)).toMatchObject({ severity: 'high', count: 2 })
    expect(unapproved(result)!.hint).toMatch(/gnubok_approve_supplier_invoice/)
    expect(
      supplierInvoiceReads(supabase.calls)
        .filter((c) => c.method === 'gte' || c.method === 'lte')
        .map((c) => [c.method, ...c.args]),
    ).toEqual([['gte', 'invoice_date', '2026-07-01'], ['lte', 'invoice_date', '2026-09-30']])
    expect(result.ready_to_close).toBe(false)
  })
})
