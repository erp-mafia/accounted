import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import {
  createQueuedMockSupabase,
  createMockRequest,
  parseJsonResponse,
  createMockRouteParams,
} from '@/tests/helpers'

vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))
vi.mock('@/lib/auth/require-auth', () => ({ requireAuth: vi.fn() }))
vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
}))
vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: vi.fn().mockResolvedValue({ ok: true }),
}))

import { PATCH, DELETE } from '../route'
import { requireAuth } from '@/lib/auth/require-auth'
import { requireWritePermission } from '@/lib/auth/require-write'

// The step every input write takes has its own suite (invalidate-calculation.test.ts).
vi.mock('@/lib/salary/invalidate-calculation', async (original) => ({
  ...(await original<typeof import('@/lib/salary/invalidate-calculation')>()),
  invalidateRunCalculation: vi.fn(async () => null),
}))

const mockUser = { id: 'user-1', email: 'test@test.se' }

function authed() {
  const { supabase, enqueueMany } = createQueuedMockSupabase()
  vi.mocked(requireAuth).mockResolvedValue({
    user: mockUser as never,
    supabase: supabase as never,
    error: null,
  })
  return { supabase, enqueueMany }
}

const params = () => createMockRouteParams({ id: 'run-1', lineId: 'line-1' })

describe('PATCH /api/salary/runs/[id]/lines/[lineId]', () => {
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
    const response = await PATCH(
      createMockRequest('/api/salary/runs/run-1/lines/line-1', { method: 'PATCH', body: { amount: 100 } }),
      params(),
    )
    expect(response.status).toBe(401)
  })

  it('returns 403 for a viewer', async () => {
    authed()
    vi.mocked(requireWritePermission).mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }),
    } as never)
    const response = await PATCH(
      createMockRequest('/api/salary/runs/run-1/lines/line-1', { method: 'PATCH', body: { amount: 100 } }),
      params(),
    )
    expect(response.status).toBe(403)
  })

  it('updates a line on a draft run', async () => {
    const { enqueueMany } = authed()
    enqueueMany([
      { data: { id: 'run-1', status: 'draft' } }, // salary_runs lookup
      // The shared service verifies the line belongs to this run before
      // writing (loadLineInRun join check).
      { data: { id: 'line-1', amount: 50, salary_run_employee: { salary_run_id: 'run-1' } } },
      { data: { id: 'line-1', amount: 100 } }, // update returning
    ])
    const response = await PATCH(
      createMockRequest('/api/salary/runs/run-1/lines/line-1', { method: 'PATCH', body: { amount: 100 } }),
      params(),
    )
    const { status, body } = await parseJsonResponse<{ data: { id: string } }>(response)
    expect(status).toBe(200)
    expect(body.data.id).toBe('line-1')
  })

  it('has nothing to update in a patch of flags: they are the type\'s (agent feedback seq 947288)', async () => {
    authed()
    const response = await PATCH(
      createMockRequest('/api/salary/runs/run-1/lines/line-1', { method: 'PATCH', body: { is_avgift_basis: false } }),
      params(),
    )
    expect(response.status).toBe(400)
  })
})

describe('DELETE /api/salary/runs/[id]/lines/[lineId]', () => {
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
    const response = await DELETE(
      createMockRequest('/api/salary/runs/run-1/lines/line-1', { method: 'DELETE' }),
      params(),
    )
    expect(response.status).toBe(401)
  })

  it('returns 403 for a viewer', async () => {
    authed()
    vi.mocked(requireWritePermission).mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }),
    } as never)
    const response = await DELETE(
      createMockRequest('/api/salary/runs/run-1/lines/line-1', { method: 'DELETE' }),
      params(),
    )
    expect(response.status).toBe(403)
  })

  it('deletes a line on a draft run', async () => {
    const { enqueueMany } = authed()
    enqueueMany([
      { data: { id: 'run-1', status: 'draft' } }, // salary_runs lookup
      // Run-membership verification added by the shared service.
      { data: { id: 'line-1', amount: 50, salary_run_employee: { salary_run_id: 'run-1' } } },
      { data: null }, // delete (error null)
    ])
    const response = await DELETE(
      createMockRequest('/api/salary/runs/run-1/lines/line-1', { method: 'DELETE' }),
      params(),
    )
    const { status, body } = await parseJsonResponse<{ data: { deleted: boolean } }>(response)
    expect(status).toBe(200)
    expect(body.data.deleted).toBe(true)
  })
})

// Text rows (item_type 'text', lib/salary/text-rows.ts) and the 0 kr rule
// every door shares (crm#1076).
describe('PATCH /api/salary/runs/[id]/lines/[lineId]: text rows and 0 kr rows', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(requireWritePermission).mockResolvedValue({ ok: true } as never)
  })

  function authedWithCalls() {
    const mock = createQueuedMockSupabase()
    vi.mocked(requireAuth).mockResolvedValue({
      user: mockUser as never,
      supabase: mock.supabase as never,
      error: null,
    })
    return mock
  }

  const TEXT_LINE = {
    id: 'line-1',
    item_type: 'text',
    description: 'Lön enligt kollektivavtal',
    quantity: null,
    unit_price: null,
    amount: 0,
    is_taxable: false,
    is_avgift_basis: false,
    is_vacation_basis: false,
    is_gross_deduction: false,
    is_net_deduction: false,
    account_number: null,
    sort_order: 5,
    one_off_tax_percent: null,
    vacation_category: null,
    vacation_saved_year: null,
    calculation_source: null,
    source_benefit_id: null,
    source_recurring_line_id: null,
    salary_run_employee: { salary_run_id: 'run-1' },
  }
  const BONUS_LINE = {
    ...TEXT_LINE,
    item_type: 'bonus',
    description: 'Bonus',
    amount: 5000,
    is_taxable: true,
    is_avgift_basis: true,
    is_vacation_basis: true,
    account_number: '7210',
  }

  async function patch(body: unknown) {
    const response = await PATCH(
      createMockRequest('/api/salary/runs/run-1/lines/line-1', { method: 'PATCH', body }),
      params(),
    )
    return parseJsonResponse<{ data?: { id: string }; error?: string; code?: string }>(response)
  }

  it('returns 401 for a text-row edit when not authenticated', async () => {
    vi.mocked(requireAuth).mockResolvedValue({
      user: null,
      supabase: null as never,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })
    const { status } = await patch({ description: 'Ny text' })
    expect(status).toBe(401)
  })

  it('updates the words of a text row and keeps it words only (200)', async () => {
    const { enqueueMany, findCall } = authedWithCalls()
    enqueueMany([
      { data: { id: 'run-1', status: 'draft' } },
      { data: TEXT_LINE },
      { data: { ...TEXT_LINE, description: 'Ny text på två rader' } },
    ])

    // Flags and an account in the patch are never stored.
    const { status, body } = await patch({ description: ' Ny text\n på två rader ', is_taxable: true, account_number: '7210' })

    expect(status).toBe(200)
    expect(body.data?.id).toBe('line-1')
    expect(findCall('salary_line_items', 'update')?.[0]).toEqual({
      description: 'Ny text på två rader',
      account_number: null,
      is_taxable: false,
      is_avgift_basis: false,
      is_vacation_basis: false,
      is_gross_deduction: false,
      is_net_deduction: false,
    })
  })

  it('returns 400 for an amount on a text row, and writes nothing', async () => {
    const { enqueueMany, findCall } = authedWithCalls()
    enqueueMany([{ data: { id: 'run-1', status: 'draft' } }, { data: TEXT_LINE }])
    const { status, body } = await patch({ amount: 250 })
    expect(status).toBe(400)
    expect(body.code).toBe('VALIDATION_ERROR')
    expect(body.error).toBe('En textrad har inget belopp. Lägg beloppet på en egen rad.')
    expect(findCall('salary_line_items', 'update')).toBeUndefined()
  })

  it('returns 400 when a money row is patched to 0 kr', async () => {
    const { enqueueMany, findCall } = authedWithCalls()
    enqueueMany([{ data: { id: 'run-1', status: 'draft' } }, { data: BONUS_LINE }])
    const { status, body } = await patch({ amount: 0 })
    expect(status).toBe(400)
    expect(body.code).toBe('VALIDATION_ERROR')
    expect(body.error).toMatch(/inte är 0 kr/)
    expect(findCall('salary_line_items', 'update')).toBeUndefined()
  })

  it('returns 400 when a row is turned into or out of a text row', async () => {
    for (const [line, itemType] of [
      [BONUS_LINE, 'text'],
      [TEXT_LINE, 'bonus'],
    ] as const) {
      const { enqueueMany } = authedWithCalls()
      enqueueMany([{ data: { id: 'run-1', status: 'draft' } }, { data: line }])
      const { status, body } = await patch({ item_type: itemType })
      expect(status).toBe(400)
      expect(body.error).toMatch(/kan inte göras om till eller från en textrad/)
    }
  })

  it('returns 404 for an unknown run', async () => {
    const { enqueueMany } = authedWithCalls()
    enqueueMany([{ data: null }])
    const { status, body } = await patch({ description: 'Ny text' })
    expect(status).toBe(404)
    expect(body.code).toBe('SALARY_RUN_NOT_FOUND')
  })

  it('returns 404 for a text row of another run', async () => {
    const { enqueueMany } = authedWithCalls()
    enqueueMany([
      { data: { id: 'run-1', status: 'draft' } },
      { data: { ...TEXT_LINE, salary_run_employee: { salary_run_id: 'run-2' } } },
    ])
    const { status, body } = await patch({ description: 'Ny text' })
    expect(status).toBe(404)
    expect(body.code).toBe('SALARY_LINE_NOT_FOUND')
  })
})
