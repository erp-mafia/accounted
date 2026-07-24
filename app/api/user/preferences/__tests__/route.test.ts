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

function authedForGet(row: { hide_assistant_fab: boolean } | null) {
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

  it('returns the stored preference', async () => {
    authedForGet({ hide_assistant_fab: true })
    const res = await GET()
    const { status, body } = await parseJsonResponse<{ data: unknown }>(res)
    expect(status).toBe(200)
    expect(body.data).toEqual({ hide_assistant_fab: true })
  })

  it('defaults to false when no preferences row exists', async () => {
    authedForGet(null)
    const res = await GET()
    const { body } = await parseJsonResponse<{ data: unknown }>(res)
    expect(body.data).toEqual({ hide_assistant_fab: false })
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

  it('returns 500 when the upsert fails', async () => {
    authedForPatch({ message: 'boom' })
    const res = await PATCH(patchRequest({ hide_assistant_fab: false }))
    expect(res.status).toBe(500)
  })
})
