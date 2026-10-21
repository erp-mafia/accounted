import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { invoiceInboxExtension } from '@/extensions/general/invoice-inbox'
import { createQueuedMockSupabase, createMockRequest, parseJsonResponse, testRoutes } from '@/tests/helpers'
import type { ExtensionContext } from '@/lib/extensions/types'

vi.mock('@/lib/rate-limits/inbox', () => ({
  checkInboxUploadRateLimit: vi.fn().mockResolvedValue({ ok: true }),
}))

/**
 * The inbox address after a rename (crm#1334, crm#1209): the address read
 * says whether it still carries the company's name and lists the earlier
 * addresses that still receive; POST /inbox/rotate with keep_previous mints
 * one with the current name through rename_company_inbox, while a bare POST
 * still rotates (every old address stops).
 */

function findRoute(method: string, path: string) {
  return testRoutes(invoiceInboxExtension).find((r) => r.method === method && r.path === path)!
}

const addressRoute = findRoute('GET', '/inbox/address')
const rotateRoute = findRoute('POST', '/inbox/rotate')

function buildCtx(supabase: unknown): ExtensionContext {
  return {
    userId: 'user-1',
    companyId: 'company-1',
    extensionId: 'invoice-inbox',
    supabase: supabase as ExtensionContext['supabase'],
    emit: vi.fn(),
    settings: { get: vi.fn(), set: vi.fn() },
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as ExtensionContext['log'],
    services: {},
  } as unknown as ExtensionContext
}

const ACTIVE = {
  id: 'inbox-2',
  company_id: 'company-1',
  local_part: 'nytt-namn-ab-m4tz',
  status: 'active',
  slug_seed: 'nytt-namn-ab',
  created_at: '2026-10-21T00:00:00Z',
  updated_at: '2026-10-21T00:00:00Z',
  deprecated_at: null,
}

function rotateRequest(body?: string) {
  return new Request('http://localhost/inbox/rotate', {
    method: 'POST',
    ...(body === undefined ? {} : { body, headers: { 'Content-Type': 'application/json' } }),
  })
}

describe('GET /inbox/address', () => {
  const originalDomain = process.env.RESEND_INBOUND_DOMAIN
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.RESEND_INBOUND_DOMAIN = 'in.example.test'
  })
  afterEach(() => {
    if (originalDomain === undefined) delete process.env.RESEND_INBOUND_DOMAIN
    else process.env.RESEND_INBOUND_DOMAIN = originalDomain
  })

  it('says the address no longer carries a renamed company name and lists the previous addresses', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: { ...ACTIVE, local_part: 'gammalt-namn-ab-m4tz', slug_seed: 'gammalt-namn-ab' } })
    enqueue({ data: [{ local_part: 'tidigare-ab-x7f2' }] }) // previous addresses
    enqueue({ data: { name: 'Nytt Namn AB' } }) // companies.name

    const res = await addressRoute.handler(createMockRequest('/inbox/address'), buildCtx(supabase))
    const { status, body } = await parseJsonResponse<{ data: Record<string, unknown> }>(res)

    expect(status).toBe(200)
    expect(body.data).toMatchObject({
      address: 'gammalt-namn-ab-m4tz@in.example.test',
      carries_company_name: false,
      previous: ['tidigare-ab-x7f2@in.example.test'],
    })
    expect(findCalls('company_inboxes', 'eq')).toContainEqual(['status', 'previous'])
  })

  it('says the address carries the name when nothing was renamed', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: ACTIVE })
    enqueue({ data: [] })
    enqueue({ data: { name: 'Nytt Namn AB' } })

    const res = await addressRoute.handler(createMockRequest('/inbox/address'), buildCtx(supabase))
    const { body } = await parseJsonResponse<{ data: Record<string, unknown> }>(res)
    expect(body.data).toMatchObject({ carries_company_name: true, previous: [] })
  })

  it('still answers with the address when the extra reads fail', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: ACTIVE })
    enqueue({ data: null, error: { message: 'boom' } })
    enqueue({ data: null, error: { message: 'boom' } })

    const res = await addressRoute.handler(createMockRequest('/inbox/address'), buildCtx(supabase))
    const { status, body } = await parseJsonResponse<{ data: Record<string, unknown> }>(res)
    expect(status).toBe(200)
    expect(body.data).toMatchObject({
      address: 'nytt-namn-ab-m4tz@in.example.test',
      carries_company_name: null,
      previous: null,
    })
  })

  it('returns 404 when the company has no active address', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null })

    const res = await addressRoute.handler(createMockRequest('/inbox/address'), buildCtx(supabase))
    expect(res.status).toBe(404)
  })
})

describe('POST /inbox/rotate', () => {
  const originalDomain = process.env.RESEND_INBOUND_DOMAIN
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.RESEND_INBOUND_DOMAIN = 'in.example.test'
  })
  afterEach(() => {
    if (originalDomain === undefined) delete process.env.RESEND_INBOUND_DOMAIN
    else process.env.RESEND_INBOUND_DOMAIN = originalDomain
  })

  it('keep_previous mints an address with the current name through rename_company_inbox', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { role: 'owner' } }) // company_members
    enqueue({ data: ACTIVE }) // rpc:rename_company_inbox

    const res = await rotateRoute.handler(rotateRequest('{"keep_previous":true}'), buildCtx(supabase))
    const { status, body } = await parseJsonResponse<{ data: Record<string, unknown> }>(res)

    expect(status).toBe(200)
    expect(body.data).toMatchObject({ address: 'nytt-namn-ab-m4tz@in.example.test', status: 'active' })
    expect(supabase.rpc).toHaveBeenCalledWith('rename_company_inbox', { p_company_id: 'company-1' })
    expect(supabase.rpc).not.toHaveBeenCalledWith('rotate_company_inbox', expect.anything())
  })

  it('without a body still rotates, as the workspace and the create button call it', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { role: 'admin' } })
    enqueue({ data: ACTIVE }) // rpc:rotate_company_inbox

    const res = await rotateRoute.handler(rotateRequest(), buildCtx(supabase))
    expect(res.status).toBe(200)
    expect(supabase.rpc).toHaveBeenCalledWith('rotate_company_inbox', { p_company_id: 'company-1' })
  })

  it('answers 409 when the address already carries the company name', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { role: 'owner' } })
    enqueue({ data: null, error: { code: 'PT409', message: 'The inbox address already carries the company name' } })

    const res = await rotateRoute.handler(rotateRequest('{"keep_previous":true}'), buildCtx(supabase))
    const { status, body } = await parseJsonResponse<{ error: string }>(res)
    expect(status).toBe(409)
    expect(body.error).toBe('Inkorgsadressen har redan bolagets namn.')
  })

  it('answers 404 when there is no address to rename', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { role: 'owner' } })
    enqueue({ data: null, error: { code: 'P0002', message: 'No active inbox address to rename' } })

    const res = await rotateRoute.handler(rotateRequest('{"keep_previous":true}'), buildCtx(supabase))
    expect(res.status).toBe(404)
  })

  it('refuses members below admin before any address changes', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { role: 'member' } })

    const res = await rotateRoute.handler(rotateRequest('{"keep_previous":true}'), buildCtx(supabase))
    expect(res.status).toBe(403)
    expect(supabase.rpc).not.toHaveBeenCalled()
  })

  it.each(['{not json', '{"keep_previous":"yes"}', '{"keep":true}', '[]'])(
    'refuses a malformed body (%s) instead of rotating',
    async (raw) => {
      const { supabase } = createQueuedMockSupabase()
      const res = await rotateRoute.handler(rotateRequest(raw), buildCtx(supabase))
      expect(res.status).toBe(400)
      expect(supabase.rpc).not.toHaveBeenCalled()
    },
  )
})
