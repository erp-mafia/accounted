import { describe, expect, it, vi } from 'vitest'
import type { PosDay } from '@accounted/connect-contract'
import {
  POS_CONNECT_PROTOCOL_ERROR,
  POS_CONNECT_UNCONFIGURED,
  POS_CONNECT_UNREACHABLE,
  PosConnectError,
  connectPosVenue,
  disconnectPosConnection,
  fetchPosDay,
  isPosConnectConfigured,
  listPosVenues,
} from '../connect-client'

const CONFIG = { baseUrl: 'https://connect.example.se', key: 'gnubok_ck_test_key_value_123456' }
const COMPANY = '7f1c2e3a-4b5d-4c6e-8f70-9a1b2c3d4e5f'

const DAY: PosDay = {
  businessDate: '2026-09-30',
  currency: 'SEK',
  sales: { net: 100, vat: 12, gross: 112 },
  vatGroups: [{ ratePercent: 12, net: 100, vat: 12, gross: 112 }],
  tenders: [{ kind: 'card', method: 'card', amount: 112, tips: 0, receiptCount: 1 }],
  tips: 0,
  discounts: 0,
  refunds: { count: 0, gross: 0 },
  receiptCount: 1,
  firstReceiptNumber: '1',
  lastReceiptNumber: '1',
  firstPaidAt: null,
  lastPaidAt: null,
  categories: [],
  receipts: [],
  issues: [],
}

function respond(status: number, body: unknown, headers: Record<string, string> = {}) {
  return vi.fn(async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers }))
}

describe('the POS Connect client', () => {
  it('posts to the pos family with the key, the company and the connection handle', async () => {
    const fetchImpl = respond(200, {
      provider: 'heynow',
      venueRef: '5550000000000001',
      day: DAY,
      raw: { contentType: 'application/json', body: '{}', sha256: 'a'.repeat(64) },
      fetchedAt: '2026-10-01T04:15:00Z',
    })
    const answer = await fetchPosDay(COMPANY, 'pos_handle_abcdefghijklmnop', '2026-09-30', { config: CONFIG, fetch: fetchImpl as unknown as typeof fetch })
    expect(answer.day.sales.gross).toBe(112)
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://connect.example.se/api/connect/pos/day')
    const headers = init.headers as Record<string, string>
    expect(headers.Authorization).toBe(`Bearer ${CONFIG.key}`)
    expect(headers['X-Connector-Company']).toBe(COMPANY)
    expect(headers['X-Connector-Connection']).toBe('pos_handle_abcdefghijklmnop')
    expect(JSON.parse(init.body as string)).toEqual({ businessDate: '2026-09-30' })
    expect(init.redirect).toBe('error')
  })

  it('sends the organisation number, never a typed venue alone, when listing and connecting', async () => {
    const venues = respond(200, { venues: [], providers: [], serverTime: '2026-10-01T00:00:00Z' })
    await listPosVenues(COMPANY, '5566778899', { config: CONFIG, fetch: venues as unknown as typeof fetch })
    expect(JSON.parse((venues.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)).toEqual({ orgNumber: '5566778899' })

    const connect = respond(200, {
      connectionHandle: 'pos_' + 'x'.repeat(40),
      provider: { ref: 'heynow', displayName: 'Heynow', legalName: null, portalUrl: null, supportUrl: null, accessRequestSv: null },
      venueRef: '5550000000000001',
      venueName: 'Restaurang Exempel',
      connectedAt: '2026-10-01T00:00:00Z',
    })
    const connection = await connectPosVenue(
      COMPANY,
      { provider: 'heynow', venueRef: '5550000000000001', orgNumber: '5566778899' },
      { config: CONFIG, fetch: connect as unknown as typeof fetch },
    )
    expect(connection.venueName).toBe('Restaurang Exempel')
    const headers = (connect.mock.calls[0] as unknown as [string, RequestInit])[1].headers as Record<string, string>
    expect(headers['X-Connector-Connection']).toBeUndefined()
  })

  it('carries the service code, the retry hint and Retry-After from an error envelope', async () => {
    const fetchImpl = respond(
      429,
      { error: 'wait', code: 'CONNECTOR_POS_PROVIDER_RATE_LIMITED', retryable: true },
      { 'retry-after': '1200' },
    )
    const err = await fetchPosDay(COMPANY, 'pos_handle_abcdefghijklmnop', '2026-09-30', { config: CONFIG, fetch: fetchImpl as unknown as typeof fetch }).catch((e) => e)
    expect(err).toBeInstanceOf(PosConnectError)
    expect(err).toMatchObject({ code: 'CONNECTOR_POS_PROVIDER_RATE_LIMITED', status: 429, retryable: true, retryAfterSec: 1200 })
  })

  it('answers HTTP_<status> for a body that is not an envelope, retryable on 5xx', async () => {
    const err = await disconnectPosConnection(COMPANY, 'pos_handle_abcdefghijklmnop', { config: CONFIG, fetch: respond(503, '<html>') as unknown as typeof fetch }).catch((e) => e)
    expect(err).toMatchObject({ code: 'HTTP_503', retryable: true })
  })

  it('refuses an answer that breaks the contract instead of using it', async () => {
    const err = await fetchPosDay(COMPANY, 'pos_handle_abcdefghijklmnop', '2026-09-30', {
      config: CONFIG,
      fetch: respond(200, { day: { ...DAY, currency: 'sek' } }) as unknown as typeof fetch,
    }).catch((e) => e)
    expect(err).toMatchObject({ code: POS_CONNECT_PROTOCOL_ERROR, retryable: false })
  })

  it('reports an unreachable service as retryable', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('fetch failed')
    })
    const err = await listPosVenues(COMPANY, '5566778899', { config: CONFIG, fetch: fetchImpl as unknown as typeof fetch }).catch((e) => e)
    expect(err).toMatchObject({ code: POS_CONNECT_UNREACHABLE, retryable: true })
  })

  it('is unavailable without a connector key, and refuses a plain-http origin', async () => {
    expect(isPosConnectConfigured({ config: null })).toBe(false)
    expect(isPosConnectConfigured({ config: CONFIG })).toBe(true)
    await expect(listPosVenues(COMPANY, '5566778899', { config: null })).rejects.toMatchObject({ code: POS_CONNECT_UNCONFIGURED })
    const fetchImpl = respond(200, {})
    await expect(
      listPosVenues(COMPANY, '5566778899', { config: { ...CONFIG, baseUrl: 'http://connect.example.se' }, fetch: fetchImpl as unknown as typeof fetch }),
    ).rejects.toMatchObject({ code: POS_CONNECT_UNCONFIGURED })
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
