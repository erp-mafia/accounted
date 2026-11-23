import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  createQueuedMockSupabase,
  makeInvoice,
  makeCustomer,
  makeCompanySettings,
} from '@/tests/helpers'
import { eventBus } from '@/lib/events'
import type { Logger } from '@/lib/logger'

const { supabase: mockSupabase, enqueue, reset, findCalls } = createQueuedMockSupabase()

const mockEnsureInvoiceNumber = vi.fn()
vi.mock('@/lib/invoices/ensure-invoice-number', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/invoices/ensure-invoice-number')>()),
  ensureInvoiceNumber: (...args: unknown[]) => mockEnsureInvoiceNumber(...args),
}))

const mockRenderToBuffer = vi.fn()
vi.mock('@react-pdf/renderer', () => ({
  renderToBuffer: (...args: unknown[]) => mockRenderToBuffer(...args),
  Document: vi.fn(),
  Page: vi.fn(),
  Text: vi.fn(),
  View: vi.fn(),
  StyleSheet: { create: (s: unknown) => s },
}))

vi.mock('@/lib/invoices/pdf-template', () => ({
  InvoicePDF: vi.fn().mockReturnValue('mock-pdf-element'),
  brandingFromCompanySettings: vi.fn().mockReturnValue({}),
}))

const mockCreateInvoiceJournalEntry = vi.fn()
vi.mock('@/lib/bookkeeping/invoice-entries', () => ({
  createInvoiceJournalEntry: (...args: unknown[]) =>
    mockCreateInvoiceJournalEntry(...args),
}))

const mockCreateSchedules = vi.fn()
vi.mock('@/lib/bookkeeping/accruals/from-invoices', () => ({
  createSchedulesForCustomerInvoice: (...args: unknown[]) => mockCreateSchedules(...args),
}))

const mockUploadDocument = vi.fn()
vi.mock('@/lib/core/documents/document-service', () => ({
  uploadDocument: (...args: unknown[]) => mockUploadDocument(...args),
}))

const mockRecordManualInvoiceDelivery = vi.fn()
vi.mock('@/lib/invoices/invoice-deliveries', () => ({
  recordManualInvoiceDelivery: (...args: unknown[]) => mockRecordManualInvoiceDelivery(...args),
}))

const mockSettleInvoicePayment = vi.fn()
vi.mock('@/lib/invoices/settle-invoice-payment', () => ({
  settleInvoicePayment: (...args: unknown[]) => mockSettleInvoicePayment(...args),
}))

import {
  archiveIssuedInvoicePdf,
  emailRefusal,
  issuable,
  issueAndBookInvoice,
  lacksMomsRuta,
  markInvoiceSentAndBook,
} from '../issue-and-book-invoice'
import { AccountsNotInChartError } from '@/lib/bookkeeping/errors'
import { InvoicePDF } from '@/lib/invoices/pdf-template'
import type { CompanySettings, VatTreatment } from '@/types'

const log: Logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: () => log,
}

const customer = makeCustomer({ id: 'cust-1' })
const settings = makeCompanySettings({
  accounting_method: 'accrual',
  entity_type: 'enskild_firma',
  bankgiro: '123-4567',
}) as CompanySettings

function makeDraft(overrides: Record<string, unknown> = {}) {
  return {
    ...makeInvoice({ id: 'inv-1', invoice_number: 'F-2026010', status: 'draft' }),
    document_type: 'invoice' as const,
    credited_invoice_id: null,
    customer,
    items: [],
    ...overrides,
  }
}

function issue(invoice = makeDraft(), theSettings = settings) {
  return issueAndBookInvoice({
    supabase: mockSupabase as never,
    companyId: 'company-1',
    userId: 'user-1',
    invoice: invoice as never,
    settings: theSettings,
    log,
  })
}

describe('issuable', () => {
  const settings = makeCompanySettings({ bankgiro: '123-4567', vat_registered: true, vat_number: 'SE556677889901' })

  it('passes an ordinary draft', () => {
    expect(issuable(makeInvoice({ status: 'draft', total: 1250 }), settings)).toBeNull()
  })

  it('refuses a credit note without a link: it has no original to name', () => {
    expect(issuable(makeInvoice({ status: 'draft', total: -1250, credited_invoice_id: null }), settings)).toEqual({
      code: 'INVOICE_CREDIT_NOTE_NOT_ISSUABLE',
    })
  })

  it('refuses a company with no payment account, naming the currency', () => {
    const noAccount = makeCompanySettings({ bankgiro: null, plusgiro: null, iban: null, bank_name: null, clearing_number: null, account_number: null, vat_registered: false })
    expect(issuable(makeInvoice({ status: 'draft', total: 1250, currency: 'SEK' }), noAccount)).toEqual({
      code: 'INVOICE_SEND_PAYMENT_ACCOUNT_MISSING',
      details: { currency: 'SEK' },
    })
  })

  it('refuses a registered company with no VAT number', () => {
    const noVatNumber = makeCompanySettings({ bankgiro: '123-4567', vat_registered: true, vat_number: null })
    expect(issuable(makeInvoice({ status: 'draft', total: 1250 }), noVatNumber)).toEqual({
      code: 'INVOICE_SEND_VAT_NUMBER_MISSING',
    })
  })

  it('reads the frozen payee: run after the snapshot, an account on the invoice counts', () => {
    const noAccount = makeCompanySettings({ bankgiro: null, plusgiro: null, iban: null, bank_name: null, clearing_number: null, account_number: null, vat_registered: false })
    const withPayee = makeInvoice({ status: 'draft', total: 1250, payment_details: { bankgiro: '123-4567' } as never })
    expect(issuable(withPayee, noAccount)).toBeNull()
  })
})

// crm#2080: a faktura to a business names its seller and buyer with name and
// address (ML 17 kap 24 § p.5-6). A förenklad faktura may leave them out (ML
// 17 kap 26-28 §§): at most 4 000 kr including moms, or a seller outside the
// VAT register at any amount, never where the buyer in another EU country
// pays the VAT. A sale to a private person needs neither unless it is
// construction work (10-11 §§).
describe('issuable: seller and buyer name and address', () => {
  const settings = makeCompanySettings({ bankgiro: '123-4567', vat_registered: true, vat_number: 'SE556677889901' })
  const noAddress = { address_line1: null, address_line2: null, postal_code: null, city: null }
  const draft = (overrides: Record<string, unknown> = {}) =>
    makeInvoice({ status: 'draft', total: 12500, customer: makeCustomer(), ...overrides })

  it('refuses a seller without an address on a full faktura', () => {
    expect(issuable(draft(), makeCompanySettings({ ...settings, ...noAddress }))).toEqual({
      code: 'INVOICE_SEND_SELLER_ADDRESS_MISSING',
    })
  })

  it('refuses a seller without a name on a full faktura', () => {
    expect(issuable(draft(), makeCompanySettings({ ...settings, company_name: '  ' }))).toEqual({
      code: 'INVOICE_SEND_SELLER_ADDRESS_MISSING',
    })
  })

  it('passes a förenklad faktura without the seller address: its organisationsnummer identifies it', () => {
    expect(issuable(draft({ total: 1000 }), makeCompanySettings({ ...settings, ...noAddress }))).toBeNull()
  })

  it('refuses a buyer without an address over 4 000 kr including moms', () => {
    expect(issuable(draft({ customer: makeCustomer(noAddress) }), settings)).toEqual({
      code: 'INVOICE_SEND_BUYER_ADDRESS_MISSING',
    })
  })

  it('refuses a buyer with a street but no postal code or town', () => {
    const streetOnly = makeCustomer({ ...noAddress, address_line1: 'Storgatan 1' })
    expect(issuable(draft({ customer: streetOnly }), settings)?.code).toBe('INVOICE_SEND_BUYER_ADDRESS_MISSING')
  })

  it('passes a buyer and a seller with a postal code and a town but no street', () => {
    const placeOnly = { ...noAddress, postal_code: '111 22', city: 'Stockholm' }
    expect(issuable(draft({ customer: makeCustomer(placeOnly) }), makeCompanySettings({ ...settings, ...placeOnly }))).toBeNull()
  })

  it('passes a buyer without an address at 4 000 kr: a förenklad faktura', () => {
    expect(issuable(draft({ total: 4000, customer: makeCustomer(noAddress) }), settings)).toBeNull()
  })

  it('refuses a buyer without an address on an EU sale under 4 000 kr', () => {
    const euBuyer = makeCustomer({ ...noAddress, customer_type: 'eu_business', country: 'DE' })
    expect(issuable(draft({ total: 1000, vat_treatment: 'reverse_charge', customer: euBuyer }), settings)?.code).toBe(
      'INVOICE_SEND_BUYER_ADDRESS_MISSING',
    )
  })

  it('passes a domestic reverse-charge sale under 4 000 kr without the buyer address: 27 § excludes only an EU buyer', () => {
    const invoice = draft({ total: 1000, vat_treatment: 'reverse_charge_domestic', customer: makeCustomer(noAddress) })
    expect(issuable(invoice, settings)).toBeNull()
  })

  it('passes a sale to a private person without either address', () => {
    const privatePerson = makeCustomer({ ...noAddress, customer_type: 'individual' })
    expect(issuable(draft({ customer: privatePerson }), makeCompanySettings({ ...settings, ...noAddress }))).toBeNull()
  })

  it('refuses construction work for a private person over 4 000 kr without the buyer address', () => {
    const privatePerson = makeCustomer({ ...noAddress, customer_type: 'individual' })
    const rot = draft({ customer: privatePerson, items: [{ deduction_type: 'rot' }] })
    expect(issuable(rot, settings)?.code).toBe('INVOICE_SEND_BUYER_ADDRESS_MISSING')
  })

  it('measures a foreign invoice in kronor', () => {
    const eur = { currency: 'EUR', exchange_rate: 11.5, payment_details: { iban: 'DE89370400440532013000' }, customer: makeCustomer(noAddress) }
    expect(issuable(draft({ ...eur, total: 500 }), settings)?.code).toBe('INVOICE_SEND_BUYER_ADDRESS_MISSING')
    expect(issuable(draft({ ...eur, total: 300 }), settings)).toBeNull()
  })

  it('passes a buyer without an address at a seller outside the VAT register, at any amount', () => {
    const momsfri = makeCompanySettings({ ...settings, vat_registered: false, vat_number: null })
    expect(issuable(draft({ total: 50000, vat_treatment: 'exempt', customer: makeCustomer(noAddress) }), momsfri)).toBeNull()
  })

  it('asks nothing of a quote, a proforma or a följesedel', () => {
    const bare = makeCompanySettings({ ...settings, ...noAddress })
    for (const document_type of ['quote', 'proforma', 'delivery_note'] as const) {
      expect(issuable(draft({ document_type, customer: makeCustomer(noAddress) }), bare)).toBeNull()
    }
  })
})

describe('emailRefusal', () => {
  it('refuses a följesedel, only that', () => {
    expect(emailRefusal({ document_type: 'delivery_note' })).toEqual({ code: 'INVOICE_SEND_DELIVERY_NOTE' })
    for (const document_type of ['invoice', 'proforma', 'quote'] as const) {
      expect(emailRefusal({ document_type }), document_type).toBeNull()
    }
  })
})

describe('lacksMomsRuta', () => {
  const momsfriSale = { vat_treatment: 'exempt', moms_ruta: null, vat_amount: 0 } as const
  const outsideTheRegister = { vat_registered: false }
  const registered = { vat_registered: true }

  it('is false for a momsfri sale: a seller outside the VAT register, exempt, no VAT', () => {
    expect(lacksMomsRuta(momsfriSale, outsideTheRegister)).toBe(false)
  })

  it('is false for any row with a ruta, whoever sells', () => {
    for (const settings of [registered, outsideTheRegister]) {
      expect(lacksMomsRuta({ ...momsfriSale, moms_ruta: '05', vat_treatment: 'standard_25' }, settings)).toBe(false)
    }
  })

  it('is true for an exempt row at a registered seller: the treatment of a 0 % import is a guess', () => {
    expect(lacksMomsRuta(momsfriSale, registered)).toBe(true)
  })

  it('is true for an exempt row with VAT on it, whoever sells', () => {
    for (const settings of [registered, outsideTheRegister]) {
      expect(lacksMomsRuta({ ...momsfriSale, vat_amount: 152 }, settings)).toBe(true)
    }
  })

  it('is true for a row read without its VAT', () => {
    const { vat_amount: _unread, ...row } = momsfriSale
    expect(lacksMomsRuta(row as typeof momsfriSale, outsideTheRegister)).toBe(true)
  })

  // A Record, so a new treatment does not compile until it says whether its
  // sale states a ruta: lacksMomsRuta itself would refuse it without a word.
  const STATES_A_RUTA: Record<VatTreatment, boolean> = {
    standard_25: true,
    reduced_12: true,
    reduced_6: true,
    reverse_charge: true,
    reverse_charge_domestic: true,
    export: true,
    exempt: false,
  }

  it.each(Object.keys(STATES_A_RUTA).filter((treatment) => STATES_A_RUTA[treatment as VatTreatment]))(
    'is true for %s, which states one, whoever sells',
    (treatment) => {
      const vat_treatment = treatment as VatTreatment
      for (const settings of [registered, outsideTheRegister]) {
        expect(lacksMomsRuta({ ...momsfriSale, vat_treatment }, settings)).toBe(true)
      }
    },
  )
})

describe('issueAndBookInvoice', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    eventBus.clear()
    mockRenderToBuffer.mockResolvedValue(Buffer.from('fake-pdf'))
    mockUploadDocument.mockResolvedValue({ id: 'doc-1' })
    mockCreateSchedules.mockResolvedValue({ created: 0, failed: 0 })
    mockRecordManualInvoiceDelivery.mockResolvedValue({ id: 'delivery-1' })
    mockEnsureInvoiceNumber.mockResolvedValue('F-2026010')
  })

  it('rejects when the payment account is missing, before number allocation', async () => {
    const bare = {
      ...settings,
      invoice_payment_accounts: {},
      clearing_number: null,
      account_number: null,
      bankgiro: null,
      plusgiro: null,
      swish: null,
      iban: null,
    } as CompanySettings

    const result = await issue(makeDraft({ invoice_number: null }), bare)

    expect(result).toEqual({
      ok: false,
      errorCode: 'INVOICE_SEND_PAYMENT_ACCOUNT_MISSING',
      details: { currency: 'SEK' },
    })
    expect(mockEnsureInvoiceNumber).not.toHaveBeenCalled()
    expect(mockCreateInvoiceJournalEntry).not.toHaveBeenCalled()
  })

  it('rejects a VAT-registered company without VAT number, before number allocation', async () => {
    const broken = { ...settings, vat_registered: true, vat_number: null } as CompanySettings

    const result = await issue(makeDraft({ invoice_number: null }), broken)

    expect(result).toEqual({ ok: false, errorCode: 'INVOICE_SEND_VAT_NUMBER_MISSING' })
    expect(mockEnsureInvoiceNumber).not.toHaveBeenCalled()
    expect(mockCreateInvoiceJournalEntry).not.toHaveBeenCalled()
  })

  // crm#2080: the reporter's flow, a buyer with only a name on a 12 500 kr
  // faktura, then a company that skipped its address at onboarding.
  it('rejects a buyer without an address, before number allocation', async () => {
    const nameOnly = makeCustomer({ address_line1: null, address_line2: null, postal_code: null, city: null })

    const result = await issue(makeDraft({ invoice_number: null, customer: nameOnly }))

    expect(result).toEqual({ ok: false, errorCode: 'INVOICE_SEND_BUYER_ADDRESS_MISSING' })
    expect(mockEnsureInvoiceNumber).not.toHaveBeenCalled()
    expect(mockCreateInvoiceJournalEntry).not.toHaveBeenCalled()
  })

  it('rejects a company without an address, before number allocation', async () => {
    const noAddress = { ...settings, address_line1: null, postal_code: null, city: null } as CompanySettings

    const result = await issue(makeDraft({ invoice_number: null }), noAddress)

    expect(result).toEqual({ ok: false, errorCode: 'INVOICE_SEND_SELLER_ADDRESS_MISSING' })
    expect(mockEnsureInvoiceNumber).not.toHaveBeenCalled()
    expect(mockCreateInvoiceJournalEntry).not.toHaveBeenCalled()
  })

  it('issues for an unregistered company without VAT number', async () => {
    enqueue({ data: [{ id: 'inv-1' }], error: null }) // CAS flip
    const unregistered = {
      ...settings,
      vat_registered: false,
      vat_number: null,
      defer_invoice_booking: true,
    } as CompanySettings

    const result = await issue(makeDraft(), unregistered)

    expect(result).toEqual({ ok: true, journalEntryId: null, partialFailures: [] })
  })

  it('refuses a draft whose customer was deleted, before a number is taken (crm#263)', async () => {
    const result = await issue(makeDraft({ invoice_number: null, customer_id: null, customer: null }))

    expect(result).toEqual({ ok: false, errorCode: 'INVOICE_CUSTOMER_MISSING' })
    expect(mockEnsureInvoiceNumber).not.toHaveBeenCalled()
    expect(findCalls('invoices', 'update')).toEqual([])
    expect(mockCreateInvoiceJournalEntry).not.toHaveBeenCalled()
  })

  it('fails with INVOICE_CREATE_NUMBER_ASSIGN_FAILED when numbering fails', async () => {
    mockEnsureInvoiceNumber.mockRejectedValue(new Error('sequence exhausted'))

    const result = await issue()

    expect(result).toEqual({ ok: false, errorCode: 'INVOICE_CREATE_NUMBER_ASSIGN_FAILED' })
    expect(mockCreateInvoiceJournalEntry).not.toHaveBeenCalled()
  })

  it('answers a series that is behind with its own code, sentence and numbers', async () => {
    const { InvoiceNumberSeriesBehindError } = await import('@/lib/invoices/ensure-invoice-number')
    const behind = new InvoiceNumberSeriesBehindError({ prefix: '', highest_number: 1002, first_allowed: 1003 })
    mockEnsureInvoiceNumber.mockRejectedValue(behind)

    const result = await issue()

    expect(result).toEqual({
      ok: false,
      errorCode: 'INVOICE_NUMBER_SERIES_BEHIND',
      details: { prefix: '', highest_number: 1002, first_allowed: 1003 },
      messageSv: behind.message,
      messageEn: behind.messageEn,
    })
    expect(mockCreateInvoiceJournalEntry).not.toHaveBeenCalled()
  })

  it('returns INVOICE_MARK_SENT_RACE when another request flipped the draft first', async () => {
    enqueue({ data: [], error: null }) // CAS update matches no row

    const result = await issue()

    expect(result).toEqual({ ok: false, errorCode: 'INVOICE_MARK_SENT_RACE' })
    expect(mockCreateInvoiceJournalEntry).not.toHaveBeenCalled()
    expect(mockUploadDocument).not.toHaveBeenCalled()
  })

  it('restores the draft and fails closed when the journal entry cannot be created', async () => {
    enqueue({ data: [{ id: 'inv-1' }], error: null }) // CAS flip
    const refusal = new Error('Period locked')
    mockCreateInvoiceJournalEntry.mockRejectedValue(refusal)
    enqueue({ data: null, error: null }) // rollback update

    const result = await issue()

    // The engine's refusal and its Swedish reason reach the door, so it can
    // answer with the engine's own code (v1, MCP) instead of a generic one.
    expect(result).toEqual({
      ok: false,
      errorCode: 'INVOICE_MARK_SENT_BOOK_FAILED',
      reason: expect.any(String),
      bookingError: refusal,
    })
    // Two invoice updates: the CAS flip and the rollback to draft.
    expect(findCalls('invoices', 'update')).toEqual([
      [{ status: 'sent' }],
      [{ status: 'draft' }],
    ])
    expect(mockUploadDocument).not.toHaveBeenCalled()
  })

  it('books, links, archives the PDF, records delivery and emits invoice.sent', async () => {
    enqueue({ data: [{ id: 'inv-1' }], error: null }) // CAS flip
    mockCreateInvoiceJournalEntry.mockResolvedValue({ id: 'je-7' })
    enqueue({ data: null, error: null }) // journal_entry_id link

    const emitted: string[] = []
    eventBus.on('invoice.sent', async () => {
      emitted.push('invoice.sent')
    })

    const result = await issue()

    expect(result).toEqual({ ok: true, journalEntryId: 'je-7', partialFailures: [] })
    expect(mockCreateInvoiceJournalEntry).toHaveBeenCalledWith(
      mockSupabase,
      'company-1',
      'user-1',
      expect.objectContaining({ id: 'inv-1' }),
      'enskild_firma',
      customer.name,
      { posting: expect.any(Function) }, // what the door saw, read by the posting port only while POSTING_EVENTS is on
    )
    expect(mockCreateSchedules).toHaveBeenCalled()
    expect(mockUploadDocument).toHaveBeenCalledTimes(1)
    expect(mockRecordManualInvoiceDelivery).toHaveBeenCalledWith({
      supabase: mockSupabase,
      companyId: 'company-1',
      userId: 'user-1',
      invoiceId: 'inv-1',
    })
    expect(emitted).toEqual(['invoice.sent'])
  })

  it('marks sent WITHOUT booking under deferred booking (#967)', async () => {
    enqueue({ data: [{ id: 'inv-1' }], error: null }) // CAS flip

    const result = await issue(makeDraft(), {
      ...settings,
      defer_invoice_booking: true,
    } as CompanySettings)

    expect(result).toEqual({ ok: true, journalEntryId: null, partialFailures: [] })
    expect(mockCreateInvoiceJournalEntry).not.toHaveBeenCalled()
    // Still a real issuance: underlag archived and delivery recorded.
    expect(mockUploadDocument).toHaveBeenCalledTimes(1)
    expect(mockRecordManualInvoiceDelivery).toHaveBeenCalledTimes(1)
  })

  it('surfaces PDF-archive failures as partial failures, not errors', async () => {
    enqueue({ data: [{ id: 'inv-1' }], error: null }) // CAS flip
    mockCreateInvoiceJournalEntry.mockResolvedValue({ id: 'je-8' })
    enqueue({ data: null, error: null }) // journal_entry_id link
    mockUploadDocument.mockRejectedValue(new Error('Storage offline'))

    const result = await issue()

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.journalEntryId).toBe('je-8')
      expect(result.partialFailures).toEqual([
        expect.objectContaining({ step: 'pdf_archive' }),
      ])
    }
  })
})

describe('issueAndBookInvoice: kontantfaktura, paid at issue (crm#1281)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    eventBus.clear()
    mockRenderToBuffer.mockResolvedValue(Buffer.from('fake-pdf'))
    mockUploadDocument.mockResolvedValue({ id: 'doc-1' })
    mockRecordManualInvoiceDelivery.mockResolvedValue({ id: 'delivery-1' })
    mockEnsureInvoiceNumber.mockResolvedValue('F-2026010')
  })

  const paidDraft = () =>
    makeDraft({ invoice_date: '2026-10-17', total: 1250, remaining_amount: 1250, paid_amount: null })

  function issuePaid(theSettings: CompanySettings = settings, invoice = paidDraft()) {
    return issueAndBookInvoice({
      supabase: mockSupabase as never,
      companyId: 'company-1',
      userId: 'user-1',
      invoice: invoice as never,
      settings: theSettings,
      log,
      paidAtIssue: { settlementAccountNumber: '1940' },
    })
  }

  it.each(['accrual', 'cash'] as const)(
    'under %s: no registration verifikat, the whole invoice settled on its date to the chosen account, the receipt archived on that voucher',
    async (method) => {
      enqueue({ data: [{ id: 'inv-1' }], error: null }) // CAS flip to sent
      mockSettleInvoicePayment.mockResolvedValue({
        ok: true,
        newStatus: 'paid',
        newPaidAmount: 1250,
        newRemaining: 0,
        journalEntryId: 'je-cash',
        paidAt: '2026-10-17T12:00:00.000Z',
      })

      const result = await issuePaid({ ...settings, accounting_method: method } as CompanySettings)

      expect(result).toEqual({ ok: true, journalEntryId: 'je-cash', partialFailures: [] })
      // Never a 1510 registration entry: the payment's cash entry is the one verifikat.
      expect(mockCreateInvoiceJournalEntry).not.toHaveBeenCalled()
      expect(mockCreateSchedules).not.toHaveBeenCalled()
      expect(mockSettleInvoicePayment).toHaveBeenCalledWith(
        mockSupabase,
        'company-1',
        'user-1',
        expect.objectContaining({
          invoice: expect.objectContaining({ id: 'inv-1', status: 'sent' }),
          paymentAmountInInvoiceCurrency: 1250,
          paymentDate: '2026-10-17',
          accountingMethod: method,
          settlementAccountNumber: '1940',
          paymentSource: 'manual',
          recognizeSaleAtPayment: true,
        }),
      )
      // The archived underlag is the receipt (BETALD), linked to the cash voucher.
      expect(InvoicePDF).toHaveBeenCalledWith(
        expect.objectContaining({ invoice: expect.objectContaining({ status: 'paid', remaining_amount: 0 }) }),
      )
      expect(mockUploadDocument).toHaveBeenCalledWith(
        mockSupabase,
        'user-1',
        'company-1',
        expect.anything(),
        expect.objectContaining({ journal_entry_id: 'je-cash' }),
      )
      expect(mockRecordManualInvoiceDelivery).toHaveBeenCalledTimes(1)
    },
  )

  // The one refusal every door gets (dashboard and v1 mark-sent, the MCP
  // approval): checked before the payee is frozen or a number taken.
  it.each([
    ['not_invoice', { document_type: 'proforma' }, null],
    ['credit_note', { credited_invoice_id: 'inv-0' }, null],
    ['self_billed', { is_self_billed: true }, null],
    ['periodisering', { items: [{ accrual_period_start: '2026-11-01', accrual_period_end: '2027-10-31' }] }, null],
    [
      'custom_lines',
      {},
      [
        { account_number: '1510', debit_amount: 1250, credit_amount: 0 },
        { account_number: '3001', debit_amount: 0, credit_amount: 1250 },
      ],
    ],
    ['dated_ahead', { invoice_date: '2099-01-01' }, undefined],
  ])('refuses %s before anything changes', async (reason, overrides, customLines) => {
    const result = await issueAndBookInvoice({
      supabase: mockSupabase as never,
      companyId: 'company-1',
      userId: 'user-1',
      invoice: { ...paidDraft(), ...overrides } as never,
      settings,
      log,
      customLines: customLines as never,
      paidAtIssue: { settlementAccountNumber: '1940' },
    })

    expect(result).toEqual({
      ok: false,
      errorCode: 'INVOICE_PAID_AT_ISSUE_NOT_ALLOWED',
      details: { reason },
    })
    expect(mockEnsureInvoiceNumber).not.toHaveBeenCalled()
    expect(mockSettleInvoicePayment).not.toHaveBeenCalled()
    expect(findCalls('invoices', 'update')).toEqual([])
  })

  it('restores the draft and answers with the refusal when the payment cannot be booked', async () => {
    enqueue({ data: [{ id: 'inv-1' }], error: null }) // CAS flip to sent
    mockSettleInvoicePayment.mockResolvedValue({
      ok: false,
      code: 'INVOICE_PAID_NO_FISCAL_PERIOD',
      details: { paymentDate: '2026-10-17' },
    })
    enqueue({ data: [{ id: 'inv-1' }], error: null }) // restore to draft

    const result = await issuePaid()

    expect(result).toEqual({ ok: false, errorCode: 'INVOICE_PAID_NO_FISCAL_PERIOD' })
    expect(findCalls('invoices', 'update')).toEqual([[{ status: 'sent' }], [{ status: 'draft' }]])
    // Nothing reaches the customer for a sale the ledger does not have.
    expect(mockUploadDocument).not.toHaveBeenCalled()
    expect(mockRecordManualInvoiceDelivery).not.toHaveBeenCalled()
  })

  it("hands the engine's refusal (a payment account outside the chart) to the door", async () => {
    enqueue({ data: [{ id: 'inv-1' }], error: null }) // CAS flip to sent
    const refusal = new AccountsNotInChartError(['1940'])
    mockSettleInvoicePayment.mockResolvedValue({ ok: false, code: 'BOOKKEEPING_ERROR', error: refusal })
    enqueue({ data: [{ id: 'inv-1' }], error: null }) // restore to draft

    const result = await issuePaid()

    expect(result).toEqual({
      ok: false,
      errorCode: 'INVOICE_MARK_SENT_BOOK_FAILED',
      reason: expect.any(String),
      bookingError: refusal,
    })
    expect(findCalls('invoices', 'update')).toEqual([[{ status: 'sent' }], [{ status: 'draft' }]])
  })
})

describe('markInvoiceSentAndBook', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    eventBus.clear()
  })

  it('never issues an invoice without a customer, whichever path calls it (crm#263)', async () => {
    const result = await markInvoiceSentAndBook({
      supabase: mockSupabase as never,
      companyId: 'company-1',
      userId: 'user-1',
      invoice: makeDraft({ customer_id: null, customer: null }) as never,
      settings,
      log,
    })

    expect(result).toEqual({ ok: false, errorCode: 'INVOICE_CUSTOMER_MISSING' })
    // Refused before the status flip: the draft is untouched.
    expect(findCalls('invoices', 'update')).toEqual([])
    expect(mockCreateInvoiceJournalEntry).not.toHaveBeenCalled()
  })
})

describe('archiveIssuedInvoicePdf', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    mockRenderToBuffer.mockResolvedValue(Buffer.from('fake-pdf'))
    mockUploadDocument.mockResolvedValue({ id: 'doc-1' })
  })

  function archive(invoice: ReturnType<typeof makeDraft>) {
    return archiveIssuedInvoicePdf({
      supabase: mockSupabase as never,
      companyId: 'company-1',
      userId: 'user-1',
      invoice: invoice as never,
      settings,
      journalEntryId: 'je-1',
      log,
    })
  }

  it('archives the payment-link QR with the "Markera som skickad" PDF, like the send route', async () => {
    // The fixture's bankgiro has a wrong check digit and there is no Swish,
    // so auto reaches the payment link.
    const result = await archive(makeDraft({ payment_link_url: 'https://pay.example.test/inv-1' }))

    expect(result).toBeNull()
    expect(InvoicePDF).toHaveBeenCalledTimes(1)
    expect(InvoicePDF).toHaveBeenCalledWith(
      expect.objectContaining({
        // Rendered as sent (the stale draft row would stamp UTKAST).
        invoice: expect.objectContaining({ status: 'sent' }),
        paymentQr: expect.objectContaining({
          kind: 'payment_link',
          imageDataUrl: expect.stringMatching(/^data:image\/png;base64,/),
        }),
      }),
    )
    expect(mockUploadDocument).toHaveBeenCalledTimes(1)
  })

  it('passes no QR when nothing on the invoice can carry one', async () => {
    await archive(makeDraft())

    expect(InvoicePDF).toHaveBeenCalledWith(expect.objectContaining({ paymentQr: null }))
  })
})
