import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import {
  createMockRequest,
  createMockRouteParams,
  parseJsonResponse,
  createQueuedMockSupabase,
} from '@/tests/helpers'

const { supabase: mockSupabase, enqueue, reset, findCalls } = createQueuedMockSupabase()

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))

vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))

vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

import { GET } from '../route'

const AGI = {
  total_tax: 12000,
  total_avgifter: 12568,
  tax_payment_file_generated_at: null,
  tax_payment_file_format: null,
  tax_paid_at: null,
}

function get(period: string) {
  return GET(
    createMockRequest(`/api/skatteverket/tax-payments/${period}`),
    createMockRouteParams({ period }),
  )
}

describe('GET /api/skatteverket/tax-payments/[period]', () => {
  const mockUser = { id: 'user-1', email: 'test@test.se' }

  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    requireAuthMock.mockResolvedValue({ user: mockUser, supabase: mockSupabase, error: null })
  })

  it('returns 401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase: mockSupabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })

    const response = await get('2026-09')
    expect(response.status).toBe(401)
  })

  it('returns 400 for an invalid period', async () => {
    const response = await get('2026-9')
    expect(response.status).toBe(400)
  })

  it('answers null when the period has no AGI declaration', async () => {
    enqueue({ data: null }) // agi_declarations

    const response = await get('2026-09')
    const { status, body } = await parseJsonResponse<{ data: unknown }>(response)

    expect(status).toBe(200)
    expect(body.data).toBeNull()
  })

  it('carries the period\'s real payment due date, not a hard-coded 12th (issue #69)', async () => {
    enqueue({ data: AGI }) // agi_declarations for 2026-08
    enqueue({ data: { vat_registered: true, vat_taxable_base_over_40m: false } }) // company_settings

    const response = await get('2026-08')
    const { status, body } = await parseJsonResponse<{ data: Record<string, unknown> }>(response)

    expect(status).toBe(200)
    // 12 September 2026 is a Saturday: the money is due on the Monday.
    expect(body.data).toEqual({ ...AGI, payment_due_date: '2026-09-14' })
    expect(findCalls('agi_declarations', 'eq')).toEqual([
      ['company_id', 'company-1'],
      ['period_year', 2026],
      ['period_month', 8],
    ])
  })

  it('gives a company up to the SEK 40M base the 17th in August', async () => {
    enqueue({ data: AGI })
    enqueue({ data: { vat_registered: true, vat_taxable_base_over_40m: false } })

    const { body } = await parseJsonResponse<{ data: Record<string, unknown> }>(await get('2026-07'))

    expect(body.data.payment_due_date).toBe('2026-08-17')
  })

  it('keeps the 12th in August above the SEK 40M base', async () => {
    enqueue({ data: AGI })
    enqueue({ data: { vat_registered: true, vat_taxable_base_over_40m: true } })

    const { body } = await parseJsonResponse<{ data: Record<string, unknown> }>(await get('2026-07'))

    expect(body.data.payment_due_date).toBe('2026-08-12')
  })
})
