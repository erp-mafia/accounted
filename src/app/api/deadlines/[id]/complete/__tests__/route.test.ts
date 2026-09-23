/**
 * Tests for POST /api/deadlines/[id]/complete.
 *
 * The load-bearing case is the explicit-state one: the page's "Ångra" button
 * posts `{ is_completed: false }`, and a route that toggles instead of setting
 * turns a second undo click (or an undo of a row already un-ticked elsewhere)
 * into a re-completed Skatteverket deadline.
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

import { POST } from '../route'

const idParams = { params: Promise.resolve({ id: 'deadline-1' }) }

interface Captured {
  update?: Record<string, unknown>
}

/**
 * Sequential query results plus the payload handed to `.update()`, which is the
 * only place the persisted state is observable.
 */
function createCapturingSupabase(
  results: { data?: unknown; error?: unknown }[],
  captured: Captured,
) {
  let idx = 0
  const makeBuilder = () => {
    const result = results[idx++] ?? { data: null, error: null }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const b: any = {}
    for (const m of ['select', 'eq', 'single', 'maybeSingle']) {
      b[m] = () => b
    }
    b.update = (payload: Record<string, unknown>) => {
      captured.update = payload
      return b
    }
    b.then = (resolve: (v: unknown) => void) =>
      resolve({ data: result.data ?? null, error: result.error ?? null })
    return b
  }
  return { from: () => makeBuilder() }
}

function auth(supabase: unknown) {
  requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase, error: null })
}

beforeEach(() => {
  vi.clearAllMocks()
  requireWriteMock.mockResolvedValue({ ok: true })
})

describe('POST /api/deadlines/[id]/complete', () => {
  it('returns 401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase: {},
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })
    const res = await POST(createMockRequest('/x', { method: 'POST' }), idParams)
    expect(res.status).toBe(401)
  })

  it('returns 403 for a viewer', async () => {
    auth(createCapturingSupabase([], {}))
    requireWriteMock.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }),
    })
    const res = await POST(
      createMockRequest('/x', { method: 'POST', body: { is_completed: false } }),
      idParams,
    )
    expect(res.status).toBe(403)
  })

  it('maps zero-rows to 404 with a Swedish message', async () => {
    auth(createCapturingSupabase([{ error: { code: 'PGRST116', message: 'no rows' } }], {}))
    const { status, body } = await parseJsonResponse<{ error: string }>(
      await POST(
        createMockRequest('/x', { method: 'POST', body: { is_completed: false } }),
        idParams,
      ),
    )
    expect(status).toBe(404)
    expect(body.error).toBe('Deadline hittades inte')
  })

  it('marks a pending deadline done and stamps completed_at', async () => {
    const captured: Captured = {}
    auth(
      createCapturingSupabase(
        [{ data: { is_completed: false } }, { data: { id: 'deadline-1', is_completed: true } }],
        captured,
      ),
    )
    const { status } = await parseJsonResponse(
      await POST(
        createMockRequest('/x', { method: 'POST', body: { is_completed: true } }),
        idParams,
      ),
    )
    expect(status).toBe(200)
    expect(captured.update?.is_completed).toBe(true)
    expect(captured.update?.completed_at).toBeTruthy()
  })

  it('undoes a completed deadline and clears completed_at', async () => {
    const captured: Captured = {}
    auth(
      createCapturingSupabase(
        [{ data: { is_completed: true } }, { data: { id: 'deadline-1', is_completed: false } }],
        captured,
      ),
    )
    const { status } = await parseJsonResponse(
      await POST(
        createMockRequest('/x', { method: 'POST', body: { is_completed: false } }),
        idParams,
      ),
    )
    expect(status).toBe(200)
    expect(captured.update?.is_completed).toBe(false)
    expect(captured.update?.completed_at).toBeNull()
  })

  it('is idempotent: undoing an already-pending deadline leaves it pending', async () => {
    // The "Ångra" click can land after the row was already un-ticked in another
    // tab or by an MCP agent. A route that toggled here would re-complete the
    // deadline, and the caller would still report it as put back on the list.
    const captured: Captured = {}
    auth(
      createCapturingSupabase(
        [{ data: { is_completed: false } }, { data: { id: 'deadline-1', is_completed: false } }],
        captured,
      ),
    )
    const { status } = await parseJsonResponse(
      await POST(
        createMockRequest('/x', { method: 'POST', body: { is_completed: false } }),
        idParams,
      ),
    )
    expect(status).toBe(200)
    expect(captured.update?.is_completed).toBe(false)
    expect(captured.update?.completed_at).toBeNull()
  })

  it('is idempotent: re-completing an already-done deadline keeps it done', async () => {
    const captured: Captured = {}
    auth(
      createCapturingSupabase(
        [{ data: { is_completed: true } }, { data: { id: 'deadline-1', is_completed: true } }],
        captured,
      ),
    )
    await POST(
      createMockRequest('/x', { method: 'POST', body: { is_completed: true } }),
      idParams,
    )
    expect(captured.update?.is_completed).toBe(true)
    expect(captured.update?.completed_at).toBeTruthy()
  })

  it('falls back to toggling when the body carries no state', async () => {
    // Backwards compatibility: a body-less POST keeps the original toggle.
    const captured: Captured = {}
    auth(
      createCapturingSupabase(
        [{ data: { is_completed: false } }, { data: { id: 'deadline-1', is_completed: true } }],
        captured,
      ),
    )
    await POST(createMockRequest('/x', { method: 'POST' }), idParams)
    expect(captured.update?.is_completed).toBe(true)
  })

  it('rejects a non-boolean is_completed with 400 instead of guessing', async () => {
    // { is_completed: "false" } is the load-bearing case: a string is truthy,
    // and the old hand-rolled parser silently degraded it to a toggle, so an
    // "undo" carrying the string could re-complete the deadline. A wrong type
    // must fail loudly and persist nothing.
    const captured: Captured = {}
    auth(createCapturingSupabase([], captured))
    const { status } = await parseJsonResponse(
      await POST(
        createMockRequest('/x', { method: 'POST', body: { is_completed: 'false' } }),
        idParams,
      ),
    )
    expect(status).toBe(400)
    expect(captured.update).toBeUndefined()
  })

  it('rejects other wrong types for is_completed with 400', async () => {
    const captured: Captured = {}
    auth(createCapturingSupabase([], captured))
    for (const bad of [1, 'nope', null, [true]]) {
      const { status } = await parseJsonResponse(
        await POST(
          createMockRequest('/x', { method: 'POST', body: { is_completed: bad } }),
          idParams,
        ),
      )
      expect(status, `is_completed=${JSON.stringify(bad)} must be a 400`).toBe(400)
    }
    expect(captured.update).toBeUndefined()
  })

  it('rejects unknown body keys with 400 (strict schema)', async () => {
    const captured: Captured = {}
    auth(createCapturingSupabase([], captured))
    const { status } = await parseJsonResponse(
      await POST(
        createMockRequest('/x', { method: 'POST', body: { is_completed: true, extra: 1 } }),
        idParams,
      ),
    )
    expect(status).toBe(400)
    expect(captured.update).toBeUndefined()
  })

  it('treats an explicit empty object as a toggle', async () => {
    const captured: Captured = {}
    auth(
      createCapturingSupabase(
        [{ data: { is_completed: false } }, { data: { id: 'deadline-1', is_completed: true } }],
        captured,
      ),
    )
    const { status } = await parseJsonResponse(
      await POST(createMockRequest('/x', { method: 'POST', body: {} }), idParams),
    )
    expect(status).toBe(200)
    expect(captured.update?.is_completed).toBe(true)
  })
})
