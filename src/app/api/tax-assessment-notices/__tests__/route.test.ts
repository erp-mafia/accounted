import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'
import {
  createMockRequest,
  createQueuedMockSupabase,
  parseJsonResponse,
} from '@/tests/helpers'

const { supabase, enqueue, enqueueMany, reset } = createQueuedMockSupabase()
const requireAuthMock = vi.fn()
const requireWriteMock = vi.fn()
const deadlineMocks = vi.hoisted(() => ({
  regenerate: vi.fn().mockResolvedValue({ created: 1, deleted: 0 }),
  normalize: vi.fn((settings: unknown) => settings),
}))

vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))
vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))
vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: (...args: unknown[]) => requireWriteMock(...args),
}))
vi.mock('@/lib/tax/deadline-generator', () => ({
  DEADLINE_SETTINGS_SELECT: 'company_id, entity_type',
  regenerateTaxDeadlinesForUser: deadlineMocks.regenerate,
  toDeadlineSettings: deadlineMocks.normalize,
}))

import { GET, POST } from '../route'
import { PATCH } from '../[id]/route'

const notice = {
  id: '11111111-1111-4111-8111-111111111111',
  company_id: 'company-1',
  user_id: 'user-1',
  fiscal_period_id: '22222222-2222-4222-8222-222222222222',
  decision_type: 'final',
  decision_date: '2026-07-01',
  payment_due_date: '2026-10-12',
  archived_at: null,
}

describe('/api/tax-assessment-notices', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    requireAuthMock.mockResolvedValue({
      user: { id: 'user-1' },
      supabase,
      error: null,
    })
    requireWriteMock.mockResolvedValue({ ok: true })
    deadlineMocks.regenerate.mockResolvedValue({ created: 1, deleted: 0 })
  })

  it('returns 401 when the user is not authenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })

    const response = await GET(createMockRequest('/api/tax-assessment-notices'), {})
    expect(response.status).toBe(401)
  })

  it('lists active notices', async () => {
    enqueue({ data: [notice], error: null })
    const { status, body } = await parseJsonResponse<{ data: Array<typeof notice> }>(
      await GET(createMockRequest('/api/tax-assessment-notices'), {}),
    )

    expect(status).toBe(200)
    expect(body.data).toEqual([notice])
  })

  it('returns 400 when the due date precedes the decision', async () => {
    const response = await POST(createMockRequest('/api/tax-assessment-notices', {
      method: 'POST',
      body: {
        fiscal_period_id: notice.fiscal_period_id,
        decision_type: 'final',
        decision_date: '2026-07-01',
        payment_due_date: '2026-06-30',
      },
    }), {})

    expect(response.status).toBe(400)
  })

  it('returns 404 when the fiscal period belongs to another company', async () => {
    enqueue({ data: null, error: null })
    const response = await POST(createMockRequest('/api/tax-assessment-notices', {
      method: 'POST',
      body: {
        fiscal_period_id: notice.fiscal_period_id,
        decision_type: 'final',
        decision_date: notice.decision_date,
        payment_due_date: notice.payment_due_date,
      },
    }), {})

    expect(response.status).toBe(404)
  })

  it('upserts a notice and regenerates company deadlines', async () => {
    enqueueMany([
      { data: { id: notice.fiscal_period_id }, error: null },
      { data: notice, error: null },
      { data: null, error: null },
      { data: { company_id: 'company-1', entity_type: 'aktiebolag' }, error: null },
    ])

    const { status, body } = await parseJsonResponse<{ data: typeof notice }>(
      await POST(createMockRequest('/api/tax-assessment-notices', {
        method: 'POST',
        body: {
          fiscal_period_id: notice.fiscal_period_id,
          decision_type: 'final',
          decision_date: notice.decision_date,
          payment_due_date: notice.payment_due_date,
        },
      }), {}),
    )

    expect(status).toBe(201)
    expect(body.data.id).toBe(notice.id)
    expect(deadlineMocks.regenerate).toHaveBeenCalledWith(
      supabase,
      'company-1',
      expect.objectContaining({ company_id: 'company-1' }),
    )
  })

  it('returns 404 when updating a notice outside the company', async () => {
    enqueue({ data: null, error: null })
    const response = await PATCH(createMockRequest(`/api/tax-assessment-notices/${notice.id}`, {
      method: 'PATCH',
      body: { archived: true },
    }), { params: Promise.resolve({ id: notice.id }) })

    expect(response.status).toBe(404)
  })

  it('archives a notice and dismisses its pending deadline', async () => {
    enqueueMany([
      { data: notice, error: null },
      { data: { ...notice, archived_at: '2026-07-21T10:00:00.000Z' }, error: null },
      { data: null, error: null },
      { data: { company_id: 'company-1', entity_type: 'aktiebolag' }, error: null },
    ])

    const response = await PATCH(createMockRequest(`/api/tax-assessment-notices/${notice.id}`, {
      method: 'PATCH',
      body: { archived: true },
    }), { params: Promise.resolve({ id: notice.id }) })

    expect(response.status).toBe(200)
    expect(deadlineMocks.regenerate).toHaveBeenCalledOnce()
  })
})
