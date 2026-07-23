/**
 * Tests for POST /api/user/ui-state: the per-user UI preference bag
 * (nav collapse/fold state, split-button create modes).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import { createQueuedMockSupabase, createMockRequest, parseJsonResponse } from '@/tests/helpers'

const { supabase, enqueue, reset } = createQueuedMockSupabase()

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))

import { POST } from '../route'

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase, error: null })
})

function request(body: unknown) {
  return createMockRequest('/api/user/ui-state', { method: 'POST', body })
}

describe('POST /api/user/ui-state', () => {
  it('returns 401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })

    const res = await POST(request({ nav_collapsed: true }))
    expect(res.status).toBe(401)
  })

  it('returns 400 on unknown keys (strict schema)', async () => {
    const res = await POST(request({ nav_collapsed: true, evil: 'x' }))
    expect(res.status).toBe(400)
  })

  it('returns 400 on wrong value types', async () => {
    const res = await POST(request({ nav_collapsed: 'yes' }))
    expect(res.status).toBe(400)
  })

  it('merges the patch into the existing ui_state', async () => {
    // select existing row
    enqueue({
      data: { ui_state: { nav_collapsed: false, nav_folds: { register: true } } },
    })
    // upsert result
    enqueue({ data: null })

    const { status, body } = await parseJsonResponse<{
      data: { ui_state: { nav_collapsed: boolean; nav_folds: Record<string, boolean> } }
    }>(await POST(request({ nav_folds: { bokslut: true } })))

    expect(status).toBe(200)
    expect(body.data.ui_state).toEqual({
      nav_collapsed: false,
      nav_folds: { register: true, bokslut: true },
    })
  })

  it('handles a missing preferences row (first write)', async () => {
    enqueue({ data: null }) // no existing row
    enqueue({ data: null }) // upsert

    const { status, body } = await parseJsonResponse<{
      data: { ui_state: { nav_collapsed: boolean } }
    }>(await POST(request({ nav_collapsed: true })))

    expect(status).toBe(200)
    expect(body.data.ui_state).toEqual({ nav_collapsed: true })
  })

  it('returns 500 when the upsert fails', async () => {
    enqueue({ data: null })
    enqueue({ data: null, error: { message: 'boom' } })

    const res = await POST(request({ nav_collapsed: true }))
    expect(res.status).toBe(500)
  })
})
