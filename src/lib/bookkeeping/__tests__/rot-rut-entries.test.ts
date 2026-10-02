import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { CreateJournalEntryInput } from '@/types'

const mockCreateJournalEntry = vi.fn()
vi.mock('../engine', () => ({
  findFiscalPeriod: vi.fn().mockResolvedValue('period-1'),
  createJournalEntry: (...args: unknown[]) => mockCreateJournalEntry(...args),
}))

import { createRotRutPayoutEntry, createRotRutPayoutSetEntry } from '../rot-rut-entries'

const supabase = {} as SupabaseClient

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
