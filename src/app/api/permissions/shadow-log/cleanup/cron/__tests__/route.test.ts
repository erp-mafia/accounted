/**
 * The permission shadow log's 7-day sweep: the cron secret is required, rows
 * older than seven days are deleted, and a failed delete answers an error.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const verifyCronSecret = vi.fn((): Response | null => null)
vi.mock('@/lib/auth/cron', () => ({ verifyCronSecret: () => verifyCronSecret() }))

const state = vi.hoisted(() => ({
  table: null as string | null,
  lt: null as unknown[] | null,
  result: { error: null as unknown, count: 0 as number | null },
}))

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: vi.fn(() => ({
    from: (table: string) => {
      state.table = table
      const chain: Record<string, unknown> = {}
      chain.delete = vi.fn(() => chain)
      chain.lt = vi.fn((...args: unknown[]) => {
        state.lt = args
        return chain
      })
      chain.then = (resolve: (v: unknown) => unknown) => Promise.resolve(state.result).then(resolve)
      return chain
    },
  })),
}))

import { GET } from '../route'
import { createCronRequest } from '@/tests/helpers'

const PATH = '/api/permissions/shadow-log/cleanup/cron'

beforeEach(() => {
  vi.clearAllMocks()
  state.table = null
  state.lt = null
  state.result = { error: null, count: 0 }
  verifyCronSecret.mockReturnValue(null)
})

describe('GET /api/permissions/shadow-log/cleanup/cron', () => {
  it('refuses a request without the cron secret', async () => {
    verifyCronSecret.mockReturnValue(new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 }))
    const response = await GET(createCronRequest(PATH))
    expect(response.status).toBe(401)
    expect(state.table).toBeNull()
  })

  it('deletes the rows older than seven days', async () => {
    state.result = { error: null, count: 42 }
    const response = await GET(createCronRequest(PATH))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ success: true, deleted: 42 })
    expect(state.table).toBe('permission_shadow_log')
    expect(state.lt![0]).toBe('created_at')
    const days = (Date.now() - new Date(state.lt![1] as string).getTime()) / 86_400_000
    expect(days).toBeCloseTo(7, 0)
  })

  it('answers an error when the delete fails', async () => {
    state.result = { error: { message: 'boom', code: 'XX000' }, count: null }
    const response = await GET(createCronRequest(PATH))
    expect(response.status).toBeGreaterThanOrEqual(500)
  })
})
