import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createQueuedMockSupabase } from '@/tests/helpers'
import {
  isOpenSkattekontoRow,
  isSkattekontoRowBeforeHistory,
  readSkattekontoOpeningDate,
  whereSkattekontoRowOpen,
  type SkattekontoWorkRow,
} from '../skattekonto-open-rows'

const COMPANY = 'company-1'
const IB_DATE = '2026-09-01'

const row = (overrides: Partial<SkattekontoWorkRow> = {}): SkattekontoWorkRow => ({
  status: 'booked',
  journal_entry_id: null,
  is_ignored: false,
  transaktionsdatum: '2026-10-12',
  ...overrides,
})

beforeEach(() => vi.clearAllMocks())

describe('which skattekonto rows are open work (crm#2010)', () => {
  it('counts a carried-out, unlinked, unignored row dated on or after the IB', () => {
    expect(isOpenSkattekontoRow(row(), IB_DATE)).toBe(true)
    expect(isOpenSkattekontoRow(row({ transaktionsdatum: IB_DATE }), IB_DATE)).toBe(true)
  })

  it('leaves out a row the IB carries: dated before it, listed apart instead', () => {
    const carried = row({ transaktionsdatum: '2026-08-26' })
    expect(isOpenSkattekontoRow(carried, IB_DATE)).toBe(false)
    expect(isSkattekontoRowBeforeHistory(carried, IB_DATE)).toBe(true)
  })

  it('counts every unhandled row when the account has no IB', () => {
    const old = row({ transaktionsdatum: '2025-05-03' })
    expect(isOpenSkattekontoRow(old, null)).toBe(true)
    expect(isSkattekontoRowBeforeHistory(old, null)).toBe(false)
  })

  it('never counts a linked, ignored or upcoming row, before the IB or after it', () => {
    for (const transaktionsdatum of ['2026-08-26', '2026-10-12']) {
      for (const handled of [
        row({ transaktionsdatum, journal_entry_id: 'je-1' }),
        row({ transaktionsdatum, is_ignored: true }),
        row({ transaktionsdatum, status: 'upcoming' }),
      ]) {
        expect(isOpenSkattekontoRow(handled, IB_DATE)).toBe(false)
        expect(isSkattekontoRowBeforeHistory(handled, IB_DATE)).toBe(false)
      }
    }
  })
})

describe('whereSkattekontoRowOpen', () => {
  it('filters on the same reading, with the IB date as the lower bound', async () => {
    const { supabase, findCalls, enqueue } = createQueuedMockSupabase()
    enqueue({ count: 2 })
    await whereSkattekontoRowOpen(supabase.from('skattekonto_transactions').select('id'), IB_DATE)
    expect(findCalls('skattekonto_transactions', 'eq')).toEqual([
      ['status', 'booked'],
      ['is_ignored', false],
    ])
    expect(findCalls('skattekonto_transactions', 'is')).toEqual([['journal_entry_id', null]])
    expect(findCalls('skattekonto_transactions', 'gte')).toEqual([['transaktionsdatum', IB_DATE]])
  })

  it('adds no date bound without an IB', async () => {
    const { supabase, findCalls, enqueue } = createQueuedMockSupabase()
    enqueue({ count: 2 })
    await whereSkattekontoRowOpen(supabase.from('skattekonto_transactions').select('id'), null)
    expect(findCalls('skattekonto_transactions', 'gte')).toEqual([])
  })
})

describe('readSkattekontoOpeningDate', () => {
  it('reads the latest IB on the company skattekonto account through the given day', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: '2012' })
    enqueue({ data: { floor_date: IB_DATE, amount: 5000, entry_ids: ['ib-1'] } })
    await expect(
      readSkattekontoOpeningDate(supabase as unknown as SupabaseClient, COMPANY, { through: '2026-11-19' }),
    ).resolves.toBe(IB_DATE)
    expect(supabase.rpc).toHaveBeenNthCalledWith(1, 'company_skattekonto_account', { p_company_id: COMPANY })
    expect(supabase.rpc).toHaveBeenNthCalledWith(2, 'account_ib_floor', {
      p_company_id: COMPANY,
      p_account_number: '2012',
      p_through: '2026-11-19',
    })
  })

  it('takes the account when the caller already holds it', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { floor_date: IB_DATE, amount: 5000, entry_ids: ['ib-1'] } })
    await readSkattekontoOpeningDate(supabase as unknown as SupabaseClient, COMPANY, { account: '1630', through: '2026-11-19' })
    expect(supabase.rpc).toHaveBeenCalledTimes(1)
    expect(supabase.rpc).toHaveBeenCalledWith('account_ib_floor', expect.objectContaining({ p_account_number: '1630' }))
  })

  it('answers null when the account has no IB', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null })
    await expect(
      readSkattekontoOpeningDate(supabase as unknown as SupabaseClient, COMPANY, { account: '1630' }),
    ).resolves.toBeNull()
  })

  it('throws when the IB cannot be read, so the caller decides', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ error: { message: 'boom' } })
    await expect(
      readSkattekontoOpeningDate(supabase as unknown as SupabaseClient, COMPANY, { account: '1630' }),
    ).rejects.toThrow(/ingående balans/)
  })
})
