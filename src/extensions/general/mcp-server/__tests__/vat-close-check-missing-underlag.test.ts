/**
 * gnubok_vat_close_check: the missing-underlag blocker delegates to the
 * `verifikat_without_documents` RPC.
 *
 * Regression cover for the hand-rolled scan that used to sit in
 * countMissingUnderlagInPeriod. It filtered journal entries on
 * `.in('source_type', ['bank_transaction', 'supplier_invoice', 'receipt'])`,
 * and the last two literals are not members of the journal_entries.source_type
 * CHECK at all: PostgREST matched zero rows, so supplier-invoice verifikat
 * never surfaced and the momsperiod got a clean bill of health on exactly the
 * entry types most likely to be missing their underlag.
 *
 * The honest assertion here is therefore DELEGATION, not a re-derived count:
 * the journal fixture below is EMPTY, so any local scan would find nothing.
 * A non-zero blocker count can only have come from the RPC envelope, which is
 * the same SQL predicate behind the web worklist badge and
 * gnubok_list_verifikat_without_documents (waivers, is_current_version and
 * the BFL 5 kap 7 § payment-verifikat hänvisning included).
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

import { computeVatCloseCheck } from '../server'

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const PERIOD = { period_type: 'monthly', year: 2026, period: 1 }

/**
 * Table-routed Supabase double with an EMPTY ledger: every table read settles
 * to zero rows, so no other blocker fires and no local scan can produce a
 * count. The verifikat_without_documents RPC answers with the envelope shape
 * the real function returns, keyed on p_since so the two page-of-one calls
 * (period start, day after period end) get their own totals.
 */
function mockSupabase(rpcResults: Record<string, unknown>) {
  const makeChain = (rows: unknown[]): Record<string, unknown> => {
    const chain: Record<string, unknown> = {}
    const settled = { data: rows, error: null, count: rows.length }
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
      const since = String(params?.p_since ?? '')
      return Promise.resolve({ data: rpcResults[since] ?? { ok: true, total_count: 0, verifikat: [] }, error: null })
    }
    return makeChain([])
  })

  return {
    supabase: {
      from: (table: string) => makeChain(table === 'company_settings'
        ? [{ moms_period: 'monthly', vat_taxable_base_over_40m: false }]
        : []),
      rpc,
    } as never,
    rpc,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('gnubok_vat_close_check: missing-underlag comes from the shared RPC predicate', () => {
  it('surfaces the RPC total as the blocker count even though no journal rows exist locally', async () => {
    // 5 verifikat missing underlag since period start, 2 of them dated after
    // the period: 3 in the period. An empty local ledger cannot explain a
    // non-zero count, so this pins the RPC as the source of truth. In prod the
    // RPC total includes supplier-invoice verifikat, the type the old local
    // scan structurally excluded.
    const { supabase, rpc } = mockSupabase({
      '2026-01-01': { ok: true, total_count: 5, verifikat: [] },
      '2026-02-01': { ok: true, total_count: 2, verifikat: [] },
    })

    const result = await computeVatCloseCheck(PERIOD, COMPANY_ID, supabase)

    const underlagCalls = rpc.mock.calls.filter(([fn]) => fn === 'verifikat_without_documents')
    expect(underlagCalls).toHaveLength(2)
    // Same predicate parameters as the web worklist badge: the 4 000 kr
    // förenklad faktura floor (ML 17 kap 26-28 §) and a page of one, because
    // only total_count is consumed.
    expect(underlagCalls.map(([, params]) => params)).toEqual(
      expect.arrayContaining([
        { p_company_id: COMPANY_ID, p_since: '2026-01-01', p_min_amount: 4000, p_limit: 1, p_offset: 0 },
        { p_company_id: COMPANY_ID, p_since: '2026-02-01', p_min_amount: 4000, p_limit: 1, p_offset: 0 },
      ]),
    )

    const blocker = result.blockers.find((b) => b.kind === 'missing_high_value_receipts')!
    expect(blocker).toBeDefined()
    expect(blocker.count).toBe(3)
    expect(blocker.severity).toBe('medium')
    expect(blocker.message).toMatch(/3 verifikat över 4000 kr saknar underlag/)
    // The hint routes the agent to the SAME predicate's listing tool with the
    // same filters, so what it lists is exactly what was counted.
    expect(blocker.hint).toContain('gnubok_list_verifikat_without_documents')
    expect(blocker.hint).toContain('since=2026-01-01')
    expect(blocker.hint).toContain('min_amount=4000')

    // Missing underlag is advisory for the momsdeklaration itself (medium, not
    // high): it must warn, not block the close.
    expect(result.ready_to_close).toBe(true)
  })

  it('reports no blocker when the RPC counts nothing in the period', async () => {
    // Everything missing an underlag is dated after the period: 4 - 4 = 0.
    const { supabase } = mockSupabase({
      '2026-01-01': { ok: true, total_count: 4, verifikat: [] },
      '2026-02-01': { ok: true, total_count: 4, verifikat: [] },
    })

    const result = await computeVatCloseCheck(PERIOD, COMPANY_ID, supabase)

    expect(result.blockers.find((b) => b.kind === 'missing_high_value_receipts')).toBeUndefined()
  })

  it('fails loudly when the RPC refuses, instead of reporting a clean period', async () => {
    // A silent zero here would be the original bug in a new coat: the check
    // must never pass because the predicate could not run.
    const { supabase } = mockSupabase({
      '2026-01-01': { ok: false, code: 'COMPANY_NOT_FOUND' },
    })

    await expect(computeVatCloseCheck(PERIOD, COMPANY_ID, supabase)).rejects.toThrow(
      /verifikat_without_documents failed: COMPANY_NOT_FOUND/,
    )
  })
})
