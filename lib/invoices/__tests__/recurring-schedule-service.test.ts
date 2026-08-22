import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  computeNextRunDate,
  computeInitialRunDate,
  rollNextRunDateForward,
  getStockholmDateHour,
  executeRecurringSchedule,
} from '@/lib/invoices/recurring-schedule-service'
import { createQueuedMockSupabase, makeCustomer, makeCompanySettings } from '@/tests/helpers'
import { eventBus } from '@/lib/events'

// ── Mocks for the executeRecurringSchedule auto-send path ─────────────
// The pure date-helper tests below don't touch any of these modules.

const mockRenderToBuffer = vi.fn()
vi.mock('@react-pdf/renderer', () => ({
  renderToBuffer: (...args: unknown[]) => mockRenderToBuffer(...args),
}))

const mockFetchExchangeRate = vi.fn()
vi.mock('@/lib/currency/riksbanken', async () => {
  const actual =
    await vi.importActual<typeof import('@/lib/currency/riksbanken')>('@/lib/currency/riksbanken')
  return { ...actual, fetchExchangeRate: (...args: unknown[]) => mockFetchExchangeRate(...args) }
})

const mockInvoicePDF = vi.fn()
vi.mock('@/lib/invoices/pdf-template', () => ({
  InvoicePDF: (...args: unknown[]) => mockInvoicePDF(...args),
}))

const mockPrepareRender = vi.fn()
const mockSwishQr = vi.fn()
const mockPaymentLinkQr = vi.fn()
vi.mock('@/lib/invoices/pdf-render-helpers', () => ({
  prepareInvoicePdfRender: (...args: unknown[]) => mockPrepareRender(...args),
  buildSwishQrDataUrl: (...args: unknown[]) => mockSwishQr(...args),
  buildPaymentLinkQrDataUrl: (...args: unknown[]) => mockPaymentLinkQr(...args),
}))

const mockApplyPaymentLink = vi.fn()
vi.mock('@/lib/extensions/payment-links', () => ({
  applyPaymentLinkToInvoice: (...args: unknown[]) => mockApplyPaymentLink(...args),
}))

const mockSendEmail = vi.fn()
const mockIsConfigured = vi.fn()
vi.mock('@/lib/email/invoice-sender', () => ({
  resolveInvoiceSender: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@/lib/email/service', () => ({
  getEmailService: () => ({
    sendEmail: (...args: unknown[]) => mockSendEmail(...args),
    isConfigured: () => mockIsConfigured(),
  }),
}))

const mockSendTrackedInvoiceEmail = vi.fn(async (input: {
  emailService: { sendEmail: (options: unknown) => Promise<Record<string, unknown>> }
  to: string | string[]
  cc?: string | string[]
  bcc?: string | string[]
  subject: string
  html: string
  text: string
  replyTo?: string
  fromName?: string
  filename: string
  pdfBuffer: Buffer
}) => ({
  ...(await input.emailService.sendEmail({
    to: input.to,
    cc: input.cc,
    bcc: input.bcc,
    subject: input.subject,
    html: input.html,
    text: input.text,
    replyTo: input.replyTo,
    fromName: input.fromName,
    attachments: [{
      filename: input.filename,
      content: input.pdfBuffer,
      contentType: 'application/pdf',
    }],
  })),
  deliveryId: 'delivery-1',
  documentId: 'document-1',
}))
const mockReserveInvoiceDelivery = vi.fn().mockResolvedValue('delivery-1')
vi.mock('@/lib/invoices/invoice-deliveries', () => ({
  InvoiceDeliverySnapshotError: class InvoiceDeliverySnapshotError extends Error {},
  reserveInvoiceDelivery: (...args: unknown[]) => mockReserveInvoiceDelivery(...args),
  sendTrackedInvoiceEmail: (...args: unknown[]) => mockSendTrackedInvoiceEmail(...args as [never]),
}))

vi.mock('@/lib/email/invoice-templates', () => ({
  generateInvoiceEmailHtml: vi.fn().mockReturnValue('<html>Invoice</html>'),
  generateInvoiceEmailText: vi.fn().mockReturnValue('Invoice text'),
  generateInvoiceEmailSubject: vi.fn().mockReturnValue('Faktura F-1'),
}))

const mockIsSandbox = vi.fn()
vi.mock('@/lib/sandbox/guard', () => ({
  isSandboxCompany: (...args: unknown[]) => mockIsSandbox(...args),
}))

const mockHasCapability = vi.fn()
vi.mock('@/lib/entitlements/has-capability', () => ({
  hasCapability: (...args: unknown[]) => mockHasCapability(...args),
}))

const mockEnsureNumber = vi.fn()
vi.mock('@/lib/invoices/ensure-invoice-number', () => ({
  ensureInvoiceNumber: (...args: unknown[]) => mockEnsureNumber(...args),
}))

const mockCreateJE = vi.fn()
vi.mock('@/lib/bookkeeping/invoice-entries', () => ({
  createInvoiceJournalEntry: (...args: unknown[]) => mockCreateJE(...args),
}))

const mockUploadDocument = vi.fn()
vi.mock('@/lib/core/documents/document-service', () => ({
  uploadDocument: (...args: unknown[]) => mockUploadDocument(...args),
  linkToJournalEntry: vi.fn().mockResolvedValue(undefined),
}))

describe('computeNextRunDate', () => {
  it('advances day 15 from January to February', () => {
    const result = computeNextRunDate(new Date(Date.UTC(2026, 0, 15)), 15)
    expect(result).toBe('2026-02-15')
  })

  it('clamps day 31 to last day of February (non-leap)', () => {
    // 2027 February has 28 days.
    const result = computeNextRunDate(new Date(Date.UTC(2027, 0, 31)), 31)
    expect(result).toBe('2027-02-28')
  })

  it('clamps day 31 to last day of February in a leap year', () => {
    const result = computeNextRunDate(new Date(Date.UTC(2028, 0, 31)), 31)
    expect(result).toBe('2028-02-29')
  })

  it('rolls into the next year correctly', () => {
    const result = computeNextRunDate(new Date(Date.UTC(2026, 11, 15)), 15)
    expect(result).toBe('2027-01-15')
  })

  it('clamps day 31 to 30 in 30-day months (April)', () => {
    const result = computeNextRunDate(new Date(Date.UTC(2026, 2, 31)), 31)
    expect(result).toBe('2026-04-30')
  })

  it('rejects invalid day_of_month', () => {
    expect(() => computeNextRunDate(new Date(), 0)).toThrow()
    expect(() => computeNextRunDate(new Date(), 32)).toThrow()
  })

  it('advances a quarter with interval 3', () => {
    const result = computeNextRunDate(new Date(Date.UTC(2026, 0, 15)), 15, 3)
    expect(result).toBe('2026-04-15')
  })

  it('advances a quarter across the year boundary', () => {
    const result = computeNextRunDate(new Date(Date.UTC(2026, 10, 15)), 15, 3)
    expect(result).toBe('2027-02-15')
  })

  it('clamps day 31 when a quarterly step lands in February', () => {
    // Nov 30 + 3 months = Feb; 2027 February has 28 days.
    const result = computeNextRunDate(new Date(Date.UTC(2026, 10, 30)), 31, 3)
    expect(result).toBe('2027-02-28')
  })

  it('advances a full year with interval 12, keeping leap-day clamp', () => {
    // 2028-02-29 (leap) + 12 months, day 29 -> 2029-02-28.
    const result = computeNextRunDate(new Date(Date.UTC(2028, 1, 29)), 29, 12)
    expect(result).toBe('2029-02-28')
  })

  it('rejects invalid interval_months', () => {
    expect(() => computeNextRunDate(new Date(), 15, 0)).toThrow()
    expect(() => computeNextRunDate(new Date(), 15, 13)).toThrow()
    expect(() => computeNextRunDate(new Date(), 15, 1.5)).toThrow()
  })
})

describe('rollNextRunDateForward', () => {
  const today = new Date(Date.UTC(2026, 6, 6)) // 2026-07-06

  it('monthly: rolls a stale date to the next occurrence on or after today', () => {
    expect(rollNextRunDateForward('2026-07-05', today, 5, 1, { allowToday: true }))
      .toBe('2026-08-05')
    expect(rollNextRunDateForward('2026-05-15', today, 15, 1, { allowToday: true }))
      .toBe('2026-07-15')
  })

  it('monthly: allowToday keeps an occurrence landing on today', () => {
    expect(rollNextRunDateForward('2026-06-06', today, 6, 1, { allowToday: true }))
      .toBe('2026-07-06')
  })

  it('monthly: default (strictly future) skips today', () => {
    expect(rollNextRunDateForward('2026-06-06', today, 6, 1)).toBe('2026-08-06')
  })

  it('quarterly: preserves the month phase across a missed run', () => {
    // Jan 15 quarterly run missed; today is Jul 6 -> Jul 15, NOT Feb/Aug 15.
    expect(rollNextRunDateForward('2026-01-15', today, 15, 3, { allowToday: true }))
      .toBe('2026-07-15')
    // Apr 5 missed -> Jul 5 already past today -> Oct 5.
    expect(rollNextRunDateForward('2026-04-05', today, 5, 3, { allowToday: true }))
      .toBe('2026-10-05')
  })

  it('yearly: rolls a missed run a whole year forward', () => {
    expect(rollNextRunDateForward('2026-03-01', today, 1, 12, { allowToday: true }))
      .toBe('2027-03-01')
  })

  it('keeps a future anchor as-is (day edit within the anchor month)', () => {
    // Quarterly schedule anchored on Oct; day edited to 20 -> stays in Oct.
    expect(rollNextRunDateForward('2026-10-15', today, 20, 3)).toBe('2026-10-20')
  })

  it('re-derives the day from day_of_month when the anchor was clamped', () => {
    // Anchor 2026-02-28 stored for a day-31 schedule; monthly roll from a
    // stale date recovers day 31 in months that have it.
    expect(rollNextRunDateForward('2026-02-28', today, 31, 1, { allowToday: true }))
      .toBe('2026-07-31')
  })

  it('clamps per month while stepping (quarterly day 31 through February)', () => {
    const winter = new Date(Date.UTC(2027, 1, 10)) // 2027-02-10
    expect(rollNextRunDateForward('2026-11-30', winter, 31, 3, { allowToday: true }))
      .toBe('2027-02-28')
  })

  it('rejects malformed anchors and invalid cadence', () => {
    expect(() => rollNextRunDateForward('2026-1-5', today, 5, 1)).toThrow()
    expect(() => rollNextRunDateForward('2026-01-05', today, 5, 0)).toThrow()
    expect(() => rollNextRunDateForward('2026-01-05', today, 0, 1)).toThrow()
  })

  it('rejects calendar-invalid anchors that pass the shape regex', () => {
    expect(() => rollNextRunDateForward('2026-13-05', today, 5, 1)).toThrow()
    expect(() => rollNextRunDateForward('2026-00-05', today, 5, 1)).toThrow()
    expect(() => rollNextRunDateForward('2026-02-31', today, 31, 1)).toThrow()
    expect(() => rollNextRunDateForward('2026-04-00', today, 5, 1)).toThrow()
  })

  it('rejects fractional day_of_month', () => {
    expect(() => rollNextRunDateForward('2026-01-05', today, 5.5, 1)).toThrow()
    expect(() => computeNextRunDate(today, 15.5)).toThrow()
  })
})

describe('computeInitialRunDate', () => {
  it('picks this month when day_of_month is in the future', () => {
    const today = new Date(Date.UTC(2026, 4, 5)) // 2026-05-05
    expect(computeInitialRunDate(today, 15)).toBe('2026-05-15')
  })

  it('picks today when day_of_month === today', () => {
    const today = new Date(Date.UTC(2026, 4, 15))
    expect(computeInitialRunDate(today, 15)).toBe('2026-05-15')
  })

  it('picks next month when day_of_month is in the past', () => {
    const today = new Date(Date.UTC(2026, 4, 20))
    expect(computeInitialRunDate(today, 15)).toBe('2026-06-15')
  })

  it('honours start_date override', () => {
    const today = new Date(Date.UTC(2026, 4, 20))
    expect(computeInitialRunDate(today, 15, '2027-01-01')).toBe('2027-01-01')
  })

  it('clamps day 31 in February when picking this-month', () => {
    const today = new Date(Date.UTC(2027, 1, 10)) // 2027-02-10, Feb has 28 days
    expect(computeInitialRunDate(today, 31)).toBe('2027-02-28')
  })
})

describe('getStockholmDateHour', () => {
  it('applies summer offset (CEST, UTC+2)', () => {
    // 2026-07-06 06:00 UTC -> 08:00 Stockholm
    expect(getStockholmDateHour(new Date('2026-07-06T06:00:00Z'))).toEqual({
      date: '2026-07-06',
      hour: 8,
    })
  })

  it('applies winter offset (CET, UTC+1)', () => {
    // 2026-01-15 06:00 UTC -> 07:00 Stockholm
    expect(getStockholmDateHour(new Date('2026-01-15T06:00:00Z'))).toEqual({
      date: '2026-01-15',
      hour: 7,
    })
  })

  it('rolls the date forward across the local midnight boundary', () => {
    // 2026-07-06 22:30 UTC -> 00:30 Stockholm on 2026-07-07 (summer +2)
    expect(getStockholmDateHour(new Date('2026-07-06T22:30:00Z'))).toEqual({
      date: '2026-07-07',
      hour: 0,
    })
  })

  it('reports hour 23 (h23 cycle, never 24) late in the local day', () => {
    // 2026-07-06 21:00 UTC -> 23:00 Stockholm (summer +2)
    expect(getStockholmDateHour(new Date('2026-07-06T21:00:00Z'))).toEqual({
      date: '2026-07-06',
      hour: 23,
    })
  })
})

describe('executeRecurringSchedule auto-send', () => {
  const { supabase, enqueue, reset } = createQueuedMockSupabase()
  const client = supabase as unknown as SupabaseClient
  const today = new Date('2026-07-06T06:30:00Z')

  const customer = makeCustomer({
    id: 'cust-1',
    name: 'Kund ÅÄÖ AB',
    email: 'kund@test.se',
  })
  const company = makeCompanySettings({
    company_name: 'Oppy Sverige',
    accounting_method: 'accrual',
    bankgiro: '123-4567',
    invoice_email_cc_addresses: ['fixed-copy@test.se'],
    invoice_email_bcc_addresses: ['fixed-archive@test.se'],
  })

  function makeSchedule() {
    return {
      id: 'sched-1',
      company_id: 'company-1',
      user_id: 'user-1',
      customer_id: 'cust-1',
      name: 'Monthly retainer',
      day_of_month: 6,
      send_hour: 8,
      payment_terms_days: 30,
      currency: 'SEK',
      your_reference: null,
      our_reference: null,
      notes: null,
      auto_send: true,
      status: 'active',
      next_run_date: '2026-07-06',
      last_run_at: null,
      last_invoice_id: null,
      last_run_warning: null,
      generated_count: 0,
      items: [
        {
          id: 'si-1',
          schedule_id: 'sched-1',
          sort_order: 0,
          description: 'Konsulttimmar',
          quantity: 10,
          unit: 'tim',
          unit_price: 1000,
          vat_rate: 25,
        },
      ],
    } as unknown as Parameters<typeof executeRecurringSchedule>[1]
  }

  // Fresh objects per test: ensureInvoiceNumber and applyPaymentLinkToInvoice
  // mutate the invoice they receive, so shared fixtures would leak state.
  function makeInsertedInvoice() {
    return { id: 'inv-1', invoice_number: null, document_type: 'invoice' }
  }
  function makeCompleteInvoice() {
    return {
      id: 'inv-1',
      invoice_number: 'F-1',
      invoice_date: '2026-07-06',
      status: 'draft',
      document_type: 'invoice',
      currency: 'SEK',
      total: 12500,
      credited_invoice_id: null,
      payment_link_url: null,
      customer,
      items: [{ id: 'item-1', sort_order: 0 }],
    }
  }

  /** Queue for the full happy path (see call order in the service). */
  function enqueueHappyPath() {
    enqueue({ data: customer, error: null }) // customers select
    enqueue({ data: makeInsertedInvoice(), error: null }) // invoices insert
    enqueue({ data: null, error: null }) // invoice_items insert
    enqueue({ data: makeCompleteInvoice(), error: null }) // re-fetch with relations
    enqueue({ data: company, error: null }) // company_settings (auto-send)
    enqueue({ data: null, error: null }) // status flip to sent
    enqueue({ data: null, error: null }) // journal_entry_id write-back
  }

  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    eventBus.clear()
    mockIsConfigured.mockReturnValue(true)
    mockIsSandbox.mockResolvedValue(false)
    mockHasCapability.mockResolvedValue(true)
    mockApplyPaymentLink.mockResolvedValue({ failure: null })
    mockEnsureNumber.mockImplementation(
      async (_supabase: unknown, _companyId: unknown, inv: { invoice_number: string | null }) => {
        inv.invoice_number = 'F-1'
        return 'F-1'
      },
    )
    mockPrepareRender.mockResolvedValue({ branding: {}, company })
    mockSwishQr.mockResolvedValue(null)
    mockPaymentLinkQr.mockResolvedValue(null)
    mockRenderToBuffer.mockResolvedValue(Buffer.from('fake-pdf'))
    mockInvoicePDF.mockReturnValue('pdf-element')
    mockSendEmail.mockResolvedValue({ success: true, messageId: 'm-1' })
    mockCreateJE.mockResolvedValue({ id: 'je-1' })
    mockUploadDocument.mockResolvedValue({})
  })

  it('creates a payment link before rendering and passes its QR to the PDF', async () => {
    enqueueHappyPath()
    mockApplyPaymentLink.mockImplementation(
      async (_s: unknown, _c: unknown, _u: unknown, inv: { payment_link_url: string | null }) => {
        inv.payment_link_url = 'https://pay.example/x'
        return { failure: null }
      },
    )
    mockPaymentLinkQr.mockResolvedValue('data:image/png;base64,QR')

    const result = await executeRecurringSchedule(client, makeSchedule(), today)

    expect(result.autoSent).toBe(true)
    expect(result.warning).toBeNull()
    expect(mockSendTrackedInvoiceEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        companyId: 'company-1',
        invoiceId: 'inv-1',
        cc: ['fixed-copy@test.se'],
        bcc: ['fixed-archive@test.se'],
      }),
    )
    expect(mockApplyPaymentLink).toHaveBeenCalledTimes(1)
    expect(mockApplyPaymentLink).toHaveBeenCalledWith(
      expect.anything(),
      'company-1',
      'user-1',
      expect.objectContaining({ id: 'inv-1' }),
      expect.anything(),
    )
    // Link applied BEFORE the render so the email button and PDF QR carry it.
    expect(mockApplyPaymentLink.mock.invocationCallOrder[0]).toBeLessThan(
      mockRenderToBuffer.mock.invocationCallOrder[0],
    )
    // QR built from the renderable copy (status overridden to 'sent').
    expect(mockPaymentLinkQr).toHaveBeenCalledWith(
      expect.objectContaining({ payment_link_url: 'https://pay.example/x', status: 'sent' }),
    )
    expect(mockInvoicePDF).toHaveBeenCalledWith(
      expect.objectContaining({ paymentLinkQrDataUrl: 'data:image/png;base64,QR' }),
    )
    expect(mockSendEmail).toHaveBeenCalledWith(expect.objectContaining({
      attachments: [expect.objectContaining({
        filename: 'Oppy Sverige x Kund ÅÄÖ AB Faktura nr F-1 20260706.pdf',
      })],
    }))
  })

  it('a payment link failure never blocks the send', async () => {
    enqueueHappyPath()
    mockApplyPaymentLink.mockResolvedValue({ failure: 'Stripe nere' })

    const result = await executeRecurringSchedule(client, makeSchedule(), today)

    expect(result.autoSent).toBe(true)
    expect(result.warning).toBeNull()
    expect(mockSendEmail).toHaveBeenCalledTimes(1)
  })

  it('does not reserve a delivery when the customer email is blank', async () => {
    const customerWithoutEmail = { ...customer, email: '   ' }
    enqueue({ data: customerWithoutEmail, error: null })
    enqueue({ data: makeInsertedInvoice(), error: null })
    enqueue({ data: null, error: null })
    enqueue({
      data: { ...makeCompleteInvoice(), customer: customerWithoutEmail },
      error: null,
    })

    const result = await executeRecurringSchedule(client, makeSchedule(), today)

    expect(result.autoSent).toBe(false)
    expect(result.warning).toContain('Auto-utskick misslyckades')
    expect(mockReserveInvoiceDelivery).not.toHaveBeenCalled()
    expect(mockSendEmail).not.toHaveBeenCalled()
  })

  it('does not reserve an auto-send delivery when configured recipients exceed the limit', async () => {
    enqueue({ data: customer, error: null })
    enqueue({ data: makeInsertedInvoice(), error: null })
    enqueue({ data: null, error: null })
    enqueue({ data: makeCompleteInvoice(), error: null })
    enqueue({
      data: {
        ...company,
        invoice_email_cc_addresses: Array.from(
          { length: 20 },
          (_, index) => `fixed-${index}@example.test`,
        ),
        invoice_email_bcc_addresses: [],
      },
      error: null,
    })

    const result = await executeRecurringSchedule(client, makeSchedule(), today)

    expect(result.autoSent).toBe(false)
    expect(result.warning).not.toBeNull()
    expect(mockReserveInvoiceDelivery).not.toHaveBeenCalled()
    expect(mockRenderToBuffer).not.toHaveBeenCalled()
    expect(mockSendEmail).not.toHaveBeenCalled()
  })

  it('never auto-sends from a sandbox company; invoice stays a numbered draft', async () => {
    mockIsSandbox.mockResolvedValue(true)
    // Sandbox bails before company_settings/payment-link/render/email, so the
    // queue only covers invoice creation.
    enqueue({ data: customer, error: null })
    enqueue({ data: makeInsertedInvoice(), error: null })
    enqueue({ data: null, error: null })
    enqueue({ data: makeCompleteInvoice(), error: null })

    const result = await executeRecurringSchedule(client, makeSchedule(), today)

    expect(result.invoiceId).toBe('inv-1')
    expect(result.autoSent).toBe(false)
    expect(result.warning).toContain('Auto-utskick misslyckades')
    expect(mockSendEmail).not.toHaveBeenCalled()
    expect(mockApplyPaymentLink).not.toHaveBeenCalled()
    expect(mockCreateJE).not.toHaveBeenCalled()
  })

  it('route-level suppressAutoSend skips the send path without relying on the internal chokepoint', async () => {
    // Defence in depth (ASVS V2.3): the flag comes from the route's own
    // isSandboxCompany resolution, so sending is suppressed even before the
    // service-internal sandbox check runs. Invoice creation is unaffected.
    enqueue({ data: customer, error: null })
    enqueue({ data: makeInsertedInvoice(), error: null })
    enqueue({ data: null, error: null })
    enqueue({ data: makeCompleteInvoice(), error: null })

    const result = await executeRecurringSchedule(client, makeSchedule(), today, {
      suppressAutoSend: true,
    })

    expect(result.invoiceId).toBe('inv-1')
    expect(result.autoSent).toBe(false)
    expect(result.warning).toContain('Auto-utskick misslyckades')
    expect(mockSendEmail).not.toHaveBeenCalled()
    // The suppress branch bails before the email chokepoint entirely.
    expect(mockIsSandbox).not.toHaveBeenCalled()
    expect(mockCreateJE).not.toHaveBeenCalled()
  })
})

describe('executeRecurringSchedule VAT rate gate', () => {
  const { supabase, enqueue, reset } = createQueuedMockSupabase()
  const client = supabase as unknown as SupabaseClient
  const today = new Date('2026-07-06T06:30:00Z')

  // Validated EU business: the picker default is a single locked 0%
  // (huvudregeln, ML 6 kap. 34 §), while the ML 6 kap. supplies taxed where they
  // are performed carry Swedish VAT to that same customer. The cron-time gate
  // reads the wider permitted set, exactly like buildInvoiceWriteData.
  const euCustomer = makeCustomer({
    id: 'cust-1',
    customer_type: 'eu_business',
    vat_number_validated: true,
  })

  function makeScheduleWithRate(vatRate: number) {
    return {
      id: 'sched-1',
      company_id: 'company-1',
      user_id: 'user-1',
      customer_id: 'cust-1',
      name: 'Monthly hotel retainer',
      day_of_month: 6,
      send_hour: 8,
      payment_terms_days: 30,
      currency: 'SEK',
      your_reference: null,
      our_reference: null,
      notes: null,
      auto_send: false,
      status: 'active',
      next_run_date: '2026-07-06',
      last_run_at: null,
      last_invoice_id: null,
      last_run_warning: null,
      generated_count: 0,
      items: [
        {
          id: 'si-1',
          schedule_id: 'sched-1',
          sort_order: 0,
          description: 'Hotellnatt Stockholm',
          quantity: 10,
          unit: 'st',
          unit_price: 1000,
          vat_rate: vatRate,
        },
      ],
    } as unknown as Parameters<typeof executeRecurringSchedule>[1]
  }

  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    eventBus.clear()
    mockEnsureNumber.mockResolvedValue('F-1')
  })

  it('generates the invoice for a 12% schedule to a validated EU business', async () => {
    enqueue({ data: euCustomer, error: null })                                    // customers select
    enqueue({ data: { id: 'inv-1', invoice_number: null, document_type: 'invoice' }, error: null }) // invoices insert
    enqueue({ data: null, error: null })                                          // invoice_items insert
    enqueue({
      data: { id: 'inv-1', invoice_number: 'F-1', customer: euCustomer, items: [] },
      error: null,
    })                                                                            // re-fetch

    const result = await executeRecurringSchedule(client, makeScheduleWithRate(12), today, {
      suppressAutoSend: true,
    })

    expect(result.invoiceId).toBe('inv-1')
  })

  it('still throws for a rate that is not a Swedish VAT rate', async () => {
    enqueue({ data: euCustomer, error: null }) // customers select; throws before any insert

    await expect(
      executeRecurringSchedule(client, makeScheduleWithRate(10), today, { suppressAutoSend: true }),
    ).rejects.toThrow(/VAT rate 10% not allowed/)
  })
})

describe('executeRecurringSchedule foreign-currency rate fetch', () => {
  const { supabase, enqueue, reset } = createQueuedMockSupabase()
  const client = supabase as unknown as SupabaseClient
  const today = new Date('2026-07-06T06:30:00Z')

  const customer = makeCustomer({ id: 'cust-1', name: 'Kund AB' })

  function makeEurSchedule() {
    return {
      id: 'sched-1',
      company_id: 'company-1',
      user_id: 'user-1',
      customer_id: 'cust-1',
      name: 'Monthly EUR retainer',
      day_of_month: 6,
      send_hour: 8,
      payment_terms_days: 30,
      currency: 'EUR',
      your_reference: null,
      our_reference: null,
      notes: null,
      auto_send: false,
      status: 'active',
      next_run_date: '2026-07-06',
      last_run_at: null,
      last_invoice_id: null,
      last_run_warning: null,
      generated_count: 0,
      items: [
        {
          id: 'si-1',
          schedule_id: 'sched-1',
          sort_order: 0,
          description: 'Konsulttimmar',
          quantity: 10,
          unit: 'tim',
          unit_price: 100,
          vat_rate: 25,
        },
      ],
    } as unknown as Parameters<typeof executeRecurringSchedule>[1]
  }

  function enqueueCreateOnlyPath() {
    enqueue({ data: customer, error: null }) // customers select
    enqueue({ data: { id: 'inv-1', invoice_number: null, document_type: 'invoice' }, error: null }) // invoices insert
    enqueue({ data: null, error: null }) // invoice_items insert
    enqueue({
      data: { id: 'inv-1', invoice_number: 'F-1', customer, items: [] },
      error: null,
    }) // re-fetch with relations
  }

  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    eventBus.clear()
    mockEnsureNumber.mockResolvedValue('F-1')
  })

  it('fetches the rate for the invoice date through the shared cache client', async () => {
    // The cron used to call fetchExchangeRate(currency) with neither the date
    // nor the supabase client, skipping the exchange_rates cache and the
    // Riksbanken-429 fallback that build-invoice-write.ts uses: one transient
    // rate limit left the monthly foreign retainer with exchange_rate NULL
    // forever. The call shape must match buildInvoiceWriteData's.
    mockFetchExchangeRate.mockResolvedValue({ currency: 'EUR', rate: 11.5, date: '2026-07-04' })
    enqueueCreateOnlyPath()

    const result = await executeRecurringSchedule(client, makeEurSchedule(), today, {
      suppressAutoSend: true,
    })

    expect(result.invoiceId).toBe('inv-1')
    expect(mockFetchExchangeRate).toHaveBeenCalledTimes(1)
    const [currencyArg, dateArg, clientArg] = mockFetchExchangeRate.mock.calls[0]
    expect(currencyArg).toBe('EUR')
    expect((dateArg as Date).toISOString().slice(0, 10)).toBe('2026-07-06')
    expect(clientArg).toBe(client)
  })

  it('keeps continue-on-null: a missing rate never fails the cron run', async () => {
    mockFetchExchangeRate.mockResolvedValue(null)
    enqueueCreateOnlyPath()

    const result = await executeRecurringSchedule(client, makeEurSchedule(), today, {
      suppressAutoSend: true,
    })

    expect(result.invoiceId).toBe('inv-1')
  })
})

describe('executeRecurringSchedule dimension propagation', () => {
  const { supabase, enqueue, reset } = createQueuedMockSupabase()
  const client = supabase as unknown as SupabaseClient
  const today = new Date('2026-07-06T06:30:00Z')

  const customer = makeCustomer({ id: 'cust-1', email: 'kund@test.se' })

  // The queued mock's chain proxy discards call args by design, so capture
  // .insert payloads per table with a thin wrapper around the original
  // implementation (grabbed once, before any override, to avoid re-wrapping).
  const originalFrom = supabase.from.getMockImplementation()!
  const inserted: Record<string, unknown[]> = {}

  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    eventBus.clear()
    for (const key of Object.keys(inserted)) delete inserted[key]
    supabase.from.mockImplementation((table: string) => {
      const chain = originalFrom(table) as object
      return new Proxy(chain, {
        get(target, prop, receiver) {
          if (prop === 'insert') {
            return (rows: unknown) => {
              ;(inserted[table] ??= []).push(rows)
              return (Reflect.get(target, prop, receiver) as (r: unknown) => unknown)(rows)
            }
          }
          return Reflect.get(target, prop, receiver)
        },
      })
    })
  })

  function makeTaggedSchedule() {
    return {
      id: 'sched-1',
      company_id: 'company-1',
      user_id: 'user-1',
      customer_id: 'cust-1',
      name: 'Monthly retainer',
      day_of_month: 6,
      send_hour: 8,
      payment_terms_days: 30,
      currency: 'SEK',
      your_reference: null,
      our_reference: null,
      notes: null,
      auto_send: false,
      status: 'active',
      next_run_date: '2026-07-06',
      last_run_at: null,
      last_invoice_id: null,
      last_run_warning: null,
      generated_count: 0,
      default_dimensions: { '1': 'KS1', '6': 'P001' },
      items: [
        {
          id: 'si-1',
          schedule_id: 'sched-1',
          sort_order: 0,
          description: 'Konsulttimmar',
          quantity: 10,
          unit: 'tim',
          unit_price: 1000,
          vat_rate: 25,
          dimensions: { '6': 'P002' },
        },
        {
          id: 'si-2',
          schedule_id: 'sched-1',
          sort_order: 1,
          description: 'Resersättning',
          quantity: 1,
          unit: 'st',
          unit_price: 500,
          vat_rate: 25,
        },
      ],
    } as unknown as Parameters<typeof executeRecurringSchedule>[1]
  }

  function enqueueCreatePath() {
    enqueue({ data: customer, error: null }) // customers select
    enqueue({ data: { id: 'inv-1', invoice_number: null, document_type: 'invoice' }, error: null }) // invoices insert
    enqueue({ data: null, error: null }) // invoice_items insert
    enqueue({
      data: { id: 'inv-1', invoice_number: 'F-1', customer, items: [] },
      error: null,
    }) // re-fetch with relations
  }

  it('copies the schedule bag onto the invoice and per-item bags onto items', async () => {
    enqueueCreatePath()

    await executeRecurringSchedule(client, makeTaggedSchedule(), today, {
      suppressAutoSend: true,
    })

    expect(inserted['invoices']).toHaveLength(1)
    expect(inserted['invoices'][0]).toMatchObject({
      default_dimensions: { '1': 'KS1', '6': 'P001' },
    })

    const itemRows = inserted['invoice_items'][0] as Array<Record<string, unknown>>
    expect(itemRows).toHaveLength(2)
    expect(itemRows[0].dimensions).toEqual({ '6': 'P002' })
    // An untagged template item lands as an explicit empty bag, matching the
    // invoice_items column default (never undefined/null).
    expect(itemRows[1].dimensions).toEqual({})
  })

  it('a legacy schedule row without the columns spawns empty bags', async () => {
    enqueueCreatePath()
    const schedule = makeTaggedSchedule() as unknown as Record<string, unknown>
    delete schedule.default_dimensions
    for (const item of schedule.items as Array<Record<string, unknown>>) {
      delete item.dimensions
    }

    await executeRecurringSchedule(
      client,
      schedule as unknown as Parameters<typeof executeRecurringSchedule>[1],
      today,
      { suppressAutoSend: true },
    )

    expect(inserted['invoices'][0]).toMatchObject({ default_dimensions: {} })
    const itemRows = inserted['invoice_items'][0] as Array<Record<string, unknown>>
    expect(itemRows.every((row) => JSON.stringify(row.dimensions) === '{}')).toBe(true)
  })
})
