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

  it('books an enskild firma owner claim on 2018 (egen insättning)', async () => {
    enqueue({ data: { entity_type: 'enskild_firma' } }) // companies entity_type
    enqueue({ data: { id: 'claim-ef', amount_sek: 500, vat_sek: 100 } }) // insert
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
    expect(input.lines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ account_number: '2018', credit_amount: 500 }),
      ]),
    )
    const insertCall = findCall('expense_claims', 'insert')
    expect(insertCall?.[0]).toEqual(
      expect.objectContaining({ liability_account: '2018' }),
    )
  })

  it('books an SEK owner claim: cost + VAT debit, liability credit', async () => {
    enqueue({ data: { entity_type: 'aktiebolag' } }) // companies entity_type
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
    enqueue({ data: { entity_type: 'aktiebolag' } }) // companies entity_type
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

  it('takes the claimant name from the employee row, ignoring a mismatched one', async () => {
    enqueue({ data: { entity_type: 'aktiebolag' } }) // companies entity_type
    enqueue({ data: { id: 'emp-1', first_name: 'Sofie', last_name: 'Persson' } }) // employee
    enqueue({ data: { id: 'claim-x', amount_sek: 500, vat_sek: 100 } }) // insert
    enqueue({ data: null }) // journal_entry_id update

    const result = await registerExpenseClaim(sb, COMPANY, USER, {
      description: 'USB-hubb',
      expense_date: '2026-09-01',
      amount: 500,
      vat_amount: 100,
      currency: 'SEK',
      expense_account: '5410',
      employee_id: 'emp-1',
      claimant_name: 'Någon Annan',
    })

    expect(result.ok).toBe(true)
    const insert = findCall('expense_claims', 'insert')
    expect(insert?.[0]).toMatchObject({
      claimant_name: 'Sofie Persson',
      liability_account: '2820',
    })
  })

  it('converts foreign currency at the explicit rate, VAT included', async () => {
    enqueue({ data: { entity_type: 'aktiebolag' } }) // companies entity_type
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
    enqueue({ data: { entity_type: 'aktiebolag' } }) // companies entity_type
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
    enqueue({ data: { entity_type: 'aktiebolag' } }) // companies entity_type
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
    enqueue({ data: { entity_type: 'aktiebolag' } }) // companies entity_type
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

  it('links an unanchored receipt document to the new verifikat', async () => {
    enqueue({ data: { entity_type: 'aktiebolag' } }) // companies entity_type
    enqueue({ data: { id: 'claim-1' } }) // insert
    enqueue({ data: null }) // journal_entry_id update
    enqueue({ data: { journal_entry_id: null, user_id: 'user-1', storage_path: 'p', file_name: 'kvitto.pdf', file_size_bytes: 1, mime_type: 'application/pdf', sha256_hash: 'x', uploaded_by: 'user-1', upload_source: 'file_upload' } }) // document lookup
    enqueue({ data: null }) // inbox item update

    const result = await registerExpenseClaim(sb, COMPANY, USER, {
      description: 'Kvitto',
      expense_date: '2026-09-01',
      amount: 100,
      vat_amount: 0,
      currency: 'SEK',
      expense_account: '5410',
      claimant_name: 'Joakim',
      document_id: 'doc-1',
      inbox_item_id: 'inbox-1',
    })

    expect(result.ok).toBe(true)
    expect(linkToJournalEntryMock).toHaveBeenCalledWith(sb, COMPANY, 'doc-1', 'je-1')
  })

  it('copies an already-anchored receipt instead of re-pointing it (BFL immutability)', async () => {
    enqueue({ data: { entity_type: 'aktiebolag' } }) // companies entity_type
    enqueue({ data: { id: 'claim-1' } }) // insert
    enqueue({ data: null }) // journal_entry_id update
    enqueue({ data: { journal_entry_id: 'je-old', user_id: 'user-1', storage_path: 'receipts/plaud.pdf', file_name: 'plaud.pdf', file_size_bytes: 42, mime_type: 'application/pdf', sha256_hash: 'abc', uploaded_by: 'user-1', upload_source: 'file_upload' } }) // document lookup
    enqueue({ data: { id: 'doc-copy' } }) // attachment copy insert
    enqueue({ data: null }) // claim document_id update

    const result = await registerExpenseClaim(sb, COMPANY, USER, {
      description: 'Kvitto',
      expense_date: '2026-09-01',
      amount: 100,
      vat_amount: 0,
      currency: 'SEK',
      expense_account: '5410',
      claimant_name: 'Joakim',
      document_id: 'doc-1',
    })

    expect(result.ok).toBe(true)
    expect(linkToJournalEntryMock).not.toHaveBeenCalled()
    const copy = findCall('document_attachments', 'insert')
    expect(copy?.[0]).toMatchObject({
      storage_path: 'receipts/plaud.pdf',
      sha256_hash: 'abc',
      journal_entry_id: 'je-1',
    })
  })

  it('books custom lines (reverse charge) converted at the claim rate', async () => {
    enqueue({ data: { entity_type: 'aktiebolag' } }) // companies entity_type
    enqueue({ data: { id: 'claim-1' } }) // insert
    enqueue({ data: null }) // update

    const result = await registerExpenseClaim(sb, COMPANY, USER, {
      description: 'Plaud Annual',
      expense_date: '2026-09-01',
      amount: 299.99,
      vat_amount: 0,
      currency: 'USD',
      exchange_rate: 10,
      expense_account: '4531',
      claimant_name: 'Joakim',
      lines: [
        { account_number: '4531', debit_amount: 239.99, credit_amount: 0 },
        { account_number: '6992', debit_amount: 60, credit_amount: 0 },
        { account_number: '2645', debit_amount: 60, credit_amount: 0 },
        { account_number: '2614', debit_amount: 0, credit_amount: 60 },
        { account_number: '2893', debit_amount: 0, credit_amount: 299.99 },
      ],
    })

    expect(result.ok).toBe(true)
    const input = createJournalEntryMock.mock.calls[0][3]
    const byAccount = Object.fromEntries(input.lines.map((l: { account_number: string }) => [l.account_number, l]))
    expect(byAccount['2893'].credit_amount).toBe(2999.9)
    expect(byAccount['4531'].debit_amount).toBeCloseTo(2399.9, 1)
    expect(byAccount['2614'].credit_amount).toBe(600)
    // Displayed VAT: no 2641 line, so the claim carries zero deductible VAT.
    const insert = findCall('expense_claims', 'insert')
    expect(insert?.[0]).toMatchObject({ vat_sek: 0 })
  })

  it('rejects unbalanced custom lines before touching the ledger', async () => {
    enqueue({ data: { entity_type: 'aktiebolag' } }) // companies entity_type
    const result = await registerExpenseClaim(sb, COMPANY, USER, {
      description: 'x',
      expense_date: '2026-09-01',
      amount: 100,
      vat_amount: 0,
      currency: 'SEK',
      expense_account: '5410',
      claimant_name: 'Joakim',
      lines: [
        { account_number: '5410', debit_amount: 90, credit_amount: 0 },
        { account_number: '2893', debit_amount: 0, credit_amount: 100 },
      ],
    })
    expect(result).toMatchObject({ ok: false, code: 'INVALID_LINES' })
    expect(createJournalEntryMock).not.toHaveBeenCalled()
  })

  it('rejects custom lines whose liability credit does not match the gross', async () => {
    enqueue({ data: { entity_type: 'aktiebolag' } }) // companies entity_type
    const result = await registerExpenseClaim(sb, COMPANY, USER, {
      description: 'x',
      expense_date: '2026-09-01',
      amount: 100,
      vat_amount: 0,
      currency: 'SEK',
      expense_account: '5410',
      claimant_name: 'Joakim',
      lines: [
        { account_number: '5410', debit_amount: 90, credit_amount: 0 },
        { account_number: '2893', debit_amount: 0, credit_amount: 90 },
      ],
    })
    expect(result).toMatchObject({ ok: false, code: 'INVALID_LINES' })
  })

  it('removes the claim row again when the booking throws', async () => {
    enqueue({ data: { entity_type: 'aktiebolag' } }) // companies entity_type
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
  const rpcCalls = () => (sb.rpc as unknown as { mock: { calls: unknown[][] } }).mock.calls

  beforeEach(() => {
    vi.clearAllMocks()
    reset()
  })

  it('returns NO_CLAIMS without calling the RPC', async () => {
    const result = await createPayoutBatch(sb, COMPANY, USER, {
      claim_ids: [],
      payout_date: '2026-09-05',
      cash_account: '1935',
    })
    expect(result).toEqual({ ok: false, code: 'NO_CLAIMS' })
    expect(rpcCalls()).toHaveLength(0)
  })

  it('books the payout through the atomic RPC with deduplicated claim ids', async () => {
    enqueue({
      data: {
        ok: true,
        batch_id: 'batch-1',
        journal_entry_id: 'je-2',
        voucher_number: 7,
        total_sek: '2101.77',
        claim_count: 2,
      },
    })

    const result = await createPayoutBatch(sb, COMPANY, USER, {
      claim_ids: ['c1', 'c2', 'c1'],
      payout_date: '2026-09-05',
      cash_account: '1935',
      notes: 'Septemberutlägg',
    })

    expect(result).toEqual({
      ok: true,
      batch_id: 'batch-1',
      journal_entry_id: 'je-2',
      voucher_number: 7,
      total_sek: 2101.77,
      claim_count: 2,
    })
    expect(rpcCalls()).toHaveLength(1)
    expect(rpcCalls()[0][0]).toBe('create_expense_payout_batch')
    expect(rpcCalls()[0][1]).toEqual({
      p_company_id: COMPANY,
      p_claim_ids: ['c1', 'c2'],
      p_payout_date: '2026-09-05',
      p_cash_account: '1935',
      p_notes: 'Septemberutlägg',
      p_user_id: USER,
    })
    // No journal write happens outside the RPC.
    expect(createJournalEntryMock).not.toHaveBeenCalled()
    expect(reverseEntryMock).not.toHaveBeenCalled()
  })

  it('echoes a refusal code from the RPC (claims already paid by a concurrent request)', async () => {
    enqueue({ data: { ok: false, code: 'ALREADY_PAID', details: { claim_id: 'c1' } } })

    const result = await createPayoutBatch(sb, COMPANY, USER, {
      claim_ids: ['c1'],
      payout_date: '2026-09-05',
      cash_account: '1935',
    })
    expect(result).toEqual({ ok: false, code: 'ALREADY_PAID', detail: '{"claim_id":"c1"}' })
  })

  it('maps an unknown refusal code to BATCH_INSERT_FAILED', async () => {
    enqueue({ data: { ok: false, code: 'SOMETHING_NEW' } })

    const result = await createPayoutBatch(sb, COMPANY, USER, {
      claim_ids: ['c1'],
      payout_date: '2026-09-05',
      cash_account: '1935',
    })
    expect(result).toMatchObject({ ok: false, code: 'BATCH_INSERT_FAILED', detail: 'SOMETHING_NEW' })
  })

  it('reports a database error (period lock trigger) as BATCH_INSERT_FAILED with the message', async () => {
    enqueue({ data: null, error: { message: 'Perioden är låst', code: 'P0001' } })

    const result = await createPayoutBatch(sb, COMPANY, USER, {
      claim_ids: ['c1'],
      payout_date: '2026-09-05',
      cash_account: '1935',
    })
    expect(result).toEqual({ ok: false, code: 'BATCH_INSERT_FAILED', detail: 'Perioden är låst' })
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
    enqueue({ data: { status: 'posted', reversed_by_id: null } }) // entry status
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

  it('reuses an existing storno when a previous delete already reversed the entry', async () => {
    // Retry after a delete that failed with the storno already posted: the
    // entry is 'reversed', so reverseEntry would refuse it.
    enqueue({ data: { id: 'c1', status: 'registered', journal_entry_id: 'je-1' } })
    enqueue({ data: { status: 'reversed', reversed_by_id: 'je-storno-1' } })
    enqueue({ data: null }) // delete

    const result = await deleteExpenseClaim(sb, COMPANY, USER, 'c1')
    expect(result).toEqual({ ok: true, reversal_entry_id: 'je-storno-1' })
    expect(reverseEntryMock).not.toHaveBeenCalled()
  })

  it('answers NOT_FOUND for an unknown claim', async () => {
    enqueue({ data: null })
    const result = await deleteExpenseClaim(sb, COMPANY, USER, 'c-x')
    expect(result).toEqual({ ok: false, code: 'NOT_FOUND' })
  })
})
