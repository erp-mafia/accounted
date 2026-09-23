/**
 * Tests for PUT /api/settings/booking-templates/[id].
 *
 * The validated body is spread straight into .update(), so the write set must
 * be exactly the fields the caller named. UpdateBookingTemplateSchema carries
 * no .default() today, so this route was never exploitable; the tests lock in
 * the property so a future .default() on the schema cannot turn a rename into a
 * silent rewrite of the template's lines, category, or entity_type.
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

import { PUT } from '../route'

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
    for (const m of ['select', 'eq', 'update', 'maybeSingle', 'single']) {
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

const validLines = [
  { account: '5010', label: 'Hyra', side: 'debit', type: 'business' },
  { account: '1930', label: 'Bank', side: 'credit', type: 'settlement' },
]

/** The pre-update fetch result for a template owned by the active company. */
const OWN_TEMPLATE = {
  data: { id: 'tpl-1', company_id: 'company-1', team_id: null, is_system: false },
}

beforeEach(() => {
  vi.clearAllMocks()
  requireWriteMock.mockResolvedValue({ ok: true })
})

function auth(supabase: unknown) {
  requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase, error: null })
}

function updatePayload(calls: CapturedCall[]): Record<string, unknown> {
  return calls.find((c) => c.method === 'update')?.args[0] as Record<string, unknown>
}

describe('PUT /api/settings/booking-templates/[id]', () => {
  it('returns 401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase: {},
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })
    const req = createMockRequest('/api/settings/booking-templates/tpl-1', {
      method: 'PUT',
      body: { name: 'Nytt namn' },
    })
    expect((await PUT(req, idParams)).status).toBe(401)
  })

  it('returns 403 for a viewer', async () => {
    const { supabase } = createCapturingSupabase([])
    auth(supabase)
    requireWriteMock.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }),
    })
    const req = createMockRequest('/api/settings/booking-templates/tpl-1', {
      method: 'PUT',
      body: { name: 'Nytt namn' },
    })
    expect((await PUT(req, idParams)).status).toBe(403)
  })

  it('returns 400 for an invalid body', async () => {
    const { supabase } = createCapturingSupabase([])
    auth(supabase)
    const req = createMockRequest('/api/settings/booking-templates/tpl-1', {
      method: 'PUT',
      // A template needs at least two lines (double entry).
      body: { lines: [validLines[0]] },
    })
    const { status } = await parseJsonResponse(await PUT(req, idParams))
    expect(status).toBe(400)
  })

  it('returns 500 when the update fails', async () => {
    const { supabase } = createCapturingSupabase([OWN_TEMPLATE, { error: { message: 'boom' } }])
    auth(supabase)
    const req = createMockRequest('/api/settings/booking-templates/tpl-1', {
      method: 'PUT',
      body: { name: 'Nytt namn' },
    })
    const { status } = await parseJsonResponse(await PUT(req, idParams))
    expect(status).toBe(500)
  })

  it('returns 404 when the template does not exist', async () => {
    // .single() used to turn zero rows into a PGRST116 ERROR, so not-found
    // surfaced as 500 and the 404 branch was dead.
    const { supabase, calls } = createCapturingSupabase([{ data: null }])
    auth(supabase)
    const req = createMockRequest('/api/settings/booking-templates/tpl-1', {
      method: 'PUT',
      body: { name: 'Nytt namn' },
    })
    const { status, body } = await parseJsonResponse<{ error: string }>(await PUT(req, idParams))
    expect(status).toBe(404)
    expect(body.error).toBe('Mallen hittades inte')
    expect(calls.find((c) => c.method === 'update')).toBeUndefined()
  })

  it("returns 404 for another company's template without touching it", async () => {
    // RLS is membership-wide: a user who belongs to companies A and B can see
    // B's templates while acting in A. The route must scope to the ACTIVE
    // company, so B's template reads as not-found here and no update runs.
    const { supabase, calls } = createCapturingSupabase([
      { data: { id: 'tpl-1', company_id: 'company-2', team_id: null, is_system: false } },
    ])
    auth(supabase)
    const req = createMockRequest('/api/settings/booking-templates/tpl-1', {
      method: 'PUT',
      body: { name: 'Nytt namn' },
    })
    const { status, body } = await parseJsonResponse<{ error: string }>(await PUT(req, idParams))
    expect(status).toBe(404)
    expect(body.error).toBe('Mallen hittades inte')
    expect(calls.find((c) => c.method === 'update')).toBeUndefined()
  })

  it('returns 404 for a system template', async () => {
    const { supabase, calls } = createCapturingSupabase([
      { data: { id: 'tpl-1', company_id: null, team_id: null, is_system: true } },
    ])
    auth(supabase)
    const req = createMockRequest('/api/settings/booking-templates/tpl-1', {
      method: 'PUT',
      body: { name: 'Nytt namn' },
    })
    const { status } = await parseJsonResponse(await PUT(req, idParams))
    expect(status).toBe(404)
    expect(calls.find((c) => c.method === 'update')).toBeUndefined()
  })

  it("updates a team template shared with the active company's team", async () => {
    // Team templates carry company_id NULL: a blind company_id filter would
    // have broken them. The scope check goes through the company's team_id.
    const { supabase, calls } = createCapturingSupabase([
      { data: { id: 'tpl-1', company_id: null, team_id: 'team-1', is_system: false } },
      { data: { team_id: 'team-1' } }, // companies lookup
      { data: { id: 'tpl-1', name: 'Nytt namn' } }, // update
    ])
    auth(supabase)
    const req = createMockRequest('/api/settings/booking-templates/tpl-1', {
      method: 'PUT',
      body: { name: 'Nytt namn' },
    })
    const { status } = await parseJsonResponse(await PUT(req, idParams))
    expect(status).toBe(200)
    expect(updatePayload(calls)).toEqual({ name: 'Nytt namn' })
  })

  it("returns 404 for another team's template", async () => {
    const { supabase, calls } = createCapturingSupabase([
      { data: { id: 'tpl-1', company_id: null, team_id: 'team-other', is_system: false } },
      { data: { team_id: 'team-1' } }, // companies lookup
    ])
    auth(supabase)
    const req = createMockRequest('/api/settings/booking-templates/tpl-1', {
      method: 'PUT',
      body: { name: 'Nytt namn' },
    })
    const { status } = await parseJsonResponse(await PUT(req, idParams))
    expect(status).toBe(404)
    expect(calls.find((c) => c.method === 'update')).toBeUndefined()
  })

  it('updates the template on the happy path', async () => {
    const { supabase } = createCapturingSupabase([
      OWN_TEMPLATE,
      { data: { id: 'tpl-1', name: 'Nytt namn' } },
    ])
    auth(supabase)
    const req = createMockRequest('/api/settings/booking-templates/tpl-1', {
      method: 'PUT',
      body: { name: 'Nytt namn' },
    })
    const { status, body } = await parseJsonResponse<{ data: { name: string } }>(
      await PUT(req, idParams),
    )
    expect(status).toBe(200)
    expect(body.data.name).toBe('Nytt namn')
  })

  it('writes only the field the caller named', async () => {
    const { supabase, calls } = createCapturingSupabase([OWN_TEMPLATE, { data: { id: 'tpl-1' } }])
    auth(supabase)
    const req = createMockRequest('/api/settings/booking-templates/tpl-1', {
      method: 'PUT',
      body: { name: 'Nytt namn' },
    })
    expect((await PUT(req, idParams)).status).toBe(200)
    expect(Object.keys(updatePayload(calls))).toEqual(['name'])
  })

  it('leaves lines, category and entity_type alone on a name-only update', async () => {
    const { supabase, calls } = createCapturingSupabase([OWN_TEMPLATE, { data: { id: 'tpl-1' } }])
    auth(supabase)
    const req = createMockRequest('/api/settings/booking-templates/tpl-1', {
      method: 'PUT',
      body: { name: 'Nytt namn' },
    })
    await PUT(req, idParams)
    const payload = updatePayload(calls)
    for (const field of ['lines', 'category', 'entity_type', 'description']) {
      expect(payload, `${field} must not be written by a name-only PUT`).not.toHaveProperty(field)
    }
  })

  it('takes a supplied lines array wholesale', async () => {
    const { supabase, calls } = createCapturingSupabase([OWN_TEMPLATE, { data: { id: 'tpl-1' } }])
    auth(supabase)
    const req = createMockRequest('/api/settings/booking-templates/tpl-1', {
      method: 'PUT',
      body: { lines: validLines },
    })
    expect((await PUT(req, idParams)).status).toBe(200)
    expect(updatePayload(calls)).toEqual({ lines: validLines })
  })

  it('drops unknown keys instead of forwarding them to the update', async () => {
    const { supabase, calls } = createCapturingSupabase([OWN_TEMPLATE, { data: { id: 'tpl-1' } }])
    auth(supabase)
    const req = createMockRequest('/api/settings/booking-templates/tpl-1', {
      method: 'PUT',
      body: { name: 'Nytt namn', is_system: false, company_id: 'other' },
    })
    expect((await PUT(req, idParams)).status).toBe(200)
    expect(Object.keys(updatePayload(calls))).toEqual(['name'])
  })
})
