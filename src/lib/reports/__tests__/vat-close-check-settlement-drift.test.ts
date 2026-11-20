/**
 * gnubok_vat_close_check's finding for moms left on 2650/1650, end to end
 * through computeVatCloseCheck (crm#1924): it describes the books today
 * whatever period is asked about, says so, and names the balance it is part
 * of and the verifikat it comes from. A failed read leaves the finding out.
 *
 * Only the bank reconciliation is mocked (as in the sanity suite): an
 * unreconciled bank would add an unrelated blocker.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/reconciliation/bank-reconciliation', () => ({
  getReconciliationStatus: vi.fn(async () => ({
    is_reconciled: true,
    difference: 0,
    unmatched_transaction_count: 0,
    unmatched_gl_line_count: 0,
  })),
}))

vi.mock('@/lib/dates/iso', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/dates/iso')>()),
  todayIsoStockholm: () => '2026-11-16',
}))

const logRecords = vi.hoisted(() => [] as { level: string; msg: string; [key: string]: unknown }[])
vi.mock('@/lib/logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/logger')>()
  return {
    ...actual,
    createLogger: (module: string, base = {}) => actual.createTestLogger(module, logRecords as never, base),
  }
})

import { computeVatCloseCheck } from '@/lib/reports/vat-close-check'

const SALES = [
  { account_number: '3001', debit: 0, credit: 100_000 },
  { account_number: '2611', debit: 0, credit: 25_000 },
]

const verifikat = (id: string, number: number, date: string, account: string, debit: number, credit: number) => ({
  id,
  voucher_series: 'A',
  voucher_number: number,
  entry_date: date,
  description: 'Momsredovisning',
  status: 'posted',
  source_type: 'manual',
  source_id: null,
  reverses_id: null,
  correction_of_id: null,
  lines: [{ id: `${id}-l`, account_number: account, debit_amount: debit, credit_amount: credit }],
})

// 2650: January's moms was charged and booked, March's never was, and
// September's is not due yet.
const ON_2650 = [
  verifikat('e1', 4, '2026-01-31', '2650', 0, 3000),
  verifikat('e2', 9, '2026-03-12', '2650', 3000, 0),
  verifikat('e3', 14, '2026-03-31', '2650', 0, 5200),
  verifikat('e4', 41, '2026-09-30', '2650', 0, 2100),
]

function mockSupabase(entries: unknown[] | 'error') {
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
    from: (table: string) =>
      table === 'company_settings'
        ? makeChain([{ moms_period: 'monthly', vat_taxable_base_over_40m: false }])
        : makeChain([]),
    rpc: (fn: string, params: { p_accounts?: string[] }) => {
      if (fn === 'get_vat_declaration_totals') {
        return Promise.resolve({ data: { totals: SALES, settlement_shaped_entries: [], source_type_counts: {} }, error: null })
      }
      if (fn === 'verifikat_without_documents') {
        return Promise.resolve({ data: { ok: true, total_count: 0, verifikat: [] }, error: null })
      }
      // The drift read asks for 2650 and 1650; the periodisk sammanställning
      // and the reverse-charge scan read other accounts through the same RPC.
      if (fn === 'get_entries_with_account_lines' && params.p_accounts?.includes('2650')) {
        return Promise.resolve(
          entries === 'error'
            ? { data: null, error: { code: '57014', message: 'canceling statement due to statement timeout' } }
            : { data: entries, error: null },
        )
      }
      return makeChain([])
    },
  } as never
}

const drift = (result: Awaited<ReturnType<typeof computeVatCloseCheck>>) =>
  result.blockers.find((b) => b.kind === 'earlier_vat_on_settlement_account')

describe('gnubok_vat_close_check: moms left on 2650/1650', () => {
  beforeEach(() => {
    logRecords.length = 0
  })

  it('describes the books today for every period asked about, and says which day that is', async () => {
    const april = await computeVatCloseCheck({ period_type: 'monthly', year: 2026, period: 4 }, 'company-1', mockSupabase(ON_2650))
    const october = await computeVatCloseCheck({ period_type: 'monthly', year: 2026, period: 10 }, 'company-1', mockSupabase(ON_2650))

    expect(drift(april)).toBeDefined()
    // The same finding for both periods, on purpose, and it states its day.
    expect(drift(october)).toEqual(drift(april))
    expect(drift(april)).toMatchObject({ severity: 'medium', count: 1, as_of: '2026-11-16' })
    expect(drift(april)?.message).toContain('per 2026-11-16, oavsett vilken period kontrollen gäller')
    // Medium: it never decides ready_to_close.
    expect(april.ready_to_close).toBe(true)
  })

  it('names the balance the amount is part of and the verifikat it comes from', async () => {
    const result = await computeVatCloseCheck({ period_type: 'monthly', year: 2026, period: 10 }, 'company-1', mockSupabase(ON_2650))

    // Huvudboken on 2650: 3 000 - 3 000 + 5 200 + 2 100 = 7 300, of which
    // September's 2 100 is inside the window.
    expect(drift(result)?.message).toMatch(/5\s200\skr av saldot 7\s300\skr på 2650/)
    expect(drift(result)?.message).toMatch(/A-14 2026-03-31: 5\s200\skr/)
    expect(drift(result)?.settlement_accounts).toEqual([
      {
        account_number: '2650',
        balance: 7300,
        counted_from: null,
        window_start: '2026-06-20',
        recent: 2100,
        older: 5200,
        inherited: 0,
        drift: 5200,
        entries: [
          { journal_entry_id: 'e3', voucher_label: 'A-14', entry_date: '2026-03-31', amount: 5200, counted: 5200, opening_balance: false },
        ],
        unattributed: 0,
        entry_count: 1,
      },
    ])
  })

  it('leaves the finding out and logs when the accounts cannot be read', async () => {
    const result = await computeVatCloseCheck({ period_type: 'monthly', year: 2026, period: 10 }, 'company-1', mockSupabase('error'))

    expect(drift(result)).toBeUndefined()
    expect(result.ready_to_close).toBe(true)
    const warning = logRecords.find((r) => r.msg === 'settlement account drift unavailable')
    expect(warning).toMatchObject({ level: 'warn' })
    expect(JSON.stringify(warning)).toContain('statement timeout')
  })
})
