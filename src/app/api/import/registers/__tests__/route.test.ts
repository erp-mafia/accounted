/**
 * GET /api/import/registers: the register import history, newest first,
 * scoped to the active company.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import {
  createQueuedMockSupabase,
  createMockRequest,
  createMockRouteParams,
  parseJsonResponse,
} from '@/tests/helpers'

const { supabase, enqueue, reset, findCall } = createQueuedMockSupabase()

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))

vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

import { GET } from '../route'

const call = () => GET(createMockRequest('/api/import/registers'), createMockRouteParams({}))

describe('GET /api/import/registers', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase })
  })

  it('returns 401 when unauthenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })

    const response = await call()

    expect(response.status).toBe(401)
  })

  it('lists the active company runs, newest first', async () => {
    const runs = [
      {
        id: 'run-2',
        kind: 'customers',
        created_count: 3,
        created_at: '2026-10-03T12:00:00Z',
        undone_at: null,
        undo_result: null,
      },
    ]
    enqueue({ data: runs })

    const { status, body } = await parseJsonResponse<{ data: typeof runs }>(await call())

    expect(status).toBe(200)
    expect(body.data).toEqual(runs)
    expect(findCall('register_import_runs', 'eq')).toEqual(['company_id', 'company-1'])
    expect(findCall('register_import_runs', 'order')).toEqual(['created_at', { ascending: false }])
  })

  it('returns an empty list when there are no runs', async () => {
    enqueue({ data: null })

    const { status, body } = await parseJsonResponse<{ data: unknown[] }>(await call())

    expect(status).toBe(200)
    expect(body.data).toEqual([])
  })

  it('returns REG_IMPORT_LIST_FAILED when the read fails', async () => {
    enqueue({ error: { message: 'boom', code: 'XX000' } })

    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(await call())

    expect(status).toBe(500)
    expect(body.error.code).toBe('REG_IMPORT_LIST_FAILED')
  })
})
