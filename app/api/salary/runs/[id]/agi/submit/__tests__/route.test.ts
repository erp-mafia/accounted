import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import {
  createQueuedMockSupabase,
  createMockRequest,
  parseJsonResponse,
  createMockRouteParams,
} from '@/tests/helpers'

// ── Mocks ────────────────────────────────────────────────────
// The route is wrapped in withRouteContext (auth via requireAuth, company via
// getActiveCompanyId, write-gate via requireWritePermission). We inject a queued
// Supabase mock through requireAuth and mock fetch to the extension endpoint.

vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))
vi.mock('@/lib/auth/require-auth', () => ({ requireAuth: vi.fn() }))
vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
}))
vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: vi.fn().mockResolvedValue({ ok: true }),
}))
vi.mock('@/lib/events', () => ({
  eventBus: { emit: vi.fn().mockResolvedValue(undefined) },
}))

// Mock fetch for the internal extension API call
const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

import { POST } from '../route'
import { requireAuth } from '@/lib/auth/require-auth'
import { requireWritePermission } from '@/lib/auth/require-write'
import { eventBus } from '@/lib/events'

// ── Test data ────────────────────────────────────────────────

const mockUser = { id: 'user-1', email: 'test@test.se' }

const makeSalaryRun = (overrides = {}) => ({
  id: 'run-1',
  company_id: 'company-1',
  period_year: 2026,
  period_month: 3,
  status: 'approved',
  total_gross: 35000,
  total_tax: 8000,
  total_net: 27000,
  total_avgifter: 10997,
  total_vacation_accrual: 4200,
  total_employer_cost: 50197,
  payment_date: '2026-03-25',
  agi_generated_at: '2026-03-20T10:00:00Z',
  agi_submitted_at: null,
  ...overrides,
})

const makeAgiDeclaration = (overrides = {}) => ({
  id: 'agi-1',
  status: 'generated',
  ...overrides,
})

function authed() {
  const { supabase, enqueueMany } = createQueuedMockSupabase()
  vi.mocked(requireAuth).mockResolvedValue({
    user: mockUser as never,
    supabase: supabase as never,
    error: null,
  })
  return { supabase, enqueueMany }
}

// ── Tests ────────────────────────────────────────────────────

describe('POST /api/salary/runs/[id]/agi/submit', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(requireWritePermission).mockResolvedValue({ ok: true } as never)
  })

  it('returns 401 when not authenticated', async () => {
    vi.mocked(requireAuth).mockResolvedValue({
      user: null,
      supabase: null as never,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })

    const request = createMockRequest('/api/salary/runs/run-1/agi/submit', { method: 'POST' })
    const response = await POST(request, createMockRouteParams({ id: 'run-1' }))
    const { status, body } = await parseJsonResponse(response)

    expect(status).toBe(401)
    expect(body).toEqual({ error: 'Unauthorized' })
  })

  it('returns 403 for a viewer (no write permission)', async () => {
    authed()
    vi.mocked(requireWritePermission).mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }),
    } as never)

    const request = createMockRequest('/api/salary/runs/run-1/agi/submit', { method: 'POST' })
    const response = await POST(request, createMockRouteParams({ id: 'run-1' }))
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(403)
  })

  it('returns 404 when salary run not found', async () => {
    const { enqueueMany } = authed()
    enqueueMany([
      { data: null, error: { message: 'Not found' } }, // salary_runs query
    ])

    const request = createMockRequest('/api/salary/runs/run-1/agi/submit', { method: 'POST' })
    const response = await POST(request, createMockRouteParams({ id: 'run-1' }))
    const { status, body } = await parseJsonResponse<{ error: string }>(response)

    expect(status).toBe(404)
    expect(body.error).toContain('hittades inte')
  })

  it('returns 400 when salary run is in draft status', async () => {
    const { enqueueMany } = authed()
    enqueueMany([
      { data: makeSalaryRun({ status: 'draft' }) }, // salary_runs query
    ])

    const request = createMockRequest('/api/salary/runs/run-1/agi/submit', { method: 'POST' })
    const response = await POST(request, createMockRouteParams({ id: 'run-1' }))
    const { status, body } = await parseJsonResponse<{ error: string }>(response)

    expect(status).toBe(400)
    expect(body.error).toContain('efter granskning')
  })

  it('returns 400 when AGI has not been generated', async () => {
    const { enqueueMany } = authed()
    enqueueMany([
      { data: makeSalaryRun() },        // salary_runs query
      { data: null },                    // agi_declarations query (not found)
    ])

    const request = createMockRequest('/api/salary/runs/run-1/agi/submit', { method: 'POST' })
    const response = await POST(request, createMockRouteParams({ id: 'run-1' }))
    const { status, body } = await parseJsonResponse<{ error: string }>(response)

    expect(status).toBe(400)
    expect(body.error).toContain('inte genererats')
  })

  it('returns 409 when AGI has already been submitted', async () => {
    const { enqueueMany } = authed()
    enqueueMany([
      { data: makeSalaryRun() },
      { data: makeAgiDeclaration({ status: 'submitted' }) },
    ])

    const request = createMockRequest('/api/salary/runs/run-1/agi/submit', { method: 'POST' })
    const response = await POST(request, createMockRouteParams({ id: 'run-1' }))
    const { status, body } = await parseJsonResponse<{ error: string }>(response)

    expect(status).toBe(409)
    expect(body.error).toContain('redan skickats')
  })

  it('submits AGI draft and returns success', async () => {
    const { enqueueMany } = authed()
    enqueueMany([
      { data: makeSalaryRun() },                          // salary_runs query
      { data: makeAgiDeclaration() },                     // agi_declarations query
      { data: null },                                     // salary_runs update (agi_submitted_at)
    ])

    // Mock the internal fetch to extension endpoint
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        data: {
          inlamningId: 'inl-123',
          kontrollresultat: { kontroller: [] },
        },
      }),
    })

    const request = createMockRequest('/api/salary/runs/run-1/agi/submit', { method: 'POST' })
    const response = await POST(request, createMockRouteParams({ id: 'run-1' }))
    const { status, body } = await parseJsonResponse<{ data: Record<string, unknown> }>(response)

    expect(status).toBe(200)
    expect(body.data.inlamningId).toBe('inl-123')
    expect(body.data.salaryRunId).toBe('run-1')
    expect(body.data.periodYear).toBe(2026)
    expect(body.data.periodMonth).toBe(3)
    expect(body.data.message).toContain('underlag')

    // Verify the extension endpoint was called correctly. The orchestrator
    // forwards to /agi/submit (XML POST /underlag flow), not the old
    // /agi/draft endpoint that mapped to a non-existent SKV URL.
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/extensions/ext/skatteverket/agi/submit'),
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ salaryRunId: 'run-1' }),
      })
    )

    // Verify event emitted
    expect(eventBus.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'agi.submitted',
        payload: expect.objectContaining({
          salaryRunId: 'run-1',
          periodYear: 2026,
          periodMonth: 3,
          companyId: 'company-1',
        }),
      })
    )
  })

  it('returns error when extension draft endpoint fails', async () => {
    const { enqueueMany } = authed()
    enqueueMany([
      { data: makeSalaryRun() },
      { data: makeAgiDeclaration() },
    ])

    mockFetch.mockResolvedValue({
      ok: false,
      status: 403,
      json: async () => ({
        error: 'Du har inte behörighet att agera för detta företag',
        code: 'BEHORIGHET_SAKNAS',
      }),
    })

    const request = createMockRequest('/api/salary/runs/run-1/agi/submit', { method: 'POST' })
    const response = await POST(request, createMockRouteParams({ id: 'run-1' }))
    const { status, body } = await parseJsonResponse<{ error: string }>(response)

    expect(status).toBe(403)
    expect(body.error).toContain('behörighet')
  })

  it('accepts booked salary runs for submission', async () => {
    const { enqueueMany } = authed()
    enqueueMany([
      { data: makeSalaryRun({ status: 'booked' }) },
      { data: makeAgiDeclaration() },
      { data: null },
    ])

    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ data: { inlamningId: 'inl-456' } }),
    })

    const request = createMockRequest('/api/salary/runs/run-1/agi/submit', { method: 'POST' })
    const response = await POST(request, createMockRouteParams({ id: 'run-1' }))
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(200)
  })
})
