import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'
import { createMockRequest, createQueuedMockSupabase, parseJsonResponse } from '@/tests/helpers'
import { eventBus } from '@/lib/events'

const { supabase: mockSupabase, reset } = createQueuedMockSupabase()

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve(mockSupabase),
}))

vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: vi.fn().mockResolvedValue({ ok: true }),
}))

vi.mock('@/lib/company/context', () => ({
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

// getRedis: the provider rate limiter reached through the routes calls it when
// its module loads; null means the in-memory fallback, as with no Upstash.
vi.mock('@/lib/auth/rate-limit-http', () => ({
  checkRateLimit: vi.fn().mockResolvedValue({ ok: true }),
  getRedis: vi.fn(() => null),
}))

vi.mock('@/lib/auth/oauth-flows', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/oauth-flows')>()),
  resolveOAuthOrigin: vi.fn(async () => 'https://byra.example.se'),
}))

// The rules are unit-tested in lib/spend; here the routes' envelopes: auth,
// write permission, validation, rate limits, the outcome mapped to the
// dashboard shapes.
const svc = vi.hoisted(() => ({
  listSpendConnections: vi.fn(),
  listAvailableSpendProviders: vi.fn(),
  startSpendConnect: vi.fn(),
  connectSpendWithApiKey: vi.fn(),
  disconnectSpendConnection: vi.fn(),
  updateSpendSettings: vi.fn(),
  listSpendItems: vi.fn(),
  getSpendItem: vi.fn(),
  fetchSpendNow: vi.fn(),
  bookSpendItem: vi.fn(),
  bookSpendItems: vi.fn(),
  syncSpendConnection: vi.fn(),
}))
vi.mock('@/lib/spend/service', () => ({
  listSpendConnections: svc.listSpendConnections,
  listAvailableSpendProviders: svc.listAvailableSpendProviders,
  startSpendConnect: svc.startSpendConnect,
  connectSpendWithApiKey: svc.connectSpendWithApiKey,
  disconnectSpendConnection: svc.disconnectSpendConnection,
  updateSpendSettings: svc.updateSpendSettings,
  listSpendItems: svc.listSpendItems,
  getSpendItem: svc.getSpendItem,
  fetchSpendNow: svc.fetchSpendNow,
  spendConnectDeps: () => ({}),
}))
vi.mock('@/lib/spend/book-item', () => ({ bookSpendItem: svc.bookSpendItem, bookSpendItems: svc.bookSpendItems }))
vi.mock('@/lib/spend/sync', () => ({ syncSpendConnection: svc.syncSpendConnection }))
vi.mock('@/lib/auth/api-keys', () => ({ createServiceClientNoCookies: () => ({}) }))
vi.mock('next/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/server')>()),
  after: (fn: () => void | Promise<void>) => void fn(),
}))

import { requireWritePermission } from '@/lib/auth/require-write'
import { checkRateLimit } from '@/lib/auth/rate-limit-http'
import { GET as listConnections, POST as connect } from '../connections/route'
import { POST as connectKey } from '../connections/key/route'
import { PATCH as updateSettings } from '../connections/[id]/settings/route'
import { POST as disconnect } from '../connections/[id]/disconnect/route'
import { GET as listProviders } from '../providers/route'
import { POST as fetchNow } from '../fetch/route'
import { GET as listItems } from '../items/route'
import { GET as getItem } from '../items/[id]/route'
import { POST as bookItem } from '../items/[id]/book/route'
import { POST as bookItems } from '../items/book/route'

const ID = '550e8400-e29b-41d4-a716-446655440000'
const ID_2 = '550e8400-e29b-41d4-a716-446655440001'
const NO_PARAMS = { params: Promise.resolve({}) }
const WITH_ID = { params: Promise.resolve({ id: ID }) }
const SHA = 'a'.repeat(64)

interface Envelope {
  data?: Record<string, unknown>
  warnings?: Array<{ code: string }>
  error?: { code: string; message?: string }
}

const req = (url: string, method: string, body?: unknown) => createMockRequest(url, { method, ...(body === undefined ? {} : { body }) })

/** Every write route with a valid body: the ones requireWrite and the service guard. */
const writes = () => [
  connect(req('/api/spend/connections', 'POST', { provider: 'pleo' }), NO_PARAMS),
  connectKey(req('/api/spend/connections/key', 'POST', { provider: 'pleo', api_key: 'pleo_live_key_0123456789' }), NO_PARAMS),
  updateSettings(req(`/api/spend/connections/${ID}/settings`, 'PATCH', { settings: { wallet_account: '1940' } }), WITH_ID),
  disconnect(req(`/api/spend/connections/${ID}/disconnect`, 'POST'), WITH_ID),
  fetchNow(req('/api/spend/fetch', 'POST', {}), NO_PARAMS),
  bookItem(req(`/api/spend/items/${ID}/book`, 'POST', {}), WITH_ID),
  bookItems(req('/api/spend/items/book', 'POST', { item_ids: [ID] }), NO_PARAMS),
]

const reads = () => [
  listConnections(req('/api/spend/connections', 'GET'), NO_PARAMS),
  listProviders(req('/api/spend/providers', 'GET'), NO_PARAMS),
  listItems(req('/api/spend/items', 'GET'), NO_PARAMS),
  getItem(req(`/api/spend/items/${ID}`, 'GET'), WITH_ID),
]

describe('/api/spend routes', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    eventBus.clear()
    reset()
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: { id: 'user-1', email: 'test@test.se' } } })
    vi.mocked(requireWritePermission).mockResolvedValue({ ok: true })
    vi.mocked(checkRateLimit).mockResolvedValue({ ok: true })
  })

  it('answers 401 without a session on every route', async () => {
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: null } })
    const responses = await Promise.all([...writes(), ...reads()])
    for (const response of responses) expect(response.status).toBe(401)
    for (const fn of Object.values(svc)) expect(fn).not.toHaveBeenCalled()
  })

  it('answers 403 on every write for a member who may only read, and still serves the reads', async () => {
    vi.mocked(requireWritePermission).mockImplementation(async () => ({
      ok: false,
      response: NextResponse.json({ error: 'Du har endast läsbehörighet i detta företag.' }, { status: 403 }),
    }))
    svc.listSpendConnections.mockResolvedValue({ ok: true, data: { connections: [], available: true } })
    svc.listAvailableSpendProviders.mockResolvedValue({ ok: true, data: { providers: [] } })
    svc.listSpendItems.mockResolvedValue({ ok: true, data: { items: [], total: 0 } })
    svc.getSpendItem.mockResolvedValue({ ok: true, data: { item: { id: ID } } })
    for (const response of await Promise.all(writes())) expect(response.status).toBe(403)
    for (const fn of [svc.startSpendConnect, svc.connectSpendWithApiKey, svc.updateSpendSettings, svc.disconnectSpendConnection, svc.fetchSpendNow, svc.bookSpendItem, svc.bookSpendItems]) {
      expect(fn).not.toHaveBeenCalled()
    }
    for (const response of await Promise.all(reads())) expect(response.status).toBe(200)
  })

  it('answers 400 for malformed input before any service runs', async () => {
    const responses = await Promise.all([
      connect(req('/api/spend/connections', 'POST', {}), NO_PARAMS),
      connectKey(req('/api/spend/connections/key', 'POST', { provider: 'pleo', api_key: 'short' }), NO_PARAMS),
      updateSettings(req(`/api/spend/connections/${ID}/settings`, 'PATCH', { settings: { wallet_account: '2820' } }), WITH_ID),
      updateSettings(req(`/api/spend/connections/${ID}/settings`, 'PATCH', { settings: { auto_book: true } }), WITH_ID),
      listItems(req('/api/spend/items?status=draft', 'GET'), NO_PARAMS),
      listItems(req('/api/spend/items?from=2026-13-45', 'GET'), NO_PARAMS),
      listItems(req('/api/spend/items?limit=500', 'GET'), NO_PARAMS),
      bookItem(req(`/api/spend/items/${ID}/book`, 'POST', { expected_raw_sha256: 'short' }), WITH_ID),
      bookItem(req(`/api/spend/items/${ID}/book`, 'POST', { debit_account: '19' }), WITH_ID),
      bookItems(req('/api/spend/items/book', 'POST', { item_ids: [] }), NO_PARAMS),
      bookItems(req('/api/spend/items/book', 'POST', { item_ids: ['not-a-uuid'] }), NO_PARAMS),
      bookItems(
        req('/api/spend/items/book', 'POST', { item_ids: Array.from({ length: 51 }, (_, i) => `550e8400-e29b-41d4-a716-${String(i).padStart(12, '0')}`) }),
        NO_PARAMS,
      ),
      fetchNow(req('/api/spend/fetch', 'POST', { connection_id: 'nope' }), NO_PARAMS),
    ])
    for (const response of responses) expect(response.status).toBe(400)
    for (const fn of Object.values(svc)) expect(fn).not.toHaveBeenCalled()
  })

  it('answers 404 for an expense or a connection the company does not have', async () => {
    svc.getSpendItem.mockResolvedValue({ ok: false, code: 'SPEND_ITEM_NOT_FOUND', details: { item_id: ID } })
    svc.bookSpendItem.mockResolvedValue({ ok: false, code: 'SPEND_ITEM_NOT_FOUND', details: { item_id: ID } })
    svc.disconnectSpendConnection.mockResolvedValue({ ok: false, code: 'SPEND_CONNECTION_NOT_FOUND' })
    svc.updateSpendSettings.mockResolvedValue({ ok: false, code: 'SPEND_CONNECTION_NOT_FOUND' })
    const item = await parseJsonResponse<Envelope>(await getItem(req(`/api/spend/items/${ID}`, 'GET'), WITH_ID))
    expect(item.status).toBe(404)
    expect(item.body.error?.code).toBe('SPEND_ITEM_NOT_FOUND')
    expect((await bookItem(req(`/api/spend/items/${ID}/book`, 'POST', {}), WITH_ID)).status).toBe(404)
    expect((await disconnect(req(`/api/spend/connections/${ID}/disconnect`, 'POST'), WITH_ID)).status).toBe(404)
    expect((await updateSettings(req(`/api/spend/connections/${ID}/settings`, 'PATCH', { settings: {} }), WITH_ID)).status).toBe(404)
  })

  it('refuses a person retrying a key or a fetch too often, per company', async () => {
    vi.mocked(checkRateLimit).mockImplementation(async () => ({
      ok: false,
      response: NextResponse.json({ error: 'För många förfrågningar. Försök igen om en stund.' }, { status: 429 }),
    }))
    expect((await connectKey(req('/api/spend/connections/key', 'POST', { provider: 'pleo', api_key: 'pleo_live_key_0123456789' }), NO_PARAMS)).status).toBe(429)
    expect((await fetchNow(req('/api/spend/fetch', 'POST', {}), NO_PARAMS)).status).toBe(429)
    expect(svc.connectSpendWithApiKey).not.toHaveBeenCalled()
    expect(svc.fetchSpendNow).not.toHaveBeenCalled()
    expect(vi.mocked(checkRateLimit).mock.calls.map((call) => call[0])).toEqual([
      { prefix: 'spend:connect_key', identifier: 'company-1', maxRequests: 10, windowMs: 60 * 60 * 1000 },
      { prefix: 'spend:fetch', identifier: 'company-1', maxRequests: 12, windowMs: 60 * 60 * 1000 },
    ])
  })

  it('starts connecting with the origin the person started on, and answers the consent page with 201', async () => {
    svc.startSpendConnect.mockResolvedValue({
      ok: true,
      data: { connection_id: 'conn-1', authorize_url: 'https://auth.pleo.io/oauth/authorize?client_id=accounted' },
    })
    const { status, body } = await parseJsonResponse<Envelope>(await connect(req('/api/spend/connections', 'POST', { provider: 'pleo' }), NO_PARAMS))
    expect(status).toBe(201)
    expect(body.data).toEqual({ connection_id: 'conn-1', authorize_url: 'https://auth.pleo.io/oauth/authorize?client_id=accounted' })
    const [ctx, input] = svc.startSpendConnect.mock.calls[0] as [{ companyId: string; userId: string; supabase: unknown }, unknown]
    expect(ctx).toMatchObject({ companyId: 'company-1', userId: 'user-1' })
    expect(ctx.supabase).toBe(mockSupabase)
    expect(input).toEqual({ provider: 'pleo', return_origin: 'https://byra.example.se' })
  })

  it('connects with a key, answers 201, and starts the first fetch after the answer', async () => {
    svc.connectSpendWithApiKey.mockResolvedValue({ ok: true, created: true, data: { connection: { id: 'conn-1', provider: 'pleo' } } })
    svc.syncSpendConnection.mockResolvedValue({ connectionId: 'conn-1', status: 'synced', received: 0, rejected: 0 })
    const response = await connectKey(req('/api/spend/connections/key', 'POST', { provider: 'pleo', api_key: ' pleo_live_key_0123456789 ' }), NO_PARAMS)
    expect(response.status).toBe(201)
    expect(svc.connectSpendWithApiKey.mock.calls[0][1]).toEqual({ provider: 'pleo', api_key: 'pleo_live_key_0123456789' })
    await vi.waitFor(() => expect(svc.syncSpendConnection).toHaveBeenCalledWith(expect.anything(), 'conn-1', expect.anything()))
  })

  it('maps Connect missing to 503 and a refused connect to its status', async () => {
    svc.listAvailableSpendProviders.mockResolvedValue({ ok: false, code: 'SPEND_CONNECT_UNCONFIGURED' })
    const providers = await parseJsonResponse<Envelope>(await listProviders(req('/api/spend/providers', 'GET'), NO_PARAMS))
    expect(providers.status).toBe(503)
    expect(providers.body.error?.code).toBe('SPEND_CONNECT_UNCONFIGURED')
    svc.startSpendConnect.mockResolvedValue({ ok: false, code: 'SPEND_ALREADY_CONNECTED', details: { connection_id: 'conn-1' } })
    expect((await connect(req('/api/spend/connections', 'POST', { provider: 'pleo' }), NO_PARAMS)).status).toBe(409)
  })

  it('saves settings, disconnects with warnings, lists, and fetches on request', async () => {
    svc.updateSpendSettings.mockResolvedValue({ ok: true, data: { connection_id: ID, settings: { wallet_account: '1940', out_of_pocket_account: '2820' }, reevaluated_items: 2 } })
    const saved = await parseJsonResponse<Envelope>(
      await updateSettings(req(`/api/spend/connections/${ID}/settings`, 'PATCH', { settings: { wallet_account: '1940' } }), WITH_ID),
    )
    expect(saved.status).toBe(200)
    expect(saved.body.data).toMatchObject({ reevaluated_items: 2 })
    expect(svc.updateSpendSettings.mock.calls[0][1]).toEqual({ connection_id: ID, settings: { wallet_account: '1940' } })

    svc.disconnectSpendConnection.mockResolvedValue({
      ok: true,
      data: { connection_id: ID, status: 'disconnected' },
      warnings: [{ code: 'SPEND_DISCONNECT_REMOTE_FAILED', message_sv: 'x', message_en: 'x' }],
    })
    const ended = await parseJsonResponse<Envelope>(await disconnect(req(`/api/spend/connections/${ID}/disconnect`, 'POST'), WITH_ID))
    expect(ended.status).toBe(200)
    expect(ended.body).toMatchObject({ data: { status: 'disconnected' }, warnings: [{ code: 'SPEND_DISCONNECT_REMOTE_FAILED' }] })
    expect(svc.disconnectSpendConnection.mock.calls[0][1]).toEqual({ connection_id: ID })

    svc.listSpendConnections.mockResolvedValue({ ok: true, data: { connections: [], available: true } })
    expect((await listConnections(req('/api/spend/connections', 'GET'), NO_PARAMS)).status).toBe(200)
    // The settings page shows ended connections too.
    expect(svc.listSpendConnections.mock.calls[0][1]).toEqual({ include_ended: true })

    svc.listSpendItems.mockResolvedValue({ ok: true, data: { items: [], total: 0 } })
    expect((await listItems(req('/api/spend/items?status=ready&limit=10&from=2026-10-01', 'GET'), NO_PARAMS)).status).toBe(200)
    expect(svc.listSpendItems.mock.calls[0][1]).toEqual({ status: 'ready', limit: 10, from: '2026-10-01' })

    svc.getSpendItem.mockResolvedValue({ ok: true, data: { item: { id: ID }, proposal: { lines: [] }, reasons: [] } })
    expect((await getItem(req(`/api/spend/items/${ID}`, 'GET'), WITH_ID)).status).toBe(200)
    expect(svc.getSpendItem.mock.calls[0][1]).toEqual({ item_id: ID })

    svc.fetchSpendNow.mockResolvedValue({ ok: true, data: { results: [] } })
    expect((await fetchNow(req('/api/spend/fetch', 'POST', { connection_id: ID }), NO_PARAMS)).status).toBe(200)
    expect(svc.fetchSpendNow.mock.calls[0][1]).toEqual({ connection_id: ID })
  })

  it('books an expense for the active company, pinning the reviewed version', async () => {
    svc.bookSpendItem.mockResolvedValue({
      ok: true,
      created: true,
      data: { journal_entry_id: 'je-1', voucher_series: 'A', voucher_number: 7, entry_date: '2026-10-05', amount: 125, linked_documents: 0 },
      warnings: [{ code: 'SPEND_ITEM_RECEIPT_NOT_LINKED', message_sv: 'x', message_en: 'x' }],
    })
    const { status, body } = await parseJsonResponse<Envelope>(
      await bookItem(req(`/api/spend/items/${ID}/book`, 'POST', { expected_raw_sha256: SHA, acknowledge_review: true, debit_account: '1685' }), WITH_ID),
    )
    expect(status).toBe(200)
    expect(body).toMatchObject({ data: { journal_entry_id: 'je-1', voucher_series: 'A' }, warnings: [{ code: 'SPEND_ITEM_RECEIPT_NOT_LINKED' }] })
    const [ctx, input] = svc.bookSpendItem.mock.calls[0] as [{ companyId: string; userId: string }, unknown]
    expect(ctx).toMatchObject({ companyId: 'company-1', userId: 'user-1' })
    expect(input).toEqual({ item_id: ID, expected_raw_sha256: SHA, acknowledge_review: true, debit_account: '1685' })
  })

  it('maps a refused booking to its status and code', async () => {
    svc.bookSpendItem.mockResolvedValue({ ok: false, code: 'SPEND_ITEM_CHANGED', details: { raw_sha256: 'b'.repeat(64) } })
    const changed = await parseJsonResponse<Envelope>(await bookItem(req(`/api/spend/items/${ID}/book`, 'POST', {}), WITH_ID))
    expect(changed.status).toBe(409)
    expect(changed.body.error?.code).toBe('SPEND_ITEM_CHANGED')
    svc.bookSpendItem.mockResolvedValue({ ok: false, code: 'SPEND_DEBIT_ACCOUNT_REQUIRED' })
    expect((await bookItem(req(`/api/spend/items/${ID}/book`, 'POST', { acknowledge_review: true }), WITH_ID)).status).toBe(400)
  })

  it('books several expenses in one request', async () => {
    svc.bookSpendItems.mockResolvedValue({ ok: true, created: true, data: { booked: [{ item_id: ID }], failed: [{ item_id: ID_2, code: 'SPEND_ITEM_NOT_READY' }] } })
    const { status, body } = await parseJsonResponse<Envelope>(await bookItems(req('/api/spend/items/book', 'POST', { item_ids: [ID, ID_2] }), NO_PARAMS))
    expect(status).toBe(200)
    expect(body.data).toMatchObject({ booked: [{ item_id: ID }], failed: [{ item_id: ID_2 }] })
    expect(svc.bookSpendItems.mock.calls[0][1]).toEqual({ item_ids: [ID, ID_2] })
  })
})
