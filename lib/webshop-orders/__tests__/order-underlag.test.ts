import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createMockSupabase } from '@/tests/helpers'
import type { WebshopOrder } from '@/types'
import type { Logger } from '@/lib/logger'

const mockUploadDocument = vi.fn()
vi.mock('@/lib/core/documents/document-service', () => ({
  uploadDocument: (...args: unknown[]) => mockUploadDocument(...args),
}))

import {
  buildOrderUnderlagModel,
  orderUnderlagFilename,
  archiveWebshopOrderUnderlag,
  formatAmount,
} from '../order-underlag'

function makeOrder(overrides: Partial<WebshopOrder> = {}): WebshopOrder {
  return {
    id: 'order-1',
    company_id: 'company-1',
    user_id: 'user-1',
    platform: 'woocommerce',
    store_scope: 'butik.example.se',
    store_label: 'Butiken',
    connection_id: null,
    row_type: 'order',
    parent_order_id: null,
    external_id: 'woo_butik.example.se_order_1001',
    platform_order_id: '1001',
    order_number: '1001',
    status: 'processing',
    is_paid: true,
    order_date: '2026-08-01',
    paid_date: '2026-08-01',
    currency: 'SEK',
    total: 500,
    total_tax: 100,
    total_sek: 500,
    exchange_rate: 1,
    vat_breakdown: [{ rate: 25, net: 400, tax: 100 }],
    line_items: [
      { name: 'Kaffekopp', quantity: 2, total: 300, total_tax: 75, vat_rate: 25 },
      { name: 'Frakt', quantity: 1, total: 100, total_tax: 25, vat_rate: 25 },
    ],
    customer_name: 'Anna Andersson',
    customer_company: null,
    customer_email: 'anna@example.se',
    customer_orgnr: null,
    customer_country: 'SE',
    payment_method: 'swish',
    payment_method_title: 'Swish',
    gateway_reference: 'SW-123',
    refunded_total: 0,
    journal_entry_id: null,
    invoice_id: null,
    legacy_transaction_id: null,
    manually_booked_at: null,
    manually_booked_by: null,
    manually_booked_journal_entry_id: null,
    remote_changed_after_freeze: false,
    created_at: '2026-08-01T00:00:00Z',
    updated_at: '2026-08-01T00:00:00Z',
    ...overrides,
  }
}

const log = {
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger

describe('buildOrderUnderlagModel', () => {
  it('maps line items, customer, payment method and per-rate totals', () => {
    const model = buildOrderUnderlagModel(makeOrder())
    expect(model.title).toBe('Orderunderlag')
    expect(model.orderNumber).toBe('1001')
    expect(model.platformLabel).toBe('WooCommerce')
    expect(model.storeLabel).toBe('Butiken')
    expect(model.lines).toEqual([
      { name: 'Kaffekopp', quantity: 2, net: 300, tax: 75, vatRateLabel: '25%' },
      { name: 'Frakt', quantity: 1, net: 100, tax: 25, vatRateLabel: '25%' },
    ])
    expect(model.customerLines).toEqual(['Anna Andersson', 'anna@example.se', 'Land: SE'])
    expect(model.paymentMethod).toBe('Swish')
    expect(model.gatewayReference).toBe('SW-123')
    expect(model.vatRows).toEqual([{ rateLabel: '25%', net: 400, tax: 100, gross: 500 }])
    expect(model.totalNet).toBe(400)
    expect(model.totalTax).toBe(100)
    expect(model.totalGross).toBe(500)
    // SEK order: no conversion facts.
    expect(model.totalSek).toBeNull()
    expect(model.exchangeRate).toBeNull()
  })

  it('keeps every rate on a multi-rate order', () => {
    const model = buildOrderUnderlagModel(
      makeOrder({
        total: 456,
        total_tax: 68,
        vat_breakdown: [
          { rate: 25, net: 200, tax: 50 },
          { rate: 12, net: 150, tax: 18 },
          { rate: 0, net: 38, tax: 0 },
        ],
      }),
    )
    expect(model.vatRows).toEqual([
      { rateLabel: '25%', net: 200, tax: 50, gross: 250 },
      { rateLabel: '12%', net: 150, tax: 18, gross: 168 },
      { rateLabel: '0%', net: 38, tax: 0, gross: 38 },
    ])
    expect(model.totalNet).toBe(388)
  })

  it('rounds öre amounts and never emits float drift', () => {
    const model = buildOrderUnderlagModel(
      makeOrder({
        total: 100.3,
        total_tax: 20.06,
        vat_breakdown: [{ rate: 25, net: 80.239999999, tax: 20.060000001 }],
        line_items: [
          { name: 'Vara', quantity: 3, total: 80.239999999, total_tax: 20.060000001, vat_rate: 25 },
        ],
      }),
    )
    expect(model.lines[0].net).toBe(80.24)
    expect(model.lines[0].tax).toBe(20.06)
    expect(model.vatRows[0]).toEqual({ rateLabel: '25%', net: 80.24, tax: 20.06, gross: 100.3 })
    expect(model.totalNet).toBe(80.24)
  })

  it('handles a missing customer entirely', () => {
    const model = buildOrderUnderlagModel(
      makeOrder({
        customer_name: null,
        customer_company: null,
        customer_email: null,
        customer_country: null,
      }),
    )
    expect(model.customerLines).toEqual([])
  })

  it('puts the company name before the contact person', () => {
    const model = buildOrderUnderlagModel(
      makeOrder({ customer_company: 'Kund AB', customer_name: 'Anna Andersson' }),
    )
    expect(model.customerLines[0]).toBe('Kund AB')
    expect(model.customerLines[1]).toBe('Anna Andersson')
  })

  it('negates the stored positive breakdown magnitudes on refund rows', () => {
    const model = buildOrderUnderlagModel(
      makeOrder({
        row_type: 'refund',
        total: -500,
        total_tax: -100,
        vat_breakdown: [{ rate: 25, net: 400, tax: 100 }],
        line_items: [],
      }),
    )
    expect(model.title).toBe('Orderunderlag: återbetalning')
    expect(model.isRefund).toBe(true)
    expect(model.vatRows).toEqual([{ rateLabel: '25%', net: -400, tax: -100, gross: -500 }])
    expect(model.totalGross).toBe(-500)
    expect(model.totalNet).toBe(-400)
  })

  it('keeps signed buckets as stored on order rows (discount bucket)', () => {
    const model = buildOrderUnderlagModel(
      makeOrder({
        total: 375,
        total_tax: 75,
        vat_breakdown: [
          { rate: 25, net: 400, tax: 100 },
          { rate: 0, net: -100, tax: -25 },
        ],
      }),
    )
    expect(model.vatRows[1]).toEqual({ rateLabel: '0%', net: -100, tax: -25, gross: -125 })
  })

  it('falls back to the inferred single bucket when the breakdown is empty', () => {
    const model = buildOrderUnderlagModel(
      makeOrder({ vat_breakdown: [], total: 125, total_tax: 25 }),
    )
    expect(model.vatRows).toEqual([{ rateLabel: '25%', net: 100, tax: 25, gross: 125 }])
  })

  it('labels an unresolved line rate with a dash', () => {
    const model = buildOrderUnderlagModel(
      makeOrder({
        line_items: [{ name: 'Vara', quantity: 1, total: 100, total_tax: 0, vat_rate: null }],
      }),
    )
    expect(model.lines[0].vatRateLabel).toBe('-')
  })

  it('carries the SEK conversion facts on non-SEK orders', () => {
    const model = buildOrderUnderlagModel(
      makeOrder({ currency: 'EUR', total: 50, total_tax: 10, total_sek: 561.5, exchange_rate: 11.23 }),
    )
    expect(model.currency).toBe('EUR')
    expect(model.totalSek).toBe(561.5)
    expect(model.exchangeRate).toBe(11.23)
  })
})

describe('formatAmount', () => {
  it('renders negatives with an ASCII hyphen, never U+2212 (WinAnsi PDF fonts drop it)', () => {
    const formatted = formatAmount(-500)
    // sv-SE Intl emits U+2212 MINUS SIGN; Helvetica/WinAnsi has no glyph for
    // it, so an unguarded refund amount would silently render as positive in
    // the archived underlag (skeptic finding).
    expect(formatted.includes(String.fromCharCode(0x2212))).toBe(false)
    expect(formatted.startsWith('-')).toBe(true)
    expect(formatted.endsWith('500,00')).toBe(true)
  })

  it('formats two decimals with a Swedish decimal comma', () => {
    expect(formatAmount(80.24).endsWith('80,24')).toBe(true)
    expect(formatAmount(0)).toBe('0,00')
  })
})

describe('orderUnderlagFilename', () => {
  it('names order and refund underlag distinctly', () => {
    expect(
      orderUnderlagFilename({ isRefund: false, orderNumber: '1001', orderDate: '2026-08-01' }),
    ).toBe('Orderunderlag_1001_2026-08-01.pdf')
    expect(
      orderUnderlagFilename({ isRefund: true, orderNumber: '1001', orderDate: '2026-08-05' }),
    ).toBe('Orderunderlag_aterbetalning_1001_2026-08-05.pdf')
  })
})

describe('archiveWebshopOrderUnderlag', () => {
  const { supabase: supabaseMock, mockResult } = createMockSupabase()
  const supabase = supabaseMock as unknown as SupabaseClient

  beforeEach(() => {
    vi.clearAllMocks()
    mockResult({ data: { company_name: 'Testbolag AB', org_number: '556677-8899' } })
    mockUploadDocument.mockResolvedValue({ id: 'doc-1' })
  })

  it('renders a PDF and archives it anchored to the verifikat', async () => {
    const result = await archiveWebshopOrderUnderlag({
      supabase,
      companyId: 'company-1',
      userId: 'user-1',
      order: makeOrder(),
      journalEntryId: 'je-1',
      log,
    })
    expect(result).toEqual({ ok: true, documentId: 'doc-1' })
    expect(mockUploadDocument).toHaveBeenCalledTimes(1)
    const [, userId, companyId, file, metadata] = mockUploadDocument.mock.calls[0]
    expect(userId).toBe('user-1')
    expect(companyId).toBe('company-1')
    expect(file.name).toBe('Orderunderlag_1001_2026-08-01.pdf')
    expect(file.type).toBe('application/pdf')
    // Real render: the buffer must actually be a PDF.
    const head = Buffer.from(file.buffer as ArrayBuffer).subarray(0, 5).toString('utf8')
    expect(head).toBe('%PDF-')
    expect(metadata).toMatchObject({
      upload_source: 'system',
      journal_entry_id: 'je-1',
      extractionOwner: 'none',
    })
  })

  it('returns ok=false and logs instead of throwing when the archive fails', async () => {
    mockUploadDocument.mockRejectedValueOnce(new Error('storage down'))
    const result = await archiveWebshopOrderUnderlag({
      supabase,
      companyId: 'company-1',
      userId: 'user-1',
      order: makeOrder(),
      journalEntryId: 'je-1',
      log,
    })
    expect(result).toEqual({ ok: false, documentId: null })
    expect(log.error).toHaveBeenCalled()
  })

  it('renders without customer data and without company settings', async () => {
    mockResult({ data: null })
    const result = await archiveWebshopOrderUnderlag({
      supabase,
      companyId: 'company-1',
      userId: 'user-1',
      order: makeOrder({
        customer_name: null,
        customer_company: null,
        customer_email: null,
        customer_country: null,
        line_items: [],
      }),
      journalEntryId: 'je-1',
      log,
    })
    expect(result.ok).toBe(true)
  })
})
