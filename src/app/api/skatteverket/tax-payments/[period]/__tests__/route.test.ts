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
    expect(body.data).toEqual({ ...AGI, payment_due_date: '2026-09-14', period_conflict: null, bank_payment: null })
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
  describe('a declaration holding one run of its month (crm#1768)', () => {
    const UNFILED = { ...AGI, status: 'generated', salary_run_id: 'run-own' }
    const OWN = { id: 'run-own', status: 'booked', period_year: 2026, period_month: 10, payment_date: '2026-10-25', corrects_run_id: null }
    const OTHER = { id: 'run-other', status: 'approved', period_year: 2026, period_month: 9, payment_date: '2026-10-05', corrects_run_id: null }
    const SETTINGS = { vat_registered: true, vat_taxable_base_over_40m: false }

    it('carries the refusal the payment file gives it, in both languages', async () => {
      enqueue({ data: UNFILED }) // agi_declarations
      enqueue({ data: SETTINGS }) // company_settings
      enqueue({ data: { id: 'run-own', corrects_run_id: null } }) // salary_runs: the declaration's run
      enqueue({ data: [OWN, OTHER] }) // salary_runs: live runs paid out in October

      const { status, body } = await parseJsonResponse<{ data: Record<string, unknown> }>(await get('2026-10'))

      expect(status).toBe(200)
      expect(body.data).toMatchObject({
        total_tax: 12000,
        period_conflict: {
          code: 'AGI_PAYMENT_PERIOD_CONFLICT',
          message: expect.stringMatching(/^Lönekörningen för 2026-09 med utbetalning 2026-10-05 hör också till redovisningsperiod 2026-10\./),
          message_en: expect.stringMatching(/^The salary run for 2026-09 paid out 2026-10-05 also belongs to reporting period 2026-10\./),
          details: { period: '2026-10', other_salary_run_id: 'run-other' },
        },
      })
      // The check's own columns are not part of the answer.
      expect(body.data).not.toHaveProperty('status')
      expect(body.data).not.toHaveProperty('salary_run_id')
    })

    it('answers null for a single-run month and for a filed declaration', async () => {
      enqueue({ data: UNFILED })
      enqueue({ data: SETTINGS })
      enqueue({ data: { id: 'run-own', corrects_run_id: null } })
      enqueue({ data: [OWN] })
      let { body } = await parseJsonResponse<{ data: Record<string, unknown> }>(await get('2026-10'))
      expect(body.data.period_conflict).toBeNull()

      reset()
      enqueue({ data: { ...UNFILED, status: 'submitted' } })
      enqueue({ data: SETTINGS })
      ;({ body } = await parseJsonResponse<{ data: Record<string, unknown> }>(await get('2026-10')))
      expect(body.data.period_conflict).toBeNull()
      expect(findCalls('salary_runs', 'select')).toEqual([])
    })

    it('fails the read when the runs cannot be read', async () => {
      enqueue({ data: UNFILED })
      enqueue({ data: SETTINGS })
      enqueue({ data: null, error: { message: 'connection reset', code: '08006' } })

      const response = await get('2026-10')

      expect(response.status).toBeGreaterThanOrEqual(500)
    })
  })

  describe('a bank payment that pays the declaration', () => {
    // A November AGI generated and filed, then paid through the bank from the
    // salary run's tax panel: signed, accepted by the bank, paid the banking
    // day before the due date (Monday 14 December).
    const FILED = { ...AGI, status: 'submitted', salary_run_id: 'run-1', created_at: '2026-11-20T09:00:00Z' }
    const SETTINGS = { vat_registered: true, vat_taxable_base_over_40m: false }
    const ACCEPTED = {
      status: 'accepted',
      amount: '24568.00',
      requested_execution_date: '2026-12-11',
      created_at: '2026-11-20T09:10:00Z',
      executed_at: null,
      signing: { status: 'completed', signing_started_at: '2026-11-20T09:10:05Z' },
    }

    it('answers the payment, so the panel stops offering to pay the month again', async () => {
      enqueue({ data: FILED }) // agi_declarations
      enqueue({ data: SETTINGS }) // company_settings
      enqueue({ data: [ACCEPTED] }) // payment_orders

      const { status, body } = await parseJsonResponse<{ data: Record<string, unknown> }>(await get('2026-11'))

      expect(status).toBe(200)
      expect(body.data.bank_payment).toEqual({
        status: 'accepted',
        amount: 24568,
        requested_execution_date: '2026-12-11',
        executed_at: null,
      })
      expect(body.data).not.toHaveProperty('created_at')
      expect(findCalls('payment_orders', 'eq')).toEqual([
        ['company_id', 'company-1'],
        ['purpose', 'skattekonto'],
      ])
      expect(findCalls('payment_orders', 'gte')).toEqual([['created_at', '2026-11-20T09:00:00Z']])
    })

    it('answers null for a payment of less than the declaration, and reads none once the month is marked paid', async () => {
      enqueue({ data: FILED })
      enqueue({ data: SETTINGS })
      enqueue({ data: [{ ...ACCEPTED, amount: '20000.00' }] })
      let { body } = await parseJsonResponse<{ data: Record<string, unknown> }>(await get('2026-11'))
      expect(body.data.bank_payment).toBeNull()

      reset()
      enqueue({ data: { ...FILED, tax_paid_at: '2026-12-14T00:00:00Z' } })
      enqueue({ data: SETTINGS })
      ;({ body } = await parseJsonResponse<{ data: Record<string, unknown> }>(await get('2026-11')))
      expect(body.data.bank_payment).toBeNull()
      expect(findCalls('payment_orders', 'select')).toEqual([])
    })

    it('fails the read when the payments cannot be read', async () => {
      enqueue({ data: FILED })
      enqueue({ data: SETTINGS })
      enqueue({ data: null, error: { message: 'connection reset', code: '08006' } })

      const response = await get('2026-11')

      expect(response.status).toBeGreaterThanOrEqual(500)
    })
  })
})
