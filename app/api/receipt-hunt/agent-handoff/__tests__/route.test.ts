/**
 * The inbox button's route: signed-in only, and it answers with the connected
 * clients plus the same count the Att göra row shows.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createMockRequest, parseJsonResponse } from '@/tests/helpers'

const mockLoadClients = vi.fn()
vi.mock('@/lib/onboarding/ai-clients.server', () => ({
  loadConnectedAiClients: (...args: unknown[]) => mockLoadClients(...args),
}))

const mockCount = vi.fn()
vi.mock('@/lib/worklist/categories', () => ({
  countVerifikatMissingDocument: (...args: unknown[]) => mockCount(...args),
}))

const serviceClient = { service: true }
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => serviceClient,
}))

vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))

const context = {
  requestId: 'req-1',
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  user: { id: 'user-1' },
  supabase: { session: true },
  companyId: 'co-1',
}

let unauthorized = false
vi.mock('@/lib/api/with-route-context', () => ({
  withRouteContext: (_op: string, handler: (req: unknown, ctx: unknown) => unknown) => {
    return async (req: unknown) => {
      if (unauthorized) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 })
      }
      return handler(req, context)
    }
  },
}))

import { GET } from '../route'

beforeEach(() => {
  vi.clearAllMocks()
  unauthorized = false
  mockLoadClients.mockResolvedValue(['claude', 'grok'])
  mockCount.mockResolvedValue(7)
})

describe('GET /api/receipt-hunt/agent-handoff', () => {
  it('answers 401 when not signed in', async () => {
    unauthorized = true
    const res = await GET(createMockRequest('http://localhost/api/receipt-hunt/agent-handoff'), undefined as never)
    expect(res.status).toBe(401)
    expect(mockLoadClients).not.toHaveBeenCalled()
  })

  it('returns the connected clients and the missing-underlag count', async () => {
    const res = await GET(createMockRequest('http://localhost/api/receipt-hunt/agent-handoff'), undefined as never)
    const { status, body } = await parseJsonResponse<{ data: { clients: string[]; count: number } }>(res)
    expect(status).toBe(200)
    expect(body.data).toEqual({ clients: ['claude', 'grok'], count: 7 })
  })

  it('reads keys by user with the service client and counts for the active company', async () => {
    await GET(createMockRequest('http://localhost/api/receipt-hunt/agent-handoff'), undefined as never)
    expect(mockLoadClients).toHaveBeenCalledWith(serviceClient, 'user-1')
    expect(mockCount).toHaveBeenCalledWith(context.supabase, 'co-1')
  })
})
