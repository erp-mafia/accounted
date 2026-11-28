import { describe, it, expect, vi, beforeEach } from 'vitest'

// The pair guard (lib/operations/inbox-pair-guard.ts, tested there): here only that the door asks and obeys.
const refuseWhenPairBookedMock = vi.hoisted(() => vi.fn())
vi.mock('@/lib/operations/inbox-pair-guard', () => ({
  refuseWhenPairBooked: (...args: unknown[]) => refuseWhenPairBookedMock(...args),
}))

import { createQueuedMockSupabase } from '@/tests/helpers'

const createJournalEntryMock = vi.fn()
const findFiscalPeriodMock = vi.fn()
const reverseEntryMock = vi.fn()
vi.mock('@/lib/bookkeeping/engine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/bookkeeping/engine')>()
  return {
    // The real payout door: it calls the RPC asserted below, then reloads the
    // posted verifikat to announce it.
    commitExpensePayoutBatch: actual.commitExpensePayoutBatch,
    createJournalEntry: (...args: unknown[]) => createJournalEntryMock(...args),
    findFiscalPeriod: (...args: unknown[]) => findFiscalPeriodMock(...args),
    reverseEntry: (...args: unknown[]) => reverseEntryMock(...args),
  }
})

const linkToJournalEntryMock = vi.fn()
vi.mock('@/lib/core/documents/document-service', () => ({
  linkToJournalEntry: (...args: unknown[]) => linkToJournalEntryMock(...args),
}))

const fetchExchangeRateMock = vi.fn()
vi.mock('@/lib/currency/riksbanken', () => ({
  fetchExchangeRate: (...args: unknown[]) => fetchExchangeRateMock(...args),
}))

// Utlägg on a payslip (#2331): the delete guard's lookup is mocked so the
// queued Supabase mock keeps its existing call order.
const findPayslipLineForClaimMock = vi.fn()
vi.mock('@/lib/salary/expense-claim-lines', () => ({
  findPayslipLineForClaim: (...args: unknown[]) => findPayslipLineForClaimMock(...args),
}))

import { registerExpenseClaim, createPayoutBatch, deleteExpenseClaim } from '../expense-claims-service'
import { invalidateRunCalculation } from '@/lib/salary/invalidate-calculation'

// The step every input write takes has its own suite (invalidate-calculation.test.ts).
vi.mock('@/lib/salary/invalidate-calculation', async (original) => ({
  ...(await original<typeof import('@/lib/salary/invalidate-calculation')>()),
  invalidateRunCalculation: vi.fn(async () => null),
}))

const { supabase, enqueue, reset, findCall, findCalls } = createQueuedMockSupabase()
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
    enqueue({ data: { created_journal_entry_id: null, created_supplier_invoice_id: null } }) // inbox item read
    enqueue({ data: { id: 'claim-1' } }) // insert
    enqueue({ data: null }) // journal_entry_id update
    enqueue({ data: [{ id: 'inbox-1' }] }) // inbox item claim (compare-and-set)
    enqueue({ data: { journal_entry_id: null, user_id: 'user-1', storage_path: 'p', file_name: 'kvitto.pdf', file_size_bytes: 1, mime_type: 'application/pdf', sha256_hash: 'x', uploaded_by: 'user-1', upload_source: 'file_upload' } }) // document lookup

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
    expect(linkToJournalEntryMock).toHaveBeenCalledWith(sb, COMPANY, 'doc-1', 'je-1', { link_basis: 'user_created', link_evidence: null })
    expect(findCalls('invoice_inbox_items', 'update')).toEqual([[{ created_journal_entry_id: 'je-1' }]])
    expect(findCalls('invoice_inbox_items', 'is')).toEqual([
      ['created_journal_entry_id', null],
      ['created_supplier_invoice_id', null],
    ])
  })

  // crm#2018: an agent staged the claim with inbox_item_id only; the item was
  // marked booked and the verifikat carried no underlag.
  it('attaches the inbox item\'s own document when the caller sent only inbox_item_id', async () => {
    enqueue({ data: { entity_type: 'aktiebolag' } }) // companies entity_type
    enqueue({ data: { created_journal_entry_id: null, created_supplier_invoice_id: null, document_id: 'doc-item' } }) // inbox item read
    enqueue({ data: { id: 'claim-1' } }) // insert
    enqueue({ data: null }) // journal_entry_id update
    enqueue({ data: [{ id: 'inbox-1' }] }) // inbox item claim (compare-and-set)
    enqueue({ data: { journal_entry_id: null, user_id: 'user-1', storage_path: 'p', file_name: 'kvitto.pdf', file_size_bytes: 1, mime_type: 'application/pdf', sha256_hash: 'x', uploaded_by: 'user-1', upload_source: 'email' } }) // document lookup

    const result = await registerExpenseClaim(sb, COMPANY, USER, {
      description: 'Toner',
      expense_date: '2026-11-16',
      amount: 329,
      vat_amount: 65.8,
      currency: 'SEK',
      expense_account: '5460',
      claimant_name: 'Joakim',
      inbox_item_id: 'inbox-1',
    })

    expect(result.ok).toBe(true)
    expect(findCall('expense_claims', 'insert')?.[0]).toMatchObject({ document_id: 'doc-item' })
    expect(findCalls('document_attachments', 'eq')).toContainEqual(['id', 'doc-item'])
    expect(linkToJournalEntryMock).toHaveBeenCalledWith(sb, COMPANY, 'doc-item', 'je-1', { link_basis: 'user_created', link_evidence: null })
  })

  it('attaches the inbox item\'s document, not a different document_id sent with it', async () => {
    enqueue({ data: { entity_type: 'aktiebolag' } }) // companies entity_type
    enqueue({ data: { created_journal_entry_id: null, created_supplier_invoice_id: null, document_id: 'doc-item' } }) // inbox item read
    enqueue({ data: { id: 'claim-1' } }) // insert
    enqueue({ data: null }) // journal_entry_id update
    enqueue({ data: [{ id: 'inbox-1' }] }) // inbox item claim (compare-and-set)
    enqueue({ data: { journal_entry_id: null, user_id: 'user-1', storage_path: 'p', file_name: 'kvitto.pdf', file_size_bytes: 1, mime_type: 'application/pdf', sha256_hash: 'x', uploaded_by: 'user-1', upload_source: 'email' } }) // document lookup

    const result = await registerExpenseClaim(sb, COMPANY, USER, {
      description: 'Toner',
      expense_date: '2026-11-16',
      amount: 329,
      vat_amount: 65.8,
      currency: 'SEK',
      expense_account: '5460',
      claimant_name: 'Joakim',
      document_id: 'doc-other',
      inbox_item_id: 'inbox-1',
    })

    expect(result.ok).toBe(true)
    expect(findCall('expense_claims', 'insert')?.[0]).toMatchObject({ document_id: 'doc-item' })
    expect(linkToJournalEntryMock).toHaveBeenCalledTimes(1)
    expect(linkToJournalEntryMock).toHaveBeenCalledWith(sb, COMPANY, 'doc-item', 'je-1', { link_basis: 'user_created', link_evidence: null })
  })

  it('links nothing for an inbox item without a document and no document_id', async () => {
    enqueue({ data: { entity_type: 'aktiebolag' } }) // companies entity_type
    enqueue({ data: { created_journal_entry_id: null, created_supplier_invoice_id: null, document_id: null } }) // inbox item read
    enqueue({ data: { id: 'claim-1' } }) // insert
    enqueue({ data: null }) // journal_entry_id update
    enqueue({ data: [{ id: 'inbox-1' }] }) // inbox item claim (compare-and-set)

    const result = await registerExpenseClaim(sb, COMPANY, USER, {
      description: 'Toner',
      expense_date: '2026-11-16',
      amount: 100,
      vat_amount: 0,
      currency: 'SEK',
      expense_account: '5460',
      claimant_name: 'Joakim',
      inbox_item_id: 'inbox-1',
    })

    expect(result.ok).toBe(true)
    expect(findCall('expense_claims', 'insert')?.[0]).toMatchObject({ document_id: null })
    expect(findCall('document_attachments', 'select')).toBeUndefined()
    expect(linkToJournalEntryMock).not.toHaveBeenCalled()
  })

  // accounted#14: the item stamp overwrote any pointer, so the same
  // underlag registered twice kept two posted verifikat.
  const INBOX_CLAIM_INPUT = {
    description: 'Kvitto',
    expense_date: '2026-09-01',
    amount: 100,
    vat_amount: 0,
    currency: 'SEK' as const,
    expense_account: '5410',
    claimant_name: 'Joakim',
    document_id: 'doc-1',
    inbox_item_id: 'inbox-1',
  }

  it('refuses an inbox item another verifikat still books, before writing anything', async () => {
    enqueue({ data: { entity_type: 'aktiebolag' } }) // companies entity_type
    enqueue({ data: { created_journal_entry_id: 'je-first', created_supplier_invoice_id: null } })
    enqueue({ data: { status: 'posted' } }) // the pointer's verifikat

    const result = await registerExpenseClaim(sb, COMPANY, USER, INBOX_CLAIM_INPUT)

    expect(result).toEqual({ ok: false, code: 'INBOX_ITEM_BOOKED' })
    expect(createJournalEntryMock).not.toHaveBeenCalled()
    expect(findCall('expense_claims', 'insert')).toBeUndefined()
  })

  it('refuses an utlägg of an item whose other half is booked already (reported 2026-10-15), before writing anything', async () => {
    refuseWhenPairBookedMock.mockResolvedValueOnce({
      ok: false,
      code: 'INBOX_ITEM_PAIR_ALREADY_BOOKED',
      details: { inbox_item_id: 'item-1', sibling_item_id: 'item-receipt', sibling_kind: 'receipt', journal_entry_id: 'je-66', voucher: 'A66', supplier_invoice_id: null },
      messageSv: 'Kvittot från samma köp är redan bokfört på verifikat A66. Lägg till det här underlaget där i stället, så bokförs köpet inte två gånger.',
      messageEn: 'The receipt from the same purchase is booked already on voucher A66. Add this document there instead, so the purchase is not booked twice.',
    })
    enqueue({ data: { entity_type: 'aktiebolag' } }) // companies entity_type
    enqueue({ data: { created_journal_entry_id: null, created_supplier_invoice_id: null } }) // the item itself is unbooked
    const result = await registerExpenseClaim(sb, COMPANY, USER, INBOX_CLAIM_INPUT)
    expect(result).toMatchObject({ ok: false, code: 'INBOX_ITEM_PAIR_BOOKED' })
    expect((result as { detail?: string }).detail).toContain('A66')
    expect(refuseWhenPairBookedMock).toHaveBeenCalledWith(sb, COMPANY, 'inbox-1')
    expect(createJournalEntryMock).not.toHaveBeenCalled()
    expect(findCall('expense_claims', 'insert')).toBeUndefined()
  })

  it('loses the claim to a concurrent registration: reverses its verifikat, removes its row, attaches nothing', async () => {
    reverseEntryMock.mockResolvedValue({ id: 'je-storno' })
    findPayslipLineForClaimMock.mockResolvedValue(null)
    enqueue({ data: { entity_type: 'aktiebolag' } }) // companies entity_type
    enqueue({ data: { created_journal_entry_id: null, created_supplier_invoice_id: null } }) // still unbooked
    enqueue({ data: { id: 'claim-2' } }) // insert
    enqueue({ data: null }) // journal_entry_id update
    enqueue({ data: [] }) // inbox item claim: the other registration stamped first
    enqueue({ data: { id: 'claim-2', status: 'registered', journal_entry_id: 'je-1' } }) // delete: claim read
    enqueue({ data: { status: 'posted', reversed_by_id: null } }) // delete: entry status
    enqueue({ data: null }) // delete: claim row

    const result = await registerExpenseClaim(sb, COMPANY, USER, INBOX_CLAIM_INPUT)

    expect(result).toEqual({ ok: false, code: 'INBOX_ITEM_BOOKED' })
    expect(reverseEntryMock).toHaveBeenCalledWith(sb, COMPANY, USER, 'je-1', undefined, { expenseClaimRemoval: true })
    expect(findCall('expense_claims', 'delete')).toBeTruthy()
    expect(linkToJournalEntryMock).not.toHaveBeenCalled()
    expect(findCall('document_attachments', 'insert')).toBeUndefined()
  })

  it('replaces a stale pointer at a reversed verifikat, exactly that value', async () => {
    enqueue({ data: { entity_type: 'aktiebolag' } }) // companies entity_type
    enqueue({ data: { created_journal_entry_id: 'je-stornoed', created_supplier_invoice_id: null } })
    enqueue({ data: { status: 'reversed' } })
    enqueue({ data: { id: 'claim-3' } }) // insert
    enqueue({ data: null }) // journal_entry_id update
    enqueue({ data: [{ id: 'inbox-1' }] }) // inbox item claim on the stale value
    enqueue({ data: { journal_entry_id: 'je-stornoed', user_id: 'user-1', storage_path: 'p', file_name: 'kvitto.pdf', file_size_bytes: 1, mime_type: 'application/pdf', sha256_hash: 'x', uploaded_by: 'user-1', upload_source: 'file_upload' } }) // document lookup
    enqueue({ data: { id: 'doc-copy' } }) // attachment copy insert
    enqueue({ data: null }) // claim document_id update

    const result = await registerExpenseClaim(sb, COMPANY, USER, INBOX_CLAIM_INPUT)

    expect(result.ok).toBe(true)
    expect(findCalls('invoice_inbox_items', 'eq')).toContainEqual(['created_journal_entry_id', 'je-stornoed'])
    expect(findCalls('invoice_inbox_items', 'is')).toEqual([['created_supplier_invoice_id', null]])
    expect(reverseEntryMock).not.toHaveBeenCalled()
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

  it('crm#1377: a privately paid EU reverse-charge invoice posts its fiktiv moms in SEK, the person owed the net', async () => {
    enqueue({ data: { entity_type: 'aktiebolag' } }) // companies entity_type
    enqueue({ data: { id: 'claim-rc' } }) // insert
    enqueue({ data: null }) // update

    // The lines buildSupplierInvoicePrivatelyPaidLines hands over for one EUR
    // row on 4535 (which reports ruta 21 itself, so no basis pair).
    const result = await registerExpenseClaim(sb, COMPANY, USER, {
      description: 'Faktura RC-1',
      expense_date: '2026-10-21',
      amount: 180,
      vat_amount: 0,
      currency: 'EUR',
      exchange_rate: 11.123,
      expense_account: '4535',
      claimant_name: 'Ägare',
      lines: [
        { account_number: '4535', debit_amount: 180, credit_amount: 0 },
        { account_number: '2645', debit_amount: 45, credit_amount: 0 },
        { account_number: '2614', debit_amount: 0, credit_amount: 45 },
        { account_number: '2893', debit_amount: 0, credit_amount: 180 },
      ],
    })

    expect(result.ok).toBe(true)
    const input = createJournalEntryMock.mock.calls[0][3]
    const byAccount = Object.fromEntries(input.lines.map((l: { account_number: string }) => [l.account_number, l]))
    expect(byAccount['4535'].debit_amount).toBe(2002.14)
    expect(byAccount['2645'].debit_amount).toBe(500.54)
    expect(byAccount['2614'].credit_amount).toBe(500.54)
    expect(byAccount['2893'].credit_amount).toBe(2002.14)
    expect(findCall('expense_claims', 'insert')?.[0]).toMatchObject({ amount_sek: 2002.14, vat_sek: 0 })
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

  it('rejects custom lines that balance only before each line is rounded', async () => {
    enqueue({ data: { entity_type: 'aktiebolag' } }) // companies entity_type
    const result = await registerExpenseClaim(sb, COMPANY, USER, {
      description: 'x',
      expense_date: '2026-09-01',
      amount: 200.01,
      vat_amount: 0,
      currency: 'SEK',
      expense_account: '5410',
      claimant_name: 'Joakim',
      lines: [
        { account_number: '5410', debit_amount: 100.004, credit_amount: 0 },
        { account_number: '5420', debit_amount: 100.004, credit_amount: 0 },
        { account_number: '2893', debit_amount: 0, credit_amount: 200.01 },
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
    enqueue({ data: { id: 'je-2', company_id: COMPANY, status: 'posted', lines: [] } }) // engine door reload

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
      p_transaction_id: null,
    })
    // No journal write happens outside the RPC.
    expect(createJournalEntryMock).not.toHaveBeenCalled()
    expect(reverseEntryMock).not.toHaveBeenCalled()
  })

  it('forwards the bank transaction so the RPC links it in the same transaction', async () => {
    enqueue({
      data: { ok: true, batch_id: 'batch-2', journal_entry_id: 'je-3', voucher_number: 8, total_sek: 1596, claim_count: 2 },
    })
    enqueue({ data: { id: 'je-3', company_id: COMPANY, status: 'posted', lines: [] } }) // engine door reload
    const result = await createPayoutBatch(sb, COMPANY, USER, {
      claim_ids: ['c2', 'c3'],
      payout_date: '2026-09-10',
      cash_account: '1930',
      transaction_id: 'tx-1',
    })
    expect(result).toMatchObject({ ok: true, batch_id: 'batch-2', journal_entry_id: 'je-3' })
    expect(rpcCalls()[0][1]).toMatchObject({ p_transaction_id: 'tx-1', p_payout_date: '2026-09-10' })
  })

  it('echoes the bank-line refusals (amount mismatch, already booked) as typed codes', async () => {
    enqueue({ data: { ok: false, code: 'TX_AMOUNT_MISMATCH', details: { transaction_amount: -1500, claims_total: 1596 } } })
    const mismatch = await createPayoutBatch(sb, COMPANY, USER, {
      claim_ids: ['c2'],
      payout_date: '2026-09-10',
      cash_account: '1930',
      transaction_id: 'tx-1',
    })
    expect(mismatch).toMatchObject({ ok: false, code: 'TX_AMOUNT_MISMATCH' })

    enqueue({ data: { ok: false, code: 'TX_ALREADY_BOOKED' } })
    const booked = await createPayoutBatch(sb, COMPANY, USER, {
      claim_ids: ['c2'],
      payout_date: '2026-09-10',
      cash_account: '1930',
      transaction_id: 'tx-1',
    })
    expect(booked).toMatchObject({ ok: false, code: 'TX_ALREADY_BOOKED' })
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
    // The RPC error rides along so the doors can classify the trigger (PERIOD_LOCKED).
    expect(result).toEqual({
      ok: false,
      code: 'BATCH_INSERT_FAILED',
      detail: 'Perioden är låst',
      error: { message: 'Perioden är låst', code: 'P0001' },
    })
  })
})

describe('deleteExpenseClaim', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    reverseEntryMock.mockResolvedValue({ id: 'je-storno' })
    findPayslipLineForClaimMock.mockResolvedValue(null)
  })

  it('refuses a claim scheduled on a payslip that has left draft, before any storno', async () => {
    enqueue({ data: { id: 'c1', status: 'registered', journal_entry_id: 'je-1' } })
    findPayslipLineForClaimMock.mockResolvedValue({
      line_id: 'li-1',
      salary_run_id: 'run-1',
      run_status: 'review',
      period_year: 2026,
      period_month: 6,
    })

    const result = await deleteExpenseClaim(sb, COMPANY, USER, 'c1')
    expect(result).toMatchObject({ ok: false, code: 'ON_PAYSLIP' })
    expect(reverseEntryMock).not.toHaveBeenCalled()
    expect(findCall('expense_claims', 'delete')).toBeUndefined()
  })

  it('on a draft payslip removes the line first (the FK is RESTRICT), then the storno, then the claim', async () => {
    enqueue({ data: { id: 'c1', status: 'registered', journal_entry_id: 'je-1' } })
    enqueue({ data: null }) // salary_line_items delete
    enqueue({ data: { status: 'posted', reversed_by_id: null } })
    enqueue({ data: null }) // expense_claims delete
    findPayslipLineForClaimMock.mockResolvedValue({
      line_id: 'li-1',
      salary_run_id: 'run-1',
      run_status: 'draft',
      period_year: 2026,
      period_month: 6,
    })

    const result = await deleteExpenseClaim(sb, COMPANY, USER, 'c1')
    expect(result).toEqual({ ok: true, reversal_entry_id: 'je-storno' })
    expect(invalidateRunCalculation).toHaveBeenCalledWith(sb, COMPANY, { salaryRunId: 'run-1' })
    expect(findCall('salary_line_items', 'delete')).toBeTruthy()
    expect(findCall('salary_line_items', 'eq')).toEqual(['id', 'li-1'])
    expect(findCall('expense_claims', 'delete')).toBeTruthy()
    expect(reverseEntryMock).toHaveBeenCalledWith(sb, COMPANY, USER, 'je-1', undefined, { expenseClaimRemoval: true })
  })

  it('stops before the storno when the draft line cannot be removed', async () => {
    enqueue({ data: { id: 'c1', status: 'registered', journal_entry_id: 'je-1' } })
    enqueue({ data: null, error: { message: 'permission denied' } }) // salary_line_items delete
    findPayslipLineForClaimMock.mockResolvedValue({
      line_id: 'li-1',
      salary_run_id: 'run-1',
      run_status: 'draft',
      period_year: 2026,
      period_month: 6,
    })

    const result = await deleteExpenseClaim(sb, COMPANY, USER, 'c1')
    expect(result).toEqual({ ok: false, code: 'DELETE_FAILED', detail: 'permission denied' })
    expect(reverseEntryMock).not.toHaveBeenCalled()
    expect(findCall('expense_claims', 'delete')).toBeUndefined()
  })

  it('reverses the verifikat and removes the row', async () => {
    enqueue({ data: { id: 'c1', status: 'registered', journal_entry_id: 'je-1' } })
    enqueue({ data: { status: 'posted', reversed_by_id: null } }) // entry status
    enqueue({ data: null }) // delete

    const result = await deleteExpenseClaim(sb, COMPANY, USER, 'c1')
    expect(result).toEqual({ ok: true, reversal_entry_id: 'je-storno' })
    expect(reverseEntryMock).toHaveBeenCalledWith(sb, COMPANY, USER, 'je-1', undefined, { expenseClaimRemoval: true })
    expect(findCall('expense_claims', 'delete')).toBeTruthy()
  })

  // After a rättelse the claim names the corrected verifikat (correctEntry
  // moves the pointer with the correction): that one is in the books, so that
  // one is stornoed. Left on the reversed original, the claim would read as
  // stornoed already and go without a storno, the correction still posted.
  it('stornos the corrected verifikat a claim names after a rättelse, never skipping the storno', async () => {
    enqueue({ data: { id: 'c1', status: 'registered', journal_entry_id: 'je-correction' } })
    enqueue({ data: { status: 'posted', reversed_by_id: null } }) // the correction's status
    enqueue({ data: null }) // delete

    const result = await deleteExpenseClaim(sb, COMPANY, USER, 'c1')
    expect(result).toEqual({ ok: true, reversal_entry_id: 'je-storno' })
    expect(reverseEntryMock).toHaveBeenCalledTimes(1)
    expect(reverseEntryMock).toHaveBeenCalledWith(sb, COMPANY, USER, 'je-correction', undefined, { expenseClaimRemoval: true })
    // Read by the claim's own pointer: the original it was first booked as is not looked up.
    expect(findCalls('journal_entries', 'eq')).toContainEqual(['id', 'je-correction'])
    expect(findCalls('journal_entries', 'eq')).not.toContainEqual(['source_type', 'expense_claim'])
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

  it('reports a failed payslip lookup instead of throwing', async () => {
    enqueue({ data: { id: 'c1', status: 'registered', journal_entry_id: 'je-1' } })
    findPayslipLineForClaimMock.mockRejectedValue(new Error('db down'))

    const result = await deleteExpenseClaim(sb, COMPANY, USER, 'c1')
    expect(result).toEqual({ ok: false, code: 'DELETE_FAILED', detail: 'db down' })
    expect(reverseEntryMock).not.toHaveBeenCalled()
  })

  // journal_entry_id is NULL for two unrelated reasons; the recoverable one
  // must not dead-end the row.
  it('stornos the entry that journal_entries still points at when the back-link is missing', async () => {
    enqueue({ data: { id: 'c1', status: 'registered', journal_entry_id: null } })
    enqueue({ data: { id: 'je-1' } }) // journal_entries by source_id
    enqueue({ data: { status: 'posted', reversed_by_id: null } })
    enqueue({ data: null }) // expense_claims delete

    const result = await deleteExpenseClaim(sb, COMPANY, USER, 'c1')
    expect(result).toEqual({ ok: true, reversal_entry_id: 'je-storno' })
    expect(reverseEntryMock).toHaveBeenCalledWith(sb, COMPANY, USER, 'je-1', undefined, { expenseClaimRemoval: true })
    expect(findCall('expense_claims', 'delete')).toBeTruthy()
  })

  it('hard-deletes the row when the verifikat is gone, with nothing left to storno', async () => {
    enqueue({ data: { id: 'c1', status: 'registered', journal_entry_id: null } })
    enqueue({ data: null }) // no journal_entries row for source_id
    enqueue({ data: null }) // expense_claims delete

    const result = await deleteExpenseClaim(sb, COMPANY, USER, 'c1')
    expect(result).toEqual({ ok: true, reversal_entry_id: null })
    expect(reverseEntryMock).not.toHaveBeenCalled()
    expect(findCall('expense_claims', 'delete')).toBeTruthy()
  })
})

describe('createPayoutBatch: claim scheduled on a payslip (#2331)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
  })

  it('echoes ON_PAYSLIP as a typed refusal instead of BATCH_INSERT_FAILED', async () => {
    enqueue({
      data: { ok: false, code: 'ON_PAYSLIP', details: { claim_id: 'c1', salary_run_id: 'run-1', period: '2026-06' } },
    })

    const result = await createPayoutBatch(sb, COMPANY, USER, {
      claim_ids: ['c1'],
      payout_date: '2026-06-30',
      cash_account: '1930',
    })
    expect(result).toEqual({
      ok: false,
      code: 'ON_PAYSLIP',
      detail: '{"claim_id":"c1","salary_run_id":"run-1","period":"2026-06"}',
    })
  })
})

describe('registerExpenseClaim: custom lines from a supplier invoice', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    findFiscalPeriodMock.mockResolvedValue('period-1')
    createJournalEntryMock.mockResolvedValue({ id: 'je-1' })
  })

  it('carries each line dimension bag onto the posted verifikat (dimensions PR7)', async () => {
    enqueue({ data: { entity_type: 'aktiebolag' } }) // companies entity_type
    enqueue({ data: { id: 'claim-1' } }) // insert
    enqueue({ data: null }) // update

    const result = await registerExpenseClaim(sb, COMPANY, USER, {
      description: 'Faktura LF-001, Pressbyrån (ankomstnr 1)',
      expense_date: '2026-09-01',
      amount: 500,
      vat_amount: 100,
      currency: 'SEK',
      expense_account: '6110',
      claimant_name: 'Ägare',
      lines: [
        { account_number: '6110', debit_amount: 400, credit_amount: 0, dimensions: { '1': 'KS01', '6': 'P001' } },
        { account_number: '2641', debit_amount: 100, credit_amount: 0, dimensions: { '1': 'KS01' } },
        { account_number: '2893', debit_amount: 0, credit_amount: 500, dimensions: { '1': 'KS01' } },
      ],
    })

    expect(result.ok).toBe(true)
    const input = createJournalEntryMock.mock.calls[0][3]
    const byAccount = Object.fromEntries(
      input.lines.map((l: { account_number: string }) => [l.account_number, l]),
    )
    expect(byAccount['6110'].dimensions).toEqual({ '1': 'KS01', '6': 'P001' })
    expect(byAccount['2641'].dimensions).toEqual({ '1': 'KS01' })
    expect(byAccount['2893'].dimensions).toEqual({ '1': 'KS01' })
    // A line without a bag posts without the key, not with dimensions: undefined.
    expect(byAccount['2893'].credit_amount).toBe(500)
  })

  it('a line without a bag posts without a dimensions key', async () => {
    enqueue({ data: { entity_type: 'aktiebolag' } })
    enqueue({ data: { id: 'claim-1' } })
    enqueue({ data: null })

    await registerExpenseClaim(sb, COMPANY, USER, {
      description: 'Kvitto',
      expense_date: '2026-09-01',
      amount: 100,
      vat_amount: 0,
      currency: 'SEK',
      expense_account: '5410',
      claimant_name: 'Ägare',
      lines: [
        { account_number: '5410', debit_amount: 100, credit_amount: 0 },
        { account_number: '2893', debit_amount: 0, credit_amount: 100 },
      ],
    })

    const input = createJournalEntryMock.mock.calls[0][3]
    for (const line of input.lines) expect(line).not.toHaveProperty('dimensions')
  })
})

describe('registerExpenseClaim: omvänd skattskyldighet on a receipt from abroad (crm#1028)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    findFiscalPeriodMock.mockResolvedValue('period-1')
    createJournalEntryMock.mockResolvedValue({ id: 'je-1' })
  })

  const saas = {
    description: 'SaaS-abonnemang',
    expense_date: '2026-09-01',
    amount: 25,
    vat_amount: 0,
    currency: 'USD' as const,
    exchange_rate: 10.5,
    expense_account: '6540',
    claimant_name: 'Ägare',
  }

  it('books the fiktiv moms and the ruta 22 basis pair on the SEK amount, balanced', async () => {
    enqueue({ data: { entity_type: 'aktiebolag' } }) // companies entity_type
    enqueue({ data: { default_vat_treatment: null, default_vat_rate: null } }) // chart row of 6540
    enqueue({ data: { id: 'claim-rc' } }) // insert
    enqueue({ data: null }) // journal_entry_id update

    const result = await registerExpenseClaim(sb, COMPANY, USER, { ...saas, reverse_charge: 'non_eu_services' })

    expect(result.ok).toBe(true)
    const lines = createJournalEntryMock.mock.calls[0][3].lines as Array<{
      account_number: string
      debit_amount: number
      credit_amount: number
    }>
    expect(lines.map((l) => [l.account_number, l.debit_amount, l.credit_amount])).toEqual([
      ['6540', 262.5, 0],
      ['2645', 65.63, 0],
      ['2614', 0, 65.63],
      ['4531', 262.5, 0],
      ['4598', 0, 262.5],
      ['2893', 0, 262.5],
    ])
    expect(lines[0]).toMatchObject({ currency: 'USD', amount_in_currency: 25, exchange_rate: 10.5 })
    const debit = lines.reduce((s, l) => s + l.debit_amount, 0)
    const credit = lines.reduce((s, l) => s + l.credit_amount, 0)
    expect(Math.round(debit * 100)).toBe(Math.round(credit * 100))
    expect(findCalls('chart_of_accounts', 'eq')).toEqual([
      ['company_id', COMPANY],
      ['account_number', '6540'],
    ])
    // Nothing is deductible on 2641: the claim owes the gross and shows no VAT.
    expect(findCall('expense_claims', 'insert')?.[0]).toMatchObject({ amount_sek: 262.5, vat_sek: 0 })
  })

  it('adds no basis pair when the cost account reports the ruta itself', async () => {
    enqueue({ data: { entity_type: 'aktiebolag' } }) // companies entity_type
    enqueue({ data: { default_vat_treatment: null, default_vat_rate: null } }) // chart row of 4535
    enqueue({ data: { id: 'claim-rc' } }) // insert
    enqueue({ data: null }) // journal_entry_id update

    await registerExpenseClaim(sb, COMPANY, USER, {
      ...saas,
      currency: 'EUR',
      exchange_rate: 11,
      amount: 10,
      expense_account: '4535',
      reverse_charge: 'eu_services',
    })

    const lines = createJournalEntryMock.mock.calls[0][3].lines as Array<{ account_number: string }>
    expect(lines.map((l) => l.account_number)).toEqual(['4535', '2645', '2614', '2893'])
  })

  it.each([
    ['the import basis (ruta 50)', '4545', { default_vat_treatment: null, default_vat_rate: null }],
    ['a reverse-charge momskod without a rate', '6541', { default_vat_treatment: 'reverse_charge_eu_services', default_vat_rate: 0 }],
    ['the other region (4535 is ruta 21)', '4535', { default_vat_treatment: null, default_vat_rate: null }],
  ])('refuses reverse_charge on %s before writing anything (crm#1028 review)', async (_case, account, row) => {
    enqueue({ data: { entity_type: 'aktiebolag' } }) // companies entity_type
    enqueue({ data: row }) // chart row of the cost account

    const result = await registerExpenseClaim(sb, COMPANY, USER, {
      ...saas,
      expense_account: account,
      reverse_charge: 'non_eu_services',
    })

    expect(result).toMatchObject({ ok: false, code: 'INVALID_LINES' })
    expect(findCall('expense_claims', 'insert')).toBeUndefined()
    expect(createJournalEntryMock).not.toHaveBeenCalled()
  })

  it('books a receipt from abroad without reverse_charge gross, with no moms lines', async () => {
    enqueue({ data: { entity_type: 'aktiebolag' } }) // companies entity_type
    enqueue({ data: { id: 'claim-gross' } }) // insert
    enqueue({ data: null }) // journal_entry_id update

    await registerExpenseClaim(sb, COMPANY, USER, saas)

    const lines = createJournalEntryMock.mock.calls[0][3].lines as Array<{ account_number: string }>
    expect(lines.map((l) => l.account_number)).toEqual(['6540', '2893'])
    expect(findCall('chart_of_accounts', 'select')).toBeUndefined()
  })

  it.each([
    ['with VAT on the receipt', { vat_amount: 5 }],
    [
      'beside custom lines',
      {
        lines: [
          { account_number: '6540', debit_amount: 25, credit_amount: 0 },
          { account_number: '2893', debit_amount: 0, credit_amount: 25 },
        ],
      },
    ],
  ])('refuses reverse_charge %s before touching the database', async (_case, extra) => {
    const result = await registerExpenseClaim(sb, COMPANY, USER, {
      ...saas,
      ...extra,
      reverse_charge: 'eu_services',
    })

    expect(result).toMatchObject({ ok: false, code: 'INVALID_LINES' })
    expect(findCall('companies', 'select')).toBeUndefined()
    expect(createJournalEntryMock).not.toHaveBeenCalled()
  })
})
