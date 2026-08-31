import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createMockRequest, parseJsonResponse } from '@/tests/helpers'

const KEY = {
  id: '11111111-1111-4111-8111-111111111111',
  orgNumber: '5561234567',
  instanceUrl: null as string | null,
  scopes: ['bank_sync', 'skatteverket', 'org_lookup', 'migration'],
  status: 'active' as const,
  currentPeriodEnd: '2027-01-01T00:00:00.000Z',
}

type UpdateResult = { error: unknown; data: Array<{ instance_url: string | null }> | null }
const updateResults: UpdateResult[] = []
const updateSelect = vi.fn(() => Promise.resolve(updateResults.shift() ?? { error: null, data: [{ instance_url: null }] }))
const updateIs = vi.fn(() => ({ select: updateSelect }))
const updateEq = vi.fn(() => ({ is: updateIs, select: updateSelect }))
const update = vi.fn((_payload: Record<string, unknown>) => ({ eq: updateEq }))
const from = vi.fn(() => ({ update }))
const logWarn = vi.fn()

// The wrapper is exercised in its own test; here it is replaced by a
// pass-through that injects the validated key so the handler logic is what
// gets tested.
vi.mock('@/lib/connect/hosted/with-connector-auth', () => ({
  withConnectorAuth: (_op: string, handler: (req: Request, ctx: unknown) => Promise<Response>) => (req: Request) =>
    handler(req, {
      requestId: 'conn_test',
      log: { info: vi.fn(), warn: logWarn, error: vi.fn() },
      supabase: { from },
      key: { ...KEY, instanceUrl: currentInstanceUrl },
    }),
}))

let currentInstanceUrl: string | null = null

import { GET, POST } from '../route'

beforeEach(() => {
  vi.clearAllMocks()
  currentInstanceUrl = null
  updateResults.length = 0
})

describe('GET /api/connect/entitlements', () => {
  it('returns the key entitlements', async () => {
    const res = await GET(createMockRequest('/api/connect/entitlements'))
    const { status, body } = await parseJsonResponse<{ data: Record<string, unknown> }>(res)
    expect(status).toBe(200)
    expect(body.data).toMatchObject({
      status: 'active',
      scopes: KEY.scopes,
      current_period_end: KEY.currentPeriodEnd,
      org_number: '5561234567',
      instance_url: null,
    })
    expect(typeof body.data.server_time).toBe('string')
  })
})

describe('POST /api/connect/entitlements', () => {
  it('400 on an invalid report', async () => {
    const res = await POST(createMockRequest('/api/connect/entitlements', { method: 'POST', body: { active_company_count: -1 } }))
    expect(res.status).toBe(400)
    expect(update).not.toHaveBeenCalled()
  })

  it('records the active company count and pins instance_url on first report', async () => {
    const res = await POST(
      createMockRequest('/api/connect/entitlements', {
        method: 'POST',
        body: { active_company_count: 12, instance_url: 'https://bokforing.example.se', app_version: '1.2.3' },
      }),
    )
    const { status, body } = await parseJsonResponse<{ data: { instance_url: string | null } }>(res)
    expect(status).toBe(200)
    expect(from).toHaveBeenCalledWith('connector_keys')
    const payload = update.mock.calls[0][0]
    expect(payload).toMatchObject({ active_company_count: 12, instance_url: 'https://bokforing.example.se' })
    expect(typeof payload.last_synced_at).toBe('string')
    expect(updateEq).toHaveBeenCalledWith('id', KEY.id)
    expect(body.data.instance_url).toBe('https://bokforing.example.se')
  })

  // A leaked key must not be able to re-home the subscription.
  it('never moves a pinned instance_url; logs the mismatch', async () => {
    currentInstanceUrl = 'https://bokforing.example.se'
    const res = await POST(
      createMockRequest('/api/connect/entitlements', {
        method: 'POST',
        body: { active_company_count: 3, instance_url: 'https://evil.example.com' },
      }),
    )
    expect(res.status).toBe(200)
    const payload = update.mock.calls[0][0]
    expect(payload.instance_url).toBeUndefined()
    expect(logWarn).toHaveBeenCalled()
    const { body } = await parseJsonResponse<{ data: { instance_url: string | null } }>(res)
    expect(body.data.instance_url).toBe('https://bokforing.example.se')
  })

  it('500 when the update fails', async () => {
    updateResults.push({ error: { message: 'boom' }, data: null })
    const res = await POST(createMockRequest('/api/connect/entitlements', { method: 'POST', body: { active_company_count: 1 } }))
    expect(res.status).toBe(500)
  })

  // Two concurrent FIRST reports: the pinning update is conditional on
  // instance_url IS NULL, so the loser affects no row and must surface the
  // winner's pin instead of its own URL.
  it('losing the pin race keeps the first pin and reports it back', async () => {
    updateResults.push({ error: null, data: [] }) // conditional pin: no row matched
    updateResults.push({ error: null, data: [{ instance_url: 'https://first.example.se' }] }) // counter-only fallback
    const res = await POST(
      createMockRequest('/api/connect/entitlements', {
        method: 'POST',
        body: { active_company_count: 2, instance_url: 'https://second.example.se' },
      }),
    )
    const { status, body } = await parseJsonResponse<{ data: { instance_url: string | null } }>(res)
    expect(status).toBe(200)
    expect(body.data.instance_url).toBe('https://first.example.se')
    expect(logWarn).toHaveBeenCalled()
    expect(update).toHaveBeenCalledTimes(2)
    expect(update.mock.calls[1][0]).not.toHaveProperty('instance_url')
  })
})
