/**
 * The bank account a posted salary verifikat credits the net pay on: what a
 * booked run's payment file pays from (crm#1483).
 */
import { describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createTableMockSupabase } from '@/tests/helpers'
import { bookedNetPayAccount, postedNetPayAccount, type PostedSalaryEntry } from '../posted-run-entries'

const line = (account_number: string, debit: number, credit: number) => ({
  account_number,
  line_description: '',
  debit_amount: debit,
  credit_amount: credit,
})

const entry = (lines: PostedSalaryEntry['lines']): PostedSalaryEntry => ({
  description: 'Lön 2026-04',
  journal_entry_id: 'je-salary',
  voucher: 'K-12',
  lines,
})

describe('postedNetPayAccount', () => {
  it('names the bank account the net pay is credited on, not the tax or the cost lines', () => {
    expect(postedNetPayAccount(entry([line('7210', 26000, 0), line('2710', 0, 6000), line('1931', 0, 20000)]))).toBe('1931')
  })

  it('takes the account with the largest net credit when a rättelse spread the net pay', () => {
    expect(
      postedNetPayAccount(entry([line('7210', 26000, 0), line('2710', 0, 6000), line('1930', 0, 15000), line('1931', 0, 5000)])),
    ).toBe('1930')
    // A struck-and-replaced leg nets out on its account.
    expect(
      postedNetPayAccount(entry([line('7210', 26000, 0), line('2710', 0, 6000), line('1930', 0, 20000), line('1930', 20000, 0), line('1940', 0, 20000)])),
    ).toBe('1940')
  })

  it('answers null with no verifikat or no bank credit', () => {
    expect(postedNetPayAccount(null)).toBeNull()
    expect(postedNetPayAccount(entry([line('7210', 6000, 0), line('2710', 0, 6000)]))).toBeNull()
  })
})

describe('bookedNetPayAccount', () => {
  it('reads the posted salary verifikat of a booked run', async () => {
    const mock = createTableMockSupabase({
      journal_entries: {
        data: [
          {
            id: 'je-salary',
            description: 'Lön 2026-04',
            voucher_series: 'K',
            voucher_number: 12,
            lines: [line('7210', 26000, 0), line('2710', 0, 6000), line('1931', 0, 20000)],
          },
        ],
      },
    })
    const supabase = mock.supabase as unknown as SupabaseClient
    expect(await bookedNetPayAccount(supabase, 'company-1', { id: 'run-1', status: 'booked', salary_entry_id: 'je-salary' })).toBe('1931')
    expect(mock.findCalls('journal_entries', 'eq')).toContainEqual(['company_id', 'company-1'])
  })

  it('reads nothing for a run that is not booked: it books on the primary', async () => {
    const mock = createTableMockSupabase()
    const supabase = mock.supabase as unknown as SupabaseClient
    for (const status of ['approved', 'paid']) {
      expect(await bookedNetPayAccount(supabase, 'company-1', { id: 'run-1', status, salary_entry_id: null })).toBeNull()
    }
    expect(await bookedNetPayAccount(supabase, 'company-1', { id: 'run-1', status: 'booked', salary_entry_id: null })).toBeNull()
    expect(mock.tables()).toEqual([])
  })

  it('throws on a failed read instead of guessing the account', async () => {
    const mock = createTableMockSupabase({ journal_entries: { error: { message: 'boom' } } })
    await expect(
      bookedNetPayAccount(mock.supabase as unknown as SupabaseClient, 'company-1', {
        id: 'run-1',
        status: 'booked',
        salary_entry_id: 'je-salary',
      }),
    ).rejects.toMatchObject({ name: 'PostedSalaryEntriesReadError' })
  })
})
