import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockRequest, createQueuedMockSupabase, parseJsonResponse } from '@/tests/helpers'

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

vi.mock('@/lib/auth/rate-limit-http', () => ({
  checkRateLimit: vi.fn().mockResolvedValue({ ok: true }),
}))

// The rules are unit-tested in lib/pos-sales; here the routes' envelopes:
// auth, validation, the outcome mapped to the dashboard shapes.
const svc = vi.hoisted(() => ({
  listPosConnections: vi.fn(),
  listAvailablePosVenues: vi.fn(),
  connectPosVenue: vi.fn(),
  disconnectPosConnection: vi.fn(),
  updatePosSalesSettings: vi.fn(),
  listPosSalesDays: vi.fn(),
  getPosSalesDay: vi.fn(),
  fetchPosSalesDays: vi.fn(),
  bookPosSalesDay: vi.fn(),
  syncPosConnection: vi.fn(),
}))
vi.mock('@/lib/pos-sales/service', () => ({
  listPosConnections: svc.listPosConnections,
  listAvailablePosVenues: svc.listAvailablePosVenues,
  connectPosVenue: svc.connectPosVenue,
  disconnectPosConnection: svc.disconnectPosConnection,
  updatePosSalesSettings: svc.updatePosSalesSettings,
  listPosSalesDays: svc.listPosSalesDays,
  getPosSalesDay: svc.getPosSalesDay,
  fetchPosSalesDays: svc.fetchPosSalesDays,
}))
vi.mock('@/lib/pos-sales/book-day', () => ({ bookPosSalesDay: svc.bookPosSalesDay }))
vi.mock('@/lib/pos-sales/sync', () => ({ syncPosConnection: svc.syncPosConnection }))
vi.mock('@/lib/auth/api-keys', () => ({ createServiceClientNoCookies: () => ({}) }))
vi.mock('next/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/server')>()),
  after: (fn: () => void | Promise<void>) => void fn(),
}))

import { GET as listConnections, POST as connect } from '../connections/route'
import { POST as disconnect } from '../connections/[id]/disconnect/route'
import { PATCH as updateSettings } from '../connections/[id]/settings/route'
import { GET as listVenues } from '../venues/route'
import { GET as listDays } from '../days/route'
import { GET as getDay } from '../days/[id]/route'
import { POST as bookDay } from '../days/[id]/book/route'
import { POST as fetchDays } from '../fetch/route'

const ID = '550e8400-e29b-41d4-a716-446655440000'
const NO_PARAMS = { params: Promise.resolve({}) }
const WITH_ID = { params: Promise.resolve({ id: ID }) }
const SHA = 'a'.repeat(64)

interface Envelope {
  data?: Record<string, unknown>
  error?: { code: string; message?: string }
}

const req = (url: string, method: string, body?: unknown) => createMockRequest(url, { method, ...(body === undefined ? {} : { body }) })

describe('/api/pos-sales routes', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: { id: 'user-1', email: 'test@test.se' } } })
  })

  it('answers 401 without a session on every route', async () => {
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: null } })
    const responses = await Promise.all([
      listConnections(req('/api/pos-sales/connections', 'GET'), NO_PARAMS),
      connect(req('/api/pos-sales/connections', 'POST', { provider: 'heynow', venue_ref: 'v' }), NO_PARAMS),
      disconnect(req(`/api/pos-sales/connections/${ID}/disconnect`, 'POST'), WITH_ID),
      updateSettings(req(`/api/pos-sales/connections/${ID}/settings`, 'PATCH', { settings: {} }), WITH_ID),
      listVenues(req('/api/pos-sales/venues', 'GET'), NO_PARAMS),
      listDays(req('/api/pos-sales/days', 'GET'), NO_PARAMS),
      getDay(req(`/api/pos-sales/days/${ID}`, 'GET'), WITH_ID),
      bookDay(req(`/api/pos-sales/days/${ID}/book`, 'POST', {}), WITH_ID),
      fetchDays(req('/api/pos-sales/fetch', 'POST', {}), NO_PARAMS),
    ])
    for (const response of responses) expect(response.status).toBe(401)
    for (const fn of Object.values(svc)) expect(fn).not.toHaveBeenCalled()
  })

  it('answers 400 for malformed input before any service runs', async () => {
    const responses = await Promise.all([
      connect(req('/api/pos-sales/connections', 'POST', { provider: 'heynow' }), NO_PARAMS),
      connect(req('/api/pos-sales/connections', 'POST', { provider: 'heynow', venue_ref: 'v', sync_from: '30/9' }), NO_PARAMS),
      updateSettings(req(`/api/pos-sales/connections/${ID}/settings`, 'PATCH', { settings: { tips_account: '28' } }), WITH_ID),
      updateSettings(req(`/api/pos-sales/connections/${ID}/settings`, 'PATCH', { settings: { auto_book: true } }), WITH_ID),
      listDays(req('/api/pos-sales/days?status=draft', 'GET'), NO_PARAMS),
      bookDay(req(`/api/pos-sales/days/${ID}/book`, 'POST', { expected_raw_sha256: 'short' }), WITH_ID),
      fetchDays(req('/api/pos-sales/fetch', 'POST', { business_dates: [] }), NO_PARAMS),
    ])
    for (const response of responses) expect(response.status).toBe(400)
    expect(svc.connectPosVenue).not.toHaveBeenCalled()
    expect(svc.updatePosSalesSettings).not.toHaveBeenCalled()
    expect(svc.bookPosSalesDay).not.toHaveBeenCalled()
  })

  it('answers 404 for a day or a connection the company does not have', async () => {
    svc.getPosSalesDay.mockResolvedValue({ ok: false, code: 'POS_DAY_NOT_FOUND' })
    svc.bookPosSalesDay.mockResolvedValue({ ok: false, code: 'POS_DAY_NOT_FOUND' })
    svc.disconnectPosConnection.mockResolvedValue({ ok: false, code: 'POS_CONNECTION_NOT_FOUND' })
    const day = await parseJsonResponse<Envelope>(await getDay(req(`/api/pos-sales/days/${ID}`, 'GET'), WITH_ID))
    expect(day.status).toBe(404)
    expect(day.body.error?.code).toBe('POS_DAY_NOT_FOUND')
    expect((await bookDay(req(`/api/pos-sales/days/${ID}/book`, 'POST', {}), WITH_ID)).status).toBe(404)
    expect((await disconnect(req(`/api/pos-sales/connections/${ID}/disconnect`, 'POST'), WITH_ID)).status).toBe(404)
  })

  it('books a day for the active company, pinning the reviewed version', async () => {
    svc.bookPosSalesDay.mockResolvedValue({
      ok: true,
      created: true,
      data: { journal_entry_id: 'je-1', voucher_series: 'F', voucher_number: 12, entry_date: '2026-09-30', business_date: '2026-09-30', gross: 112, underlag_document_id: 'doc-1' },
    })
    const { status, body } = await parseJsonResponse<Envelope>(
      await bookDay(req(`/api/pos-sales/days/${ID}/book`, 'POST', { expected_raw_sha256: SHA, acknowledge_issues: true }), WITH_ID),
    )
    expect(status).toBe(200)
    expect(body.data).toMatchObject({ journal_entry_id: 'je-1', voucher_series: 'F' })
    const [ctx, input] = svc.bookPosSalesDay.mock.calls[0] as [{ companyId: string; userId: string }, unknown]
    expect(ctx).toMatchObject({ companyId: 'company-1', userId: 'user-1' })
    expect(input).toEqual({ day_id: ID, expected_raw_sha256: SHA, acknowledge_issues: true })
  })

  it('maps a refused booking to its status and code', async () => {
    svc.bookPosSalesDay.mockResolvedValue({ ok: false, code: 'POS_DAY_CHANGED', details: { raw_sha256: 'b'.repeat(64) } })
    const { status, body } = await parseJsonResponse<Envelope>(await bookDay(req(`/api/pos-sales/days/${ID}/book`, 'POST', {}), WITH_ID))
    expect(status).toBe(409)
    expect(body.error?.code).toBe('POS_DAY_CHANGED')
  })

  it('connects a venue, answers 201, and starts the first fetch after the answer', async () => {
    svc.connectPosVenue.mockResolvedValue({ ok: true, created: true, data: { connection: { id: 'conn-1', venue_name: 'Restaurang Exempel' } } })
    svc.syncPosConnection.mockResolvedValue({ status: 'synced', fetched: [] })
    const response = await connect(
      req('/api/pos-sales/connections', 'POST', { provider: 'heynow', venue_ref: '5550000000000001', sync_from: '2026-09-30' }),
      NO_PARAMS,
    )
    expect(response.status).toBe(201)
    expect(svc.connectPosVenue.mock.calls[0][1]).toEqual({ provider: 'heynow', venue_ref: '5550000000000001', sync_from: '2026-09-30' })
    await vi.waitFor(() => expect(svc.syncPosConnection).toHaveBeenCalledWith(expect.anything(), 'conn-1', expect.anything()))
  })

  it('saves settings, lists days and connections, and fetches on request', async () => {
    svc.updatePosSalesSettings.mockResolvedValue({ ok: true, data: { connection_id: ID, settings: {}, reevaluated_days: 2 } })
    const saved = await parseJsonResponse<Envelope>(
      await updateSettings(req(`/api/pos-sales/connections/${ID}/settings`, 'PATCH', { settings: { revenue_accounts: { '0': '2421' } } }), WITH_ID),
    )
    expect(saved.status).toBe(200)
    expect(svc.updatePosSalesSettings.mock.calls[0][1]).toEqual({ connection_id: ID, settings: { revenue_accounts: { '0': '2421' } } })

    svc.listPosSalesDays.mockResolvedValue({ ok: true, data: { days: [], total: 0 } })
    expect((await listDays(req('/api/pos-sales/days?status=ready&limit=10', 'GET'), NO_PARAMS)).status).toBe(200)
    expect(svc.listPosSalesDays.mock.calls[0][1]).toEqual({ status: 'ready', limit: 10 })

    svc.listPosConnections.mockResolvedValue({ ok: true, data: { connections: [], available: true } })
    expect((await listConnections(req('/api/pos-sales/connections', 'GET'), NO_PARAMS)).status).toBe(200)

    svc.fetchPosSalesDays.mockResolvedValue({ ok: true, data: { results: [] } })
    expect((await fetchDays(req('/api/pos-sales/fetch', 'POST', { business_dates: ['2026-10-01'] }), NO_PARAMS)).status).toBe(200)
    expect(svc.fetchPosSalesDays.mock.calls[0][1]).toEqual({ business_dates: ['2026-10-01'] })
  })

  it('says Connect is missing with 503 rather than an empty venue list', async () => {
    svc.listAvailablePosVenues.mockResolvedValue({ ok: false, code: 'POS_CONNECT_UNCONFIGURED' })
    const { status, body } = await parseJsonResponse<Envelope>(await listVenues(req('/api/pos-sales/venues', 'GET'), NO_PARAMS))
    expect(status).toBe(503)
    expect(body.error?.code).toBe('POS_CONNECT_UNCONFIGURED')
  })
})
