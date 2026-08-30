import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'

const createJournalEntryMock = vi.fn()
const findFiscalPeriodMock = vi.fn()
const reverseEntryMock = vi.fn()
vi.mock('@/lib/bookkeeping/engine', () => ({
  createJournalEntry: (...args: unknown[]) => createJournalEntryMock(...args),
  findFiscalPeriod: (...args: unknown[]) => findFiscalPeriodMock(...args),
  reverseEntry: (...args: unknown[]) => reverseEntryMock(...args),
}))

const linkToJournalEntryMock = vi.fn()
vi.mock('@/lib/core/documents/document-service', () => ({
  linkToJournalEntry: (...args: unknown[]) => linkToJournalEntryMock(...args),
}))

const fetchExchangeRateMock = vi.fn()
vi.mock('@/lib/currency/riksbanken', () => ({
  fetchExchangeRate: (...args: unknown[]) => fetchExchangeRateMock(...args),
}))

import { registerExpenseClaim, createPayoutBatch, deleteExpenseClaim } from '../expense-claims-service'

const { supabase, enqueue, reset, findCall } = createQueuedMockSupabase()
// The queued mock is structurally sufficient for the service; the cast keeps
// the test honest about not being a real client.
const sb = supabase as unknown as import('@supabase/supabase-js').SupabaseClient

const COMPANY = 'company-1'
const USER = 'user-1'

describe('registerExpenseClaim', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    findFiscalPeriodMock.mockResolvedValue('period-1')
    createJournalEntryMock.mockResolvedValue({ id: 'je-1' })
  })

  it('books an SEK owner claim: cost + VAT debit, liability credit', async () => {
    enqueue({ data: { id: 'claim-1', amount_sek: 500, vat_sek: 100 } }) // insert
    enqueue({ data: null }) // journal_entry_id update

    const result = await registerExpenseClaim(sb, COMPANY, USER, {
      description: 'USB-hubb',
      expense_date: '2026-09-01',
      amount: 500,
      vat_amount: 100,
      currency: 'SEK',
      expense_account: '5410',
      claimant_name: 'Joakim Hansson',
    })

    expect(result.ok).toBe(true)
    const input = createJournalEntryMock.mock.calls[0][3]
    expect(input.source_type).toBe('expense_claim')
    expect(input.lines).toEqual([
      expect.objectContaining({ account_number: '5410', debit_amount: 400 }),
      expect.objectContaining({ account_number: '2641', debit_amount: 100 }),
      expect.objectContaining({ account_number: '2893', credit_amount: 500 }),
    ])
  })

  it('defaults an employee claim to liability 2820', async () => {
    enqueue({ data: { id: 'emp-1', first_name: 'Sofie', last_name: 'Persson' } }) // employee lookup
    enqueue({ data: { id: 'claim-1' } }) // insert
    enqueue({ data: null }) // update

    const result = await registerExpenseClaim(sb, COMPANY, USER, {
      description: 'Tågbiljett',
      expense_date: '2026-09-01',
      amount: 250,
      vat_amount: 15,
      currency: 'SEK',
      expense_account: '5810',
      employee_id: 'emp-1',
    })

    expect(result.ok).toBe(true)
    const liabilityLine = createJournalEntryMock.mock.calls[0][3].lines.at(-1)
    expect(liabilityLine.account_number).toBe('2820')
    const insert = findCall('expense_claims', 'insert')
    expect(insert?.[0]).toMatchObject({ claimant_name: 'Sofie Persson', liability_account: '2820' })
  })

  it('converts foreign currency at the explicit rate, VAT included', async () => {
    enqueue({ data: { id: 'claim-1' } }) // insert
    enqueue({ data: null }) // update

    const result = await registerExpenseClaim(sb, COMPANY, USER, {
      description: 'Plaud Note Pro',
      expense_date: '2026-08-21',
      amount: 189.99,
      vat_amount: 38,
      currency: 'EUR',
      exchange_rate: 11.0625,
      expense_account: '5410',
      claimant_name: 'Joakim Hansson',
    })

    expect(result.ok).toBe(true)
    const lines = createJournalEntryMock.mock.calls[0][3].lines
    expect(lines[0]).toMatchObject({ account_number: '5410', debit_amount: 1681.38 })
    expect(lines[1]).toMatchObject({ account_number: '2641', debit_amount: 420.38 })
    expect(lines[2]).toMatchObject({ account_number: '2893', credit_amount: 2101.76 })
    expect(fetchExchangeRateMock).not.toHaveBeenCalled()
  })

  it('fails with RATE_UNAVAILABLE when Riksbanken has no rate', async () => {
    fetchExchangeRateMock.mockResolvedValue(null)

    const result = await registerExpenseClaim(sb, COMPANY, USER, {
      description: 'SaaS',
      expense_date: '2026-09-01',
      amount: 20,
      vat_amount: 0,
      currency: 'USD',
      expense_account: '6540',
      claimant_name: 'Joakim',
    })

    expect(result).toEqual({ ok: false, code: 'RATE_UNAVAILABLE' })
    expect(createJournalEntryMock).not.toHaveBeenCalled()
  })

  it('rejects VAT >= amount before touching the database', async () => {
    const result = await registerExpenseClaim(sb, COMPANY, USER, {
      description: 'x',
      expense_date: '2026-09-01',
      amount: 100,
      vat_amount: 100,
      currency: 'SEK',
      expense_account: '5410',
      claimant_name: 'Joakim',
    })
    expect(result).toEqual({ ok: false, code: 'VAT_EXCEEDS_AMOUNT' })
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('requires a claimant when no employee is given', async () => {
    const result = await registerExpenseClaim(sb, COMPANY, USER, {
      description: 'x',
      expense_date: '2026-09-01',
      amount: 100,
      vat_amount: 0,
      currency: 'SEK',
      expense_account: '5410',
    })
    expect(result).toEqual({ ok: false, code: 'CLAIMANT_REQUIRED' })
  })

  it('returns EMPLOYEE_NOT_FOUND for an employee outside the company', async () => {
    enqueue({ data: null }) // employee lookup

    const result = await registerExpenseClaim(sb, COMPANY, USER, {
      description: 'x',
      expense_date: '2026-09-01',
      amount: 100,
      vat_amount: 0,
      currency: 'SEK',
      expense_account: '5410',
      employee_id: 'emp-x',
    })
    expect(result).toEqual({ ok: false, code: 'EMPLOYEE_NOT_FOUND' })
  })

  it('removes the claim row again when the booking throws', async () => {
    enqueue({ data: { id: 'claim-1' } }) // insert
    enqueue({ data: null }) // delete (cleanup)
    createJournalEntryMock.mockRejectedValue(new Error('period locked'))

    await expect(
      registerExpenseClaim(sb, COMPANY, USER, {
        description: 'x',
        expense_date: '2026-09-01',
        amount: 100,
        vat_amount: 0,
        currency: 'SEK',
        expense_account: '5410',
        claimant_name: 'Joakim',
      }),
    ).rejects.toThrow('period locked')

    expect(findCall('expense_claims', 'delete')).toBeTruthy()
  })
})

describe('createPayoutBatch', () => {
  const registeredClaim = (over: Record<string, unknown> = {}) => ({
    id: 'c1',
    employee_id: null,
    claimant_name: 'Joakim Hansson',
    amount_sek: 500,
    liability_account: '2893',
    status: 'registered',
    ...over,
  })

  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    findFiscalPeriodMock.mockResolvedValue('period-1')
    createJournalEntryMock.mockResolvedValue({ id: 'je-2' })
  })

  it('books one payout verifikat covering all claims and marks them paid', async () => {
    enqueue({ data: [registeredClaim(), registeredClaim({ id: 'c2', amount_sek: 1601.77 })] })
    enqueue({ data: { id: 'batch-1' } }) // batch insert
    enqueue({ data: null }) // batch je update
    enqueue({ data: null }) // claims mark paid

    const result = await createPayoutBatch(sb, COMPANY, USER, {
      claim_ids: ['c1', 'c2'],
      payout_date: '2026-09-05',
      cash_account: '1935',
    })

    expect(result).toMatchObject({ ok: true, total_sek: 2101.77, claim_count: 2 })
    const input = createJournalEntryMock.mock.calls[0][3]
    expect(input.source_type).toBe('expense_payout')
    expect(input.lines).toEqual([
      expect.objectContaining({ account_number: '2893', debit_amount: 2101.77 }),
      expect.objectContaining({ account_number: '1935', credit_amount: 2101.77 }),
    ])
    const mark = findCall('expense_claims', 'update')
    expect(mark?.[0]).toMatchObject({ status: 'paid', payout_batch_id: 'batch-1' })
  })

  it('refuses to mix claimants in one payout', async () => {
    enqueue({
      data: [registeredClaim(), registeredClaim({ id: 'c2', employee_id: 'emp-1' })],
    })

    const result = await createPayoutBatch(sb, COMPANY, USER, {
      claim_ids: ['c1', 'c2'],
      payout_date: '2026-09-05',
      cash_account: '1935',
    })
    expect(result).toEqual({ ok: false, code: 'MIXED_CLAIMANTS' })
    expect(createJournalEntryMock).not.toHaveBeenCalled()
  })

  it('refuses claims that are already paid', async () => {
    enqueue({ data: [registeredClaim({ status: 'paid' })] })

    const result = await createPayoutBatch(sb, COMPANY, USER, {
      claim_ids: ['c1'],
      payout_date: '2026-09-05',
      cash_account: '1935',
    })
    expect(result).toEqual({ ok: false, code: 'ALREADY_PAID' })
  })

  it('removes the batch again when the booking throws', async () => {
    enqueue({ data: [registeredClaim()] })
    enqueue({ data: { id: 'batch-1' } }) // insert
    enqueue({ data: null }) // delete (cleanup)
    createJournalEntryMock.mockRejectedValue(new Error('period locked'))

    await expect(
      createPayoutBatch(sb, COMPANY, USER, {
        claim_ids: ['c1'],
        payout_date: '2026-09-05',
        cash_account: '1935',
      }),
    ).rejects.toThrow('period locked')

    expect(findCall('expense_payout_batches', 'delete')).toBeTruthy()
  })
})

describe('deleteExpenseClaim', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    reverseEntryMock.mockResolvedValue({ id: 'je-storno' })
  })

  it('reverses the verifikat and removes the row', async () => {
    enqueue({ data: { id: 'c1', status: 'registered', journal_entry_id: 'je-1' } })
    enqueue({ data: null }) // delete

    const result = await deleteExpenseClaim(sb, COMPANY, USER, 'c1')
    expect(result).toEqual({ ok: true, reversal_entry_id: 'je-storno' })
    expect(reverseEntryMock).toHaveBeenCalledWith(sb, COMPANY, USER, 'je-1')
    expect(findCall('expense_claims', 'delete')).toBeTruthy()
  })

  it('refuses a paid claim', async () => {
    enqueue({ data: { id: 'c1', status: 'paid', journal_entry_id: 'je-1' } })
    const result = await deleteExpenseClaim(sb, COMPANY, USER, 'c1')
    expect(result).toEqual({ ok: false, code: 'ALREADY_PAID' })
    expect(reverseEntryMock).not.toHaveBeenCalled()
  })

  it('answers NOT_FOUND for an unknown claim', async () => {
    enqueue({ data: null })
    const result = await deleteExpenseClaim(sb, COMPANY, USER, 'c-x')
    expect(result).toEqual({ ok: false, code: 'NOT_FOUND' })
  })
})
