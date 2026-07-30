/**
 * gnubok_vat_close_check: cash-account scoping for bank reconciliation.
 *
 * getReconciliationStatus only isolates same-currency bank feeds when its
 * cashAccountId is populated. These tests pin the VAT close check to the same
 * account resolution used by the standalone reconciliation tool so another
 * cash account cannot inflate 1930's bank total.
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
import { computeVatCloseCheck } from '../server'

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const PERIOD = { period_type: 'monthly', year: 2026, period: 1 }
const getReconciliationStatusMock = vi.mocked(getReconciliationStatus)

interface CashAccountFixture {
  id: string
  currency: string
  is_primary: boolean
}

function mockSupabase(
  cashAccount: CashAccountFixture | null,
  cashAccountError: { message: string } | null = null,
) {
  const cashAccountFilters: Array<[string, unknown]> = []

  const makeChain = (
    rows: unknown[],
    maybeSingleData: unknown = null,
    eqCalls?: Array<[string, unknown]>,
    maybeSingleError: { message: string } | null = null,
  ): Record<string, unknown> => {
    const chain: Record<string, unknown> = {}
    const settled = { data: rows, error: null, count: rows.length }
    chain.range = () => settled
    chain.single = async () => ({ data: null, error: null })
    chain.maybeSingle = async () => ({ data: maybeSingleData, error: maybeSingleError })
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
      return makeChain(
        cashAccount ? [cashAccount] : [],
        cashAccount,
        cashAccountFilters,
        cashAccountError,
      )
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
})

describe('gnubok_vat_close_check: reconciliation scope', () => {
  it('passes the primary 1930 identity so another SEK cash account cannot leak into its total', async () => {
    const cashAccount = {
      id: '11111111-1111-4111-8111-111111111111',
      currency: 'SEK',
      is_primary: true,
    }
    const { supabase, cashAccountFilters } = mockSupabase(cashAccount)

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
    }
    const { supabase } = mockSupabase(cashAccount)

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
    const { supabase } = mockSupabase(null)

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

  it('fails closed when the cash-account lookup errors instead of reconciling every SEK account', async () => {
    const { supabase } = mockSupabase(null, { message: 'connection failed' })

    await expect(computeVatCloseCheck(PERIOD, COMPANY_ID, supabase)).rejects.toThrow(
      'Kunde inte hämta kassakonto 1930',
    )
    expect(getReconciliationStatusMock).not.toHaveBeenCalled()
  })
})
