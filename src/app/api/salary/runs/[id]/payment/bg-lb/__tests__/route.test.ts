import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import { createQueuedMockSupabase, createMockRequest, createMockRouteParams } from '@/tests/helpers'

// The route is wrapped in withRouteContext and gated with requireWrite (it
// persists payment_file_generated_at). The file generator, net-payout helper and
// bankgiro validator are stubbed so we can exercise auth + the happy path.
vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))
vi.mock('@/lib/auth/require-auth', () => ({ requireAuth: vi.fn() }))
vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
}))
vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: vi.fn().mockResolvedValue({ ok: true }),
}))
vi.mock('@/lib/salary/payment/bg-lb-generator', () => ({
  generateBgLb: vi.fn(() => ({ content: 'LBFILE', filename: 'lb_2026-03.txt' })),
}))
vi.mock('@/lib/salary/payment/effective-net', () => ({
  effectiveNetPayout: vi.fn(() => 20000),
}))
vi.mock('@/lib/bankgiro/luhn', () => ({
  validateBankgiroNumber: vi.fn(() => true),
}))

import { GET } from '../route'
import { requireAuth } from '@/lib/auth/require-auth'
import { requireWritePermission } from '@/lib/auth/require-write'
import { generateBgLb } from '@/lib/salary/payment/bg-lb-generator'

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

describe('GET /api/salary/runs/[id]/payment/bg-lb', () => {
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
    const response = await GET(
      createMockRequest('/api/salary/runs/run-1/payment/bg-lb'),
      createMockRouteParams({ id: 'run-1' }),
    )
    expect(response.status).toBe(401)
  })

  it('returns 403 for a viewer', async () => {
    authed()
    vi.mocked(requireWritePermission).mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }),
    } as never)
    const response = await GET(
      createMockRequest('/api/salary/runs/run-1/payment/bg-lb'),
      createMockRouteParams({ id: 'run-1' }),
    )
    expect(response.status).toBe(403)
  })

  it('returns 400 pointing at the invoicing settings when bankgiro is empty', async () => {
    const { enqueueMany } = authed()
    enqueueMany([
      { data: { id: 'run-1', status: 'approved', period_year: 2026, period_month: 3, payment_date: '2026-03-25' } },
      { data: { name: 'Bolaget AB' } }, // companies
      { data: { company_name: 'Bolaget AB', bankgiro: null } }, // company_settings
    ])

    const response = await GET(
      createMockRequest('/api/salary/runs/run-1/payment/bg-lb'),
      createMockRouteParams({ id: 'run-1' }),
    )

    expect(response.status).toBe(400)
    const body = await response.json()
    // The message must name where the setting lives: the settings overview
    // shows a registry bankgiro this route does not read.
    expect(body.error).toContain('Inställningar → Fakturering')
  })

  it('returns 404 when the run does not exist', async () => {
    const { enqueueMany } = authed()
    enqueueMany([{ data: null }])

    const response = await GET(
      createMockRequest('/api/salary/runs/run-1/payment/bg-lb'),
      createMockRouteParams({ id: 'run-1' }),
    )

    expect(response.status).toBe(404)
  })

  it('returns 400 naming the employees whose account does not fit the LB field, never the number', async () => {
    // Invented numbers: the support-ticket shape. A 5-digit clearing with a
    // 10-digit account needs 11 positions in the 10-wide LB account field; the
    // toast used to read "Numeriskt fält för långt (11 > 10): 996...".
    const { enqueueMany } = authed()
    enqueueMany([
      { data: { id: 'run-1', status: 'approved', period_year: 2026, period_month: 9, payment_date: '2026-09-25' } },
      { data: { name: 'Bolaget AB' } }, // companies
      { data: { company_name: 'Bolaget AB', bankgiro: '123-4567' } }, // company_settings
      {
        data: [
          { employee_id: 'e1', employee: { first_name: 'Anna', last_name: 'A', clearing_number: '6000', bank_account_number: '1234567' } },
          { employee_id: 'e2', employee: { first_name: 'Sara', last_name: 'S', clearing_number: '8327-9', bank_account_number: '9612345678' } },
          { employee_id: 'e3', employee: { first_name: 'Sven', last_name: 'T', clearing_number: '81059', bank_account_number: '9698765432' } },
        ],
      }, // salary_run_employees
    ])

    const response = await GET(
      createMockRequest('/api/salary/runs/run-1/payment/bg-lb'),
      createMockRouteParams({ id: 'run-1' }),
    )

    expect(response.status).toBe(400)
    const text = await response.text()
    const body = JSON.parse(text)
    expect(body.error).toBe(
      'Sara S, Sven T: kontonumret ryms inte i Bankgirot LB-filen (femsiffrigt clearingnummer med tiosiffrigt kontonummer). Skapa betalfilen som ISO 20022 (pain.001) i stället.',
    )
    expect(text).not.toContain('9612345678')
    expect(text).not.toContain('9698765432')
    expect(text).not.toContain('996')
    expect(generateBgLb).not.toHaveBeenCalled()
  })

  it('generates a Bankgirot LB file for an approved run', async () => {
    const { enqueueMany } = authed()
    enqueueMany([
      { data: { id: 'run-1', status: 'approved', period_year: 2026, period_month: 3, payment_date: '2026-03-25' } },
      { data: { name: 'Bolaget AB' } }, // companies
      { data: { company_name: 'Bolaget AB', bankgiro: '123-4567' } }, // company_settings
      {
        data: [
          {
            employee: { first_name: 'Anna', last_name: 'A', clearing_number: '1234', bank_account_number: '567890' },
          },
        ],
      }, // salary_run_employees
      { data: null }, // salary_runs update (payment_file_generated_at)
    ])

    const response = await GET(
      createMockRequest('/api/salary/runs/run-1/payment/bg-lb'),
      createMockRouteParams({ id: 'run-1' }),
    )

    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toBe('text/plain; charset=iso-8859-1')
    expect(response.headers.get('Content-Disposition')).toContain('lb_2026-03.txt')
  })
})
