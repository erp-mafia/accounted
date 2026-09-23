/**
 * Route tests for the authenticated /link endpoints: unmute from the app
 * (the in-chat counterpart is the literal text `start`) and the health
 * counters GET /link exposes for the settings panel.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import type { ExtensionContext } from '@/lib/extensions/types'

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(),
}))

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: vi.fn(),
}))

vi.mock('@/extensions/general/whatsapp-inbox/lib/graph-api', async () => {
  const actual = await vi.importActual<
    typeof import('@/extensions/general/whatsapp-inbox/lib/graph-api')
  >('@/extensions/general/whatsapp-inbox/lib/graph-api')
  return {
    ...actual,
    sendText: vi.fn().mockResolvedValue({ ok: true, wamid: 'wamid.OUT', errorDetail: null, failure: null }),
    getDisplayPhoneNumber: vi.fn().mockResolvedValue(null),
  }
})

vi.mock('@/extensions/general/whatsapp-inbox/lib/process-inbound', () => ({
  kickInboundProcessing: vi.fn(),
}))

import { createServiceClient } from '@/lib/supabase/server'
import { whatsappInboxExtension } from '@/extensions/general/whatsapp-inbox'

function findRoute(method: string, path: string) {
  return whatsappInboxExtension.apiRoutes!.find((r) => r.method === method && r.path === path)!
}

function makeCtx(supabase: unknown): ExtensionContext {
  return {
    userId: 'user-1',
    companyId: 'company-1',
    extensionId: 'whatsapp-inbox',
    supabase,
  } as unknown as ExtensionContext
}

function request(path: string, method = 'POST'): Request {
  return new Request(`http://localhost:3000/api/extensions/ext/whatsapp-inbox${path}`, { method })
}

describe('POST /link/unmute', () => {
  const route = findRoute('POST', '/link/unmute')

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('401s without an authenticated context', async () => {
    const response = await route.handler(request('/link/unmute'))
    expect(response.status).toBe(401)
  })

  it('clears muted_at on the caller own active link', async () => {
    const { supabase, enqueue, findCall, calls } = createQueuedMockSupabase()
    enqueue({ data: [{ id: 'link-1' }] }) // guarded update matched the row

    const response = await route.handler(request('/link/unmute'), makeCtx(supabase))
    expect(response.status).toBe(200)
    const body = (await response.json()) as { data: { unmuted: boolean } }
    expect(body.data).toEqual({ unmuted: true })

    const [patch] = findCall('whatsapp_phone_links', 'update') as [Record<string, unknown>]
    expect(patch).toEqual({ muted_at: null })
    // Scoped to the caller's own active link.
    expect(
      calls.some(
        (c) =>
          c.table === 'whatsapp_phone_links' &&
          c.method === 'eq' &&
          c.args[0] === 'user_id' &&
          c.args[1] === 'user-1',
      ),
    ).toBe(true)
    expect(
      calls.some(
        (c) =>
          c.table === 'whatsapp_phone_links' && c.method === 'is' && c.args[0] === 'revoked_at',
      ),
    ).toBe(true)
  })

  it('404s when there is no active link', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: [] }) // no row matched

    const response = await route.handler(request('/link/unmute'), makeCtx(supabase))
    expect(response.status).toBe(404)
  })
})

describe('GET /link', () => {
  const route = findRoute('GET', '/link')

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('401s without an authenticated context', async () => {
    const response = await route.handler(request('/link', 'GET'))
    expect(response.status).toBe(401)
  })

  it('includes the 7-day health counters for the caller link only', async () => {
    const userMock = createQueuedMockSupabase()
    userMock.enqueue({
      data: {
        id: 'link-1',
        phone_masked: '+46 70 *** ** 67',
        default_company_id: null,
        muted_at: null,
        verified_at: '2026-08-01T09:00:00Z',
      },
    })
    const serviceMock = createQueuedMockSupabase()
    serviceMock.enqueue({
      data: {
        created_at: '2026-08-12T10:00:00Z',
        processing_status: 'done',
        error_message: null,
        inbox_item_id: 'item-1',
      },
    }) // last inbound
    serviceMock.enqueue({ data: { delivery_status: 'sent' } }) // last outbound
    serviceMock.enqueue({ count: 2 }) // outboundFailed7d
    serviceMock.enqueue({ count: 1 }) // parkedInbound7d
    vi.mocked(createServiceClient).mockReturnValue(serviceMock.supabase as never)

    const response = await route.handler(request('/link', 'GET'), makeCtx(userMock.supabase))
    expect(response.status).toBe(200)
    const { data } = (await response.json()) as {
      data: { linked: boolean; health: { outboundFailed7d: number; parkedInbound7d: number } }
    }
    expect(data.linked).toBe(true)
    expect(data.health).toEqual({ outboundFailed7d: 2, parkedInbound7d: 1 })
    // Both head counts are keyed strictly by the link row RLS just proved
    // the caller owns.
    const linkScoped = serviceMock.calls.filter(
      (c) =>
        c.table === 'whatsapp_messages' &&
        c.method === 'eq' &&
        c.args[0] === 'phone_link_id' &&
        c.args[1] === 'link-1',
    )
    expect(linkScoped.length).toBeGreaterThanOrEqual(4)
  })

  it('reports linked: false without touching the service client', async () => {
    const userMock = createQueuedMockSupabase()
    userMock.enqueue({ data: null }) // no active link row

    const response = await route.handler(request('/link', 'GET'), makeCtx(userMock.supabase))
    const { data } = (await response.json()) as { data: { linked: boolean } }
    expect(data).toEqual({ linked: false })
    expect(vi.mocked(createServiceClient)).not.toHaveBeenCalled()
  })
})

describe('POST /link/default-company', () => {
  const route = findRoute('POST', '/link/default-company')

  function jsonRequest(body: unknown): Request {
    return new Request('http://localhost:3000/api/extensions/ext/whatsapp-inbox/link/default-company', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  }
  const COMPANY = '11111111-1111-4111-8111-111111111111'

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('401s without an authenticated context', async () => {
    const response = await route.handler(jsonRequest({ companyId: COMPANY }))
    expect(response.status).toBe(401)
  })

  it('400s on a malformed body', async () => {
    const { supabase } = createQueuedMockSupabase()
    const response = await route.handler(jsonRequest({ companyId: 'not-a-uuid' }), makeCtx(supabase))
    expect(response.status).toBe(400)
  })

  it('checks LIVE membership: the same archived filter intake applies (#2062)', async () => {
    const { supabase, enqueue, findCalls, calls } = createQueuedMockSupabase()
    enqueue({ data: { company_id: COMPANY } }) // live membership
    enqueue({ data: null }) // link update

    const response = await route.handler(jsonRequest({ companyId: COMPANY }), makeCtx(supabase))
    expect(response.status).toBe(200)
    expect(findCalls('company_members', 'select')[0][0]).toContain('companies!inner(archived_at)')
    expect(findCalls('company_members', 'is')).toContainEqual(['companies.archived_at', null])
    expect(
      calls.some(
        (c) =>
          c.table === 'company_members' &&
          c.method === 'eq' &&
          c.args[0] === 'user_id' &&
          c.args[1] === 'user-1',
      ),
    ).toBe(true)
    const [patch] = findCalls('whatsapp_phone_links', 'update')[0] as [Record<string, unknown>]
    expect(patch).toEqual({ default_company_id: COMPANY })
  })

  it('403s when the company is archived or the caller is not a member', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: null }) // filtered out by the archived join

    const response = await route.handler(jsonRequest({ companyId: COMPANY }), makeCtx(supabase))
    expect(response.status).toBe(403)
    expect(findCalls('whatsapp_phone_links', 'update')).toHaveLength(0)
  })

  it('500s on a failed membership read instead of reading it as "not a member"', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ error: { message: 'connection reset' } })

    const response = await route.handler(jsonRequest({ companyId: COMPANY }), makeCtx(supabase))
    expect(response.status).toBe(500)
    expect(findCalls('whatsapp_phone_links', 'update')).toHaveLength(0)
  })

  it('clears the default without any membership check', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: null }) // link update

    const response = await route.handler(jsonRequest({ companyId: null }), makeCtx(supabase))
    expect(response.status).toBe(200)
    expect(findCalls('company_members', 'select')).toHaveLength(0)
    const [patch] = findCalls('whatsapp_phone_links', 'update')[0] as [Record<string, unknown>]
    expect(patch).toEqual({ default_company_id: null })
  })
})
