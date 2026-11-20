import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createQueuedMockSupabase } from '@/tests/helpers'
import type { CreateJournalEntryInput } from '@/types'

const mockCreateJournalEntry = vi.fn()
vi.mock('../engine', () => ({
  findFiscalPeriod: vi.fn().mockResolvedValue('period-1'),
  createJournalEntry: (...args: unknown[]) => mockCreateJournalEntry(...args),
}))

import { createRotRutPayoutEntry, createRotRutPayoutSetEntry } from '../rot-rut-entries'

// Only the primary test answers the cash_accounts reads: a payout elsewhere in
// this file names no account and books on the 1930 fallback.
const { supabase: mockSupabase, enqueue, reset, findCalls } = createQueuedMockSupabase()
const supabase = mockSupabase as unknown as SupabaseClient

function bookedLines() {
  const input = mockCreateJournalEntry.mock.calls[0][3] as CreateJournalEntryInput
  return input.lines.map((l) => ({
    account: l.account_number,
    debit: l.debit_amount,
    credit: l.credit_amount,
  }))
}

function expectBalanced() {
  const lines = bookedLines()
  const debit = Math.round(lines.reduce((s, l) => s + l.debit, 0) * 100) / 100
  const credit = Math.round(lines.reduce((s, l) => s + l.credit, 0) * 100) / 100
  expect(debit).toBe(credit)
}

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  mockCreateJournalEntry.mockResolvedValue({ id: 'je-1' })
})

const base = {
  requestId: 'req-1',
  requestName: 'ROT 2026-07',
  deductionType: 'rot' as const,
  paymentDate: '2026-07-10',
}

describe('createRotRutPayoutEntry öre rounding', () => {
  it('credits 1513 with the full receivable and debits 3740 the remainder', async () => {
    await createRotRutPayoutEntry(supabase, 'company-1', 'user-1', {
      ...base,
      amount: 671,
      oreRounding: 0.25,
    })
    expect(bookedLines()).toEqual([
      { account: '1930', debit: 671, credit: 0 },
      { account: '3740', debit: 0.25, credit: 0 },
      { account: '1513', debit: 0, credit: 671.25 },
    ])
    expectBalanced()
  })

  it('books no 3740 line for a whole-kronor receivable', async () => {
    await createRotRutPayoutEntry(supabase, 'company-1', 'user-1', { ...base, amount: 3000, oreRounding: 0 })
    expect(bookedLines()).toEqual([
      { account: '1930', debit: 3000, credit: 0 },
      { account: '1513', debit: 0, credit: 3000 },
    ])
  })

  it('keeps the voucher unchanged when no rounding is passed', async () => {
    await createRotRutPayoutEntry(supabase, 'company-1', 'user-1', { ...base, amount: 3000 })
    expect(bookedLines().map((l) => l.account)).toEqual(['1930', '1513'])
  })

  it('allows a krona or more across several invoices (under a krona each)', async () => {
    await createRotRutPayoutEntry(supabase, 'company-1', 'user-1', {
      ...base,
      amount: 1871,
      oreRounding: 1.25,
      invoiceCount: 2,
    })
    expect(bookedLines()).toEqual([
      { account: '1930', debit: 1871, credit: 0 },
      { account: '3740', debit: 1.25, credit: 0 },
      { account: '1513', debit: 0, credit: 1872.25 },
    ])
    expectBalanced()
  })

  it('refuses a krona or more per invoice: that is never rounding', async () => {
    await expect(
      createRotRutPayoutEntry(supabase, 'company-1', 'user-1', {
        ...base,
        amount: 1871,
        oreRounding: 2,
        invoiceCount: 2,
      }),
    ).rejects.toThrow(/Invalid öre rounding/)
  })

  it('refuses a remainder of a krona or more: that is never rounding', async () => {
    await expect(
      createRotRutPayoutEntry(supabase, 'company-1', 'user-1', { ...base, amount: 671, oreRounding: 1 }),
    ).rejects.toThrow(/Invalid öre rounding/)
    await expect(
      createRotRutPayoutEntry(supabase, 'company-1', 'user-1', { ...base, amount: 671, oreRounding: -0.1 }),
    ).rejects.toThrow(/Invalid öre rounding/)
    expect(mockCreateJournalEntry).not.toHaveBeenCalled()
  })
})

describe('createRotRutPayoutSetEntry öre rounding', () => {
  it('rounds per leg, keeps the bank leg at the transfer', async () => {
    await createRotRutPayoutSetEntry(supabase, 'company-1', 'user-1', {
      paymentDate: '2026-07-10',
      legs: [
        { requestId: 'req-1', requestName: 'ROT A', deductionType: 'rot', amount: 2500, oreRounding: 0 },
        { requestId: 'req-2', requestName: 'RUT B', deductionType: 'rut', amount: 2250, oreRounding: 0.75 },
      ],
    })
    expect(bookedLines()).toEqual([
      { account: '1930', debit: 4750, credit: 0 },
      { account: '3740', debit: 0.75, credit: 0 },
      { account: '1513', debit: 0, credit: 2500 },
      { account: '1513', debit: 0, credit: 2250.75 },
    ])
    expectBalanced()
  })
})

describe('the account a payout lands on', () => {
  const legs = [{ requestId: 'req-1', requestName: 'ROT A', deductionType: 'rot' as const, amount: 2500 }]

  it('books on the primary bank account when told none', async () => {
    enqueue({ data: { id: 'ca-1931', ledger_account: '1931', enabled: true, currency: 'SEK' } })

    await createRotRutPayoutSetEntry(supabase, 'company-1', 'user-1', { paymentDate: '2026-07-10', legs })

    expect(bookedLines()).toEqual([
      { account: '1931', debit: 2500, credit: 0 },
      { account: '1513', debit: 0, credit: 2500 },
    ])
    expect(findCalls('cash_accounts', 'eq')).toEqual([
      ['company_id', 'company-1'],
      ['is_primary', true],
    ])
  })

  it('books on a named bank account without reading the primary', async () => {
    await createRotRutPayoutSetEntry(supabase, 'company-1', 'user-1', { paymentDate: '2026-07-10', bankAccount: '1940', legs })

    expect(bookedLines()).toEqual([
      { account: '1940', debit: 2500, credit: 0 },
      { account: '1513', debit: 0, credit: 2500 },
    ])
    expect(mockSupabase.from).not.toHaveBeenCalled()
  })
})

describe('kontantmetoden: a leg that recognises the deduction share', () => {
  const recognition = {
    amount: 3000,
    lines: [
      { account_number: '3001', debit_amount: 0, credit_amount: 2400, line_description: 'Försäljning faktura 1042, ROT-avdrag' },
      { account_number: '2611', debit_amount: 0, credit_amount: 600, line_description: 'Utgående moms 25% faktura 1042, ROT-avdrag' },
    ],
  }

  it('books revenue and moms instead of 1513 when the whole leg is recognised', async () => {
    await createRotRutPayoutEntry(supabase, 'company-1', 'user-1', { ...base, amount: 3000, recognition })
    expect(bookedLines()).toEqual([
      { account: '1930', debit: 3000, credit: 0 },
      { account: '3001', debit: 0, credit: 2400 },
      { account: '2611', debit: 0, credit: 600 },
    ])
    expectBalanced()
  })

  it('clears 1513 with the rest of a leg that also pays invoices booked on 1513', async () => {
    await createRotRutPayoutSetEntry(supabase, 'company-1', 'user-1', {
      paymentDate: '2026-07-10',
      legs: [{ ...base, amount: 5000, oreRounding: 0.4, invoiceCount: 2, recognition }],
    })
    expect(bookedLines()).toEqual([
      { account: '1930', debit: 5000, credit: 0 },
      { account: '3740', debit: 0.4, credit: 0 },
      { account: '1513', debit: 0, credit: 2000.4 },
      { account: '3001', debit: 0, credit: 2400 },
      { account: '2611', debit: 0, credit: 600 },
    ])
    expectBalanced()
  })

  it('refuses a recognition above the leg or one its lines do not carry exactly', async () => {
    await expect(
      createRotRutPayoutEntry(supabase, 'company-1', 'user-1', { ...base, amount: 2000, recognition }),
    ).rejects.toThrow(/Invalid revenue recognition/)
    await expect(
      createRotRutPayoutEntry(supabase, 'company-1', 'user-1', {
        ...base,
        amount: 3000,
        recognition: { ...recognition, amount: 2999 },
      }),
    ).rejects.toThrow(/Invalid revenue recognition/)
    expect(mockCreateJournalEntry).not.toHaveBeenCalled()
  })
})
