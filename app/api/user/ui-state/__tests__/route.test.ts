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

  it('returns 400 on unknown agent_panel keys (strict schema)', async () => {
    const res = await POST(request({ agent_panel: { mode: 'docked', evil: 1 } }))
    expect(res.status).toBe(400)
  })

  it('returns 400 on an invalid agent_panel mode', async () => {
    const res = await POST(request({ agent_panel: { mode: 'popup' } }))
    expect(res.status).toBe(400)
  })

  it('returns 400 on fractional float pixels', async () => {
    const res = await POST(
      request({ agent_panel: { float: { x: 10.5, y: 0, w: 400, h: 500 } } }),
    )
    expect(res.status).toBe(400)
  })

  it('returns 400 on an incomplete float rect', async () => {
    const res = await POST(request({ agent_panel: { float: { x: 10, y: 0, w: 400 } } }))
    expect(res.status).toBe(400)
  })

  it('merges agent_panel keys instead of replacing the object', async () => {
    enqueue({
      data: {
        ui_state: {
          agent_panel: { mode: 'docked', dock_width: 620 },
        },
      },
    })
    enqueue({ data: null })

    const { status, body } = await parseJsonResponse<{
      data: { ui_state: { agent_panel: Record<string, unknown> } }
    }>(await POST(request({ agent_panel: { mode: 'floating' } })))

    expect(status).toBe(200)
    // dock_width survives a mode-only patch: undocking must not forget the
    // user's chosen docked width.
    expect(body.data.ui_state.agent_panel).toEqual({ mode: 'floating', dock_width: 620 })
  })

  it('accepts a full agent_panel geometry payload', async () => {
    enqueue({ data: null })
    enqueue({ data: null })

    const { status, body } = await parseJsonResponse<{
      data: { ui_state: { agent_panel: Record<string, unknown> } }
    }>(
      await POST(
        request({
          agent_panel: {
            mode: 'floating',
            dock_width: 480,
            float: { x: 1200, y: 300, w: 420, h: 640 },
          },
        }),
      ),
    )

    expect(status).toBe(200)
    expect(body.data.ui_state.agent_panel).toEqual({
      mode: 'floating',
      dock_width: 480,
      float: { x: 1200, y: 300, w: 420, h: 640 },
    })
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

  it('returns 400 when a trial_expired_ack key is not a company UUID', async () => {
    const res = await POST(request({ trial_expired_ack: { 'not-a-uuid': new Date().toISOString() } }))
    expect(res.status).toBe(400)
  })

  it('returns 400 when a trial_expired_ack value is not an ISO timestamp', async () => {
    const res = await POST(
      request({ trial_expired_ack: { '11111111-1111-4111-8111-111111111111': 'yesterday' } }),
    )
    expect(res.status).toBe(400)
  })

  it('merges trial_expired_ack per company instead of replacing the record', async () => {
    const ackedAt = '2026-08-01T10:00:00.000Z'
    enqueue({
      data: {
        ui_state: {
          trial_expired_ack: { '11111111-1111-4111-8111-111111111111': ackedAt },
        },
      },
    })
    enqueue({ data: null })

    const newAck = '2026-08-19T09:00:00.000Z'
    const { status, body } = await parseJsonResponse<{
      data: { ui_state: { trial_expired_ack: Record<string, string> } }
    }>(
      await POST(
        request({
          trial_expired_ack: { '22222222-2222-4222-8222-222222222222': newAck },
        }),
      ),
    )

    expect(status).toBe(200)
    // Acking company B never clears company A's ack.
    expect(body.data.ui_state.trial_expired_ack).toEqual({
      '11111111-1111-4111-8111-111111111111': ackedAt,
      '22222222-2222-4222-8222-222222222222': newAck,
    })
  })

  it('returns 500 when the upsert fails', async () => {
    enqueue({ data: null })
    enqueue({ data: null, error: { message: 'boom' } })

    const res = await POST(request({ nav_collapsed: true }))
    expect(res.status).toBe(500)
  })
})
