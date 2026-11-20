import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createLogger } from '@/lib/logger'
import { createFakeDb } from './fake-db'

const { trialBalance } = vi.hoisted(() => ({ trialBalance: vi.fn() }))
vi.mock('@/lib/reports/trial-balance', () => ({ generateTrialBalance: trialBalance }))

import { getPosClearingBalance } from '../clearing-balance'

/**
 * The till's money not yet in the bank: the ledger balance of the clearing
 * accounts read through the trial balance as of a date, and the card and
 * Swish of the days not booked yet beside it.
 */

const COMPANY = 'company-cafe-exempel'
const log = createLogger('test')

const tbRow = (account_number: string, debit: number, credit: number) => ({
  account_number,
  account_name: '',
  account_class: Number(account_number[0]),
  opening_debit: 0,
  opening_credit: 0,
  period_debit: debit,
  period_credit: credit,
  closing_debit: debit,
  closing_credit: credit,
})

const day = (id: string, business_date: string, over: Record<string, unknown> = {}) => ({
  id,
  company_id: COMPANY,
  connection_id: 'conn-1',
  business_date,
  status: 'ready',
  journal_entry_id: null,
  tenders: [
    { kind: 'card', method: 'Kort', amount: 10_000, tips: 200, receiptCount: 40 },
    { kind: 'swish', method: 'Swish', amount: 1_500.5, tips: 0, receiptCount: 9 },
    { kind: 'cash', method: 'Kontant', amount: 800, tips: 0, receiptCount: 3 },
  ],
  ...over,
})

function ctx(seed: Record<string, Array<Record<string, unknown>>>) {
  const db = createFakeDb(seed)
  return { supabase: db.client as unknown as SupabaseClient, companyId: COMPANY, userId: 'user-1', log }
}

beforeEach(() => {
  vi.clearAllMocks()
  trialBalance.mockResolvedValue({
    rows: [tbRow('1686', 52_000, 40_500), tbRow('1930', 90_000, 1_000), tbRow('3002', 0, 46_000)],
    totalDebit: 0,
    totalCredit: 0,
    isBalanced: true,
  })
})

describe('getPosClearingBalance', () => {
  it('reads the clearing account through the trial balance as of the date, and the unbooked days beside it', async () => {
    const outcome = await getPosClearingBalance(
      ctx({
        pos_connections: [{ id: 'conn-1', company_id: COMPANY, status: 'active', settings: {} }],
        fiscal_periods: [{ id: 'fy-2026', company_id: COMPANY, period_start: '2026-01-01', period_end: '2026-12-31' }],
        pos_sales_days: [
          day('d-1', '2026-10-20'),
          day('d-2', '2026-10-21', { status: 'needs_review' }),
          day('d-booked', '2026-10-19', { status: 'booked', journal_entry_id: 'je-1' }),
          day('d-later', '2026-10-25'),
          day('d-cash-only', '2026-10-18', { tenders: [{ kind: 'cash', method: 'Kontant', amount: 300, tips: 0, receiptCount: 2 }] }),
        ],
      }),
      { as_of: '2026-10-22' },
    )
    expect(outcome).toEqual({
      ok: true,
      data: {
        as_of: '2026-10-22',
        accounts: ['1686'],
        ledger_balance: 11_500,
        fiscal_period_id: 'fy-2026',
        unbooked_days: 2,
        unbooked_amount: 23_001,
      },
    })
    expect(trialBalance).toHaveBeenCalledWith(expect.anything(), COMPANY, 'fy-2026', expect.objectContaining({ closingEntry: 'include', toDate: '2026-10-22' }))
  })

  it('answers not found for a company without a till', async () => {
    const outcome = await getPosClearingBalance(ctx({ pos_connections: [] }), { as_of: '2026-10-22' })
    expect(outcome).toMatchObject({ ok: false, code: 'POS_CONNECTION_NOT_FOUND' })
    expect(trialBalance).not.toHaveBeenCalled()
  })

  it('has no ledger balance without a fiscal year, and none to read when every kind books to a cash ledger', async () => {
    const noYear = await getPosClearingBalance(
      ctx({ pos_connections: [{ id: 'conn-1', company_id: COMPANY, status: 'active', settings: {} }], fiscal_periods: [], pos_sales_days: [] }),
      { as_of: '2026-10-22' },
    )
    expect(noYear).toMatchObject({ ok: true, data: { ledger_balance: null, fiscal_period_id: null, accounts: ['1686'] } })

    const straight = await getPosClearingBalance(
      ctx({
        pos_connections: [{ id: 'conn-1', company_id: COMPANY, status: 'active', settings: { tender_accounts: { card: '1930', swish: '1930' } } }],
        fiscal_periods: [{ id: 'fy-2026', company_id: COMPANY, period_start: '2026-01-01', period_end: '2026-12-31' }],
        pos_sales_days: [day('d-1', '2026-10-20')],
      }),
      { as_of: '2026-10-22' },
    )
    expect(straight).toMatchObject({ ok: true, data: { accounts: [], ledger_balance: 0, unbooked_days: 0, unbooked_amount: 0 } })
    expect(trialBalance).not.toHaveBeenCalled()
  })

  it('fails as a read failure when the trial balance does', async () => {
    trialBalance.mockRejectedValue(new Error('statement timeout'))
    const outcome = await getPosClearingBalance(
      ctx({
        pos_connections: [{ id: 'conn-1', company_id: COMPANY, status: 'active', settings: {} }],
        fiscal_periods: [{ id: 'fy-2026', company_id: COMPANY, period_start: '2026-01-01', period_end: '2026-12-31' }],
        pos_sales_days: [],
      }),
      { as_of: '2026-10-22' },
    )
    expect(outcome).toMatchObject({ ok: false, code: 'POS_READ_FAILED' })
  })
})
