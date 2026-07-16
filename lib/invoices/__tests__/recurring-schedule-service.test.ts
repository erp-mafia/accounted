import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  computeNextRunDate,
  computeInitialRunDate,
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
vi.mock('@/lib/email/service', () => ({
  getEmailService: () => ({
    sendEmail: (...args: unknown[]) => mockSendEmail(...args),
    isConfigured: () => mockIsConfigured(),
  }),
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

  const customer = makeCustomer({ id: 'cust-1', email: 'kund@test.se' })
  const company = makeCompanySettings({ accounting_method: 'accrual' })

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
  })

  it('a payment link failure never blocks the send', async () => {
    enqueueHappyPath()
    mockApplyPaymentLink.mockResolvedValue({ failure: 'Stripe nere' })

    const result = await executeRecurringSchedule(client, makeSchedule(), today)

    expect(result.autoSent).toBe(true)
    expect(result.warning).toBeNull()
    expect(mockSendEmail).toHaveBeenCalledTimes(1)
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
