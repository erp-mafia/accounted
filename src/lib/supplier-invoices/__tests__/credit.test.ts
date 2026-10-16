/**
 * creditSupplierInvoice: the one credit service behind the dashboard, v1 and
 * MCP doors (issue #2980). Covers the plain credit, the credit of an inbox
 * credit note (date, number and document from the document; partial and
 * mismatching credit notes refused), the refusal of rows that do not add up
 * to the invoice (before an ankomstnummer is drawn, and on a dry run), and
 * the guards that keep a credit from landing half-way.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createTableMockSupabase, makeInvoiceInboxItem, makeSupplierInvoice } from '@/tests/helpers'
import type { Logger } from '@/lib/logger'

const createCreditEntryMock = vi.fn()
vi.mock('@/lib/bookkeeping/supplier-invoice-entries', async () => {
  const actual = await vi.importActual<typeof import('@/lib/bookkeeping/supplier-invoice-entries')>('@/lib/bookkeeping/supplier-invoice-entries')
  // Only the posting is mocked: the rows are held to the payable by the real
  // rule (assertSupplierCreditNoteRowsMatchPayable), as in production.
  return {
    ...actual,
    createSupplierCreditNoteEntry: (...args: unknown[]) => createCreditEntryMock(...args),
  }
})

const cancelSchedulesMock = vi.fn()
vi.mock('@/lib/bookkeeping/accruals/service', () => ({
  cancelSchedulesForSource: (...args: unknown[]) => cancelSchedulesMock(...args),
}))

const reverseEntryMock = vi.fn()
vi.mock('@/lib/bookkeeping/engine', async () => {
  const actual = await vi.importActual<typeof import('@/lib/bookkeeping/engine')>('@/lib/bookkeeping/engine')
  return {
    ...actual,
    getSwedishLocalDate: () => '2026-09-27',
    reverseEntry: (...args: unknown[]) => reverseEntryMock(...args),
  }
})

import { creditSupplierInvoice, CreditSupplierInvoiceInputSchema } from '../credit'
import {
  SupplierCreditNoteRowsMismatchError,
  SupplierInvoiceFxRateMissingError,
} from '@/lib/bookkeeping/supplier-invoice-entries'
import { getErrorEntry } from '@/lib/errors/structured-errors'

const { supabase, setTable, reset, findCall, findCalls, calls } = createTableMockSupabase()

const log: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: () => log } as unknown as Logger
const ctx = () => ({ supabase: supabase as unknown as SupabaseClient, companyId: 'company-1', userId: 'user-1', log })
const emit = vi.fn().mockResolvedValue(undefined)

const ORIGINAL_ID = '11111111-1111-4111-8111-111111111111'
const ITEM_ID = '22222222-2222-4222-8222-222222222222'
const DOC_ID = '33333333-3333-4333-8333-333333333333'

const originalItems = [
  {
    id: 'item-1',
    supplier_invoice_id: ORIGINAL_ID,
    sort_order: 0,
    description: 'Licens',
    quantity: 1,
    unit: 'st',
    unit_price: 8000,
    line_total: 8000,
    account_number: '5420',
    vat_code: null,
    vat_rate: 25,
    vat_amount: 2000,
    reverse_charge_rate: null,
    apply_slp: false,
    dimensions: {},
    accrual_period_start: '2026-09-01',
    accrual_period_end: '2026-12-31',
    accrual_balance_account: '1790',
  },
]

const original = {
  ...makeSupplierInvoice({
    id: ORIGINAL_ID,
    supplier_id: 'supplier-1',
    supplier_invoice_number: '10234',
    invoice_date: '2026-09-01',
    status: 'approved',
    subtotal: 8000,
    vat_amount: 2000,
    total: 10000,
    remaining_amount: 10000,
  }),
  supplier: { id: 'supplier-1', name: 'Programvara AB', supplier_type: 'swedish_business' },
  items: originalItems,
}

const creditNoteRow = makeSupplierInvoice({
  id: 'credit-1',
  arrival_number: 44,
  is_credit_note: true,
  credited_invoice_id: ORIGINAL_ID,
  supplier_invoice_number: 'K-778',
  invoice_date: '2026-09-18',
  status: 'credited',
})

function inboxItem(extracted: Record<string, unknown>, overrides: Record<string, unknown> = {}) {
  return makeInvoiceInboxItem({
    id: ITEM_ID,
    document_id: DOC_ID,
    matched_supplier_id: 'supplier-1',
    extracted_data: extracted,
    ...overrides,
  })
}

const fullCreditNote = {
  documentKind: 'credit_note',
  supplier: { name: 'Programvara AB' },
  invoice: { invoiceNumber: 'K-778', invoiceDate: '2026-09-18', currency: 'SEK', creditedInvoiceNumber: '10234' },
  totals: { subtotal: -8000, vatAmount: -2000, total: -10000 },
  lineItems: [],
}

function happyTables() {
  setTable('supplier_invoices', [
    { data: original },
    { data: creditNoteRow },
    { data: null }, // link the verifikat to the credit note
    { data: { id: ORIGINAL_ID } }, // flip the original
  ])
  setTable('company_settings', { data: { accounting_method: 'accrual', bookkeeping_locked_through: null } })
  setTable('fiscal_periods', { data: { id: 'fp-1', is_closed: false, locked_at: null } })
  setTable('rpc:get_next_arrival_number', { data: 44 })
  setTable('supplier_invoice_items', { data: null })
  setTable('document_attachments', { data: { id: DOC_ID, journal_entry_id: null } })
}

/** Nothing reached the database: no ankomstnummer drawn, no row written, nothing posted. */
function expectNothingWritten() {
  expect(supabase.rpc).not.toHaveBeenCalled()
  expect(calls.filter((c) => ['insert', 'update', 'delete'].includes(c.method))).toEqual([])
  expect(createCreditEntryMock).not.toHaveBeenCalled()
  expect(reverseEntryMock).not.toHaveBeenCalled()
}

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  createCreditEntryMock.mockResolvedValue({ id: 'je-credit' })
  cancelSchedulesMock.mockResolvedValue({ cancelledSchedules: 1, reversedEntries: 1, failedReversals: 0 })
})

describe('creditSupplierInvoice: plain Kreditera', () => {
  it('mirrors the whole original, dated today, numbered KREDIT-, and flips the original', async () => {
    happyTables()

    const outcome = await creditSupplierInvoice(ctx(), ORIGINAL_ID, {}, { emit })

    expect(outcome.ok).toBe(true)
    const row = findCall('supplier_invoices', 'insert')?.[0] as Record<string, unknown>
    expect(row).toMatchObject({
      supplier_invoice_number: 'KREDIT-10234',
      invoice_date: '2026-09-27',
      status: 'credited',
      is_credit_note: true,
      credited_invoice_id: ORIGINAL_ID,
      total: 10000,
      document_id: null,
    })
    // The reversal is computed from the ORIGINAL items (17xx interim account).
    expect(createCreditEntryMock.mock.calls[0]?.[4]).toBe(originalItems)
    // ...and checked against what the original owes on 2440.
    expect(createCreditEntryMock.mock.calls[0]?.[7]).toBe(10000)
    const flip = findCalls('supplier_invoices', 'update').find((args) => (args[0] as { status?: string }).status)
    expect(flip?.[0]).toEqual({ status: 'credited', remaining_amount: 0 })
    // Periodisering stops on the credit date.
    expect(cancelSchedulesMock).toHaveBeenCalledWith(expect.anything(), 'company-1', 'user-1', { supplierInvoiceId: ORIGINAL_ID }, { reversalDate: '2026-09-27' })
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'supplier_invoice.credited' }))
  })

  it('copies the reverse-charge rate, the SLP flag and the dimensions onto the credit items', async () => {
    happyTables()
    await creditSupplierInvoice(ctx(), ORIGINAL_ID, {}, { emit })
    const items = findCall('supplier_invoice_items', 'insert')?.[0] as Array<Record<string, unknown>>
    expect(items[0]).toMatchObject({ vat_rate: 0.25, reverse_charge_rate: null, apply_slp: false, dimensions: {} })
  })

  it('answers SI_NOT_FOUND for an invoice outside the company', async () => {
    setTable('supplier_invoices', { data: null })
    const outcome = await creditSupplierInvoice(ctx(), ORIGINAL_ID, {}, { emit })
    expect(outcome).toMatchObject({ ok: false, code: 'SI_NOT_FOUND' })
  })

  it('refuses an already credited invoice and a credit note', async () => {
    setTable('supplier_invoices', { data: { ...original, status: 'credited' } })
    expect(await creditSupplierInvoice(ctx(), ORIGINAL_ID, {}, { emit })).toMatchObject({
      ok: false,
      code: 'SI_CREDIT_ALREADY_CREDITED',
    })
    setTable('supplier_invoices', { data: { ...original, is_credit_note: true } })
    expect(await creditSupplierInvoice(ctx(), ORIGINAL_ID, {}, { emit })).toMatchObject({
      ok: false,
      code: 'VALIDATION_ERROR',
    })
  })

  it('refuses a locked period before anything is written', async () => {
    happyTables()
    setTable('company_settings', { data: { accounting_method: 'accrual', bookkeeping_locked_through: '2026-12-31' } })
    const outcome = await creditSupplierInvoice(ctx(), ORIGINAL_ID, {}, { emit })
    expect(outcome).toMatchObject({ ok: false, code: 'SI_CREDIT_PERIOD_LOCKED' })
    expect(calls.filter((c) => c.method === 'insert')).toEqual([])
  })

  it('rolls the credit note back when no fiscal year takes the verifikat', async () => {
    happyTables()
    createCreditEntryMock.mockResolvedValue(null)
    const outcome = await creditSupplierInvoice(ctx(), ORIGINAL_ID, {}, { emit })
    expect(outcome).toMatchObject({ ok: false, code: 'SI_CREDIT_FAILED' })
    expect(findCalls('supplier_invoices', 'delete').length).toBe(1)
    expect(findCalls('supplier_invoices', 'update')).toEqual([])
  })

  describe('rows that do not add up to the invoice (crm#1094)', () => {
    // The rows carry twice what the invoice owes: 20 000 against 10 000.
    const duplicatedRows = { ...original, items: [originalItems[0], { ...originalItems[0], id: 'item-2', sort_order: 1 }] }
    // A header without rows, as a migration leaves some: 0 against 10 000.
    const noRows = { ...original, items: [] }

    it.each([
      ['rows that miss the payable', duplicatedRows, 20000],
      ['an invoice with no rows at all', noRows, 0],
      ['an invoice whose rows were never read (null)', { ...original, items: null }, 0],
    ])('refuses %s before an ankomstnummer is drawn or a row is written', async (_label, row, rowsPayableSek) => {
      happyTables()
      setTable('supplier_invoices', { data: row })

      const outcome = await creditSupplierInvoice(ctx(), ORIGINAL_ID, {}, { emit })

      expect(outcome).toMatchObject({
        ok: false,
        code: 'SI_CREDIT_ROWS_MISMATCH',
        details: { rows_payable_sek: rowsPayableSek, invoice_payable_sek: 10000 },
      })
      expect(getErrorEntry('SI_CREDIT_ROWS_MISMATCH')).toMatchObject({ httpStatus: 409, message_sv: expect.stringMatching(/Ingenting har bokförts/) })
      expectNothingWritten()
      expect(emit).not.toHaveBeenCalled()
    })

    it.each([
      ['rows that miss the payable', duplicatedRows, 20000],
      ['an invoice with no rows at all', noRows, 0],
    ])('refuses %s on a dry run, as the commit would', async (_label, row, rowsPayableSek) => {
      happyTables()
      setTable('supplier_invoices', { data: row })

      const outcome = await creditSupplierInvoice(ctx(), ORIGINAL_ID, {}, { dryRun: true, emit })

      expect(outcome).toMatchObject({
        ok: false,
        code: 'SI_CREDIT_ROWS_MISMATCH',
        details: { rows_payable_sek: rowsPayableSek, invoice_payable_sek: 10000 },
      })
      expectNothingWritten()
    })

    it('credits an unpaid invoice without rows under kontantmetoden: no verifikat is built from them', async () => {
      happyTables()
      setTable('supplier_invoices', [{ data: noRows }, { data: creditNoteRow }, { data: { id: ORIGINAL_ID } }])
      setTable('company_settings', { data: { accounting_method: 'cash', bookkeeping_locked_through: null } })

      const outcome = await creditSupplierInvoice(ctx(), ORIGINAL_ID, {}, { emit })

      expect(outcome.ok).toBe(true)
      expect(createCreditEntryMock).not.toHaveBeenCalled()
    })

    it('stops before the ankomstnummer when the lines cannot be built at all (a foreign invoice without a rate)', async () => {
      happyTables()
      setTable('supplier_invoices', { data: { ...original, currency: 'EUR', exchange_rate: null, total_sek: 115000 } })

      const outcome = await creditSupplierInvoice(ctx(), ORIGINAL_ID, {}, { emit })

      expect(outcome).toMatchObject({ ok: false, error: expect.any(SupplierInvoiceFxRateMissingError) })
      expectNothingWritten()
    })

    it('keeps the builder as the backstop: its refusal deletes the credit note row and posts nothing', async () => {
      // The rows fit when they are checked and no longer when the verifikat
      // is built (changed in between): the builder refuses on its own.
      happyTables()
      createCreditEntryMock.mockRejectedValue(new SupplierCreditNoteRowsMismatchError(-500, 125))
      const outcome = await creditSupplierInvoice(ctx(), ORIGINAL_ID, {}, { emit })
      expect(outcome).toMatchObject({
        ok: false,
        code: 'SI_CREDIT_ROWS_MISMATCH',
        details: { rows_payable_sek: -500, invoice_payable_sek: 125 },
      })
      // Nothing was posted: the credit note row is deleted, never kept as reversed.
      expect(findCalls('supplier_invoices', 'delete').length).toBe(1)
      expect(findCalls('supplier_invoices', 'update')).toEqual([])
      expect(reverseEntryMock).not.toHaveBeenCalled()
    })
  })

  it('compares a foreign invoice without total_sek at its own rate', async () => {
    happyTables()
    const euro = {
      ...original,
      currency: 'EUR',
      exchange_rate: 11.5,
      subtotal: 800,
      vat_amount: 200,
      total: 1000,
      total_sek: null,
      items: [{ ...originalItems[0], unit_price: 800, line_total: 800, vat_amount: 200 }],
    }
    setTable('supplier_invoices', [
      { data: euro },
      { data: creditNoteRow },
      { data: null },
      { data: { id: ORIGINAL_ID } },
    ])
    const outcome = await creditSupplierInvoice(ctx(), ORIGINAL_ID, {}, { emit })
    expect(outcome.ok).toBe(true)
    expect(createCreditEntryMock.mock.calls[0]?.[7]).toBe(11500)
  })

  it('takes its own verifikat back when a concurrent credit won the race', async () => {
    happyTables()
    setTable('supplier_invoices', [{ data: original }, { data: creditNoteRow }, { data: null }, { data: null }])
    const outcome = await creditSupplierInvoice(ctx(), ORIGINAL_ID, {}, { emit })
    expect(outcome).toMatchObject({ ok: false, code: 'SI_CREDIT_ALREADY_CREDITED' })
    expect(reverseEntryMock).toHaveBeenCalledWith(expect.anything(), 'company-1', 'user-1', 'je-credit', '2026-09-27')
    expect(cancelSchedulesMock).not.toHaveBeenCalled()
  })

  it('writes nothing on a dry run and says whether a verifikat would post', async () => {
    happyTables()
    const outcome = await creditSupplierInvoice(ctx(), ORIGINAL_ID, {}, { dryRun: true, emit })
    expect(outcome).toMatchObject({ ok: true, dryRun: true })
    if (!outcome.ok || !outcome.dryRun) throw new Error('expected a preview')
    expect(outcome.preview).toMatchObject({ credit_date: '2026-09-27', date_source: 'today', would_create_reversal_journal_entry: true })
    expect(supabase.rpc).not.toHaveBeenCalled()
    expect(calls.filter((c) => ['insert', 'update', 'delete'].includes(c.method))).toEqual([])
  })
})

describe('creditSupplierInvoice: a credit note from the inbox', () => {
  it('books on the credit note\'s date with its number and document, and marks the item handled', async () => {
    happyTables()
    setTable('invoice_inbox_items', [{ data: inboxItem(fullCreditNote) }, { data: null }])

    const outcome = await creditSupplierInvoice(ctx(), ORIGINAL_ID, { inbox_item_id: ITEM_ID }, { emit })

    expect(outcome.ok).toBe(true)
    const row = findCall('supplier_invoices', 'insert')?.[0] as Record<string, unknown>
    expect(row).toMatchObject({ supplier_invoice_number: 'K-778', invoice_date: '2026-09-18', document_id: DOC_ID })
    // The document becomes the credit verifikat's underlag.
    expect(findCall('document_attachments', 'update')?.[0]).toEqual({
      journal_entry_id: 'je-credit',
      link_basis: 'user_created',
      link_evidence: null,
    })
    expect(findCall('invoice_inbox_items', 'update')?.[0]).toEqual({ created_supplier_invoice_id: 'credit-1' })
    expect(cancelSchedulesMock).toHaveBeenCalledWith(expect.anything(), 'company-1', 'user-1', { supplierInvoiceId: ORIGINAL_ID }, { reversalDate: '2026-09-18' })
    if (outcome.ok && !outcome.dryRun) {
      expect(outcome.data).toMatchObject({ journal_entry_id: 'je-credit', document_id: DOC_ID, inbox_item_id: ITEM_ID })
    }
  })

  it('lets explicit inputs win over the reading', async () => {
    happyTables()
    setTable('invoice_inbox_items', [{ data: inboxItem(fullCreditNote) }, { data: null }])
    await creditSupplierInvoice(
      ctx(),
      ORIGINAL_ID,
      { inbox_item_id: ITEM_ID, credit_date: '2026-09-20', supplier_credit_note_number: 'KN-1' },
      { emit },
    )
    expect(findCall('supplier_invoices', 'insert')?.[0]).toMatchObject({ supplier_invoice_number: 'KN-1', invoice_date: '2026-09-20' })
  })

  it('refuses a partial credit note instead of crediting the whole invoice', async () => {
    happyTables()
    setTable('invoice_inbox_items', {
      data: inboxItem({ ...fullCreditNote, totals: { subtotal: -2000, vatAmount: -500, total: -2500 } }),
    })
    const outcome = await creditSupplierInvoice(ctx(), ORIGINAL_ID, { inbox_item_id: ITEM_ID }, { emit })
    expect(outcome).toMatchObject({
      ok: false,
      code: 'SI_CREDIT_PARTIAL',
      details: { credit_total: 2500, invoice_total: 10000 },
    })
    expect(calls.filter((c) => ['insert', 'update', 'delete'].includes(c.method))).toEqual([])
  })

  it('refuses a credit note whose amount is missing, larger, in another currency or from another supplier', async () => {
    for (const [reading, overrides, reason] of [
      [{ ...fullCreditNote, totals: { subtotal: null, vatAmount: null, total: null } }, {}, 'amount_missing'],
      [{ ...fullCreditNote, totals: { subtotal: -9000, vatAmount: -2250, total: -11250 } }, {}, 'exceeds'],
      [{ ...fullCreditNote, invoice: { ...fullCreditNote.invoice, currency: 'EUR' } }, {}, 'currency'],
      [fullCreditNote, { matched_supplier_id: 'supplier-9' }, 'supplier'],
    ] as const) {
      reset()
      happyTables()
      setTable('invoice_inbox_items', { data: inboxItem(reading as Record<string, unknown>, overrides) })
      const outcome = await creditSupplierInvoice(ctx(), ORIGINAL_ID, { inbox_item_id: ITEM_ID }, { emit })
      expect(outcome, reason).toMatchObject({ ok: false, code: 'SI_CREDIT_DOCUMENT_MISMATCH', details: { reason } })
    }
  })

  it('refuses an item that is already handled and a credit note dated before its invoice', async () => {
    happyTables()
    setTable('invoice_inbox_items', { data: inboxItem(fullCreditNote, { created_supplier_invoice_id: 'si-x' }) })
    expect(await creditSupplierInvoice(ctx(), ORIGINAL_ID, { inbox_item_id: ITEM_ID }, { emit })).toMatchObject({
      ok: false,
      code: 'INBOX_ITEM_ALREADY_CONVERTED',
    })

    reset()
    happyTables()
    setTable('invoice_inbox_items', {
      data: inboxItem({ ...fullCreditNote, invoice: { ...fullCreditNote.invoice, invoiceDate: '2026-08-15' } }),
    })
    expect(await creditSupplierInvoice(ctx(), ORIGINAL_ID, { inbox_item_id: ITEM_ID }, { emit })).toMatchObject({
      ok: false,
      code: 'VALIDATION_ERROR',
      details: { field: 'credit_date' },
    })
  })

  it('refuses a document that already belongs to another verifikat', async () => {
    happyTables()
    setTable('invoice_inbox_items', { data: inboxItem(fullCreditNote) })
    setTable('document_attachments', { data: { id: DOC_ID, journal_entry_id: 'je-other' } })
    expect(await creditSupplierInvoice(ctx(), ORIGINAL_ID, { inbox_item_id: ITEM_ID }, { emit })).toMatchObject({
      ok: false,
      code: 'SI_CREDIT_DOCUMENT_UNAVAILABLE',
      details: { reason: 'linked' },
    })
  })

  it('refuses the credit note\'s own date when its period is locked, never re-dating it', async () => {
    happyTables()
    setTable('invoice_inbox_items', { data: inboxItem(fullCreditNote) })
    setTable('fiscal_periods', { data: { id: 'fp-9', is_closed: false, locked_at: '2026-09-25T00:00:00Z' } })
    expect(await creditSupplierInvoice(ctx(), ORIGINAL_ID, { inbox_item_id: ITEM_ID }, { emit })).toMatchObject({
      ok: false,
      code: 'SI_CREDIT_PERIOD_LOCKED',
      details: { credit_date: '2026-09-18', date_source: 'document' },
    })
  })
})

describe('CreditSupplierInvoiceInputSchema', () => {
  it('accepts an empty body and refuses unknown or malformed fields', () => {
    expect(CreditSupplierInvoiceInputSchema.safeParse({}).success).toBe(true)
    expect(CreditSupplierInvoiceInputSchema.safeParse({ credit_date: '18/9 2026' }).success).toBe(false)
    expect(CreditSupplierInvoiceInputSchema.safeParse({ inbox_item_id: 'nope' }).success).toBe(false)
    expect(CreditSupplierInvoiceInputSchema.safeParse({ amount: 100 }).success).toBe(false)
  })
})
