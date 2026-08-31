/**
 * Tests for POST/DELETE /api/settings/booking-templates/[id]/hide.
 *
 * Hiding is opt-in and per-company: a hide row is written for the ACTIVE
 * company only, and only for system templates (company/team templates have a
 * real delete path already). The tests lock in both properties, plus the
 * idempotent unhide.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import { createMockRequest, parseJsonResponse } from '@/tests/helpers'

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))

vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

const requireWriteMock = vi.fn()
vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: (...args: unknown[]) => requireWriteMock(...args),
}))

import { POST, DELETE } from '../route'

interface CapturedCall {
  method: string
  args: unknown[]
}

/** Chainable builder recording calls; resolves queued {data,error} per from(). */
function createCapturingSupabase(results: { data?: unknown; error?: unknown }[]) {
  const calls: CapturedCall[] = []
  let idx = 0
  const makeBuilder = () => {
    const result = results[idx++] ?? { data: null, error: null }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const b: any = {}
    for (const m of ['select', 'eq', 'upsert', 'delete', 'maybeSingle']) {
      b[m] = (...args: unknown[]) => {
        calls.push({ method: m, args })
        return b
      }
    }
    b.then = (resolve: (v: unknown) => void) =>
      resolve({ data: result.data ?? null, error: result.error ?? null })
    return b
  }
  return {
    supabase: {
      from: (table: string) => {
        calls.push({ method: 'from', args: [table] })
        return makeBuilder()
      },
    },
    calls,
  }
}

const idParams = { params: Promise.resolve({ id: 'tpl-1' }) }

const SYSTEM_TEMPLATE = {
  data: { id: 'tpl-1', is_system: true, is_active: true },
}

beforeEach(() => {
  vi.clearAllMocks()
  requireWriteMock.mockResolvedValue({ ok: true })
})

function auth(supabase: unknown) {
  requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase, error: null })
}

function req(method: 'POST' | 'DELETE') {
  return createMockRequest('/api/settings/booking-templates/tpl-1/hide', { method })
}

describe('POST /api/settings/booking-templates/[id]/hide', () => {
  it('returns 401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase: {},
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })
    expect((await POST(req('POST'), idParams)).status).toBe(401)
  })

  it('returns 403 for a viewer', async () => {
    const { supabase } = createCapturingSupabase([])
    auth(supabase)
    requireWriteMock.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }),
    })
    expect((await POST(req('POST'), idParams)).status).toBe(403)
  })

  it('returns 404 when the template does not exist', async () => {
    const { supabase, calls } = createCapturingSupabase([{ data: null }])
    auth(supabase)
    const { status } = await parseJsonResponse(await POST(req('POST'), idParams))
    expect(status).toBe(404)
    expect(calls.find((c) => c.method === 'upsert')).toBeUndefined()
  })

  it('returns 404 for a retired (inactive) template', async () => {
    const { supabase, calls } = createCapturingSupabase([
      { data: { id: 'tpl-1', is_system: true, is_active: false } },
    ])
    auth(supabase)
    const { status } = await parseJsonResponse(await POST(req('POST'), idParams))
    expect(status).toBe(404)
    expect(calls.find((c) => c.method === 'upsert')).toBeUndefined()
  })

  it('returns 400 for a non-system template', async () => {
    const { supabase, calls } = createCapturingSupabase([
      { data: { id: 'tpl-1', is_system: false, is_active: true } },
    ])
    auth(supabase)
    const { status } = await parseJsonResponse(await POST(req('POST'), idParams))
    expect(status).toBe(400)
    expect(calls.find((c) => c.method === 'upsert')).toBeUndefined()
  })

  it('returns 500 when the upsert fails', async () => {
    const { supabase } = createCapturingSupabase([
      SYSTEM_TEMPLATE,
      { error: { message: 'boom' } },
    ])
    auth(supabase)
    const { status } = await parseJsonResponse(await POST(req('POST'), idParams))
    expect(status).toBe(500)
  })

  it('hides a system template for the active company on the happy path', async () => {
    const { supabase, calls } = createCapturingSupabase([SYSTEM_TEMPLATE, { data: null }])
    auth(supabase)
    const { status } = await parseJsonResponse(await POST(req('POST'), idParams))
    expect(status).toBe(200)
    const upsert = calls.find((c) => c.method === 'upsert')
    expect(upsert?.args[0]).toEqual({
      template_id: 'tpl-1',
      company_id: 'company-1',
      hidden_by: 'user-1',
    })
    // ignoreDuplicates is load-bearing: the table has no UPDATE policy, so a
    // DO UPDATE conflict arm would be rejected by RLS on a concurrent re-hide.
    expect(upsert?.args[1]).toEqual({
      onConflict: 'template_id,company_id',
      ignoreDuplicates: true,
    })
  })
})

describe('DELETE /api/settings/booking-templates/[id]/hide', () => {
  it('returns 401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase: {},
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })
    expect((await DELETE(req('DELETE'), idParams)).status).toBe(401)
  })

  it('returns 403 for a viewer', async () => {
    const { supabase } = createCapturingSupabase([])
    auth(supabase)
    requireWriteMock.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }),
    })
    expect((await DELETE(req('DELETE'), idParams)).status).toBe(403)
  })

  it('returns 500 when the delete fails', async () => {
    const { supabase } = createCapturingSupabase([{ error: { message: 'boom' } }])
    auth(supabase)
    const { status } = await parseJsonResponse(await DELETE(req('DELETE'), idParams))
    expect(status).toBe(500)
  })

  it('unhides scoped to the active company, idempotently', async () => {
    // Zero deleted rows is still success: unhide may race a double click.
    const { supabase, calls } = createCapturingSupabase([{ data: null }])
    auth(supabase)
    const { status } = await parseJsonResponse(await DELETE(req('DELETE'), idParams))
    expect(status).toBe(200)
    const eqCalls = calls.filter((c) => c.method === 'eq').map((c) => c.args)
    expect(eqCalls).toContainEqual(['template_id', 'tpl-1'])
    expect(eqCalls).toContainEqual(['company_id', 'company-1'])
  })
})
