/**
 * gnubok_vat_close_check: cash-account scoping for bank reconciliation.
 *
 * getReconciliationStatus only isolates same-currency bank feeds when its
 * cashAccountId is populated. These tests pin the VAT close check to the same
 * account resolution used by the standalone reconciliation tool so another
 * cash account cannot inflate 1930's bank total.
 *
 * Both call sites now resolve through lib/reconciliation/cash-account-scope.ts
 * (shared with the bokslut readiness aggregator, which is core code and cannot
 * import from @/extensions/), so the same assertions cover the tool handler too.
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

import { getReconciliationStatus } from '@/lib/reconciliation/bank-reconciliation'
import { computeVatCloseCheck, tools } from '../server'

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const PERIOD = { period_type: 'monthly', year: 2026, period: 1 }
const getReconciliationStatusMock = vi.mocked(getReconciliationStatus)
const reconStatusTool = tools.find((t) => t.name === 'gnubok_get_reconciliation_status')!

interface CashAccountFixture {
  id: string
  currency: string
  is_primary: boolean
  ledger_account: string
}

/**
 * `cashAccounts` is a QUEUE, one entry per cash_accounts lookup: resolving the
 * settlement account can take a second query (no 1930 row -> the company's
 * primary cash account), and those two must be able to answer differently.
 */
function mockSupabase(
  cashAccounts: Array<CashAccountFixture | null>,
  cashAccountError: { message: string } | null = null,
) {
  const cashAccountFilters: Array<[string, unknown]> = []
  let lookup = 0

  const makeChain = (
    rows: unknown[],
    isCashAccounts = false,
    eqCalls?: Array<[string, unknown]>,
    maybeSingleError: { message: string } | null = null,
  ): Record<string, unknown> => {
    const chain: Record<string, unknown> = {}
    const settled = { data: rows, error: null, count: rows.length }
    chain.range = () => settled
    chain.single = async () => ({ data: null, error: null })
    chain.maybeSingle = async () => {
      if (!isCashAccounts) return { data: null, error: null }
      const row = cashAccounts[lookup] ?? null
      lookup += 1
      return { data: row, error: maybeSingleError }
    }
    chain.then = (resolve: (value: unknown) => void) => resolve(settled)
    for (const method of [
      'order', 'lte', 'gte', 'neq', 'in', 'is', 'select',
      'limit', 'contains', 'filter', 'not', 'or',
    ]) {
      chain[method] = () => chain
    }
    chain.eq = (column: string, value: unknown) => {
      eqCalls?.push([column, value])
      return chain
    }
    return chain
  }

  const from = vi.fn((table: string) => {
    if (table === 'cash_accounts') {
      return makeChain([], true, cashAccountFilters, cashAccountError)
    }
    return makeChain([])
  })

  return {
    supabase: {
      from,
      rpc: (fn: string) =>
        fn === 'verifikat_without_documents'
          ? Promise.resolve({
              data: { ok: true, total_count: 0, verifikat: [] },
              error: null,
            })
          : makeChain([]),
    } as never,
    cashAccountFilters,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  getReconciliationStatusMock.mockResolvedValue({
    is_reconciled: true,
    difference: 0,
    unmatched_transaction_count: 0,
    unmatched_gl_line_count: 0,
  } as never)
})

describe('gnubok_vat_close_check: reconciliation scope', () => {
  it('passes the primary 1930 identity so another SEK cash account cannot leak into its total', async () => {
    const cashAccount = {
      id: '11111111-1111-4111-8111-111111111111',
      currency: 'SEK',
      is_primary: true,
      ledger_account: '1930',
    }
    const { supabase, cashAccountFilters } = mockSupabase([cashAccount])

    await computeVatCloseCheck(PERIOD, COMPANY_ID, supabase)

    expect(cashAccountFilters).toEqual([
      ['company_id', COMPANY_ID],
      ['ledger_account', '1930'],
    ])
    expect(getReconciliationStatusMock).toHaveBeenCalledWith(
      supabase,
      COMPANY_ID,
      '2026-01-01',
      '2026-01-31',
      '1930',
      'SEK',
      cashAccount.id,
      true,
    )
  })

  it('does not claim unassigned transactions when 1930 is not the primary cash account', async () => {
    const cashAccount = {
      id: '22222222-2222-4222-8222-222222222222',
      currency: 'EUR',
      is_primary: false,
      ledger_account: '1930',
    }
    const { supabase } = mockSupabase([cashAccount])

    await computeVatCloseCheck(PERIOD, COMPANY_ID, supabase)

    expect(getReconciliationStatusMock).toHaveBeenCalledWith(
      supabase,
      COMPANY_ID,
      '2026-01-01',
      '2026-01-31',
      '1930',
      'EUR',
      cashAccount.id,
      false,
    )
  })

  it('keeps the legacy 1930 fallback when the company has no cash_accounts row', async () => {
    const { supabase } = mockSupabase([null, null])

    await computeVatCloseCheck(PERIOD, COMPANY_ID, supabase)

    expect(getReconciliationStatusMock).toHaveBeenCalledWith(
      supabase,
      COMPANY_ID,
      '2026-01-01',
      '2026-01-31',
      '1930',
      'SEK',
      undefined,
      true,
    )
  })

  it('reconciles the primary cash account when the company has no 1930 row at all', async () => {
    // The worst instance of #1290, measured on prod: 2 companies run two SEK
    // cash accounts each (1935+1936 and 1932+1935), have NO 1930 cash_accounts
    // row and ZERO journal_entry_lines on 1930. Scoped to '1930' they compared
    // their whole SEK bank volume (2026: 120104.43 kr and -22347.00 kr) against
    // an empty GL side, i.e. a high-severity bank_unreconciled blocker with
    // count 0 that no user action could clear.
    const primary = {
      id: '33333333-3333-4333-8333-333333333333',
      currency: 'SEK',
      is_primary: true,
      ledger_account: '1935',
    }
    const { supabase, cashAccountFilters } = mockSupabase([null, primary])

    await computeVatCloseCheck(PERIOD, COMPANY_ID, supabase)

    expect(cashAccountFilters).toEqual([
      ['company_id', COMPANY_ID],
      ['ledger_account', '1930'],
      ['company_id', COMPANY_ID],
      ['is_primary', true],
    ])
    expect(getReconciliationStatusMock).toHaveBeenCalledWith(
      supabase,
      COMPANY_ID,
      '2026-01-01',
      '2026-01-31',
      '1935',
      'SEK',
      primary.id,
      true,
    )
  })

  it('fails closed when the cash-account lookup errors instead of reconciling every SEK account', async () => {
    const { supabase } = mockSupabase([null], { message: 'connection failed' })

    await expect(computeVatCloseCheck(PERIOD, COMPANY_ID, supabase)).rejects.toThrow(
      'Kunde inte hämta kassakonto 1930',
    )
    expect(getReconciliationStatusMock).not.toHaveBeenCalled()
  })

  it('still raises the blocker when the SCOPED run finds a real difference', async () => {
    // Proves these tests isolate the SCOPING, not the blocker logic: a genuine
    // scoped difference must keep blocking, since moms is computed from the
    // huvudbok and a difference there hides errors.
    getReconciliationStatusMock.mockResolvedValue({
      is_reconciled: false,
      difference: -5599.97,
      unmatched_transaction_count: 0,
      unmatched_gl_line_count: 0,
    } as never)
    const { supabase } = mockSupabase([
      {
        id: '11111111-1111-4111-8111-111111111111',
        currency: 'SEK',
        is_primary: true,
        ledger_account: '1930',
      },
    ])

    const result = await computeVatCloseCheck(PERIOD, COMPANY_ID, supabase)

    const blocker = result.blockers.find((b) => b.kind === 'bank_unreconciled')!
    expect(blocker).toBeDefined()
    expect(blocker.severity).toBe('high')
    expect(blocker.message).toContain('-5599.97')
    expect(blocker.message).toContain('1930')
  })

  it('names the RESOLVED account in the blocker message, not a hard-coded 1930', async () => {
    getReconciliationStatusMock.mockResolvedValue({
      is_reconciled: false,
      difference: 120104.43,
      unmatched_transaction_count: 0,
      unmatched_gl_line_count: 0,
    } as never)
    const { supabase } = mockSupabase([
      null,
      {
        id: '33333333-3333-4333-8333-333333333333',
        currency: 'SEK',
        is_primary: true,
        ledger_account: '1935',
      },
    ])

    const result = await computeVatCloseCheck(PERIOD, COMPANY_ID, supabase)

    const blocker = result.blockers.find((b) => b.kind === 'bank_unreconciled')!
    // Pointing the user at 1930 here would send them to an account with no
    // lines on it whatsoever.
    expect(blocker.message).toContain('1935')
    expect(blocker.message).not.toContain('1930')
  })
})

describe('gnubok_get_reconciliation_status: same shared resolution', () => {
  it('resolves the same scope arguments as the close check', async () => {
    const cashAccount = {
      id: '11111111-1111-4111-8111-111111111111',
      currency: 'SEK',
      is_primary: true,
      ledger_account: '1930',
    }
    const { supabase, cashAccountFilters } = mockSupabase([cashAccount])

    await reconStatusTool.execute({}, COMPANY_ID, 'user-1', supabase)

    expect(getReconciliationStatusMock).toHaveBeenCalledWith(
      supabase,
      COMPANY_ID,
      undefined,
      undefined,
      '1930',
      'SEK',
      cashAccount.id,
      true,
    )
    expect(cashAccountFilters).toEqual([
      ['company_id', COMPANY_ID],
      ['ledger_account', '1930'],
    ])
  })

  it('rejects an account_number the company has no cash account for', async () => {
    const { supabase, cashAccountFilters } = mockSupabase([null, null])

    await expect(
      reconStatusTool.execute({ account_number: '9999' }, COMPANY_ID, 'user-1', supabase),
    ).rejects.toThrow(/Okänt kassakonto 9999/)
    expect(getReconciliationStatusMock).not.toHaveBeenCalled()
    // A NAMED account must never silently resolve to the primary one: the
    // caller asked about 9999, so a status labelled 9999 carrying another
    // account's figures would be worse than the error.
    expect(cashAccountFilters).toEqual([
      ['company_id', COMPANY_ID],
      ['ledger_account', '9999'],
    ])
  })

  it('carries a foreign account currency through to the reconciliation', async () => {
    const { supabase } = mockSupabase([
      {
        id: '44444444-4444-4444-8444-444444444444',
        currency: 'EUR',
        is_primary: false,
        ledger_account: '1932',
      },
    ])

    await reconStatusTool.execute(
      { account_number: '1932', date_from: '2026-01-01', date_to: '2026-01-31' },
      COMPANY_ID,
      'user-1',
      supabase,
    )

    expect(getReconciliationStatusMock).toHaveBeenCalledWith(
      supabase,
      COMPANY_ID,
      '2026-01-01',
      '2026-01-31',
      '1932',
      'EUR',
      '44444444-4444-4444-8444-444444444444',
      false,
    )
  })

  it('returns the status object itself, not the internal scope wrapper', async () => {
    const status = {
      is_reconciled: false,
      difference: -12.5,
      unmatched_transaction_count: 1,
      unmatched_gl_line_count: 2,
    }
    getReconciliationStatusMock.mockResolvedValue(status as never)
    const { supabase } = mockSupabase([
      {
        id: '11111111-1111-4111-8111-111111111111',
        currency: 'SEK',
        is_primary: true,
        ledger_account: '1930',
      },
    ])

    const result = await reconStatusTool.execute({}, COMPANY_ID, 'user-1', supabase)

    expect(result).toEqual(status)
  })
})
