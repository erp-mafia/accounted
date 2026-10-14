/**
 * creditInvoice, the credit every door runs (lib/invoices/credit-invoice.ts).
 *
 * The v1 and MCP credits used to copy the original's items without the
 * ROT/RUT and periodisering fields, credit a credit note, number a
 * self-billed original after its id, and flip the original to 'credited'
 * before the verifikat existed. These pin the one implementation: the
 * reversal mirrors the original (Cr 1513 + Cr 1510 customer share, 29xx,
 * override accounts), a credit note is refused, and nothing is written or
 * flipped unless the verifikat can be posted.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTableMockSupabase } from '@/tests/helpers'
import { eventBus } from '@/lib/events'
import type { Logger } from '@/lib/logger'

const mocks = vi.hoisted(() => ({
  checkPeriodLock: vi.fn(),
  createJournalEntry: vi.fn(),
  findFiscalPeriod: vi.fn(),
  cancelSchedulesForSource: vi.fn(),
  renderInvoicePdfBuffer: vi.fn(),
  uploadDocument: vi.fn(),
  recordManualInvoiceDelivery: vi.fn(),
}))

vi.mock('@/lib/api/v1/check-period-lock', () => ({ checkPeriodLock: mocks.checkPeriodLock }))
vi.mock('@/lib/bookkeeping/engine', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/bookkeeping/engine')>()),
  createJournalEntry: mocks.createJournalEntry,
  findFiscalPeriod: mocks.findFiscalPeriod,
}))
vi.mock('@/lib/bookkeeping/accruals/service', () => ({
  cancelSchedulesForSource: mocks.cancelSchedulesForSource,
}))
vi.mock('@/lib/invoices/render-invoice-pdf', () => ({
  renderInvoicePdfBuffer: mocks.renderInvoicePdfBuffer,
}))
vi.mock('@/lib/core/documents/document-service', () => ({
  uploadDocument: mocks.uploadDocument,
}))
vi.mock('@/lib/invoices/invoice-deliveries', () => ({
  recordManualInvoiceDelivery: mocks.recordManualInvoiceDelivery,
}))
vi.mock('@/lib/collections/forward-hook', () => ({
  scheduleCollectionForwardDrain: vi.fn(),
}))

import { creditInvoice, creditNoteRefusal } from '../credit-invoice'
import { buildCreditNoteFields } from '../build-credit-note'
import { buildCreditNoteItem } from '../build-credit-note-item'
import type { Invoice, InvoiceItem } from '@/types'

const log: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: () => log }

const COMPANY_ID = 'company-1'
const USER_ID = 'user-1'
const ORIGINAL_ID = 'original-1'
const CREDIT_ID = 'credit-1'

const SETTINGS = {
  company_id: COMPANY_ID,
  company_name: 'Test AB',
  accounting_method: 'accrual',
  entity_type: 'aktiebolag',
}

// 10 000 kr arbete + 25 % moms = 12 500; ROT 30 % of the labour incl. moms
// is 3 750, Skatteverket's share (1513); the customer owes 8 750 (1510).
const ROT_ITEM = {
  id: 'item-1',
  invoice_id: ORIGINAL_ID,
  sort_order: 0,
  line_type: 'product',
  description: 'Arbete',
  quantity: 10,
  unit: 'tim',
  unit_price: 1000,
  discount_percent: 0,
  line_total: 10000,
  vat_rate: 25,
  vat_amount: 2500,
  revenue_account: '3041',
  article_id: null,
  deduction_type: 'rot',
  deduction_amount: 3750,
  labor_hours: 10,
  work_type: 'bygg',
  accrual_period_start: null,
  accrual_period_end: null,
  accrual_balance_account: null,
  dimensions: {},
} as unknown as InvoiceItem

const ORIGINAL = {
  id: ORIGINAL_ID,
  company_id: COMPANY_ID,
  invoice_number: 'F-1042',
  external_invoice_number: null,
  customer_id: 'customer-1',
  invoice_date: '2026-09-01',
  due_date: '2026-10-01',
  status: 'sent',
  document_type: 'invoice',
  credited_invoice_id: null,
  currency: 'SEK',
  exchange_rate: null,
  subtotal: 10000,
  subtotal_sek: 10000,
  vat_amount: 2500,
  vat_amount_sek: 2500,
  total: 12500,
  total_sek: 12500,
  vat_treatment: 'standard_25',
  vat_rate: 25,
  moms_ruta: '05',
  deduction_total: 3750,
  deduction_reclaimed_total: 0,
  journal_entry_id: 'je-original',
  paid_at: null,
  paid_amount: 0,
  default_dimensions: {},
  customer: { id: 'customer-1', name: 'Kund' },
  items: [ROT_ITEM],
} as unknown as Invoice & { items: InvoiceItem[] }

/** The credit note as createCreditNoteDraft writes it, read back. */
function draftOf(original: Invoice & { items: InvoiceItem[] }, overrides: Record<string, unknown> = {}) {
  const ref = original.invoice_number ?? original.external_invoice_number ?? ''
  return {
    id: CREDIT_ID,
    company_id: COMPANY_ID,
    invoice_number: `KR-${ref}`,
    ...buildCreditNoteFields(original, { originalReference: ref, today: '2026-10-13' }),
    status: 'draft',
    document_type: 'invoice',
    journal_entry_id: null,
    customer: original.customer,
    items: original.items.map((item) => buildCreditNoteItem(CREDIT_ID, item)),
    ...overrides,
  }
}

function setup(original: object = ORIGINAL, extra: Record<string, unknown> = {}) {
  const draft = draftOf(original as Invoice & { items: InvoiceItem[] })
  return createTableMockSupabase({
    invoices: [
      { data: original }, // creditInvoice: the original
      { data: null }, // createCreditNoteDraft: no existing credit note
      { data: { id: CREDIT_ID } }, // insert
      { data: null }, // creation_complete
      { data: draft }, // the completed draft
      { data: original }, // issueCreditNoteDraft: the original's booked-ness
      { data: [{ id: CREDIT_ID }] }, // compare-and-set to sent
      { data: [{ id: CREDIT_ID }] }, // journal_entry_id link
      { data: [{ id: ORIGINAL_ID }] }, // original flipped to credited
    ],
    invoice_items: { data: null },
    journal_entries: { data: null },
    company_settings: { data: SETTINGS },
    ...extra,
  })
}

const ctx = (supabase: unknown) => ({ supabase: supabase as never, companyId: COMPANY_ID, userId: USER_ID, log })

beforeEach(() => {
  vi.clearAllMocks()
  eventBus.clear()
  mocks.checkPeriodLock.mockResolvedValue({ locked: false, fiscal_period_id: 'fp-1' })
  mocks.findFiscalPeriod.mockResolvedValue('fp-1')
  mocks.createJournalEntry.mockResolvedValue({ id: 'je-credit', voucher_series: 'A', voucher_number: 7 })
  mocks.cancelSchedulesForSource.mockResolvedValue({ cancelled: 0, failedReversals: 0 })
  mocks.renderInvoicePdfBuffer.mockResolvedValue({ buffer: Buffer.from('pdf') })
  mocks.uploadDocument.mockResolvedValue({ id: 'doc-1' })
  mocks.recordManualInvoiceDelivery.mockResolvedValue({ id: 'delivery-1' })
})

describe('creditNoteRefusal', () => {
  it('refuses a credit note: crediting it would reverse the same sale twice', () => {
    expect(creditNoteRefusal({ status: 'sent', document_type: 'invoice', credited_invoice_id: 'x', invoice_number: 'KR-1' }))
      .toEqual({ code: 'INVOICE_CREDIT_NOT_INVOICE', details: { reason: 'credit_note' } })
  })

  it.each([
    [{ status: 'sent', document_type: 'proforma', invoice_number: 'P-1' }, 'INVOICE_CREDIT_NOT_INVOICE'],
    [{ status: 'credited', invoice_number: 'F-1' }, 'INVOICE_CREDIT_ALREADY_CREDITED'],
    [{ status: 'draft', invoice_number: null }, 'INVOICE_CREDIT_NOT_SENT'],
    [{ status: 'partially_paid', invoice_number: 'F-1' }, 'INVOICE_CREDIT_NOT_SENT'],
    [{ status: 'sent', invoice_number: 'F-1', deduction_reclaimed_total: 100 }, 'INVOICE_CREDIT_ROT_RUT_RECLAIMED'],
    [{ status: 'sent', invoice_number: null, external_invoice_number: null }, 'INVOICE_CREDIT_NO_NUMBER'],
  ])('refuses %o with %s', (original, code) => {
    expect(creditNoteRefusal(original as never)?.code).toBe(code)
  })

  it('takes a sent, paid or overdue invoice', () => {
    for (const status of ['sent', 'paid', 'overdue']) {
      expect(creditNoteRefusal({ status: status as never, invoice_number: 'F-1' })).toBeNull()
    }
  })
})

describe('creditInvoice', () => {
  it('mirrors a ROT invoice: Cr 1513 for Skatteverket, Cr 1510 for the customer, the override account debited', async () => {
    const { supabase, calls } = setup()

    const result = await creditInvoice(ctx(supabase), ORIGINAL_ID, { reason: 'Fel pris' })

    expect(result).toMatchObject({ ok: true, creditNoteId: CREDIT_ID, journalEntryId: 'je-credit' })
    // The credit items carry everything the reversal books from.
    const itemsInsert = calls.find((c) => c.table === 'invoice_items' && c.method === 'insert')
    expect(itemsInsert?.args[0]).toEqual([
      expect.objectContaining({
        quantity: -10,
        line_total: -10000,
        revenue_account: '3041',
        deduction_type: 'rot',
        deduction_amount: 3750,
        work_type: 'bygg',
      }),
    ])
    const entry = mocks.createJournalEntry.mock.calls[0][3] as {
      source_type: string
      lines: Array<{ account_number: string; debit_amount: number; credit_amount: number }>
    }
    expect(entry.source_type).toBe('credit_note')
    const byAccount = Object.fromEntries(entry.lines.map((l) => [l.account_number, l]))
    expect(byAccount['3041']).toMatchObject({ debit_amount: 10000, credit_amount: 0 })
    expect(byAccount['2611']).toMatchObject({ debit_amount: 2500, credit_amount: 0 })
    expect(byAccount['1513']).toMatchObject({ debit_amount: 0, credit_amount: 3750 })
    expect(byAccount['1510']).toMatchObject({ debit_amount: 0, credit_amount: 8750 })
    // The original is flipped only after the verifikat exists.
    const updates = calls.filter((c) => c.table === 'invoices' && c.method === 'update').map((c) => c.args[0])
    expect(updates).toContainEqual({ status: 'credited' })
    // The schedules of a periodised original stop (faktureringsmetoden).
    expect(mocks.cancelSchedulesForSource).toHaveBeenCalledWith(
      expect.anything(),
      COMPANY_ID,
      USER_ID,
      { invoiceId: ORIGINAL_ID },
      expect.objectContaining({ reversalDate: expect.any(String) }),
    )
    // The issued credit note is archived as underlag on its verifikat.
    expect(mocks.uploadDocument).toHaveBeenCalledWith(
      expect.anything(),
      USER_ID,
      COMPANY_ID,
      expect.objectContaining({ type: 'application/pdf' }),
      expect.objectContaining({ journal_entry_id: 'je-credit' }),
    )
  })

  it('reverses a deferred line on its 29xx account', async () => {
    const deferred = {
      ...ORIGINAL,
      deduction_total: 0,
      items: [{
        ...ROT_ITEM,
        revenue_account: null,
        deduction_type: null,
        deduction_amount: 0,
        accrual_period_start: '2026-09-01',
        accrual_period_end: '2027-02-28',
        accrual_balance_account: '2970',
      }],
    }
    const { supabase } = setup(deferred)

    const result = await creditInvoice(ctx(supabase), ORIGINAL_ID, {})

    expect(result.ok).toBe(true)
    const entry = mocks.createJournalEntry.mock.calls[0][3] as {
      lines: Array<{ account_number: string; debit_amount: number }>
    }
    expect(entry.lines.find((l) => l.account_number === '2970')?.debit_amount).toBe(10000)
    expect(entry.lines.some((l) => l.account_number.startsWith('30'))).toBe(false)
  })

  it('numbers a self-billed original KR-<its external number>', async () => {
    const selfBilled = { ...ORIGINAL, invoice_number: null, external_invoice_number: 'SB-77' }
    const { supabase, calls } = setup(selfBilled)

    await creditInvoice(ctx(supabase), ORIGINAL_ID, {})

    const insert = calls.find((c) => c.table === 'invoices' && c.method === 'insert')
    expect(insert?.args[0]).toMatchObject({ invoice_number: 'KR-SB-77', credited_invoice_id: ORIGINAL_ID })
  })

  it('refuses a credit note as the original before anything is written', async () => {
    const { supabase, calls } = setup({ ...ORIGINAL, invoice_number: 'KR-F-1', credited_invoice_id: 'other' })

    const result = await creditInvoice(ctx(supabase), ORIGINAL_ID, {})

    expect(result).toMatchObject({ ok: false, code: 'INVOICE_CREDIT_NOT_INVOICE' })
    expect(calls.filter((c) => c.method === 'insert' || c.method === 'update')).toEqual([])
  })

  it.each([
    [{ locked: true, reason: 'period_locked_at_set', fiscal_period_id: 'fp-locked' }, 'period_locked_at_set'],
    [{ locked: true, reason: 'period_is_closed', fiscal_period_id: 'fp-closed' }, 'period_is_closed'],
    [{ locked: false, reason: 'no_fiscal_period' }, 'no_fiscal_period'],
  ])('refuses before any write when today cannot take the verifikat (%o)', async (verdict, reason) => {
    mocks.checkPeriodLock.mockResolvedValue(verdict)
    const { supabase, calls } = setup()

    const result = await creditInvoice(ctx(supabase), ORIGINAL_ID, {})

    expect(result).toMatchObject({ ok: false, code: 'INVOICE_CREDIT_PERIOD_LOCKED', details: { reason } })
    expect(calls.filter((c) => c.method === 'insert' || c.method === 'update')).toEqual([])
    expect(mocks.createJournalEntry).not.toHaveBeenCalled()
  })

  it('keeps the draft and leaves the original untouched when the verifikat is refused', async () => {
    mocks.createJournalEntry.mockRejectedValue(new Error('Period locked'))
    const { supabase, calls } = setup(ORIGINAL, {
      invoices: [
        { data: ORIGINAL },
        { data: null },
        { data: { id: CREDIT_ID } },
        { data: null },
        { data: draftOf(ORIGINAL) },
        { data: ORIGINAL },
        { data: [{ id: CREDIT_ID }] }, // compare-and-set to sent
        { data: [{ id: CREDIT_ID }] }, // restored to draft
      ],
    })

    const result = await creditInvoice(ctx(supabase), ORIGINAL_ID, {})

    expect(result).toMatchObject({
      ok: false,
      code: 'INVOICE_CREDIT_ISSUE_INCOMPLETE',
      details: { failure_steps: ['journal_entry'] },
    })
    expect(result).not.toHaveProperty('postedIds')
    const updates = calls.filter((c) => c.table === 'invoices' && c.method === 'update').map((c) => c.args[0])
    expect(updates).toContainEqual({ status: 'sent' })
    expect(updates).toContainEqual({ status: 'draft' })
    expect(updates).not.toContainEqual({ status: 'credited' })
  })

  it('reuses the kept draft on a retry instead of creating a second credit note', async () => {
    const draft = draftOf(ORIGINAL, { invoice_date: '2026-10-13' })
    const { supabase, calls } = createTableMockSupabase({
      invoices: [
        { data: ORIGINAL },
        { data: draft }, // the existing credit note
        { data: ORIGINAL },
        { data: [{ id: CREDIT_ID }] },
        { data: [{ id: CREDIT_ID }] },
        { data: [{ id: ORIGINAL_ID }] },
      ],
      journal_entries: { data: null },
      company_settings: { data: SETTINGS },
    })

    const result = await creditInvoice(ctx(supabase), ORIGINAL_ID, {})

    expect(result).toMatchObject({ ok: true, creditNoteId: CREDIT_ID })
    expect(calls.some((c) => c.table === 'invoices' && c.method === 'insert')).toBe(false)
  })

  it('reports a verifikat that posted before a later step failed with its ids (repair)', async () => {
    const { supabase } = setup(ORIGINAL, {
      invoices: [
        { data: ORIGINAL },
        { data: null },
        { data: { id: CREDIT_ID } },
        { data: null },
        { data: draftOf(ORIGINAL) },
        { data: ORIGINAL },
        { data: [{ id: CREDIT_ID }] }, // compare-and-set to sent
        { data: [] }, // journal_entry_id link matched nothing
      ],
    })

    const result = await creditInvoice(ctx(supabase), ORIGINAL_ID, {})

    expect(result).toMatchObject({
      ok: false,
      code: 'INVOICE_CREDIT_REPAIR_REQUIRED',
      postedIds: { credit_note_id: CREDIT_ID, original_invoice_id: ORIGINAL_ID, journal_entry_id: 'je-credit' },
    })
  })

  it('credits an unpaid kontantmetod invoice without a verifikat and without a period check', async () => {
    mocks.checkPeriodLock.mockResolvedValue({ locked: true, reason: 'period_is_closed' })
    const unpaid = { ...ORIGINAL, journal_entry_id: null, paid_at: null, paid_amount: 0 }
    const { supabase } = setup(unpaid, { company_settings: { data: { ...SETTINGS, accounting_method: 'cash' } } })

    const result = await creditInvoice(ctx(supabase), ORIGINAL_ID, {})

    expect(result).toMatchObject({ ok: true, journalEntryId: null })
    expect(mocks.checkPeriodLock).not.toHaveBeenCalled()
    expect(mocks.createJournalEntry).not.toHaveBeenCalled()
  })

  it('dry run: the would-be credit note, nothing written, no personnummer ciphertext', async () => {
    const withPn = { ...ORIGINAL, deduction_personnummer_encrypted: 'cipher', deduction_personnummer_last4: '1234' }
    const { supabase, calls } = setup(withPn)

    const result = await creditInvoice(ctx(supabase), ORIGINAL_ID, {}, { dryRun: true })

    expect(result.ok && result.dryRun).toBe(true)
    if (!result.ok || !result.dryRun) return
    expect(result.preview).toMatchObject({
      invoice_number: 'KR-F-1042',
      total: -12500,
      deduction_total: 3750,
      would_create_journal_entry: true,
      items: [expect.objectContaining({ deduction_type: 'rot', revenue_account: '3041' })],
    })
    expect(result.preview).not.toHaveProperty('deduction_personnummer_encrypted')
    expect(calls.filter((c) => c.method === 'insert' || c.method === 'update')).toEqual([])
  })
})
