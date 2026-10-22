/**
 * bookCounterpartySetoff: the dry run's preview, the refusals answered before
 * the database is asked, the posting port call (book_counterparty_setoff
 * through commitSqlPosting), the RPC's refusals and races translated, and the
 * best-effort rest after the commit (the archived note, the paid events, the
 * reserve release). The RPC's own rules are tested in
 * tests/pg/counterparty-setoff.pg.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockSupabase } from '@/tests/helpers'
import type { SetoffPairState } from '../state'

const h = vi.hoisted(() => ({
  loadSetoffPair: vi.fn(),
  countPairSetoffs: vi.fn(),
  checkPeriodLock: vi.fn(),
  recordEventsForSql: vi.fn(),
  commitSqlPosting: vi.fn(),
  uploadDocument: vi.fn(),
  renderSetoffNote: vi.fn(),
  releaseDoubtfulReserveAfterChange: vi.fn(),
  emitInvoicePaidIfSettled: vi.fn(),
  emitSupplierInvoicePaidIfSettled: vi.fn(),
  clearSettledInvoiceSuggestions: vi.fn(),
}))

vi.mock('../state', () => ({ loadSetoffPair: h.loadSetoffPair, countPairSetoffs: h.countPairSetoffs }))
vi.mock('@/lib/api/v1/check-period-lock', () => ({ checkPeriodLock: h.checkPeriodLock }))
vi.mock('@/lib/posting/port', () => ({
  postingPort: { recordEventsForSql: h.recordEventsForSql, commitSqlPosting: h.commitSqlPosting },
}))
vi.mock('@/lib/core/documents/document-service', () => ({ uploadDocument: h.uploadDocument }))
vi.mock('../note-pdf', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../note-pdf')>()),
  renderSetoffNote: h.renderSetoffNote,
}))
vi.mock('@/lib/customer-loss/doubtful', () => ({ releaseDoubtfulReserveAfterChange: h.releaseDoubtfulReserveAfterChange }))
vi.mock('@/lib/invoices/paid-events', () => ({
  emitInvoicePaidIfSettled: h.emitInvoicePaidIfSettled,
  emitSupplierInvoicePaidIfSettled: h.emitSupplierInvoicePaidIfSettled,
}))
vi.mock('@/lib/invoices/clear-settled-invoice-suggestions', () => ({
  clearSettledInvoiceSuggestions: h.clearSettledInvoiceSuggestions,
}))
vi.mock('@/lib/dates/iso', () => ({ todayIsoStockholm: () => '2026-10-21' }))

import { bookCounterpartySetoff } from '../book'
import { setoffId } from '../ids'

const PARTY = 'party-crayfish'

function pair(): SetoffPairState {
  return {
    invoice: {
      id: 'inv-1',
      number: '2631',
      status: 'sent',
      documentType: 'invoice',
      creditedInvoiceId: null,
      currency: 'SEK',
      total: 1388,
      remaining: 1388,
      paid: 0,
      deductionTotal: 0,
      invoiceDate: '2026-08-31',
      dueDate: '2026-09-10',
      booked: true,
      partyId: PARTY,
      collectionOpen: false,
    },
    supplierInvoice: {
      id: 'si-1',
      number: 'SF-CE-202607',
      arrivalNumber: 41,
      status: 'registered',
      isCreditNote: false,
      currency: 'SEK',
      total: 4504,
      remaining: 4504,
      paid: 0,
      invoiceDate: '2026-09-11',
      dueDate: '2026-10-11',
      booked: true,
      partyId: PARTY,
      paymentInFlight: false,
    },
    customerName: 'Crayfish Energy AB',
    supplierName: 'Crayfish Energy AB',
  }
}

const BOOKED = {
  ok: true,
  setoff_id: 'set-1',
  journal_entry_id: 'je-1',
  voucher_series: 'A',
  voucher_number: 42,
  party_id: PARTY,
  amount: '1388.00',
  receivable_account: '1510',
  payable_account: '2440',
  invoice: { invoice_id: 'inv-1', payment_id: 'ip-1', status: 'paid', paid_amount: '1388', remaining_amount: '0' },
  supplier_invoice: { supplier_invoice_id: 'si-1', payment_id: 'sip-1', status: 'partially_paid', paid_amount: '1388', remaining_amount: '3116' },
}

function context() {
  const { supabase } = createMockSupabase()
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
  return { supabase: supabase as never, companyId: 'company-1', userId: 'user-1', log: log as never }
}

beforeEach(() => {
  vi.clearAllMocks()
  h.loadSetoffPair.mockResolvedValue({ ok: true, state: pair() })
  h.countPairSetoffs.mockResolvedValue(0)
  h.checkPeriodLock.mockResolvedValue({ locked: false, fiscal_period_id: 'fp-1' })
  h.recordEventsForSql.mockResolvedValue(undefined)
  h.commitSqlPosting.mockResolvedValue({ data: BOOKED, error: null })
  h.renderSetoffNote.mockResolvedValue(Buffer.from('%PDF'))
  h.uploadDocument.mockResolvedValue({ id: 'doc-1' })
})

describe('bookCounterpartySetoff: dry run', () => {
  it('answers the preview and writes nothing', async () => {
    const outcome = await bookCounterpartySetoff(
      context(),
      { invoiceId: 'inv-1', supplierInvoiceId: 'si-1', setoffDate: '2026-09-30', note: ' Flexavtal ' },
      { dryRun: true },
    )
    expect(outcome).toEqual({
      ok: true,
      dryRun: true,
      preview: expect.objectContaining({
        party_id: PARTY,
        amount: 1388,
        setoff_date: '2026-09-30',
        note: 'Flexavtal',
        invoice: expect.objectContaining({ invoice_id: 'inv-1', remaining_after: 0, status_after: 'paid' }),
        supplier_invoice: expect.objectContaining({ supplier_invoice_id: 'si-1', remaining_after: 3116, status_after: 'partially_paid' }),
        net: { direction: 'we_pay', amount: 3116 },
        lines: [
          { account_number: '2440', debit_amount: 1388, credit_amount: 0 },
          { account_number: '1510', debit_amount: 0, credit_amount: 1388 },
        ],
      }),
    })
    expect(h.commitSqlPosting).not.toHaveBeenCalled()
    expect(h.recordEventsForSql).not.toHaveBeenCalled()
  })

  it('refuses before the database: not found, planner refusals, a pinned party, a locked or missing period', async () => {
    h.loadSetoffPair.mockResolvedValueOnce({ ok: false, code: 'SETOFF_INVOICE_NOT_FOUND' })
    expect(await bookCounterpartySetoff(context(), { invoiceId: 'x', supplierInvoiceId: 'si-1' }, { dryRun: false })).toEqual({
      ok: false,
      code: 'SETOFF_INVOICE_NOT_FOUND',
    })

    expect(
      await bookCounterpartySetoff(context(), { invoiceId: 'inv-1', supplierInvoiceId: 'si-1', amount: 5000 }, { dryRun: false }),
    ).toMatchObject({ ok: false, code: 'SETOFF_AMOUNT_EXCEEDS_REMAINING' })

    expect(
      await bookCounterpartySetoff(context(), { invoiceId: 'inv-1', supplierInvoiceId: 'si-1', expectedPartyId: 'someone-else' }, { dryRun: false }),
    ).toMatchObject({ ok: false, code: 'SETOFF_PARTY_MISMATCH' })

    h.checkPeriodLock.mockResolvedValueOnce({ locked: true, reason: 'company_lock_date_covers' })
    expect(await bookCounterpartySetoff(context(), { invoiceId: 'inv-1', supplierInvoiceId: 'si-1' }, { dryRun: false })).toMatchObject({
      ok: false,
      code: 'SETOFF_PERIOD_LOCKED',
    })

    h.checkPeriodLock.mockResolvedValueOnce({ locked: false, reason: 'no_fiscal_period' })
    expect(await bookCounterpartySetoff(context(), { invoiceId: 'inv-1', supplierInvoiceId: 'si-1' }, { dryRun: true })).toMatchObject({
      ok: false,
      code: 'SETOFF_NO_FISCAL_PERIOD',
    })
    expect(h.commitSqlPosting).not.toHaveBeenCalled()
  })
})

describe('bookCounterpartySetoff: booking', () => {
  it('books through the posting port with the deterministic id and answers the result', async () => {
    const outcome = await bookCounterpartySetoff(
      context(),
      { invoiceId: 'inv-1', supplierInvoiceId: 'si-1', setoffDate: '2026-09-30', note: 'Flexavtal' },
      { dryRun: false },
    )
    expect(h.commitSqlPosting).toHaveBeenCalledWith({
      supabase: expect.anything(),
      companyId: 'company-1',
      userId: 'user-1',
      fn: 'book_counterparty_setoff',
      args: [
        {
          setoffId: await setoffId('inv-1', 'si-1', 0),
          invoiceId: 'inv-1',
          supplierInvoiceId: 'si-1',
          amount: 1388,
          setoffDate: '2026-09-30',
          note: 'Flexavtal',
        },
      ],
    })
    expect(outcome).toEqual({
      ok: true,
      data: {
        setoff_id: 'set-1',
        journal_entry_id: 'je-1',
        voucher_series: 'A',
        voucher_number: 42,
        party_id: PARTY,
        amount: 1388,
        setoff_date: '2026-09-30',
        invoice: { invoice_id: 'inv-1', status: 'paid', remaining_amount: 0 },
        supplier_invoice: { supplier_invoice_id: 'si-1', status: 'partially_paid', remaining_amount: 3116 },
        net: { direction: 'we_pay', amount: 3116 },
        underlag_document_id: 'doc-1',
      },
    })
    // The note goes on the set-off's own verifikat.
    expect(h.uploadDocument).toHaveBeenCalledWith(
      expect.anything(),
      'user-1',
      'company-1',
      expect.objectContaining({ name: 'Kvittningsavrakning_2026-09-30_2631.pdf', type: 'application/pdf' }),
      expect.objectContaining({ upload_source: 'system', journal_entry_id: 'je-1', extractionOwner: 'none' }),
    )
    expect(h.renderSetoffNote).toHaveBeenCalledWith(
      expect.objectContaining({ voucherLabel: 'A42', amount: 1388, receivableAccount: '1510', payableAccount: '2440' }),
    )
    // The settled customer invoice drops its stale match suggestions; the part-paid supplier invoice keeps them.
    expect(h.clearSettledInvoiceSuggestions).toHaveBeenCalledWith(expect.anything(), 'company-1', 'invoice', 'inv-1')
    expect(h.clearSettledInvoiceSuggestions).toHaveBeenCalledTimes(1)
    expect(h.releaseDoubtfulReserveAfterChange).toHaveBeenCalledWith(expect.anything(), 'company-1', 'user-1', {
      invoiceId: 'inv-1',
      entryDate: '2026-09-30',
      trigger: 'payment',
    })
  })

  it('takes the next ordinal for a pair that was set off before', async () => {
    h.countPairSetoffs.mockResolvedValue(2)
    await bookCounterpartySetoff(context(), { invoiceId: 'inv-1', supplierInvoiceId: 'si-1' }, { dryRun: false })
    const args = h.commitSqlPosting.mock.calls[0]![0].args[0] as { setoffId: string }
    expect(args.setoffId).toBe(await setoffId('inv-1', 'si-1', 2))
    expect(args.setoffId).not.toBe(await setoffId('inv-1', 'si-1', 0))
  })

  it("answers the RPC's refusal with its code", async () => {
    h.commitSqlPosting.mockResolvedValue({ data: { ok: false, code: 'SETOFF_PAYMENT_IN_FLIGHT', details: { supplier_invoice_id: 'si-1' } }, error: null })
    expect(await bookCounterpartySetoff(context(), { invoiceId: 'inv-1', supplierInvoiceId: 'si-1' }, { dryRun: false })).toEqual({
      ok: false,
      code: 'SETOFF_PAYMENT_IN_FLIGHT',
      details: { supplier_invoice_id: 'si-1' },
    })
    expect(h.uploadDocument).not.toHaveBeenCalled()
  })

  it('answers a unique violation as SETOFF_RACE and any other error as SETOFF_BOOKING_FAILED', async () => {
    h.commitSqlPosting.mockResolvedValueOnce({ data: null, error: { code: '23505', message: 'duplicate key' } })
    expect(await bookCounterpartySetoff(context(), { invoiceId: 'inv-1', supplierInvoiceId: 'si-1' }, { dryRun: false })).toEqual({
      ok: false,
      code: 'SETOFF_RACE',
    })
    h.commitSqlPosting.mockResolvedValueOnce({ data: null, error: { code: 'XX000', message: 'boom' } })
    expect(await bookCounterpartySetoff(context(), { invoiceId: 'inv-1', supplierInvoiceId: 'si-1' }, { dryRun: false })).toEqual({
      ok: false,
      code: 'SETOFF_BOOKING_FAILED',
    })
  })

  it('stops before any number when the posting port cannot record the event (strict)', async () => {
    h.recordEventsForSql.mockRejectedValue(new Error('strict'))
    expect(await bookCounterpartySetoff(context(), { invoiceId: 'inv-1', supplierInvoiceId: 'si-1' }, { dryRun: false })).toEqual({
      ok: false,
      code: 'SETOFF_BOOKING_FAILED',
    })
    expect(h.commitSqlPosting).not.toHaveBeenCalled()
  })

  it('keeps the booking and warns when the note cannot be archived', async () => {
    h.uploadDocument.mockRejectedValue(new Error('storage down'))
    const outcome = await bookCounterpartySetoff(context(), { invoiceId: 'inv-1', supplierInvoiceId: 'si-1' }, { dryRun: false })
    expect(outcome.ok).toBe(true)
    if (outcome.ok && !outcome.dryRun) {
      expect(outcome.data.underlag_document_id).toBeNull()
      expect(outcome.warnings?.map((w) => w.code)).toEqual(['SETOFF_UNDERLAG_NOT_ARCHIVED'])
    }
  })
})
