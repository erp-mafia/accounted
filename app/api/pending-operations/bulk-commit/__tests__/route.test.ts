import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  createMockRequest,
  parseJsonResponse,
  createQueuedMockSupabase,
} from '@/tests/helpers'
import { eventBus } from '@/lib/events/bus'

const { supabase: mockSupabase, enqueue, reset } = createQueuedMockSupabase()
vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve(mockSupabase),
}))
vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))

vi.mock('@/lib/company/context', () => ({
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: vi.fn().mockResolvedValue({ ok: true }),
}))

const mockCommit = vi.fn()
vi.mock('@/lib/pending-operations/commit', () => ({
  commitPendingOperation: (...args: unknown[]) => mockCommit(...args),
}))

import { POST } from '../route'

const VALID_ID_1 = '11111111-1111-4111-8111-111111111111'
const VALID_ID_2 = '22222222-2222-4222-8222-222222222222'
const VALID_ID_3 = '33333333-3333-4333-8333-333333333333'
const VALID_ID_4 = '44444444-4444-4444-8444-444444444444'
const VALID_ID_5 = '55555555-5555-4555-8555-555555555555'

function makeOp(overrides: Record<string, unknown> = {}) {
  return {
    id: VALID_ID_1,
    company_id: 'company-1',
    user_id: 'user-1',
    operation_type: 'categorize_transaction',
    status: 'pending',
    risk_level: 'low',
    title: 'Kategorisera test',
    params: {},
    preview_data: {},
    ...overrides,
  }
}

describe('POST /api/pending-operations/bulk-commit', () => {
  const mockUser = { id: 'user-1', email: 'test@test.se' }

  beforeEach(() => {
    vi.clearAllMocks()
    eventBus.clear()
    reset()
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: mockUser } })
  })

  it('returns 401 when not authenticated', async () => {
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: null } })

    const request = createMockRequest('/api/pending-operations/bulk-commit', {
      method: 'POST',
      body: { ids: [VALID_ID_1] },
    })
    const response = await POST(request)
    const { status, body } = await parseJsonResponse(response)

    expect(status).toBe(401)
    expect(body).toEqual({ error: 'Unauthorized' })
  })

  it('returns 400 when ids array is empty', async () => {
    const request = createMockRequest('/api/pending-operations/bulk-commit', {
      method: 'POST',
      body: { ids: [] },
    })
    const response = await POST(request)
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(400)
    expect(mockCommit).not.toHaveBeenCalled()
  })

  it('returns 400 when ids contain non-UUID values', async () => {
    const request = createMockRequest('/api/pending-operations/bulk-commit', {
      method: 'POST',
      body: { ids: ['not-a-uuid'] },
    })
    const response = await POST(request)
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(400)
    expect(mockCommit).not.toHaveBeenCalled()
  })

  it('returns 400 when ids exceed 100 items', async () => {
    const ids = Array.from({ length: 101 }, (_, i) => {
      const hex = i.toString(16).padStart(4, '0')
      return `${hex}${hex}${hex}${hex}-${hex}${hex}-4${hex.slice(1)}-8${hex.slice(1)}-${hex}${hex}${hex}${hex}${hex}${hex}`
    })
    const request = createMockRequest('/api/pending-operations/bulk-commit', {
      method: 'POST',
      body: { ids },
    })
    const response = await POST(request)
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(400)
    expect(mockCommit).not.toHaveBeenCalled()
  })

  it('returns 500 when fetching pending operations fails', async () => {
    enqueue({ data: null, error: { message: 'db connection lost' } })

    const request = createMockRequest('/api/pending-operations/bulk-commit', {
      method: 'POST',
      body: { ids: [VALID_ID_1] },
    })
    const response = await POST(request)
    const { status, body } = await parseJsonResponse<{ error: string }>(response)

    expect(status).toBe(500)
    expect(body.error).toBe('db connection lost')
  })

  it('reports per-item not-found as failed without calling commit', async () => {
    enqueue({ data: [] })

    const request = createMockRequest('/api/pending-operations/bulk-commit', {
      method: 'POST',
      body: { ids: [VALID_ID_1] },
    })
    const response = await POST(request)
    const { status, body } = await parseJsonResponse<{
      data: {
        results: Array<{ id: string; status: string; error?: string }>
        summary: { total: number; committed: number; failed: number; skipped: number; rejected: number }
      }
    }>(response)

    expect(status).toBe(200)
    expect(body.data.results).toEqual([
      { id: VALID_ID_1, status: 'failed', error: 'Operation not found' },
    ])
    expect(body.data.summary).toEqual({
      total: 1,
      committed: 0,
      failed: 1,
      skipped: 0,
      rejected: 0,
    })
    expect(mockCommit).not.toHaveBeenCalled()
  })

  it('skips non-pending operations and high-risk operations', async () => {
    enqueue({
      data: [
        makeOp({ id: VALID_ID_1, status: 'committed' }),
        makeOp({ id: VALID_ID_2, status: 'pending', risk_level: 'high' }),
      ],
    })

    const request = createMockRequest('/api/pending-operations/bulk-commit', {
      method: 'POST',
      body: { ids: [VALID_ID_1, VALID_ID_2] },
    })
    const response = await POST(request)
    const { status, body } = await parseJsonResponse<{
      data: {
        results: Array<{ id: string; status: string; error?: string }>
        summary: { total: number; committed: number; failed: number; skipped: number; rejected: number }
      }
    }>(response)

    expect(status).toBe(200)
    expect(body.data.results).toEqual([
      { id: VALID_ID_1, status: 'skipped', error: 'Already committed' },
      {
        id: VALID_ID_2,
        status: 'skipped',
        error: 'Hög risk: kräver individuellt godkännande',
      },
    ])
    expect(body.data.summary).toEqual({
      total: 2,
      committed: 0,
      failed: 0,
      skipped: 2,
      rejected: 0,
    })
    expect(mockCommit).not.toHaveBeenCalled()
  })

  it('commits pending operations and aggregates summary on the happy path', async () => {
    enqueue({
      data: [
        makeOp({ id: VALID_ID_1 }),
        makeOp({ id: VALID_ID_2 }),
      ],
    })

    mockCommit.mockResolvedValue({ status: 'committed', data: {} })

    const request = createMockRequest('/api/pending-operations/bulk-commit', {
      method: 'POST',
      body: { ids: [VALID_ID_1, VALID_ID_2] },
    })
    const response = await POST(request)
    const { status, body } = await parseJsonResponse<{
      data: {
        results: Array<{ id: string; status: string }>
        summary: { total: number; committed: number; failed: number; skipped: number; rejected: number }
      }
    }>(response)

    expect(status).toBe(200)
    expect(body.data.results).toEqual([
      { id: VALID_ID_1, status: 'committed' },
      { id: VALID_ID_2, status: 'committed' },
    ])
    expect(body.data.summary).toEqual({
      total: 2,
      committed: 2,
      failed: 0,
      skipped: 0,
      rejected: 0,
    })
    expect(mockCommit).toHaveBeenCalledTimes(2)
    expect(mockCommit).toHaveBeenCalledWith(
      mockSupabase,
      'user-1',
      'company-1',
      expect.objectContaining({ id: VALID_ID_1 }),
      // commit_method must be 'bulk_accept' so any journal_entries created
      // during bulk approval are tagged distinctly from single-approval ones
      // (BFNAR 2013:2 behandlingshistorik). The actor option attributes the
      // commits to the approving user (migration 20260619120000).
      {
        userEmail: 'test@test.se',
        commitMethod: 'bulk_accept',
        actor: { type: 'user', label: 'test@test.se' },
      }
    )
  })

  it('routes auto_rejected results into the rejected bucket', async () => {
    enqueue({ data: [makeOp({ id: VALID_ID_1 })] })

    mockCommit.mockResolvedValue({
      status: 'rejected',
      auto_rejected: true,
      error: 'Resource already deleted',
      http_status: 409,
    })

    const request = createMockRequest('/api/pending-operations/bulk-commit', {
      method: 'POST',
      body: { ids: [VALID_ID_1] },
    })
    const response = await POST(request)
    const { status, body } = await parseJsonResponse<{
      data: {
        results: Array<{ id: string; status: string; error?: string }>
        summary: { total: number; committed: number; failed: number; skipped: number; rejected: number }
      }
    }>(response)

    expect(status).toBe(200)
    expect(body.data.results).toEqual([
      { id: VALID_ID_1, status: 'rejected', error: 'Resource already deleted' },
    ])
    expect(body.data.summary).toEqual({
      total: 1,
      committed: 0,
      failed: 0,
      skipped: 0,
      rejected: 1,
    })
  })

  it('reports commit failures as failed and aggregates a mixed summary', async () => {
    enqueue({
      data: [
        makeOp({ id: VALID_ID_1 }),
        makeOp({ id: VALID_ID_2 }),
        makeOp({ id: VALID_ID_3, status: 'rejected' }),
        makeOp({ id: VALID_ID_4 }),
      ],
    })

    mockCommit
      .mockResolvedValueOnce({ status: 'committed', data: {} })
      .mockResolvedValueOnce({ status: 'failed', error: 'boom', http_status: 500 })
      .mockResolvedValueOnce({
        status: 'rejected',
        auto_rejected: true,
        error: 'gone',
        http_status: 404,
      })

    const request = createMockRequest('/api/pending-operations/bulk-commit', {
      method: 'POST',
      body: { ids: [VALID_ID_1, VALID_ID_2, VALID_ID_3, VALID_ID_4, VALID_ID_5] },
    })
    const response = await POST(request)
    const { status, body } = await parseJsonResponse<{
      data: {
        results: Array<{ id: string; status: string; error?: string }>
        summary: { total: number; committed: number; failed: number; skipped: number; rejected: number }
      }
    }>(response)

    expect(status).toBe(200)
    expect(body.data.results).toEqual([
      { id: VALID_ID_1, status: 'committed' },
      { id: VALID_ID_2, status: 'failed', error: 'boom' },
      { id: VALID_ID_3, status: 'skipped', error: 'Already rejected' },
      { id: VALID_ID_4, status: 'rejected', error: 'gone' },
      { id: VALID_ID_5, status: 'failed', error: 'Operation not found' },
    ])
    expect(body.data.summary).toEqual({
      total: 5,
      committed: 1,
      failed: 2,
      skipped: 1,
      rejected: 1,
    })
    expect(mockCommit).toHaveBeenCalledTimes(3)
  })
})
