/**
 * Tests for GET/DELETE /api/import/sie/[id].
 *
 * Exercises the route through the real withRouteContext wrapper, mocking only
 * its auth/company/write dependencies and injecting a queued Supabase mock via
 * requireAuth. Covers: 401, 403 viewer, the completed-import guard, and the
 * happy-path delete of a failed import.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import {
  createQueuedMockSupabase,
  createMockRequest,
  createMockRouteParams,
  parseJsonResponse,
} from '@/tests/helpers'

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

import { GET, DELETE } from '../route'

const routeParams = () => createMockRouteParams({ id: 'import-1' })

describe('GET/DELETE /api/import/sie/[id]', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase })
    requireWriteMock.mockResolvedValue({ ok: true })
  })

  it('DELETE returns 401 when unauthenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })

    const response = await DELETE(
      createMockRequest('/api/import/sie/import-1', { method: 'DELETE' }),
      routeParams(),
    )

    expect(response.status).toBe(401)
  })

  it('DELETE returns 403 for a viewer', async () => {
    requireWriteMock.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }),
    })

    const response = await DELETE(
      createMockRequest('/api/import/sie/import-1', { method: 'DELETE' }),
      routeParams(),
    )

    expect(response.status).toBe(403)
  })

  it('DELETE refuses to delete a completed import (BFL retention)', async () => {
    enqueue({ data: { status: 'completed' } })

    const response = await DELETE(
      createMockRequest('/api/import/sie/import-1', { method: 'DELETE' }),
      routeParams(),
    )
    const { status, body } = await parseJsonResponse<{ error: string }>(response)

    expect(status).toBe(403)
    expect(body.error).toContain('BFL 7 kap')
  })

  it('DELETE removes a failed import', async () => {
    // 1st DB hit: status lookup. 2nd DB hit: the delete itself.
    enqueue({ data: { status: 'failed' } })
    enqueue({ data: null })

    const response = await DELETE(
      createMockRequest('/api/import/sie/import-1', { method: 'DELETE' }),
      routeParams(),
    )
    const { status, body } = await parseJsonResponse<{ success: boolean }>(response)

    expect(status).toBe(200)
    expect(body.success).toBe(true)
  })

  it('GET returns the import record', async () => {
    enqueue({ data: { id: 'import-1', status: 'pending' } })

    const response = await GET(
      createMockRequest('/api/import/sie/import-1'),
      routeParams(),
    )
    const { status, body } = await parseJsonResponse<{ data: { id: string } }>(response)

    expect(status).toBe(200)
    expect(body.data.id).toBe('import-1')
  })
})
