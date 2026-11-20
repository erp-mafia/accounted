import { describe, it, expect } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createQueuedMockSupabase } from '@/tests/helpers'
import {
  AVGIFTER_LIABILITY_ACCOUNTS,
  findAvgifterLiabilityAccount,
  pickAvgifterLiabilityAccount,
  type AvgifterLiabilityEntry,
} from '../agi/avgifter-liability-account'

// accounted#68: the skattekonto's AGI draw must clear the account the
// company's own avgifter liability sits on, 2731 (the salary module) or the
// group account 2730 (other payroll systems, SIE history), never the other.

type Line = { account_number: string; debit_amount: number; credit_amount: number }

const credit = (account_number: string, amount: number): Line => ({
  account_number,
  debit_amount: 0,
  credit_amount: amount,
})
const debit = (account_number: string, amount: number): Line => ({
  account_number,
  debit_amount: amount,
  credit_amount: 0,
})
const entry = (entry_date: string, ...lines: Line[]): AvgifterLiabilityEntry => ({
  entry_date,
  journal_entry_lines: lines,
})

describe('AVGIFTER_LIABILITY_ACCOUNTS', () => {
  it('names the salary module account and the BAS group account', () => {
    expect(AVGIFTER_LIABILITY_ACCOUNTS).toEqual(['2731', '2730'])
  })
})

describe('pickAvgifterLiabilityAccount', () => {
  it('answers 2730 when the payroll books the liability on the group account (the bug case)', () => {
    expect(
      pickAvgifterLiabilityAccount([
        entry('2026-09-25', credit('2730', 22319)),
        entry('2026-09-12', debit('2730', 21645)),
      ]),
    ).toBe('2730')
  })

  it('answers 2731 after a salary run here', () => {
    expect(pickAvgifterLiabilityAccount([entry('2026-09-25', credit('2731', 9426.5))])).toBe('2731')
  })

  it('takes the newest booking when the company moved from 2730 to 2731', () => {
    expect(
      pickAvgifterLiabilityAccount([
        entry('2026-03-25', credit('2731', 9426)),
        entry('2026-02-12', debit('2730', 8800)),
        entry('2026-01-25', credit('2730', 8800)),
      ]),
    ).toBe('2731')
  })

  it('skips draws and payments (debits only) to reach the liability booking', () => {
    expect(
      pickAvgifterLiabilityAccount([
        entry('2026-10-12', debit('2731', 5000)),
        entry('2026-09-30', credit('2730', 5000)),
      ]),
    ).toBe('2730')
  })

  it('follows a move between the two accounts to the account it moves the liability to', () => {
    // The company moved its open liability onto 2731: the next draw clears it there.
    expect(
      pickAvgifterLiabilityAccount([
        entry('2026-09-30', debit('2730', 6284), credit('2731', 6284)),
        entry('2026-09-25', credit('2730', 3142)),
      ]),
    ).toBe('2731')
    // The other way: the wrong draws moved off 2731 onto the liability on 2730.
    expect(
      pickAvgifterLiabilityAccount([
        entry('2026-09-30', debit('2731', 96569), credit('2730', 96569)),
        entry('2026-09-25', credit('2731', 100)),
      ]),
    ).toBe('2730')
  })

  it('skips an ingående balans that carries the liability on both accounts', () => {
    expect(
      pickAvgifterLiabilityAccount([
        entry('2026-01-01', credit('2730', 1200), credit('2731', 800), debit('1930', 2000)),
        entry('2025-12-25', credit('2731', 800)),
      ]),
    ).toBe('2731')
  })

  it('answers null when the newest date books the liability on both accounts', () => {
    expect(
      pickAvgifterLiabilityAccount([
        entry('2026-09-25', credit('2730', 100)),
        entry('2026-09-25', credit('2731', 200)),
        entry('2026-08-25', credit('2731', 200)),
      ]),
    ).toBeNull()
  })

  it('answers null with no liability booking at all', () => {
    expect(pickAvgifterLiabilityAccount([])).toBeNull()
    expect(pickAvgifterLiabilityAccount([entry('2026-09-12', debit('2731', 100))])).toBeNull()
  })

  it('counts an ingående balans that carries the liability on one account', () => {
    expect(
      pickAvgifterLiabilityAccount([
        entry('2026-01-01', credit('2730', 18000), debit('1930', 18000)),
      ]),
    ).toBe('2730')
  })

  it('ignores lines on other accounts and an entry with no lines', () => {
    expect(
      pickAvgifterLiabilityAccount([
        { entry_date: '2026-09-26', journal_entry_lines: null },
        entry('2026-09-25', debit('7510', 3142), credit('2730', 3142)),
      ]),
    ).toBe('2730')
  })
})

describe('findAvgifterLiabilityAccount', () => {
  it('reads the newest posted liability bookings before the cutoff, without skattekonto or storno verifikat', async () => {
    const { supabase, enqueue, findCall, findCalls } = createQueuedMockSupabase()
    enqueue({ data: [entry('2026-09-25', credit('2730', 22319))] })

    const account = await findAvgifterLiabilityAccount(
      supabase as unknown as SupabaseClient,
      'company-1',
      '2026-10-12',
    )

    expect(account).toBe('2730')
    expect(findCall('journal_entries', 'eq')).toEqual(['company_id', 'company-1'])
    expect(findCalls('journal_entries', 'eq')).toContainEqual(['status', 'posted'])
    expect(findCall('journal_entries', 'not')).toEqual(['source_type', 'in', '(system,storno)'])
    expect(findCall('journal_entries', 'lte')).toEqual(['entry_date', '2026-10-12'])
    expect(findCall('journal_entries', 'gte')).toEqual(['entry_date', '2025-09-12'])
    expect(findCall('journal_entries', 'in')).toEqual(['journal_entry_lines.account_number', ['2731', '2730']])
    expect(findCall('journal_entries', 'order')).toEqual(['entry_date', { ascending: false }])
  })

  it('answers null on a failed read so the caller keeps its account', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ error: { message: 'boom' } })
    expect(
      await findAvgifterLiabilityAccount(supabase as unknown as SupabaseClient, 'company-1', '2026-10-12'),
    ).toBeNull()
  })
})
