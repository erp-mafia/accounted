/**
 * One ingående balans per fiscal year (ÅRL 2:4: IB is the previous year's UB).
 * assertNoOpeningBalance is the question every IB writer asks before it draws
 * a voucher number; linkOpeningBalance is the pointer every writer sets.
 */
import { describe, expect, it } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import {
  assertNoOpeningBalance,
  linkOpeningBalance,
  OpeningBalanceExistsError,
  OPENING_BALANCE_EXISTS_CODE,
} from '../existing'

const NO_POINTER = { opening_balances_set: false, opening_balance_entry_id: null, opening_balance_entry: null }

describe('assertNoOpeningBalance', () => {
  it('refuses a year whose pointer names an IB', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({
      data: {
        opening_balances_set: true,
        opening_balance_entry_id: 'ib-1',
        opening_balance_entry: { voucher_series: 'A', voucher_number: 1 },
      },
    })

    const err = await assertNoOpeningBalance(supabase as never, 'company-1', 'fp-1').catch((e) => e)

    expect(err).toBeInstanceOf(OpeningBalanceExistsError)
    expect(err.code).toBe(OPENING_BALANCE_EXISTS_CODE)
    expect(err.existing).toMatchObject({ journal_entry_id: 'ib-1', linked: true })
    expect(err.message).toContain('redan en ingående balans')
  })

  it('refuses a posted IB verifikat that no pointer names (booked as a voucher)', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: NO_POINTER })
    enqueue({ data: [{ id: 'ib-voucher', voucher_series: 'A', voucher_number: 4 }] })

    const err = await assertNoOpeningBalance(supabase as never, 'company-1', 'fp-1').catch((e) => e)

    expect(err).toBeInstanceOf(OpeningBalanceExistsError)
    expect(err.existing).toMatchObject({ journal_entry_id: 'ib-voucher', linked: false })
  })

  it('passes a year with no pointer and no posted IB', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: NO_POINTER })
    enqueue({ data: [] })

    await expect(assertNoOpeningBalance(supabase as never, 'company-1', 'fp-1')).resolves.toBeUndefined()
    // Only posted IBs count: a reversed one leaves the year open for a new IB.
    expect(findCalls('journal_entries', 'eq')).toContainEqual(['status', 'posted'])
    expect(findCalls('journal_entries', 'eq')).toContainEqual(['company_id', 'company-1'])
  })

  it('fails closed when the read fails', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ error: { message: 'connection reset' } })

    await expect(assertNoOpeningBalance(supabase as never, 'company-1', 'fp-1')).rejects.toThrow('connection reset')
  })
})

describe('linkOpeningBalance', () => {
  it('sets the pointer and the flag on the company\'s year', async () => {
    const { supabase, enqueue, findCall, findCalls } = createQueuedMockSupabase()
    enqueue({ data: null })

    const error = await linkOpeningBalance(supabase as never, 'company-1', 'fp-1', 'ib-1')

    expect(error).toBeNull()
    expect(findCall('fiscal_periods', 'update')).toEqual([{ opening_balance_entry_id: 'ib-1', opening_balances_set: true }])
    expect(findCalls('fiscal_periods', 'eq')).toEqual([
      ['id', 'fp-1'],
      ['company_id', 'company-1'],
    ])
  })

  it('returns the update error for the caller to report', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ error: { message: 'immutable' } })

    expect(await linkOpeningBalance(supabase as never, 'company-1', 'fp-1', 'ib-1')).toEqual({ message: 'immutable' })
  })
})
