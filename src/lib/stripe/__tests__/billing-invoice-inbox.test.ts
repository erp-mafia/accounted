import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type Stripe from 'stripe'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { calculateMerchantSimilarity } from '@/lib/documents/core-receipt-matcher'
import { NAME_AGREEMENT } from '@/lib/documents/bank-match/decide'

const uploadDocumentMock = vi.hoisted(() => vi.fn())
const matchSupplierIdMock = vi.hoisted(() => vi.fn())
const recordDocumentArrivalMock = vi.hoisted(() => vi.fn())
const proposeBankMatchMock = vi.hoisted(() => vi.fn())

vi.mock('@/lib/core/documents/document-service', () => ({
  uploadDocument: (...args: unknown[]) => uploadDocumentMock(...args),
}))
vi.mock('@/lib/suppliers/match-supplier', () => ({
  matchSupplierId: (...args: unknown[]) => matchSupplierIdMock(...args),
}))
vi.mock('@/lib/intake/arrivals', () => ({
  recordDocumentArrival: (...args: unknown[]) => recordDocumentArrivalMock(...args),
}))
vi.mock('@/lib/operations/inbox-bank-match', () => ({
  proposeBankMatchForInboxItem: (...args: unknown[]) => proposeBankMatchMock(...args),
}))

import {
  billingInvoiceSkipReason,
  billingInvoiceToExtraction,
  billingSellerName,
  deliverBillingInvoiceToInbox,
  fetchStripeInvoicePdf,
  invoiceNumberSeries,
  orgNumberFromSwedishVat,
} from '../billing-invoice-inbox'

const unix = (iso: string) => Math.floor(Date.parse(iso) / 1000)
const ISSUED = unix('2026-10-23T10:00:00Z')
const PERIOD_END = unix('2026-11-23T10:00:00Z')
const SELLER_VAT = 'SE559538621901'

/** A paid monthly invoice as the dahlia API sends it: 199 kr + 25 % VAT. */
function paidInvoice(over: Record<string, unknown> = {}): Stripe.Invoice {
  return {
    id: 'in_test_1',
    object: 'invoice',
    number: 'TEST-0001',
    status: 'paid',
    collection_method: 'charge_automatically',
    currency: 'sek',
    customer: 'cus_test',
    account_name: 'Arcim Technology AB',
    account_tax_ids: [{ id: 'txi_1', object: 'tax_id', type: 'eu_vat', value: SELLER_VAT }],
    amount_paid: 24875,
    total: 24875,
    subtotal_excluding_tax: 19900,
    total_excluding_tax: 19900,
    total_taxes: [{ amount: 4975, taxable_amount: 19900, tax_behavior: 'exclusive', type: 'tax_rate_details' }],
    created: ISSUED,
    effective_at: ISSUED,
    status_transitions: { finalized_at: ISSUED, paid_at: ISSUED + 40, marked_uncollectible_at: null, voided_at: null },
    invoice_pdf: 'https://pay.stripe.com/invoice/acct_test/live_test/pdf?s=ap',
    parent: {
      type: 'subscription_details',
      quote_details: null,
      subscription_details: { subscription: 'sub_test', metadata: { company_id: 'company-1' } },
    },
    lines: {
      object: 'list',
      data: [
        {
          id: 'il_1',
          description: '1 × Accounted (at 199.00 kr / month)',
          amount: 19900,
          quantity: 1,
          period: { start: ISSUED, end: PERIOD_END },
          taxes: [{ amount: 4975, taxable_amount: 19900, tax_behavior: 'exclusive', type: 'tax_rate_details' }],
        },
      ],
    },
    ...over,
  } as unknown as Stripe.Invoice
}

describe('billingInvoiceSkipReason', () => {
  it('files a paid, automatically charged invoice', () => {
    expect(billingInvoiceSkipReason(paidInvoice())).toBeNull()
  })

  it("skips a trial's 0 kr invoice: nothing reaches the bank", () => {
    expect(billingInvoiceSkipReason(paidInvoice({ amount_paid: 0, total: 0 }))).toBe('nothing_paid')
  })

  it('skips a send_invoice invoice: it reached the company by mail before it was paid', () => {
    expect(billingInvoiceSkipReason(paidInvoice({ collection_method: 'send_invoice' }))).toBe('not_charged_automatically')
  })

  it('skips an invoice that is not paid', () => {
    expect(billingInvoiceSkipReason(paidInvoice({ status: 'open' }))).toBe('not_paid')
  })
})

describe('billingInvoiceToExtraction', () => {
  it("reads Stripe's own numbers: a receipt with 25 % VAT, the coverage period and the seller", () => {
    const extracted = billingInvoiceToExtraction(paidInvoice(), { name: 'Accounted (Arcim Technology AB)', vatNumber: SELLER_VAT })
    expect(extracted).toEqual({
      documentKind: 'receipt',
      legibility: 'good',
      supplier: {
        name: 'Accounted (Arcim Technology AB)',
        orgNumber: '559538-6219',
        vatNumber: SELLER_VAT,
        address: null,
        bankgiro: null,
        plusgiro: null,
      },
      invoice: {
        invoiceNumber: 'TEST-0001',
        invoiceDate: '2026-10-23',
        dueDate: null,
        paymentReference: null,
        currency: 'SEK',
        servicePeriodStart: '2026-10-23',
        servicePeriodEnd: '2026-11-22',
      },
      lineItems: [
        {
          description: '1 × Accounted (at 199.00 kr / month)',
          quantity: 1,
          unitPrice: 199,
          lineTotal: 199,
          vatRate: 25,
          accountSuggestion: null,
        },
      ],
      totals: { subtotal: 199, vatAmount: 49.75, total: 248.75 },
      vatBreakdown: [{ rate: 25, base: 199, amount: 49.75 }],
      confidence: 1,
    })
  })

  it('leaves out zero lines and dates the invoice by the Swedish calendar day', () => {
    const lateEvening = unix('2026-10-23T22:30:00Z') // 00:30 on the 24th in Stockholm
    const invoice = paidInvoice({
      effective_at: lateEvening,
      lines: {
        object: 'list',
        data: [
          ...paidInvoice().lines.data,
          { id: 'il_0', description: 'Free trial', amount: 0, quantity: 1, period: { start: ISSUED, end: ISSUED }, taxes: [{ amount: 0, taxable_amount: 0 }] },
        ],
      },
    })
    const extracted = billingInvoiceToExtraction(invoice, { name: 'Accounted', vatNumber: null })
    expect(extracted.invoice.invoiceDate).toBe('2026-10-24')
    expect(extracted.lineItems).toHaveLength(1)
    expect(extracted.supplier.orgNumber).toBeNull()
  })
})

describe('the seller name', () => {
  it('puts the brand the card statement prints before the legal name', () => {
    expect(billingSellerName('Arcim Technology AB', 'Accounted')).toBe('Accounted (Arcim Technology AB)')
    expect(billingSellerName('Accounted AB', 'Accounted')).toBe('Accounted AB')
    expect(billingSellerName(null, 'Accounted')).toBe('Accounted')
  })

  // Match on arrival proposes a receipt's bank row only when the row names the
  // seller; the card statement says ACCOUNTED, never the legal name.
  it('lets match on arrival recognise the bank row, which the legal name alone does not', () => {
    const bankText = 'Kortköp 261024 ACCOUNTED'
    expect(calculateMerchantSimilarity(billingSellerName('Arcim Technology AB', 'Accounted'), bankText)).toBeGreaterThanOrEqual(NAME_AGREEMENT)
    expect(calculateMerchantSimilarity('Arcim Technology AB', bankText)).toBeLessThan(NAME_AGREEMENT)
  })

  it("reads the invoice number's series", () => {
    expect(invoiceNumberSeries('DXN79OUV-0348')).toBe('DXN79OUV')
    expect(invoiceNumberSeries('1234')).toBeNull()
    expect(invoiceNumberSeries(null)).toBeNull()
  })

  it('derives the organisationsnummer only from a Swedish VAT number', () => {
    expect(orgNumberFromSwedishVat('SE559538621901')).toBe('559538-6219')
    expect(orgNumberFromSwedishVat('IE6364992H')).toBeNull()
    expect(orgNumberFromSwedishVat(null)).toBeNull()
  })
})

describe('fetchStripeInvoicePdf', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('fetches nothing outside stripe.com', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    await expect(fetchStripeInvoicePdf('https://example.com/invoice.pdf')).rejects.toThrow('not on stripe.com')
    await expect(fetchStripeInvoicePdf('http://pay.stripe.com/invoice/x/pdf')).rejects.toThrow('not on stripe.com')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  // Observed 2026-10-26: pay.stripe.com answers 303 to a presigned link in
  // Stripe's S3 file store, which serves the PDF as application/octet-stream.
  it("follows Stripe's redirect to its file store and returns the bytes", async () => {
    const bytes = new TextEncoder().encode('%PDF-1.7 test')
    const response = new Response(bytes, { status: 200, headers: { 'content-type': 'application/octet-stream' } })
    Object.defineProperty(response, 'url', { value: 'https://stripe-upload-api.s3.us-west-1.amazonaws.com/x' })
    const fetchSpy = vi.fn().mockResolvedValue(response)
    vi.stubGlobal('fetch', fetchSpy)

    const buffer = await fetchStripeInvoicePdf('https://pay.stripe.com/invoice/acct_test/live_test/pdf?s=ap')

    expect(new Uint8Array(buffer)).toEqual(bytes)
    expect(fetchSpy.mock.calls[0][1]).toMatchObject({ redirect: 'follow' })
  })

  it('throws on a failed download, so the event is delivered again', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 503 })))
    await expect(fetchStripeInvoicePdf('https://pay.stripe.com/invoice/x/pdf')).rejects.toThrow('503')
  })
})

describe('deliverBillingInvoiceToInbox', () => {
  const { supabase: mock, enqueue, reset, calls } = createQueuedMockSupabase()
  const supabase = mock as unknown as SupabaseClient
  const retrieve = vi.fn()
  const stripe = { invoices: { retrieve } } as unknown as Stripe
  const PDF = new TextEncoder().encode('%PDF-1.7 test').buffer as ArrayBuffer
  const fetchPdf = vi.fn()
  const log = { info: vi.fn(), warn: vi.fn() }

  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    retrieve.mockResolvedValue(paidInvoice())
    fetchPdf.mockResolvedValue(PDF)
    uploadDocumentMock.mockResolvedValue({ id: 'doc-1' })
    matchSupplierIdMock.mockResolvedValue(null)
    recordDocumentArrivalMock.mockResolvedValue(null)
    proposeBankMatchMock.mockResolvedValue(undefined)
  })

  const deliver = (invoice = paidInvoice()) =>
    deliverBillingInvoiceToInbox(supabase, stripe, { invoice, companyId: 'company-1' }, { fetchPdf, log })

  it("archives Stripe's PDF and files one inbox item with the invoice's numbers, then asks the bank", async () => {
    enqueue({ data: { id: 'company-1', archived_at: null } }) // company
    enqueue({ data: null }) // no item for this invoice yet
    enqueue({ data: [] }) // the company brings none in itself
    enqueue({ data: { user_id: 'user-owner' } }) // first owner
    enqueue({ data: { id: 'inbox-1' } }) // insert

    const result = await deliver()

    expect(result).toEqual({ inboxItemId: 'inbox-1' })
    expect(retrieve).toHaveBeenCalledWith('in_test_1', { expand: ['account_tax_ids'] })
    expect(fetchPdf).toHaveBeenCalledWith('https://pay.stripe.com/invoice/acct_test/live_test/pdf?s=ap')
    const [, userId, companyId, file, metadata] = uploadDocumentMock.mock.calls[0]
    expect(userId).toBe('user-owner')
    expect(companyId).toBe('company-1')
    expect(file).toEqual({ name: 'accounted-faktura-TEST-0001.pdf', buffer: PDF, type: 'application/pdf' })
    expect(metadata).toEqual({ upload_source: 'system', dedupeByContent: true, extractionOwner: 'none' })
    expect(matchSupplierIdMock).toHaveBeenCalledWith(supabase, 'company-1', {
      orgNumber: '559538-6219',
      vatNumber: SELLER_VAT,
      name: 'Arcim Technology AB',
    })

    const inserted = calls.find((c) => c.table === 'invoice_inbox_items' && c.method === 'insert')?.args[0] as Record<string, unknown>
    expect(inserted).toMatchObject({
      company_id: 'company-1',
      user_id: 'user-owner',
      document_id: 'doc-1',
      source: 'upload',
      status: 'received',
      extraction_skipped: false,
      matched_supplier_id: null,
      email_from: 'Accounted (Arcim Technology AB)',
      email_received_at: new Date((ISSUED + 40) * 1000).toISOString(),
      channel_context: { intake_source: 'system', stripe_invoice_id: 'in_test_1', stripe_invoice_number: 'TEST-0001' },
    })
    expect((inserted.extracted_data as { documentKind: string; totals: { total: number } })).toMatchObject({
      documentKind: 'receipt',
      totals: { total: 248.75 },
    })
    expect(recordDocumentArrivalMock).toHaveBeenCalledWith(supabase, expect.objectContaining({
      companyId: 'company-1',
      source: 'system',
      documentId: 'doc-1',
      inboxItemId: 'inbox-1',
      sourceRef: 'in_test_1',
    }))
    expect(proposeBankMatchMock).toHaveBeenCalledWith(supabase, 'company-1', 'inbox-1')
    // Never a verifikat: nothing but the inbox item is written.
    expect(calls.filter((c) => c.method === 'insert').map((c) => c.table)).toEqual(['invoice_inbox_items'])
  })

  it('returns the item it filed before on a redelivered event, without fetching or filing again', async () => {
    enqueue({ data: { id: 'company-1', archived_at: null } })
    enqueue({ data: { id: 'inbox-earlier' } })

    const result = await deliver()

    expect(result).toEqual({ inboxItemId: 'inbox-earlier', skipped: 'already_filed' })
    const lookup = calls.filter((c) => c.table === 'invoice_inbox_items' && c.method === 'eq').map((c) => c.args)
    expect(lookup).toContainEqual(['channel_context->>stripe_invoice_id', 'in_test_1'])
    expect(retrieve).not.toHaveBeenCalled()
    expect(uploadDocumentMock).not.toHaveBeenCalled()
  })

  // Measured 2026-10-26: about half the paying companies forward Stripe's
  // receipt mail to their inbox address or upload the PDF themselves, and
  // Stripe renders the PDF anew on every download (no content dedupe).
  it('files nothing for a company that brings our invoices in itself, by the invoice number series', async () => {
    enqueue({ data: { id: 'company-1', archived_at: null } })
    enqueue({ data: null })
    enqueue({ data: [{ id: 'inbox-forwarded' }] })

    const result = await deliverBillingInvoiceToInbox(
      supabase,
      stripe,
      { invoice: paidInvoice(), companyId: 'company-1' },
      { fetchPdf, log, now: new Date('2026-10-26T00:00:00Z') },
    )

    expect(result).toEqual({ inboxItemId: null, skipped: 'company_brings_own' })
    const own = calls.filter((c) => c.table === 'invoice_inbox_items')
    expect(own).toContainEqual({ table: 'invoice_inbox_items', method: 'ilike', args: ['extracted_data->invoice->>invoiceNumber', 'TEST-%'] })
    // The items this door filed never count: they would stop every later delivery.
    expect(own).toContainEqual({ table: 'invoice_inbox_items', method: 'is', args: ['channel_context->>stripe_invoice_id', null] })
    // A yearly plan's previous invoice is inside the lookback.
    const since = own.find((c) => c.method === 'gte')?.args[1] as string
    expect(since.slice(0, 10)).toBe('2025-09-21')
    expect(retrieve).not.toHaveBeenCalled()
    expect(uploadDocumentMock).not.toHaveBeenCalled()
  })

  it('files nothing for an archived company', async () => {
    enqueue({ data: { id: 'company-1', archived_at: '2026-10-01T00:00:00Z' } })

    expect(await deliver()).toEqual({ inboxItemId: null, skipped: 'company_unavailable' })
    expect(retrieve).not.toHaveBeenCalled()
  })

  it('files nothing for a company without an owner, and says so', async () => {
    enqueue({ data: { id: 'company-1', archived_at: null } })
    enqueue({ data: null })
    enqueue({ data: [] })
    enqueue({ data: null })

    expect(await deliver()).toEqual({ inboxItemId: null, skipped: 'no_owner' })
    expect(log.warn).toHaveBeenCalled()
    expect(uploadDocumentMock).not.toHaveBeenCalled()
  })

  it('files nothing for a trial invoice and reads nothing for it', async () => {
    expect(await deliver(paidInvoice({ amount_paid: 0, total: 0 }))).toEqual({ inboxItemId: null, skipped: 'nothing_paid' })
    expect(calls).toHaveLength(0)
  })

  it('throws when the PDF cannot be fetched, so Stripe delivers the event again', async () => {
    enqueue({ data: { id: 'company-1', archived_at: null } })
    enqueue({ data: null })
    enqueue({ data: [] })
    enqueue({ data: { user_id: 'user-owner' } })
    fetchPdf.mockRejectedValue(new Error('invoice PDF fetch failed with status 503'))

    await expect(deliver()).rejects.toThrow('503')
    expect(uploadDocumentMock).not.toHaveBeenCalled()
    expect(calls.some((c) => c.method === 'insert')).toBe(false)
  })
})
