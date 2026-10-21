import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'
import { createMockRequest, createMockRouteParams, createQueuedMockSupabase, parseJsonResponse } from '@/tests/helpers'

const { supabase: mockSupabase, enqueueMany, findCall, findCalls, reset } = createQueuedMockSupabase()

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({ requireAuth: (...args: unknown[]) => requireAuthMock(...args) }))
vi.mock('@/lib/company/context', () => ({
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))
const requireWriteMock = vi.fn()
vi.mock('@/lib/auth/require-write', () => ({ requireWritePermission: (...args: unknown[]) => requireWriteMock(...args) }))

import { GET, POST } from '../route'

const TX_ID = '6f1c2a40-0000-4000-8000-0000000000b2'

const TELIA_ROW = {
  id: 'p-telia',
  counterparty_key: 'telia sverige',
  vendor_name: 'Telia',
  url: 'https://minasidor.telia.se/foretag',
  created_at: '2026-10-20T10:00:00Z',
  updated_at: '2026-10-20T10:00:00Z',
}

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  requireAuthMock.mockResolvedValue({ user: { id: 'user-1', email: 'a@b.se' }, supabase: mockSupabase, error: null })
  requireWriteMock.mockResolvedValue({ ok: true })
})

const post = (body: unknown) => POST(createMockRequest('/api/inkorg/portals', { method: 'POST', body }), createMockRouteParams({}))
const unauthenticated = () =>
  requireAuthMock.mockResolvedValue({
    user: null,
    supabase: mockSupabase,
    error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
  })

describe('GET /api/inkorg/portals', () => {
  it('returns 401 when not authenticated', async () => {
    unauthenticated()
    expect((await GET(createMockRequest('/api/inkorg/portals'), createMockRouteParams({}))).status).toBe(401)
    expect(findCalls('company_portals', 'select')).toHaveLength(0)
  })

  it("lists the company's own portals by name, read for the active company", async () => {
    enqueueMany([{ data: [TELIA_ROW, { ...TELIA_ROW, id: 'p-e', counterparty_key: 'ellevio', vendor_name: 'Ellevio' }] }])
    const { status, body } = await parseJsonResponse<{ data: { vendor_name: string }[] }>(
      await GET(createMockRequest('/api/inkorg/portals'), createMockRouteParams({})),
    )
    expect(status).toBe(200)
    expect(body.data.map((p) => p.vendor_name)).toEqual(['Ellevio', 'Telia'])
    expect(findCall('company_portals', 'eq')).toEqual(['company_id', 'company-1'])
  })
})

describe('POST /api/inkorg/portals', () => {
  it('returns 401 when not authenticated, and writes nothing', async () => {
    unauthenticated()
    expect((await post({ transaction_id: TX_ID, url: 'minasidor.telia.se' })).status).toBe(401)
    expect(findCalls('company_portals', 'insert')).toHaveLength(0)
  })

  it('refuses a viewer', async () => {
    requireWriteMock.mockResolvedValue({ ok: false, response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) })
    expect((await post({ transaction_id: TX_ID, url: 'minasidor.telia.se' })).status).toBe(403)
    expect(findCalls('company_portals', 'insert')).toHaveLength(0)
  })

  it('returns 400 without a purchase, with a purchase id that is not a uuid, or without a link', async () => {
    expect((await post({ url: 'minasidor.telia.se' })).status).toBe(400)
    expect((await post({ transaction_id: 'tx-1', url: 'minasidor.telia.se' })).status).toBe(400)
    expect((await post({ transaction_id: TX_ID, url: '   ' })).status).toBe(400)
    // The client never names the supplier: a key it sends is not read.
    expect(findCalls('transactions', 'select')).toHaveLength(0)
  })

  it('returns 400 INKORG_PORTAL_URL_INVALID for a link the rule refuses, before reading anything', async () => {
    for (const url of ['javascript:alert(1)', 'http://minasidor.telia.se', 'https://user:pass@minasidor.telia.se', 'localhost']) {
      const { status, body } = await parseJsonResponse<{ error: { code: string; message: string } }>(
        await post({ transaction_id: TX_ID, url }),
      )
      expect(status, url).toBe(400)
      expect(body.error.code).toBe('INKORG_PORTAL_URL_INVALID')
      expect(body.error.message).toContain('Länken')
    }
    expect(findCalls('transactions', 'select')).toHaveLength(0)
  })

  it('returns 404 when the purchase is not the company\'s', async () => {
    enqueueMany([{ data: null }])
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(
      await post({ transaction_id: TX_ID, url: 'minasidor.telia.se' }),
    )
    expect(status).toBe(404)
    expect(body.error.code).toBe('INKORG_PORTAL_PURCHASE_NOT_FOUND')
    expect(findCalls('transactions', 'eq')).toEqual(expect.arrayContaining([['company_id', 'company-1'], ['id', TX_ID]]))
    expect(findCalls('company_portals', 'insert')).toHaveLength(0)
  })

  it('returns 422 for salary, tax and a bank row that names nobody', async () => {
    for (const description of ['Lön Juli Jakob', 'Skatt lön Juni BG 0000050501055', 'INTERNET BET 4']) {
      reset()
      enqueueMany([{ data: { id: TX_ID, merchant_name: null, description } }])
      const { status, body } = await parseJsonResponse<{ error: { code: string } }>(
        await post({ transaction_id: TX_ID, url: 'minasidor.telia.se' }),
      )
      expect(status, description).toBe(422)
      expect(body.error.code).toBe('INKORG_PORTAL_NO_SUPPLIER')
      expect(findCalls('company_portals', 'insert')).toHaveLength(0)
    }
  })

  it('stores the portal under the purchase\'s own supplier, with the link as the rule leaves it', async () => {
    enqueueMany([{ data: { id: TX_ID, merchant_name: null, description: 'TELIA SVERIGE AB' } }, { data: TELIA_ROW }])
    const { status, body } = await parseJsonResponse<{ data: unknown }>(
      await post({ transaction_id: TX_ID, url: 'minasidor.telia.se/foretag?session=abc' }),
    )
    expect(status).toBe(200)
    expect(body.data).toEqual(TELIA_ROW)
    expect(findCall('company_portals', 'insert')).toEqual([
      {
        company_id: 'company-1',
        counterparty_key: 'telia sverige',
        vendor_name: 'Telia',
        url: 'https://minasidor.telia.se/foretag',
        created_by: 'user-1',
      },
    ])
  })

  it('names the supplier as the Inkorg shows the purchase, the merchant name first, without its legal form', async () => {
    enqueueMany([{ data: { id: TX_ID, merchant_name: 'ELLEVIO AB', description: 'ELLEVIO AB AUTOGIRO' } }, { data: TELIA_ROW }])
    await post({ transaction_id: TX_ID, url: 'https://www.ellevio.se/mina-sidor' })
    expect(findCall('company_portals', 'insert')?.[0]).toMatchObject({ counterparty_key: 'ellevio', vendor_name: 'Ellevio' })
  })

  it('changes the link of a supplier that has a portal already', async () => {
    enqueueMany([
      { data: { id: TX_ID, merchant_name: null, description: 'TELIA SVERIGE AB AUTOGIRO' } },
      { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint "company_portals_counterparty_key"' } },
      { data: { ...TELIA_ROW, url: 'https://www.telia.se/foretag/mitt-telia' } },
    ])
    const { status, body } = await parseJsonResponse<{ data: { url: string } }>(
      await post({ transaction_id: TX_ID, url: 'www.telia.se/foretag/mitt-telia' }),
    )
    expect(status).toBe(200)
    expect(body.data.url).toBe('https://www.telia.se/foretag/mitt-telia')
    expect(findCall('company_portals', 'update')).toEqual([{ url: 'https://www.telia.se/foretag/mitt-telia' }])
    expect(findCalls('company_portals', 'eq')).toEqual(
      expect.arrayContaining([['company_id', 'company-1'], ['counterparty_key', 'telia sverige']]),
    )
  })
})
