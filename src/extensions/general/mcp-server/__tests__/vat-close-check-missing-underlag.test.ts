/**
 * gnubok_vat_close_check: the missing-underlag blocker delegates to the
 * `verifikat_without_documents` RPC.
 *
 * Regression cover for the hand-rolled scan that used to sit in the close
 * check. It filtered journal entries on
 * `.in('source_type', ['bank_transaction', 'supplier_invoice', 'receipt'])`,
 * and the last two literals are not members of the journal_entries.source_type
 * CHECK at all: PostgREST matched zero rows, so supplier-invoice verifikat
 * never surfaced and the momsperiod got a clean bill of health on exactly the
 * entry types most likely to be missing their underlag.
 *
 * The honest assertion here is therefore DELEGATION, not a re-derived count:
 * the journal fixture holds no verifikat, so any local scan would find
 * nothing. A non-zero blocker count can only have come from the RPC envelope,
 * which is the same SQL predicate behind the web worklist badge and
 * gnubok_list_verifikat_without_documents (waivers, is_current_version and
 * the BFL 5 kap 7 § payment-verifikat hänvisning included).
 *
 * Of those rows, a transfer between the company's own accounts (Kvittojakten's
 * errand own_transfer) has the bank statement as its underlag: the count
 * leaves it out and the message says how many and why. A verifikat booked
 * from the Stripe feed (errand stripe), such as the day's sales
 * samlingsverifikat, still needs Stripe's report: it is counted, and the
 * message says how many are fetched from Stripe. Every other verifikat counts
 * as before. The errand is read through the real classifier, on the lines and
 * links in the fixture.
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

import { computeVatCloseCheck } from '@/lib/reports/vat-close-check'

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const PERIOD = { period_type: 'monthly', year: 2026, period: 1 }

type Row = Record<string, unknown>

const verifikat = (id: string, description: string) => ({
  journal_entry_id: id,
  voucher_series: 'A',
  voucher_number: 1,
  entry_date: '2026-01-15',
  description,
  source_type: 'bank_transaction',
  gross_amount: 5000,
})

const line = (entry: string, n: number, account_number: string, debit: number, credit = 0) => ({
  id: `${entry}-${n}`,
  journal_entry_id: entry,
  account_number,
  debit_amount: debit,
  credit_amount: credit,
})

/**
 * Table-routed Supabase double with no verifikat of its own: every table read
 * settles to `tables[table]` (default none), so no other blocker fires and no
 * local scan can produce a count. The verifikat_without_documents RPC answers
 * one envelope per page, keyed on p_offset. A `failing` table answers an error.
 */
function mockSupabase(pages: Record<number, unknown>, tables: Record<string, Row[]> = {}, failing?: string) {
  const makeChain = (rows: unknown[], error: { message: string } | null = null): Record<string, unknown> => {
    const chain: Record<string, unknown> = {}
    const settled = { data: error ? null : rows, error, count: rows.length }
    chain.range = () => settled
    chain.single = async () => ({ data: rows[0] ?? null, error: null })
    chain.maybeSingle = async () => ({ data: null, error: null })
    chain.then = (resolve: (v: unknown) => void) => resolve(settled)
    for (const m of [
      'order', 'lte', 'gte', 'neq', 'in', 'eq', 'is', 'select',
      'limit', 'contains', 'filter', 'not', 'or',
    ]) {
      chain[m] = () => chain
    }
    return chain
  }

  const rpc = vi.fn((fn: string, params?: Record<string, unknown>) => {
    if (fn === 'verifikat_without_documents') {
      const page = pages[Number(params?.p_offset ?? 0)] ?? { ok: true, total_count: 0, verifikat: [] }
      return Promise.resolve({ data: page, error: null })
    }
    return makeChain([])
  })

  return {
    supabase: {
      from: (table: string) =>
        table === 'company_settings'
          ? makeChain([{ moms_period: 'monthly', vat_taxable_base_over_40m: false }])
          : makeChain(tables[table] ?? [], table === failing ? { message: 'timeout' } : null),
      rpc,
    } as never,
    rpc,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('gnubok_vat_close_check: missing-underlag comes from the shared RPC predicate', () => {
  it('counts the RPC rows in the period, paging through the RPC, even though no journal rows exist locally', async () => {
    // 103 verifikat in the period: one full page of 100 and a second of 3.
    // Without lines no row reads as bought-nothing, so all of them count.
    const rows = Array.from({ length: 103 }, (_, i) => verifikat(`je-${i}`, 'Kortköp Kontorsgiganten'))
    const { supabase, rpc } = mockSupabase({
      0: { ok: true, total_count: 103, verifikat: rows.slice(0, 100) },
      100: { ok: true, total_count: 103, verifikat: rows.slice(100) },
    })

    const result = await computeVatCloseCheck(PERIOD, COMPANY_ID, supabase)

    const underlagCalls = rpc.mock.calls.filter(([fn]) => fn === 'verifikat_without_documents')
    // Same predicate parameters as the web worklist badge: the 4 000 kr
    // förenklad faktura floor (ML 17 kap 26-28 §), bounded on both sides by
    // the period.
    expect(underlagCalls.map(([, params]) => params)).toEqual([
      { p_company_id: COMPANY_ID, p_since: '2026-01-01', p_until: '2026-01-31', p_min_amount: 4000, p_limit: 100, p_offset: 0 },
      { p_company_id: COMPANY_ID, p_since: '2026-01-01', p_until: '2026-01-31', p_min_amount: 4000, p_limit: 100, p_offset: 100 },
    ])

    const blocker = result.blockers.find((b) => b.kind === 'missing_high_value_receipts')!
    expect(blocker).toBeDefined()
    expect(blocker.count).toBe(103)
    expect(blocker.severity).toBe('medium')
    expect(blocker.message).toBe('103 verifikat över 4000 kr saknar underlag')
    // The hint routes the agent to the SAME predicate's listing tool with the
    // same filters, so what it lists is exactly what was counted.
    expect(blocker.hint).toContain('gnubok_list_verifikat_without_documents')
    expect(blocker.hint).toContain('since=2026-01-01, until=2026-01-31')
    expect(blocker.hint).toContain('min_amount=4000')
    expect(blocker.hint).toContain('next_step_kind')

    // Missing underlag is advisory for the momsdeklaration itself (medium, not
    // high): it must warn, not block the close.
    expect(result.ready_to_close).toBe(true)
  })

  it('leaves out a transfer between own accounts and counts a Stripe samlingsverifikat with its report, saying how many of each', async () => {
    const { supabase } = mockSupabase(
      {
        0: {
          ok: true,
          total_count: 4,
          verifikat: [
            verifikat('je-transfer', 'Överföring till sparkonto'),
            verifikat('je-stripe', 'Stripe kortförsäljning 2026-01-14, samlingsverifikat'),
            verifikat('je-sale', 'Försäljning 2026-01-14'),
            verifikat('je-purchase', 'Kortköp Kontorsgiganten'),
          ],
        },
      },
      {
        journal_entry_lines: [
          line('je-transfer', 1, '1940', 5000), line('je-transfer', 2, '1930', 0, 5000),
          line('je-stripe', 1, '1686', 5000), line('je-stripe', 2, '2611', 0, 1000), line('je-stripe', 3, '3001', 0, 4000),
          line('je-sale', 1, '1930', 5000), line('je-sale', 2, '2611', 0, 1000), line('je-sale', 3, '3001', 0, 4000),
          line('je-purchase', 1, '5410', 4000), line('je-purchase', 2, '2640', 1000), line('je-purchase', 3, '1930', 0, 5000),
        ],
        // The Stripe day's rows are anchored by voucher links only.
        transaction_voucher_links: [{ journal_entry_id: 'je-stripe', tx: { import_source: 'stripe' } }],
      },
    )

    const result = await computeVatCloseCheck(PERIOD, COMPANY_ID, supabase)

    const blocker = result.blockers.find((b) => b.kind === 'missing_high_value_receipts')!
    // The Stripe day, the sale without a feed row and the purchase: only the transfer is left out.
    expect(blocker.count).toBe(3)
    expect(blocker.message).toBe(
      '3 verifikat över 4000 kr saknar underlag, varav 1 från Stripe: ladda ner underlaget i Stripe ' +
        '(månadsfakturan för avgifterna, saldorapporten för övriga rader), det finns inte i mejlen. ' +
        '1 verifikat till räknas inte, överföringar mellan egna konton: kontoutdraget är underlaget',
    )
    expect(blocker.hint).toContain('stripe hämtas i Stripe, own_transfer räknas inte här')
    expect(result.ready_to_close).toBe(true)
  })

  it('reports no blocker when every verifikat without underlag is a transfer between own accounts', async () => {
    const { supabase } = mockSupabase(
      { 0: { ok: true, total_count: 1, verifikat: [verifikat('je-transfer', 'Överföring till sparkonto')] } },
      { journal_entry_lines: [line('je-transfer', 1, '1940', 5000), line('je-transfer', 2, '1930', 0, 5000)] },
    )

    const result = await computeVatCloseCheck(PERIOD, COMPANY_ID, supabase)

    expect(result.blockers.find((b) => b.kind === 'missing_high_value_receipts')).toBeUndefined()
  })

  it('counts a Stripe samlingsverifikat when it is the only one, and leaves the transfer sentence out', async () => {
    const { supabase } = mockSupabase(
      { 0: { ok: true, total_count: 1, verifikat: [verifikat('je-stripe', 'Stripe kortförsäljning 2026-01-14')] } },
      {
        journal_entry_lines: [line('je-stripe', 1, '1686', 5000), line('je-stripe', 2, '2611', 0, 1000), line('je-stripe', 3, '3001', 0, 4000)],
        transaction_voucher_links: [{ journal_entry_id: 'je-stripe', tx: { import_source: 'stripe' } }],
      },
    )

    const result = await computeVatCloseCheck(PERIOD, COMPANY_ID, supabase)

    const blocker = result.blockers.find((b) => b.kind === 'missing_high_value_receipts')!
    expect(blocker.count).toBe(1)
    expect(blocker.message).toBe(
      '1 verifikat över 4000 kr saknar underlag, varav 1 från Stripe: ladda ner underlaget i Stripe ' +
        '(månadsfakturan för avgifterna, saldorapporten för övriga rader), det finns inte i mejlen',
    )
  })

  it('counts every row when the errands cannot be read, as before the split', async () => {
    const { supabase } = mockSupabase(
      { 0: { ok: true, total_count: 1, verifikat: [verifikat('je-transfer', 'Överföring till sparkonto')] } },
      { journal_entry_lines: [line('je-transfer', 1, '1940', 5000), line('je-transfer', 2, '1930', 0, 5000)] },
      'transactions',
    )

    const result = await computeVatCloseCheck(PERIOD, COMPANY_ID, supabase)

    const blocker = result.blockers.find((b) => b.kind === 'missing_high_value_receipts')!
    expect(blocker.count).toBe(1)
    expect(blocker.message).toBe('1 verifikat över 4000 kr saknar underlag')
  })

  it('reports no blocker when the RPC counts nothing in the period', async () => {
    const { supabase } = mockSupabase({ 0: { ok: true, total_count: 0, verifikat: [] } })

    const result = await computeVatCloseCheck(PERIOD, COMPANY_ID, supabase)

    expect(result.blockers.find((b) => b.kind === 'missing_high_value_receipts')).toBeUndefined()
  })

  it('fails loudly when the RPC refuses, instead of reporting a clean period', async () => {
    // A silent zero here would be the original bug in a new coat: the check
    // must never pass because the predicate could not run.
    const { supabase } = mockSupabase({ 0: { ok: false, code: 'COMPANY_NOT_FOUND' } })

    await expect(computeVatCloseCheck(PERIOD, COMPANY_ID, supabase)).rejects.toThrow(
      /verifikat_without_documents failed: COMPANY_NOT_FOUND/,
    )
  })
})
