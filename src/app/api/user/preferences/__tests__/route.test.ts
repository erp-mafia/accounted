import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import { parseJsonResponse } from '@/tests/helpers'

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))

import { GET, PATCH } from '../route'

beforeEach(() => {
  vi.clearAllMocks()
})

function unauthed() {
  requireAuthMock.mockResolvedValue({
    user: null,
    supabase: null,
    error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
  })
}

function authedForGet(
  row: { hide_assistant_fab?: boolean; auto_logout?: boolean; ui_state?: Record<string, unknown> } | null,
) {
  const maybeSingle = vi.fn().mockResolvedValue({ data: row, error: null })
  const supabase = {
    from: vi.fn(() => ({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({ maybeSingle })),
      })),
    })),
  }
  requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase, error: null })
  return { supabase }
}

function authedForPatch(upsertError: { message: string } | null = null) {
  const upsert = vi.fn().mockResolvedValue({ error: upsertError })
  const supabase = { from: vi.fn(() => ({ upsert })) }
  requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase, error: null })
  return { upsert }
}

function patchRequest(body: unknown) {
  return new Request('http://localhost/api/user/preferences', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('GET /api/user/preferences', () => {
  it('returns 401 when unauthenticated', async () => {
    unauthed()
    const res = await GET()
    expect(res.status).toBe(401)
  })

  it('returns the stored preferences', async () => {
    authedForGet({ hide_assistant_fab: true, auto_logout: true })
    const res = await GET()
    const { status, body } = await parseJsonResponse<{ data: unknown }>(res)
    expect(status).toBe(200)
    expect(body.data).toEqual({ hide_assistant_fab: true, auto_logout: true, support_fab_hidden: false, start_page: {} })
  })

  it('defaults to false when no preferences row exists', async () => {
    authedForGet(null)
    const res = await GET()
    const { body } = await parseJsonResponse<{ data: unknown }>(res)
    expect(body.data).toEqual({ hide_assistant_fab: false, auto_logout: false, support_fab_hidden: false, start_page: {} })
  })

  it('reads the support button choice out of the ui state, apart from the assistant one', async () => {
    authedForGet({ hide_assistant_fab: true, auto_logout: false, ui_state: { support_fab_hidden: true } })
    const { body } = await parseJsonResponse<{ data: unknown }>(await GET())
    expect(body.data).toEqual({ hide_assistant_fab: true, auto_logout: false, support_fab_hidden: true, start_page: {} })

    authedForGet({ hide_assistant_fab: true, auto_logout: false, ui_state: {} })
    const second = await parseJsonResponse<{ data: { support_fab_hidden: boolean } }>(await GET())
    expect(second.body.data.support_fab_hidden).toBe(false)
  })

  it('reads the start page per company out of the ui state, dropping what it does not know', async () => {
    authedForGet({
      ui_state: {
        start_page: {
          '11111111-1111-4111-8111-111111111111': 'bookkeeping',
          '22222222-2222-4222-8222-222222222222': 'payroll',
        },
      },
    })
    const { body } = await parseJsonResponse<{ data: { start_page: Record<string, string> } }>(await GET())
    expect(body.data.start_page).toEqual({ '11111111-1111-4111-8111-111111111111': 'bookkeeping' })
  })
})

describe('PATCH /api/user/preferences', () => {
  it('returns 401 when unauthenticated', async () => {
    unauthed()
    const res = await PATCH(patchRequest({ hide_assistant_fab: true }))
    expect(res.status).toBe(401)
  })

  it('rejects an invalid body with 400', async () => {
    authedForPatch()
    const res = await PATCH(patchRequest({ hide_assistant_fab: 'yes' }))
    expect(res.status).toBe(400)
  })

  it('rejects unknown keys with 400', async () => {
    authedForPatch()
    const res = await PATCH(patchRequest({ hide_assistant_fab: true, locale: 'en' }))
    expect(res.status).toBe(400)
  })

  it('upserts the preference for the authenticated user', async () => {
    const { upsert } = authedForPatch()
    const res = await PATCH(patchRequest({ hide_assistant_fab: true }))
    const { status, body } = await parseJsonResponse<{ data: unknown }>(res)
    expect(status).toBe(200)
    expect(body.data).toEqual({ hide_assistant_fab: true })
    expect(upsert).toHaveBeenCalledWith(
      { user_id: 'user-1', hide_assistant_fab: true },
      { onConflict: 'user_id' }
    )
  })

  it('writes a multi-field request as one atomic upsert', async () => {
    const { upsert } = authedForPatch()
    const res = await PATCH(
      patchRequest({ hide_assistant_fab: true, auto_logout: false })
    )
    expect(res.status).toBe(200)
    expect(upsert).toHaveBeenCalledTimes(1)
    expect(upsert).toHaveBeenCalledWith(
      { user_id: 'user-1', hide_assistant_fab: true, auto_logout: false },
      { onConflict: 'user_id' }
    )
  })

  it('rejects an empty body with 400', async () => {
    authedForPatch()
    const res = await PATCH(patchRequest({}))
    expect(res.status).toBe(400)
  })

  it('upserts auto_logout and resets the session timeout cookie', async () => {
    const { upsert } = authedForPatch()
    const res = await PATCH(patchRequest({ auto_logout: true }))
    const { status, body } = await parseJsonResponse<{ data: unknown }>(res)
    expect(status).toBe(200)
    expect(body.data).toEqual({ auto_logout: true })
    expect(upsert).toHaveBeenCalledWith(
      { user_id: 'user-1', auto_logout: true },
      { onConflict: 'user_id' }
    )
    // The signed timeout cookie caches the opt-in; a change must clear it so
    // the middleware re-mints with the new preference on the next request.
    const setCookie = res.headers.get('set-cookie') ?? ''
    expect(setCookie).toContain('gnubok-session-timeout=;')
  })

  it('does not touch the session timeout cookie for unrelated preferences', async () => {
    authedForPatch()
    const res = await PATCH(patchRequest({ hide_assistant_fab: true }))
    expect(res.status).toBe(200)
    expect(res.headers.get('set-cookie')).toBeNull()
  })

  it('returns 500 when the upsert fails', async () => {
    authedForPatch({ message: 'boom' })
    const res = await PATCH(patchRequest({ hide_assistant_fab: false }))
    expect(res.status).toBe(500)
  })
})
