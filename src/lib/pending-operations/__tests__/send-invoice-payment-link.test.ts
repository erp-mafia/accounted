/**
 * send_invoice (the staged MCP/agent send) applies the online payment link
 * exactly like the dashboard send, the v1 send and the recurring auto-send:
 * through the shared applyPaymentLinkToInvoice bridge, after the F-series
 * number exists and before the PDF render, so the email button and the PDF
 * QR both carry the link. A provider failure never blocks the send: it
 * degrades to a Swedish warning, as on the dashboard. With no provider
 * extension registered nothing changes and no extra query runs.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createQueuedMockSupabase, makeInvoice, makeCustomer } from '@/tests/helpers'
import { eventBus } from '@/lib/events'
import { extensionRegistry } from '@/lib/extensions/registry'
import type { Invoice, PendingOperation } from '@/types'

vi.mock('@/lib/entitlements/has-capability', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/entitlements/has-capability')>()),
  hasCapability: vi.fn().mockResolvedValue(true),
}))

vi.mock('@react-pdf/renderer', () => ({
  renderToBuffer: vi.fn().mockResolvedValue(Buffer.from('pdf')),
}))

const mocks = vi.hoisted(() => ({
  InvoicePDF: vi.fn().mockReturnValue({}),
  generateInvoiceEmailHtml: vi.fn().mockReturnValue('<html />'),
  sendTrackedInvoiceEmail: vi.fn(),
  createInvoiceJournalEntry: vi.fn(),
  linkToJournalEntry: vi.fn(),
  ensureInvoiceNumber: vi.fn(),
}))

vi.mock('@/lib/invoices/pdf-template', () => ({
  InvoicePDF: mocks.InvoicePDF,
  brandingFromCompanySettings: vi.fn().mockReturnValue({}),
}))

// A company with no giro and no Swish: the one QR (lib/invoices/payment-qr)
// can only be the payment link, so the PDF carries a code exactly when the
// invoice carries a link.
vi.mock('@/lib/invoices/pdf-render-helpers', () => ({
  prepareInvoicePdfRender: vi.fn().mockResolvedValue({ branding: {}, company: {} }),
}))

vi.mock('@/lib/email/service', () => ({
  getEmailService: () => ({ isConfigured: () => true, sendEmail: vi.fn() }),
}))

vi.mock('@/lib/email/invoice-sender', () => ({
  resolveInvoiceSender: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@/lib/email/invoice-templates', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/email/invoice-templates')>()),
  generateInvoiceEmailHtml: mocks.generateInvoiceEmailHtml,
  generateInvoiceEmailText: vi.fn().mockReturnValue('text'),
  generateInvoiceEmailSubject: vi.fn().mockReturnValue('Faktura'),
}))

vi.mock('@/lib/invoices/invoice-deliveries', () => ({
  reserveInvoiceDelivery: vi.fn().mockResolvedValue('delivery-1'),
  sendTrackedInvoiceEmail: mocks.sendTrackedInvoiceEmail,
  recordManualInvoiceDelivery: vi.fn(),
}))

vi.mock('@/lib/invoices/ensure-invoice-number', () => ({
  ensureInvoiceNumber: mocks.ensureInvoiceNumber,
}))

vi.mock('@/lib/bookkeeping/invoice-entries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/bookkeeping/invoice-entries')>()),
  createInvoiceJournalEntry: mocks.createInvoiceJournalEntry,
}))

vi.mock('@/lib/core/documents/document-service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/core/documents/document-service')>()),
  linkToJournalEntry: mocks.linkToJournalEntry,
}))

import { commitPendingOperation } from '../commit'

const PROVIDER_ID = 'fake-psp'
const LINK_URL = 'https://pay.example.com/l/abc'
const NO_LINK_WARNING = 'Betalningslänken kunde inte skapas. Fakturan skickades utan betalningslänk.'

const customer = makeCustomer({ id: 'cust-1', name: 'Kund AB', email: 'kund@example.se' })

// A fresh draft: the F-series number is allocated during the send, so the
// provider must see the allocated number, not null.
function draftInvoice(overrides: Partial<Invoice> = {}) {
  return makeInvoice({
    id: 'invoice-1',
    status: 'draft',
    invoice_number: null,
    credited_invoice_id: null,
    document_type: 'invoice',
    payment_link_url: null,
    customer,
    items: [],
    ...overrides,
  } as Partial<Invoice>)
}

const SETTINGS = {
  company_name: 'Test AB',
  accounting_method: 'accrual',
  entity_type: 'enskild_firma',
  bankgiro: '123-4567',
  invoice_email_cc_addresses: [],
  invoice_email_bcc_addresses: [],
}

function sendOp(): PendingOperation {
  const overrides: Partial<PendingOperation> = {
    operation_type: 'send_invoice',
    params: { invoice_id: 'invoice-1' },
  }
  return {
    id: 'op-1',
    user_id: 'user-1',
    company_id: 'company-1',
    status: 'pending',
    title: 'test',
    preview_data: {},
    result_data: null,
    actor_type: 'user',
    actor_id: null,
    actor_label: null,
    risk_level: 'high',
    created_at: '2026-06-01T00:00:00Z',
    resolved_at: null,
    updated_at: '2026-06-01T00:00:00Z',
    ...overrides,
  } as PendingOperation
}

const createLink = vi.fn()

function registerProvider() {
  extensionRegistry.register({
    id: PROVIDER_ID,
    name: 'Fake PSP',
    version: '1.0.0',
    services: { createInvoicePaymentLink: createLink as (...args: unknown[]) => Promise<unknown> },
  })
}

/** The payment-link code the render entry point hands the template. */
const LINK_QR = expect.objectContaining({
  kind: 'payment_link',
  imageDataUrl: expect.stringMatching(/^data:image\/png;base64,/),
})

/** The invoice the final PDF render received. */
function renderedInvoice(): Invoice {
  const call = mocks.InvoicePDF.mock.calls.at(-1)
  return (call?.[0] as { invoice: Invoice }).invoice
}

beforeEach(() => {
  vi.clearAllMocks()
  eventBus.clear()
  mocks.ensureInvoiceNumber.mockImplementation(async (_s: unknown, _c: unknown, inv: Invoice) => {
    inv.invoice_number = 'F-2026007'
    return 'F-2026007'
  })
  mocks.sendTrackedInvoiceEmail.mockResolvedValue({
    success: true,
    messageId: 'msg-1',
    deliveryId: 'delivery-1',
    documentId: 'document-1',
  })
  mocks.createInvoiceJournalEntry.mockResolvedValue({ id: 'je-1' })
  mocks.linkToJournalEntry.mockResolvedValue(undefined)
  createLink.mockResolvedValue({ url: LINK_URL, externalId: 'plink_1' })
})

afterEach(() => {
  extensionRegistry.unregister(PROVIDER_ID)
})

describe('commitPendingOperation: send_invoice payment link parity', () => {
  it('without a payment provider the send is unchanged: no link lookup, no QR, no warning', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({ data: draftInvoice(), error: null })
    enqueue({ data: SETTINGS, error: null })
    enqueue({ data: [{ id: 'invoice-1' }], error: null }) // status flip draft -> sent
    enqueue({ data: null, error: null }) // journal_entry_id link
    enqueue({ data: null, error: null }) // dispatcher finalize

    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', sendOp())

    expect(result.status).toBe('committed')
    expect(result.data).toEqual({ message: 'Invoice F-2026007 sent to kund@example.se' })
    expect(createLink).not.toHaveBeenCalled()
    // Only the one full settings read: the payment-link opt-in is never queried.
    expect(findCalls('company_settings', 'select')).toEqual([['*']])
    expect(findCalls('invoices', 'update')).toEqual([[{ status: 'sent' }], [{ journal_entry_id: 'je-1' }]])
    expect(mocks.InvoicePDF).toHaveBeenLastCalledWith(
      expect.objectContaining({ paymentQr: null }),
    )
    expect(renderedInvoice().payment_link_url).toBeNull()
  })

  it('with a provider and the company opted in, the link is created, persisted, and carried by the email and PDF QR', async () => {
    registerProvider()
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({ data: draftInvoice(), error: null })
    enqueue({ data: SETTINGS, error: null })
    enqueue({ data: { invoice_payment_links_enabled: true }, error: null }) // opt-in read
    enqueue({ data: null, error: null }) // persist payment_link_url
    enqueue({ data: [{ id: 'invoice-1' }], error: null }) // status flip draft -> sent
    enqueue({ data: null, error: null }) // journal_entry_id link
    enqueue({ data: null, error: null }) // dispatcher finalize

    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', sendOp())

    expect(result.status).toBe('committed')
    expect(result.data).toEqual({ message: 'Invoice F-2026007 sent to kund@example.se' })

    // The provider sees the allocated number, after allocation.
    expect(createLink).toHaveBeenCalledTimes(1)
    const [, linkCompanyId, linkUserId, linkInvoice] = createLink.mock.calls[0]
    expect(linkCompanyId).toBe('company-1')
    expect(linkUserId).toBe('user-1')
    expect((linkInvoice as Invoice).invoice_number).toBe('F-2026007')
    expect(mocks.ensureInvoiceNumber.mock.invocationCallOrder[0]).toBeLessThan(
      createLink.mock.invocationCallOrder[0],
    )

    // Persisted on the row BEFORE the invoice is issued and emailed, so a
    // payment event can always be matched back to it.
    expect(findCalls('invoices', 'update')).toEqual([
      [{ payment_link_url: LINK_URL, stripe_payment_link_id: 'plink_1' }],
      [{ status: 'sent' }],
      [{ journal_entry_id: 'je-1' }],
    ])
    expect(createLink.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.sendTrackedInvoiceEmail.mock.invocationCallOrder[0],
    )

    // PDF QR and email button both carry the link.
    expect(mocks.InvoicePDF).toHaveBeenLastCalledWith(
      expect.objectContaining({ paymentQr: LINK_QR }),
    )
    expect(renderedInvoice().payment_link_url).toBe(LINK_URL)
    expect(mocks.generateInvoiceEmailHtml).toHaveBeenCalledWith(
      expect.objectContaining({
        invoice: expect.objectContaining({ payment_link_url: LINK_URL, status: 'sent' }),
      }),
    )
  })

  it('a provider failure never blocks the send: emailed without a link and a Swedish warning returned', async () => {
    registerProvider()
    createLink.mockRejectedValue(new Error('psp down'))
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({ data: draftInvoice(), error: null })
    enqueue({ data: SETTINGS, error: null })
    enqueue({ data: { invoice_payment_links_enabled: true }, error: null }) // opt-in read
    enqueue({ data: [{ id: 'invoice-1' }], error: null }) // status flip draft -> sent
    enqueue({ data: null, error: null }) // journal_entry_id link
    enqueue({ data: null, error: null }) // dispatcher finalize

    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', sendOp())

    expect(result.status).toBe('committed')
    expect(result.data).toEqual({
      message: 'Invoice F-2026007 sent to kund@example.se',
      warning: NO_LINK_WARNING,
    })
    expect(mocks.sendTrackedInvoiceEmail).toHaveBeenCalledTimes(1)
    expect(findCalls('invoices', 'update')).toEqual([[{ status: 'sent' }], [{ journal_entry_id: 'je-1' }]])
    expect(renderedInvoice().payment_link_url).toBeNull()
    expect(mocks.InvoicePDF).toHaveBeenLastCalledWith(
      expect.objectContaining({ paymentQr: null }),
    )
  })

  it('a provider whose company has not opted in creates no link and sends as before', async () => {
    registerProvider()
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({ data: draftInvoice(), error: null })
    enqueue({ data: SETTINGS, error: null })
    enqueue({ data: { invoice_payment_links_enabled: false }, error: null }) // opt-in read
    enqueue({ data: [{ id: 'invoice-1' }], error: null }) // status flip draft -> sent
    enqueue({ data: null, error: null }) // journal_entry_id link
    enqueue({ data: null, error: null }) // dispatcher finalize

    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', sendOp())

    expect(result.status).toBe('committed')
    expect(result.data).toEqual({ message: 'Invoice F-2026007 sent to kund@example.se' })
    expect(createLink).not.toHaveBeenCalled()
    expect(findCalls('invoices', 'update')).toEqual([[{ status: 'sent' }], [{ journal_entry_id: 'je-1' }]])
  })

  it('a manually pasted link is kept (no provider call) and now reaches the PDF QR too', async () => {
    registerProvider()
    const manual = 'https://pay.example.com/manual'
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({ data: draftInvoice({ payment_link_url: manual }), error: null })
    enqueue({ data: SETTINGS, error: null })
    enqueue({ data: [{ id: 'invoice-1' }], error: null }) // status flip draft -> sent
    enqueue({ data: null, error: null }) // journal_entry_id link
    enqueue({ data: null, error: null }) // dispatcher finalize

    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', sendOp())

    expect(result.status).toBe('committed')
    expect(createLink).not.toHaveBeenCalled()
    expect(findCalls('invoices', 'update')).toEqual([[{ status: 'sent' }], [{ journal_entry_id: 'je-1' }]])
    expect(mocks.InvoicePDF).toHaveBeenLastCalledWith(
      expect.objectContaining({ paymentQr: LINK_QR }),
    )
    expect(renderedInvoice().payment_link_url).toBe(manual)
  })
})
