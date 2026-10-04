import { describe, expect, it } from 'vitest'
import {
  CONNECTOR_ERROR_CODES,
  POS_CONNECTION_HEADER,
  POS_SALES_BASE_PATH,
  POS_SALES_ERROR_CODES,
  POS_SALES_OPERATIONS,
  POS_SALES_SCOPE,
  POS_TENDER_KINDS,
  posConnectRequestSchema,
  posConnectionSchema,
  posDayResponseSchema,
  posDaySchema,
  posVenuesRequestSchema,
  posVenuesResponseSchema,
  type PosDay,
} from '../index'

const provider = {
  ref: 'acme-pos',
  displayName: 'Acme Kassa',
  legalName: 'Acme Kassa AB',
  portalUrl: 'https://acme-pos.example.com',
  supportUrl: null,
  accessRequestSv: 'Be Acme Kassa öppna API-åtkomst för Accounted.',
}

const day: PosDay = {
  businessDate: '2026-09-30',
  currency: 'SEK',
  sales: { net: 261.29, vat: 45.71, gross: 307 },
  vatGroups: [
    { ratePercent: 12, net: 150.89, vat: 18.11, gross: 169 },
    { ratePercent: 25, net: 110.4, vat: 27.6, gross: 138 },
  ],
  tenders: [
    { kind: 'card', method: 'card', amount: 189, tips: 20, receiptCount: 1 },
    { kind: 'swish', method: 'swish', amount: 138, tips: 0, receiptCount: 1 },
  ],
  tips: 20,
  discounts: 0,
  refunds: { count: 0, gross: 0 },
  receiptCount: 2,
  firstReceiptNumber: '108764998',
  lastReceiptNumber: '108764999',
  firstPaidAt: '2026-09-30T11:57:00.789329',
  lastPaidAt: '2026-09-30T11:57:07.411247',
  categories: [{ name: 'drink', quantity: 2, gross: 138, vat: 27.6 }],
  receipts: [
    { number: '108764998', kind: 'sale', paidAt: '2026-09-30T11:57:00.789329', method: 'swish', gross: 138, tips: 0 },
    { number: '108764999', kind: 'sale', paidAt: '2026-09-30T11:57:07.411247', method: 'card', gross: 169, tips: 20 },
  ],
  issues: [],
}

describe('POS sales family', () => {
  it('names its path, scope and connection header', () => {
    expect(POS_SALES_BASE_PATH).toBe('/api/connect/pos')
    expect(POS_SALES_SCOPE).toBe('pos_sales')
    expect(POS_CONNECTION_HEADER).toBe('X-Connector-Connection')
  })

  it('lists every operation with a method, path, company flag and schemas', () => {
    for (const [name, op] of Object.entries(POS_SALES_OPERATIONS)) {
      expect(op.path.startsWith('/'), name).toBe(true)
      expect(op.method).toBe('POST')
      expect(op.company, name).toBe(true)
      expect(typeof op.request.safeParse).toBe('function')
      expect(typeof op.response.safeParse).toBe('function')
    }
    expect(POS_SALES_OPERATIONS.day.connection).toBe(true)
    expect(POS_SALES_OPERATIONS.disconnect.connection).toBe(true)
    expect(POS_SALES_OPERATIONS.venues.connection).toBe(false)
    expect(POS_SALES_OPERATIONS.connect.connection).toBe(false)
  })

  it('keeps its error codes unique and apart from the shared list', () => {
    expect(new Set(POS_SALES_ERROR_CODES).size).toBe(POS_SALES_ERROR_CODES.length)
    const shared = new Set<string>(CONNECTOR_ERROR_CODES)
    for (const code of POS_SALES_ERROR_CODES) {
      if (code === 'CONNECTOR_CONNECTION_NOT_OWNED') continue
      expect(shared.has(code), code).toBe(false)
    }
  })

  it('accepts a day whose sums hold and the tender kinds it declares', () => {
    expect(posDaySchema.safeParse(day).success).toBe(true)
    expect(POS_TENDER_KINDS).toContain('card')
    expect(POS_TENDER_KINDS).toContain('other')
    const vatGross = day.vatGroups.reduce((sum, group) => sum + group.gross, 0)
    expect(vatGross).toBe(day.sales.gross)
    const tendered = day.tenders.reduce((sum, tender) => sum + tender.amount, 0)
    expect(tendered).toBe(day.sales.gross + day.tips)
  })

  it('refuses an unknown tender kind, a malformed date and a non-finite amount', () => {
    expect(posDaySchema.safeParse({ ...day, tenders: [{ ...day.tenders[0], kind: 'bitcoin' }] }).success).toBe(false)
    expect(posDaySchema.safeParse({ ...day, businessDate: '2026-02-30' }).success).toBe(false)
    expect(posDaySchema.safeParse({ ...day, tips: Number.POSITIVE_INFINITY }).success).toBe(false)
    expect(posDaySchema.safeParse({ ...day, currency: 'sek' }).success).toBe(false)
  })

  it('wraps the day with the verbatim provider answer and its hash', () => {
    const response = {
      provider: 'acme-pos',
      venueRef: '6081523749284167',
      day,
      raw: { contentType: 'application/json', body: '{"data":{}}', sha256: 'a'.repeat(64) },
      fetchedAt: '2026-10-01T04:00:00.000Z',
    }
    expect(posDayResponseSchema.safeParse(response).success).toBe(true)
    expect(posDayResponseSchema.safeParse({ ...response, raw: { ...response.raw, sha256: 'A'.repeat(64) } }).success).toBe(false)
  })

  it('asks for a ten-digit organisation number and never a typed venue alone', () => {
    expect(posVenuesRequestSchema.safeParse({ orgNumber: '5566778899' }).success).toBe(true)
    expect(posVenuesRequestSchema.safeParse({ orgNumber: '556677-8899' }).success).toBe(false)
    expect(posConnectRequestSchema.safeParse({ provider: 'acme-pos', venueRef: '6081523749284167' }).success).toBe(false)
    expect(
      posConnectRequestSchema.safeParse({ provider: 'acme-pos', venueRef: '6081523749284167', orgNumber: '5566778899' }).success,
    ).toBe(true)
  })

  it('round-trips the venue listing and the connection', () => {
    expect(
      posVenuesResponseSchema.safeParse({
        venues: [{ provider, venueRef: '6081523749284167', name: 'Restaurang Exempel', connected: false, available: true }],
        providers: [provider],
        serverTime: '2026-10-01T04:00:00.000Z',
      }).success,
    ).toBe(true)
    expect(
      posConnectionSchema.safeParse({
        connectionHandle: 'pos_' + 'x'.repeat(40),
        provider,
        venueRef: '6081523749284167',
        venueName: 'Restaurang Exempel',
        connectedAt: '2026-10-01T04:00:00.000Z',
      }).success,
    ).toBe(true)
    expect(posVenuesResponseSchema.safeParse({ venues: [], providers: [{ ...provider, portalUrl: 'http://acme.example.com' }], serverTime: 'x' }).success).toBe(false)
  })
})
