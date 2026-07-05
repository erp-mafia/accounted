import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import {
  createQueuedMockSupabase,
  createMockRequest,
  parseJsonResponse,
  createMockRouteParams,
} from '@/tests/helpers'

// The route is wrapped in withRouteContext (auth via requireAuth, company via
// getActiveCompanyId, write gate via requireWritePermission) — mock those.
vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))
vi.mock('@/lib/auth/require-auth', () => ({ requireAuth: vi.fn() }))
vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))
vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: vi.fn().mockResolvedValue({ ok: true }),
}))
vi.mock('@/lib/events', () => ({ eventBus: { emit: vi.fn().mockResolvedValue(undefined) } }))

import { POST } from '../route'
import { requireAuth } from '@/lib/auth/require-auth'
import { eventBus } from '@/lib/events'

const mockUser = { id: 'user-1', email: 'test@test.se' }

function authed(supabase: unknown) {
  vi.mocked(requireAuth).mockResolvedValue({
    user: mockUser as never,
    supabase: supabase as never,
    error: null,
  })
}

const approvedRun = {
  id: 'run-1',
  company_id: 'company-1',
  status: 'approved',
  agi_submitted_at: null,
}

describe('POST /api/salary/runs/[id]/unapprove', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns 401 when not authenticated', async () => {
    vi.mocked(requireAuth).mockResolvedValue({
      user: null as never,
      supabase: {} as never,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })

    const request = createMockRequest('/api/salary/runs/run-1/unapprove', { method: 'POST' })
    const response = await POST(request, createMockRouteParams({ id: 'run-1' }))
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(401)
  })

  it('returns 404 when the salary run is not found', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    authed(supabase)

    enqueueMany([
      { data: null, error: { message: 'Not found' } }, // salary_runs lookup
    ])

    const request = createMockRequest('/api/salary/runs/run-1/unapprove', { method: 'POST' })
    const response = await POST(request, createMockRouteParams({ id: 'run-1' }))
    const { status, body } = await parseJsonResponse<{ error: string }>(response)

    expect(status).toBe(404)
    expect(body.error).toContain('hittades inte')
  })

  it('returns 400 when the run is not approved (e.g. already paid)', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    authed(supabase)

    enqueueMany([
      { data: { ...approvedRun, status: 'paid' } }, // salary_runs lookup
    ])

    const request = createMockRequest('/api/salary/runs/run-1/unapprove', { method: 'POST' })
    const response = await POST(request, createMockRouteParams({ id: 'run-1' }))
    const { status, body } = await parseJsonResponse<{ error: string }>(response)

    expect(status).toBe(400)
    expect(body.error).toContain('godkänd')
  })

  it('returns 409 when the AGI declaration has been submitted to Skatteverket', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    authed(supabase)

    enqueueMany([
      { data: approvedRun },                              // salary_runs lookup
      { data: { id: 'agi-1', status: 'submitted' } },     // agi_declarations lookup
    ])

    const request = createMockRequest('/api/salary/runs/run-1/unapprove', { method: 'POST' })
    const response = await POST(request, createMockRouteParams({ id: 'run-1' }))
    const { status, body } = await parseJsonResponse<{ error: string }>(response)

    expect(status).toBe(409)
    expect(body.error).toContain('Skatteverket')
    expect(eventBus.emit).not.toHaveBeenCalled()
  })

  it('returns 409 when the run itself is stamped agi_submitted_at', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    authed(supabase)

    enqueueMany([
      { data: { ...approvedRun, agi_submitted_at: '2026-07-01T10:00:00Z' } }, // run lookup
      { data: null, error: { message: 'No rows' } },                          // agi lookup
    ])

    const request = createMockRequest('/api/salary/runs/run-1/unapprove', { method: 'POST' })
    const response = await POST(request, createMockRouteParams({ id: 'run-1' }))
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(409)
  })

  it('returns 409 when the run transitions concurrently between read and update', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    authed(supabase)

    enqueueMany([
      { data: approvedRun },                            // salary_runs lookup
      { data: null, error: { message: 'No rows' } },    // agi_declarations lookup
      { data: null, error: { code: 'PGRST116', message: 'no rows returned' } }, // update matched 0 rows
    ])

    const request = createMockRequest('/api/salary/runs/run-1/unapprove', { method: 'POST' })
    const response = await POST(request, createMockRouteParams({ id: 'run-1' }))
    const { status, body } = await parseJsonResponse<{ error: string }>(response)

    expect(status).toBe(409)
    expect(body.error).toContain('ändrats')
    expect(eventBus.emit).not.toHaveBeenCalled()
  })

  it('reverts an approved run to review and emits the event', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    authed(supabase)

    enqueueMany([
      { data: approvedRun },                          // salary_runs lookup
      { data: null, error: { message: 'No rows' } },  // agi_declarations lookup (none)
      { data: { id: 'run-1', status: 'review' } },    // salary_runs update
    ])

    const request = createMockRequest('/api/salary/runs/run-1/unapprove', { method: 'POST' })
    const response = await POST(request, createMockRouteParams({ id: 'run-1' }))
    const { status, body } = await parseJsonResponse<{ data: { status: string } }>(response)

    expect(status).toBe(200)
    expect(body.data.status).toBe('review')
    expect(eventBus.emit).toHaveBeenCalledWith({
      type: 'salary_run.approval_reverted',
      payload: {
        salaryRunId: 'run-1',
        revertedBy: 'user-1',
        deletedAgiDeclarationId: null,
        userId: 'user-1',
        companyId: 'company-1',
      },
    })
  })

  it('deletes a generated (unfiled) AGI declaration after reverting', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    authed(supabase)

    enqueueMany([
      { data: approvedRun },                          // salary_runs lookup
      { data: { id: 'agi-1', status: 'generated' } }, // agi_declarations lookup
      { data: { id: 'run-1', status: 'review' } },    // salary_runs update
      { data: [{ id: 'agi-1' }] },                    // agi_declarations delete
    ])

    const request = createMockRequest('/api/salary/runs/run-1/unapprove', { method: 'POST' })
    const response = await POST(request, createMockRouteParams({ id: 'run-1' }))
    const { status, body } = await parseJsonResponse<{ data: { status: string } }>(response)

    expect(status).toBe(200)
    expect(body.data.status).toBe('review')
    expect(eventBus.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'salary_run.approval_reverted',
        payload: expect.objectContaining({ deletedAgiDeclarationId: 'agi-1' }),
      }),
    )
  })
})
