import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { CollectionsCase } from '@accounted/connect-contract'
import { createMemorySupabase, type MemorySupabase } from './memory-supabase'
import { recordCollectedPayments } from '../collected-payment-record'
import {
  autoBookCollectedPayments,
  bookCollectedPayment,
  automaticBookingUser,
  previewCollectedPayment,
  type CollectedPaymentBookingDeps,
} from '../collected-payments'
import type { settleInvoicePayment } from '@/lib/invoices/settle-invoice-payment'
import type { recordRecoveredLoss } from '@/lib/customer-loss/recovered'
import { createInvoiceCashPartialEntry } from '@/lib/bookkeeping/invoice-entries'

// The real settleInvoicePayment runs in the CASH_PARTIAL_PAYMENTS_ENABLED
// tests below; the pro-rata voucher itself is the one thing kept out of the
// store (it answers "no voucher", which settleInvoicePayment fails closed on).
vi.mock('@/lib/bookkeeping/invoice-entries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/bookkeeping/invoice-entries')>()),
  createInvoiceCashPartialEntry: vi.fn(async () => null),
}))

const COMPANY = 'company-1'
const OTHER_COMPANY = 'company-2'
const CASE = 'case-1'
const INVOICE = 'invoice-1'
const CONNECTION = 'connection-1'
const USER = 'user-1'
const OPENER = 'user-opener'
const NOW = new Date('2026-10-06T12:00:00.000Z')

type Settle = typeof settleInvoicePayment
type RecoverLoss = typeof recordRecoveredLoss

let mem: MemorySupabase
let settle: ReturnType<typeof vi.fn<Settle>>
let archiveRecord: ReturnType<typeof vi.fn<NonNullable<CollectedPaymentBookingDeps['archiveRecord']>>>

function seedWorld(options: { autoBook?: boolean; currency?: string; accountingMethod?: string } = {}) {
  mem.seed('collection_connections', [
    {
      id: CONNECTION,
      company_id: COMPANY,
      route: 'fake',
      state: 'active',
      user_id: USER,
      consented_by: USER,
      clearing_account: '1689',
      payout_account: '1930',
      auto_book_collected_payments: options.autoBook ?? false,
      auto_book_settlements: false,
    },
  ])
  mem.seed('collection_cases', [{ id: CASE, company_id: COMPANY, invoice_id: INVOICE, connection_id: CONNECTION, opened_by: OPENER }])
  mem.seed('invoices', [{ id: INVOICE, company_id: COMPANY, currency: options.currency ?? 'SEK', total: 1000, paid_amount: 0, status: 'sent' }])
  mem.seed('company_settings', [{ company_id: COMPANY, accounting_method: options.accountingMethod ?? 'accrual', entity_type: 'aktiebolag' }])
}

function seedCollected(overrides: Record<string, unknown> = {}): string {
  const id = (overrides.id as string | undefined) ?? `collected-${mem.rows('collection_collected_payments').length + 1}`
  mem.seed('collection_collected_payments', [
    {
      id,
      company_id: COMPANY,
      case_id: CASE,
      invoice_id: INVOICE,
      provider_payment_ref: 'pay-1',
      paid_at: '2026-09-27',
      total: 1100,
      capital_paid: 1000,
      to_creditor_other: 0,
      to_agency: 100,
      status: 'pending',
      invoice_payment_id: null,
      write_off_id: null,
      journal_entry_id: null,
      review_reason: null,
      booking_lease_until: null,
      settlement_id: null,
      ...overrides,
    },
  ])
  return id
}

/** settleInvoicePayment's effect on the store: a collections payment row, and a voucher id. */
function settles(journalEntryId = 'je-c1') {
  settle.mockImplementation(async (_db, companyId, _userId, params) => {
    mem.seed('journal_entries', [{ id: journalEntryId, company_id: companyId, status: 'posted' }])
    mem.seed('invoice_payments', [
      {
        id: `ip-${mem.rows('invoice_payments').length + 1}`,
        company_id: companyId,
        invoice_id: params.invoice.id,
        source: params.paymentSource,
        external_ref: params.externalRef,
        journal_entry_id: journalEntryId,
      },
    ])
    return { ok: true, newStatus: 'paid', newPaidAmount: 1000, newRemaining: 0, journalEntryId, paidAt: params.paymentDate, saleJournalEntryId: null, warnings: [] }
  })
}

function deps(companyId = COMPANY) {
  return { db: mem.client as SupabaseClient, companyId, now: () => NOW, settle: settle as unknown as Settle, archiveRecord }
}

beforeEach(() => {
  mem = createMemorySupabase()
  settle = vi.fn<Settle>()
  // The archive: a document row, not yet on a voucher.
  archiveRecord = vi.fn(async (input) => {
    const id = `record-${mem.rows('document_attachments').length + 1}`
    mem.seed('document_attachments', [{ id, company_id: input.companyId, journal_entry_id: null, file_name: 'record.pdf' }])
    return id
  })
})

describe('recordCollectedPayments', () => {
  const caseRow = { id: CASE, company_id: COMPANY, invoice_id: INVOICE }
  const payment = (ref: string, capitalPaid: number): CollectionsCase['collectedPayments'][number] => ({
    paymentRef: ref,
    paidAt: '2026-09-27',
    total: capitalPaid + 100,
    capitalPaid,
    toCreditorOther: 0,
    toAgency: 100,
  })

  it('stores each payment with capital once, and nothing for fees the provider keeps', async () => {
    const snapshot = { collectedPayments: [payment('pay-1', 1000), payment('pay-fees', 0)] }
    expect(await recordCollectedPayments(mem.client, caseRow, snapshot)).toBe(1)
    expect(await recordCollectedPayments(mem.client, caseRow, snapshot)).toBe(0)
    expect(mem.rows('collection_collected_payments')).toEqual([
      expect.objectContaining({ case_id: CASE, invoice_id: INVOICE, provider_payment_ref: 'pay-1', capital_paid: 1000, to_agency: 100, paid_at: '2026-09-27' }),
    ])
  })

  it('writes nothing for a case without collected payments', async () => {
    expect(await recordCollectedPayments(mem.client, caseRow, { collectedPayments: [] })).toBe(0)
    expect(mem.writes).toEqual([])
  })
})

describe('bookCollectedPayment', () => {
  it('settles the invoice against the clearing account at the capital, as a collections payment, and records the booking', async () => {
    seedWorld()
    const id = seedCollected()
    settles()
    const result = await bookCollectedPayment(deps(), id, { userId: USER })
    expect(result).toEqual({ ok: true, journalEntryId: 'je-c1', invoicePaymentId: 'ip-1', writeOffId: null, alreadyBooked: false })
    expect(settle).toHaveBeenCalledTimes(1)
    const [, companyId, userId, params] = settle.mock.calls[0]!
    expect(companyId).toBe(COMPANY)
    expect(userId).toBe(USER)
    expect(params).toMatchObject({
      paymentAmountInInvoiceCurrency: 1000,
      paymentDate: '2026-09-27',
      accountingMethod: 'accrual',
      entityType: 'aktiebolag',
      settlementAccountNumber: '1689',
      paymentSource: 'collections',
      externalRef: 'pay-1',
    })
    expect(mem.rows('collection_collected_payments')[0]).toMatchObject({
      status: 'booked',
      invoice_payment_id: 'ip-1',
      journal_entry_id: 'je-c1',
      booked_by: USER,
      booked_at: NOW.toISOString(),
      booking_lease_until: null,
    })
  })

  it('passes kontantmetoden through, so a part payment books its pro-rata cash entry', async () => {
    seedWorld({ accountingMethod: 'cash' })
    const id = seedCollected({ capital_paid: 400 })
    settles('je-cash')
    await bookCollectedPayment(deps(), id, null)
    expect(settle.mock.calls[0]![3]).toMatchObject({ accountingMethod: 'cash', paymentAmountInInvoiceCurrency: 400, settlementAccountNumber: '1689' })
  })

  describe('a kontantmetoden part payment through the real settlement', () => {
    function seedCashPartWorld() {
      seedWorld({ accountingMethod: 'cash' })
      // 800 + 200 moms, never booked, nothing paid yet.
      Object.assign(mem.rows('invoices')[0]!, {
        subtotal: 800,
        vat_amount: 200,
        vat_treatment: 'standard_25',
        remaining_amount: 1000,
        journal_entry_id: null,
        invoice_number: 'F-1',
      })
      return seedCollected({ capital_paid: 400 })
    }
    afterEach(() => {
      vi.unstubAllEnvs()
    })

    it('waits for a person with the old refusal while CASH_PARTIAL_PAYMENTS_ENABLED is unset', async () => {
      vi.stubEnv('CASH_PARTIAL_PAYMENTS_ENABLED', '')
      const id = seedCashPartWorld()
      await bookCollectedPayment({ ...deps(), settle: undefined }, id, null)
      expect(vi.mocked(createInvoiceCashPartialEntry)).not.toHaveBeenCalled()
      expect(mem.rows('collection_collected_payments').find((r) => r.id === id)).toMatchObject({
        status: 'needs_review',
        review_reason: 'INVOICE_PAID_CASH_PARTIAL_UNSUPPORTED',
        journal_entry_id: null,
      })
    })

    it('goes for the pro-rata voucher on the clearing account once CASH_PARTIAL_PAYMENTS_ENABLED is set', async () => {
      vi.stubEnv('CASH_PARTIAL_PAYMENTS_ENABLED', '1')
      const id = seedCashPartWorld()
      await bookCollectedPayment({ ...deps(), settle: undefined }, id, null)
      expect(vi.mocked(createInvoiceCashPartialEntry)).toHaveBeenCalledWith(
        expect.anything(),
        COMPANY,
        OPENER,
        INVOICE,
        expect.objectContaining({
          lines: [
            expect.objectContaining({ account_number: '1689', debit_amount: 400, credit_amount: 0 }),
            expect.objectContaining({ credit_amount: 320 }),
            expect.objectContaining({ account_number: '2611', credit_amount: 80 }),
          ],
        }),
        '2026-09-27',
        // What the door saw, for the posting port (read only while POSTING_EVENTS is on).
        expect.any(Function),
      )
      // The stub books nothing, so the settlement fails closed and the row waits.
      expect(mem.rows('collection_collected_payments').find((r) => r.id === id)).toMatchObject({
        status: 'needs_review',
        review_reason: 'INVOICE_PAID_BOOK_FAILED',
      })
    })
  })

  it('books as the person who handed the invoice over when nobody clicked', async () => {
    seedWorld()
    const id = seedCollected()
    settles()
    await bookCollectedPayment(deps(), id, null)
    expect(settle.mock.calls[0]![2]).toBe(OPENER)
    expect(mem.rows('collection_collected_payments')[0]).toMatchObject({ status: 'booked', booked_by: null })
    expect(automaticBookingUser(null, { user_id: null, consented_by: 'consenter' })).toBe('consenter')
  })

  it('answers a booked row without settling again', async () => {
    seedWorld()
    const id = seedCollected({ status: 'booked', invoice_payment_id: 'ip-9', journal_entry_id: 'je-9', booked_at: NOW.toISOString() })
    expect(await bookCollectedPayment(deps(), id, { userId: USER })).toEqual({
      ok: true,
      journalEntryId: 'je-9',
      invoicePaymentId: 'ip-9',
      writeOffId: null,
      alreadyBooked: true,
    })
    expect(settle).not.toHaveBeenCalled()
  })

  it('records a payment the invoice already carries (a run that died after settling) without a second voucher', async () => {
    seedWorld()
    const id = seedCollected()
    mem.seed('journal_entries', [{ id: 'je-earlier', company_id: COMPANY, status: 'posted' }])
    mem.seed('invoice_payments', [
      { id: 'ip-earlier', company_id: COMPANY, invoice_id: INVOICE, source: 'collections', external_ref: 'pay-1', journal_entry_id: 'je-earlier' },
    ])
    expect(await bookCollectedPayment(deps(), id, { userId: USER })).toMatchObject({ ok: true, invoicePaymentId: 'ip-earlier', alreadyBooked: true })
    expect(settle).not.toHaveBeenCalled()
    // The voucher gets its payment record all the same.
    expect(archiveRecord).toHaveBeenCalledTimes(1)
    expect(mem.rows('document_attachments')).toEqual([expect.objectContaining({ id: 'record-1', journal_entry_id: 'je-earlier' })])
    expect(mem.rows('collection_collected_payments')[0]).toMatchObject({ payment_record_document_id: 'record-1', status: 'booked' })
  })

  it('removes the row a settlement that lost its race left on a cancelled voucher, and books the payment again', async () => {
    seedWorld()
    const id = seedCollected({ status: 'needs_review', review_reason: 'INVOICE_PAID_RACE' })
    mem.seed('journal_entries', [{ id: 'je-orphan', company_id: COMPANY, status: 'cancelled' }])
    mem.seed('invoice_payments', [
      { id: 'ip-stranded', company_id: COMPANY, invoice_id: INVOICE, source: 'collections', external_ref: 'pay-1', journal_entry_id: 'je-orphan' },
    ])
    settles('je-c2')
    expect(await bookCollectedPayment(deps(), id, { userId: USER })).toMatchObject({ ok: true, journalEntryId: 'je-c2', alreadyBooked: false })
    expect(settle).toHaveBeenCalledTimes(1)
    expect(mem.rows('invoice_payments').map((p) => p.id)).not.toContain('ip-stranded')
    expect(mem.rows('collection_collected_payments')[0]).toMatchObject({ status: 'booked', journal_entry_id: 'je-c2' })
    // The record goes on the voucher in the books, never on the cancelled one.
    expect(mem.rows('document_attachments')).toEqual([expect.objectContaining({ id: 'record-1', journal_entry_id: 'je-c2' })])
  })

  it.each([
    ['a reversed voucher', 'reversed'],
    ['a voucher the books do not hold', null],
  ])('never marks a payment booked on %s: a person looks', async (_label, status) => {
    seedWorld()
    const id = seedCollected()
    if (status) mem.seed('journal_entries', [{ id: 'je-other', company_id: COMPANY, status }])
    mem.seed('invoice_payments', [
      { id: 'ip-other', company_id: COMPANY, invoice_id: INVOICE, source: 'collections', external_ref: 'pay-1', journal_entry_id: status ? 'je-other' : null },
    ])
    expect(await bookCollectedPayment(deps(), id, { userId: USER })).toEqual({ ok: false, outcome: 'needs_review', reason: 'INVOICE_PAID_BOOK_FAILED' })
    expect(settle).not.toHaveBeenCalled()
    expect(mem.rows('invoice_payments').map((p) => p.id)).toContain('ip-other')
    expect(mem.rows('collection_collected_payments')[0]).toMatchObject({ status: 'needs_review', journal_entry_id: null })
  })

  it('archives the payment record before the voucher and links it as the voucher\'s underlag', async () => {
    seedWorld()
    mem.rows('collection_cases')[0]!.provider_case_number = 'CASE-77'
    mem.rows('collection_connections')[0]!.display_name = 'Acme Inkasso'
    mem.seed('profiles', [{ id: USER, full_name: 'Anna Andersson', email: 'anna@example.test' }])
    mem.rows('company_settings')[0]!.company_name = 'Testbolaget AB'
    mem.rows('invoices')[0]!.invoice_number = '1042'
    const id = seedCollected()
    let linkedWhenSettling: unknown = 'not called'
    settle.mockImplementation(async (_db, companyId, _userId, params) => {
      // The record exists, archived and not yet on a voucher, when the voucher is booked.
      linkedWhenSettling = mem.rows('document_attachments')[0]?.journal_entry_id
      mem.seed('journal_entries', [{ id: 'je-c1', company_id: companyId, status: 'posted' }])
      mem.seed('invoice_payments', [
        { id: 'ip-1', company_id: companyId, invoice_id: params.invoice.id, source: 'collections', external_ref: params.externalRef, journal_entry_id: 'je-c1' },
      ])
      return { ok: true, newStatus: 'paid', newPaidAmount: 1000, newRemaining: 0, journalEntryId: 'je-c1', paidAt: params.paymentDate, saleJournalEntryId: null, warnings: [] }
    })
    expect(await bookCollectedPayment(deps(), id, { userId: USER })).toMatchObject({ ok: true, journalEntryId: 'je-c1' })
    expect(linkedWhenSettling).toBeNull()
    expect(archiveRecord).toHaveBeenCalledTimes(1)
    const [input] = archiveRecord.mock.calls[0]!
    expect(input).toMatchObject({ companyId: COMPANY, userId: USER })
    expect(input.model).toMatchObject({
      providerName: 'Acme Inkasso',
      companyName: 'Testbolaget AB',
      invoiceNumber: '1042',
      caseNumber: 'CASE-77',
      providerPaymentRef: 'pay-1',
      paidAt: '2026-09-27',
      capitalPaid: 1000,
      toAgency: 100,
      clearingAccount: '1689',
      bookedAt: '2026-10-06 14:00',
      bookedBy: 'Anna Andersson',
      automatic: false,
    })
    expect(mem.rows('document_attachments')).toEqual([expect.objectContaining({ id: 'record-1', journal_entry_id: 'je-c1' })])
    expect(mem.rows('collection_collected_payments')[0]).toMatchObject({ status: 'booked', payment_record_document_id: 'record-1', journal_entry_id: 'je-c1' })
  })

  it('keeps the archived record when the booking is refused, and books with that one record on the next attempt', async () => {
    seedWorld()
    const id = seedCollected()
    settle.mockResolvedValueOnce({ ok: false, code: 'INVOICE_PAID_NO_FISCAL_PERIOD', details: {} })
    expect(await bookCollectedPayment(deps(), id, { userId: USER })).toMatchObject({ ok: false, outcome: 'needs_review' })
    expect(mem.rows('collection_collected_payments')[0]).toMatchObject({ status: 'needs_review', payment_record_document_id: 'record-1' })
    expect(mem.rows('document_attachments')[0]).toMatchObject({ journal_entry_id: null })

    settles()
    expect(await bookCollectedPayment(deps(), id, { userId: USER })).toMatchObject({ ok: true })
    expect(archiveRecord).toHaveBeenCalledTimes(1)
    expect(mem.rows('document_attachments')).toEqual([expect.objectContaining({ id: 'record-1', journal_entry_id: 'je-c1' })])
  })

  it('uses the record an attempt archived but died before noting on the row, never archiving a second', async () => {
    seedWorld()
    mem.rows('invoices')[0]!.invoice_number = '1042'
    const id = seedCollected()
    const fileName = 'Inbetalning_inkasso_1042_2026-09-27_pay-1.pdf'
    mem.seed('document_attachments', [
      // The earlier attempt's record: archived, not on a voucher, not on the row.
      { id: 'record-earlier', company_id: COMPANY, file_name: fileName, upload_source: 'system', is_current_version: true, journal_entry_id: null, created_at: '2026-10-06T11:00:00Z' },
      // Another company's document of the same name, and a record already on a voucher: never taken.
      { id: 'record-foreign', company_id: OTHER_COMPANY, file_name: fileName, upload_source: 'system', is_current_version: true, journal_entry_id: null, created_at: '2026-10-06T10:00:00Z' },
      { id: 'record-linked', company_id: COMPANY, file_name: fileName, upload_source: 'system', is_current_version: true, journal_entry_id: 'je-old', created_at: '2026-10-06T09:00:00Z' },
    ])
    settles()
    expect(await bookCollectedPayment(deps(), id, { userId: USER })).toMatchObject({ ok: true, journalEntryId: 'je-c1' })
    expect(archiveRecord).not.toHaveBeenCalled()
    expect(mem.rows('collection_collected_payments')[0]).toMatchObject({ payment_record_document_id: 'record-earlier' })
    expect(mem.rows('document_attachments').find((d) => d.id === 'record-earlier')).toMatchObject({ journal_entry_id: 'je-c1' })
    expect(mem.rows('document_attachments').find((d) => d.id === 'record-linked')).toMatchObject({ journal_entry_id: 'je-old' })
  })

  it('books nothing when the record cannot be archived', async () => {
    seedWorld()
    const id = seedCollected()
    archiveRecord.mockRejectedValueOnce(new Error('storage down'))
    await expect(bookCollectedPayment(deps(), id, { userId: USER })).rejects.toThrow('storage down')
    expect(settle).not.toHaveBeenCalled()
    expect(mem.rows('collection_collected_payments')[0]).toMatchObject({ status: 'pending', booking_lease_until: null })
  })

  it('names the automatic booking and the person it runs for on the record', async () => {
    seedWorld()
    mem.seed('profiles', [{ id: OPENER, full_name: null, email: 'opener@example.test' }])
    const id = seedCollected()
    settles()
    await bookCollectedPayment(deps(), id, null)
    expect(archiveRecord.mock.calls[0]![0]).toMatchObject({ userId: OPENER, model: { bookedBy: 'opener@example.test', automatic: true } })
  })

  it('leaves a row another booking holds alone', async () => {
    seedWorld()
    const id = seedCollected({ booking_lease_until: new Date(NOW.getTime() + 60_000).toISOString() })
    expect(await bookCollectedPayment(deps(), id, { userId: USER })).toEqual({ ok: false, outcome: 'busy' })
    expect(settle).not.toHaveBeenCalled()
  })

  it('takes over a lease that ran out', async () => {
    seedWorld()
    const id = seedCollected({ booking_lease_until: new Date(NOW.getTime() - 1).toISOString() })
    settles()
    expect(await bookCollectedPayment(deps(), id, { userId: USER })).toMatchObject({ ok: true })
  })

  it('puts a refused settlement (locked period, overpayment, race) in needs_review with the reason', async () => {
    seedWorld()
    const id = seedCollected()
    settle.mockResolvedValue({ ok: false, code: 'MATCH_AMOUNT_EXCEEDS_REMAINING', details: {} })
    expect(await bookCollectedPayment(deps(), id, { userId: USER })).toEqual({
      ok: false,
      outcome: 'needs_review',
      reason: 'MATCH_AMOUNT_EXCEEDS_REMAINING',
    })
    expect(mem.rows('collection_collected_payments')[0]).toMatchObject({
      status: 'needs_review',
      review_reason: 'MATCH_AMOUNT_EXCEEDS_REMAINING',
      booking_lease_until: null,
    })

    // Booked again once the cause is fixed.
    settles()
    expect(await bookCollectedPayment(deps(), id, { userId: USER })).toMatchObject({ ok: true })
    expect(mem.rows('collection_collected_payments')[0]).toMatchObject({ status: 'booked', review_reason: null })
  })

  it('names the bookkeeping error code when the engine refused', async () => {
    seedWorld()
    const id = seedCollected()
    settle.mockResolvedValue({ ok: false, code: 'BOOKKEEPING_ERROR', error: Object.assign(new Error('locked'), { code: 'TARGET_PERIOD_LOCKED' }) })
    expect(await bookCollectedPayment(deps(), id, null)).toMatchObject({ outcome: 'needs_review', reason: 'TARGET_PERIOD_LOCKED' })
  })

  it('never books an invoice in another currency', async () => {
    seedWorld({ currency: 'EUR' })
    const id = seedCollected()
    expect(await bookCollectedPayment(deps(), id, null)).toMatchObject({ outcome: 'needs_review', reason: 'CURRENCY_NOT_SEK' })
    expect(settle).not.toHaveBeenCalled()
  })

  it("never reaches another company's row, and refuses an ignored one", async () => {
    seedWorld()
    const id = seedCollected()
    expect(await bookCollectedPayment(deps(OTHER_COMPANY), id, null)).toEqual({ ok: false, outcome: 'not_found' })
    const ignored = seedCollected({ id: 'ignored', provider_payment_ref: 'pay-2', status: 'ignored', review_reason: 'handled by hand' })
    expect(await bookCollectedPayment(deps(), ignored, null)).toEqual({ ok: false, outcome: 'ignored' })
    expect(settle).not.toHaveBeenCalled()
  })

  it('releases the row when the booking throws', async () => {
    seedWorld()
    const id = seedCollected()
    settle.mockRejectedValue(new Error('network'))
    await expect(bookCollectedPayment(deps(), id, null)).rejects.toThrow('network')
    expect(mem.rows('collection_collected_payments')[0]).toMatchObject({ status: 'pending', booking_lease_until: null })
  })
})

describe('bookCollectedPayment on a written-off invoice', () => {
  let recoverLoss: ReturnType<typeof vi.fn<RecoverLoss>>

  beforeEach(() => {
    // recordRecoveredLoss's effect on the store: a posted customer_loss voucher and the recovered decision.
    recoverLoss = vi.fn<RecoverLoss>(async (_db, companyId, _userId, params) => {
      const n = mem.rows('invoice_write_offs').length + 1
      mem.seed('journal_entries', [{ id: `je-r${n}`, company_id: companyId, status: 'posted' }])
      mem.seed('invoice_write_offs', [
        {
          id: `wo-${n}`,
          company_id: companyId,
          invoice_id: params.invoiceId,
          kind: 'recovered',
          journal_entry_id: `je-r${n}`,
          evidence_document_id: params.evidenceDocumentId ?? null,
        },
      ])
      return { ok: true, writeOffId: `wo-${n}`, journalEntryId: `je-r${n}`, invoiceStatus: 'written_off', amount: params.amount }
    })
  })

  function writtenOffWorld(options: { autoBook?: boolean } = {}) {
    seedWorld(options)
    mem.rows('invoices')[0]!.status = 'written_off'
  }

  function recoveryDeps() {
    return { ...deps(), recoverLoss: recoverLoss as unknown as RecoverLoss }
  }

  it('books it as a recovered loss against the clearing account, with the payment record as underlag, and never settles the invoice', async () => {
    writtenOffWorld()
    const id = seedCollected()
    const result = await bookCollectedPayment(recoveryDeps(), id, { userId: USER })
    expect(result).toEqual({ ok: true, journalEntryId: 'je-r1', invoicePaymentId: null, writeOffId: 'wo-1', alreadyBooked: false })
    expect(settle).not.toHaveBeenCalled()
    expect(recoverLoss).toHaveBeenCalledTimes(1)
    const [, companyId, userId, params] = recoverLoss.mock.calls[0]!
    expect([companyId, userId]).toEqual([COMPANY, USER])
    expect(params).toEqual({
      invoiceId: INVOICE,
      amount: 1000,
      entryDate: '2026-09-27',
      paymentAccount: '1689',
      reason: expect.stringContaining('pay-1'),
      decidedBy: USER,
      fromCollectedPayment: true,
      evidenceDocumentId: 'record-1',
    })
    expect(mem.rows('collection_collected_payments')[0]).toMatchObject({
      status: 'booked',
      invoice_payment_id: null,
      write_off_id: 'wo-1',
      journal_entry_id: 'je-r1',
      payment_record_document_id: 'record-1',
      booked_by: USER,
      booking_lease_until: null,
    })
    expect(mem.rows('document_attachments')).toEqual([expect.objectContaining({ id: 'record-1', journal_entry_id: 'je-r1' })])
    expect(mem.rows('invoices')[0]).toMatchObject({ status: 'written_off' })
  })

  it('debits the clearing account the connection names', async () => {
    writtenOffWorld()
    mem.rows('collection_connections')[0]!.clearing_account = '1680'
    const id = seedCollected()
    await bookCollectedPayment(recoveryDeps(), id, { userId: USER })
    expect(recoverLoss.mock.calls[0]![3]).toMatchObject({ paymentAccount: '1680' })
  })

  it('leaves it to a person: the automatic booking never books a recovery', async () => {
    writtenOffWorld({ autoBook: true })
    const id = seedCollected()
    expect(await bookCollectedPayment(recoveryDeps(), id, null)).toEqual({ ok: false, outcome: 'needs_review', reason: 'WRITTEN_OFF_RECOVERY' })
    expect(recoverLoss).not.toHaveBeenCalled()
    expect(settle).not.toHaveBeenCalled()
    expect(archiveRecord).not.toHaveBeenCalled()
    expect(mem.rows('collection_collected_payments')[0]).toMatchObject({ status: 'needs_review', review_reason: 'WRITTEN_OFF_RECOVERY' })

    // The person's click books it.
    expect(await bookCollectedPayment(recoveryDeps(), id, { userId: USER })).toMatchObject({ ok: true, writeOffId: 'wo-1' })
  })

  it('puts a refused recovery in needs_review with its code and keeps the record for the next attempt', async () => {
    writtenOffWorld()
    const id = seedCollected()
    recoverLoss.mockResolvedValueOnce({ ok: false, code: 'CUSTOMER_LOSS_RECOVERY_EXCEEDS', details: { left: 500 } })
    expect(await bookCollectedPayment(recoveryDeps(), id, { userId: USER })).toEqual({
      ok: false,
      outcome: 'needs_review',
      reason: 'CUSTOMER_LOSS_RECOVERY_EXCEEDS',
    })
    expect(mem.rows('collection_collected_payments')[0]).toMatchObject({
      status: 'needs_review',
      review_reason: 'CUSTOMER_LOSS_RECOVERY_EXCEEDS',
      write_off_id: null,
      payment_record_document_id: 'record-1',
    })
    expect(mem.rows('document_attachments')[0]).toMatchObject({ journal_entry_id: null })
  })

  it('records a recovery a run booked and died before noting, without recovering twice', async () => {
    writtenOffWorld()
    mem.seed('document_attachments', [{ id: 'record-1', company_id: COMPANY, journal_entry_id: null, file_name: 'record.pdf' }])
    mem.seed('journal_entries', [{ id: 'je-r1', company_id: COMPANY, status: 'posted' }])
    mem.seed('invoice_write_offs', [
      { id: 'wo-1', company_id: COMPANY, invoice_id: INVOICE, kind: 'recovered', journal_entry_id: 'je-r1', evidence_document_id: 'record-1' },
    ])
    const id = seedCollected({ payment_record_document_id: 'record-1' })
    expect(await bookCollectedPayment(recoveryDeps(), id, { userId: USER })).toEqual({
      ok: true,
      journalEntryId: 'je-r1',
      invoicePaymentId: null,
      writeOffId: 'wo-1',
      alreadyBooked: true,
    })
    expect(recoverLoss).not.toHaveBeenCalled()
    expect(mem.rows('collection_collected_payments')[0]).toMatchObject({ status: 'booked', write_off_id: 'wo-1', journal_entry_id: 'je-r1' })
    expect(mem.rows('document_attachments')[0]).toMatchObject({ journal_entry_id: 'je-r1' })
  })

  it('recovers again when the earlier recovery of this record was reversed', async () => {
    writtenOffWorld()
    mem.seed('document_attachments', [{ id: 'record-1', company_id: COMPANY, journal_entry_id: null, file_name: 'record.pdf' }])
    mem.seed('journal_entries', [{ id: 'je-r0', company_id: COMPANY, status: 'reversed' }])
    mem.seed('invoice_write_offs', [
      { id: 'wo-0', company_id: COMPANY, invoice_id: INVOICE, kind: 'recovered', journal_entry_id: 'je-r0', evidence_document_id: 'record-1' },
    ])
    const id = seedCollected({ payment_record_document_id: 'record-1' })
    expect(await bookCollectedPayment(recoveryDeps(), id, { userId: USER })).toMatchObject({ ok: true, writeOffId: 'wo-2', alreadyBooked: false })
    expect(recoverLoss).toHaveBeenCalledTimes(1)
  })

  it('answers a row booked as a recovery without booking again', async () => {
    writtenOffWorld()
    const id = seedCollected({ status: 'booked', write_off_id: 'wo-1', journal_entry_id: 'je-r1', booked_at: NOW.toISOString() })
    expect(await bookCollectedPayment(recoveryDeps(), id, { userId: USER })).toEqual({
      ok: true,
      journalEntryId: 'je-r1',
      invoicePaymentId: null,
      writeOffId: 'wo-1',
      alreadyBooked: true,
    })
    expect(recoverLoss).not.toHaveBeenCalled()
  })
})

describe('autoBookCollectedPayments', () => {
  it('books only for companies that turned automatic booking on', async () => {
    seedWorld({ autoBook: false })
    seedCollected()
    settles()
    expect(await autoBookCollectedPayments({ db: mem.client as SupabaseClient, now: () => NOW, settle: settle as unknown as Settle, archiveRecord })).toEqual({
      booked: 0,
      needsReview: 0,
      skipped: 0,
      failed: 0,
      deferred: 0,
    })
    expect(settle).not.toHaveBeenCalled()

    mem.rows('collection_connections')[0]!.auto_book_collected_payments = true
    expect(await autoBookCollectedPayments({ db: mem.client as SupabaseClient, now: () => NOW, settle: settle as unknown as Settle, archiveRecord })).toEqual({
      booked: 1,
      needsReview: 0,
      skipped: 0,
      failed: 0,
      deferred: 0,
    })
    expect(settle.mock.calls[0]![2]).toBe(OPENER)
  })

  it('is not crowded out by payments that wait for a click in other companies', async () => {
    seedWorld({ autoBook: true })
    // Older payments of a company without automatic booking, more than one run takes.
    for (let i = 0; i < 60; i++) {
      seedCollected({ id: `other-${i}`, company_id: OTHER_COMPANY, provider_payment_ref: `other-pay-${i}`, paid_at: '2026-09-01' })
    }
    seedCollected({ id: 'own-1', paid_at: '2026-09-27' })
    settles()
    expect(await autoBookCollectedPayments({ db: mem.client as SupabaseClient, now: () => NOW, settle: settle as unknown as Settle, archiveRecord })).toEqual({
      booked: 1,
      needsReview: 0,
      skipped: 0,
      failed: 0,
      deferred: 0,
    })
    expect(settle).toHaveBeenCalledTimes(1)
    expect(mem.rows('collection_collected_payments').find((r) => r.id === 'own-1')!.status).toBe('booked')
    expect(mem.rows('collection_collected_payments').filter((r) => r.company_id === OTHER_COMPANY && r.status !== 'pending')).toEqual([])
  })

  it('starts no booking once the run budget is spent; the next run books the rest', async () => {
    seedWorld({ autoBook: true })
    seedCollected({ id: 'first', provider_payment_ref: 'pay-1', paid_at: '2026-09-26' })
    seedCollected({ id: 'second', provider_payment_ref: 'pay-2', paid_at: '2026-09-27' })
    let now = 0
    settle.mockImplementation(async (_db, companyId, _userId, params) => {
      now += 10
      mem.seed('journal_entries', [{ id: `je-${params.externalRef}`, company_id: companyId, status: 'posted' }])
      mem.seed('invoice_payments', [
        { id: `ip-${params.externalRef}`, company_id: companyId, invoice_id: params.invoice.id, source: 'collections', external_ref: params.externalRef, journal_entry_id: `je-${params.externalRef}` },
      ])
      return { ok: true, newStatus: 'partially_paid', newPaidAmount: 500, newRemaining: 500, journalEntryId: `je-${params.externalRef}`, paidAt: params.paymentDate, saleJournalEntryId: null, warnings: [] }
    })
    const run = () =>
      autoBookCollectedPayments(
        { db: mem.client as SupabaseClient, now: () => NOW, settle: settle as unknown as Settle, archiveRecord },
        { budgetMs: 5, clock: () => now },
      )
    expect(await run()).toEqual({ booked: 1, needsReview: 0, skipped: 0, failed: 0, deferred: 1 })
    expect(mem.rows('collection_collected_payments').map((r) => [r.id, r.status])).toEqual([
      ['first', 'booked'],
      ['second', 'pending'],
    ])
    expect(await run()).toEqual({ booked: 1, needsReview: 0, skipped: 0, failed: 0, deferred: 0 })
  })

  it('makes no call at all when nothing waits', async () => {
    expect(await autoBookCollectedPayments({ db: mem.client as SupabaseClient, now: () => NOW })).toEqual({ booked: 0, needsReview: 0, skipped: 0, failed: 0, deferred: 0 })
    expect(mem.writes).toEqual([])
  })
})

describe('previewCollectedPayment', () => {
  it('names the invoice and the clearing account the booking would debit, and writes nothing', async () => {
    seedWorld()
    Object.assign(mem.rows('collection_connections')[0]!, { clearing_account: '1680' })
    Object.assign(mem.rows('invoices')[0]!, { invoice_number: '1042' })
    const id = seedCollected()
    const writes = mem.writes.length
    const preview = await previewCollectedPayment(mem.client as SupabaseClient, COMPANY, id)
    expect(preview).toMatchObject({ row: { id, paid_at: '2026-09-27', capital_paid: 1000, status: 'pending' }, invoiceNumber: '1042', clearingAccount: '1680' })
    expect(mem.writes.length).toBe(writes)
    expect(await previewCollectedPayment(mem.client as SupabaseClient, 'other-company', id)).toBeNull()
  })
})
