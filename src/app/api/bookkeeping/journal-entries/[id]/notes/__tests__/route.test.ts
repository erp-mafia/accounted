/**
 * Tests for PATCH /api/bookkeeping/journal-entries/[id]/notes.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import { createQueuedMockSupabase, createMockRequest, parseJsonResponse } from '@/tests/helpers'

const { supabase, enqueue, reset } = createQueuedMockSupabase()

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

import { PATCH } from '../route'

const idParams = { params: Promise.resolve({ id: 'entry-1' }) }

function patch(body: unknown) {
  return PATCH(
    createMockRequest('/api/bookkeeping/journal-entries/entry-1/notes', {
      method: 'PATCH',
      body,
    }),
    idParams,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase, error: null })
  requireWriteMock.mockResolvedValue({ ok: true })
})

describe('PATCH /api/bookkeeping/journal-entries/[id]/notes', () => {
  it('returns 401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })
    const res = await patch({ notes: 'hej' })
    expect(res.status).toBe(401)
  })

  it('rejects an over-long note with 400', async () => {
    const { status } = await parseJsonResponse(await patch({ notes: 'x'.repeat(2001) }))
    expect(status).toBe(400)
  })

  it('returns 404 instead of phantom success when no row matches', async () => {
    enqueue({ data: null }) // update matched zero rows

    const { status, body } = await parseJsonResponse<{ error: string }>(
      await patch({ notes: 'En anteckning' })
    )
    expect(status).toBe(404)
    expect(body.error).toBe('Verifikationen hittades inte.')
  })

  it('updates the note on the happy path', async () => {
    enqueue({ data: { id: 'entry-1' } })

    const { status, body } = await parseJsonResponse<{ data: { updated: boolean } }>(
      await patch({ notes: 'En anteckning' })
    )
    expect(status).toBe(200)
    expect(body.data.updated).toBe(true)
  })
})
