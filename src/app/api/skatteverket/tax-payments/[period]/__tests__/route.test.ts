import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
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

const resolveDueDateMock = vi.fn()
vi.mock('@/lib/payments/orders/skattekonto-sources', () => ({
  resolveSkattekontoDueDate: (...args: unknown[]) => resolveDueDateMock(...args),
}))

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
  describe('a bank payment to the skattekonto on the day the period is paid on', () => {
    const FILED = { ...AGI, status: 'submitted', salary_run_id: 'run-own' }
    const SETTINGS = { vat_registered: true, vat_taxable_base_over_40m: false }

    beforeEach(() => {
      // The November AGI the evening it was filed and paid: due Saturday
      // 12 December, so Monday the 14th, and paid the Friday before.
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(new Date('2026-11-24T21:10:00+01:00'))
    })
    afterEach(() => {
      vi.useRealTimers()
    })

    it('carries a payment already signed for that day, so the panel offers no second one', async () => {
      enqueue({ data: FILED }) // agi_declarations
      enqueue({ data: SETTINGS }) // company_settings
      enqueue({
        data: [{ id: 'order-1', status: 'accepted', amount: '24568.00', batch_id: 'batch-1', requested_execution_date: '2026-12-11' }],
      }) // payment_orders

      const { status, body } = await parseJsonResponse<{ data: Record<string, unknown> }>(await get('2026-11'))

      expect(status).toBe(200)
      expect(body.data.payment_due_date).toBe('2026-12-14')
      expect(body.data.bank_payment).toEqual({
        status: 'accepted',
        amount: 24568,
        requested_execution_date: '2026-12-11',
        pays_declaration: true,
      })
      expect(findCalls('payment_orders', 'eq')).toEqual([
        ['company_id', 'company-1'],
        ['purpose', 'skattekonto'],
      ])
      expect(findCalls('payment_orders', 'in')[0]).toEqual(['requested_execution_date', ['2026-12-11']])
      // Cancelled, failed and rejected orders pay nothing: never read.
      expect(findCalls('payment_orders', 'in')[1]).toEqual([
        'status',
        ['draft', 'approved', 'submitted', 'awaiting_signature', 'awaiting_second_signer', 'accepted', 'executed'],
      ])
    })

    // Everything declared due on Monday 14 December: the quarter's moms and the November AGI.
    const DUE_DAY = {
      ok: true,
      combined: {
        due_date: '2026-12-14',
        total: 84568,
        components: [
          { source: 'vat_declaration', period: '2026-Q3', amount: 60000 },
          { source: 'agi', period: '2026-11', amount: 24568 },
        ],
        excluded: [],
      },
      parts: [],
    }
    const accepted = (amount: string) => ({
      data: [{ id: 'order-1', status: 'accepted', amount, batch_id: 'batch-1', requested_execution_date: '2026-12-11' }],
    })

    it('asks nothing more of a payment of exactly the declaration', async () => {
      enqueue({ data: FILED })
      enqueue({ data: SETTINGS })
      enqueue(accepted('24568.00'))

      const { body } = await parseJsonResponse<{ data: Record<string, unknown> }>(await get('2026-11'))

      expect(body.data.bank_payment).toMatchObject({ pays_declaration: true })
      expect(resolveDueDateMock).not.toHaveBeenCalled()
    })

    it('shows a larger payment of the same day without reading it as this declaration\'s', async () => {
      // The momsdeklaration due the same day, paid on its own: 60 000 kr.
      resolveDueDateMock.mockResolvedValue(DUE_DAY)
      enqueue({ data: FILED })
      enqueue({ data: SETTINGS })
      enqueue(accepted('60000.00'))

      const { body } = await parseJsonResponse<{ data: Record<string, unknown> }>(await get('2026-11'))

      expect(body.data.bank_payment).toEqual({
        status: 'accepted',
        amount: 60000,
        requested_execution_date: '2026-12-11',
        pays_declaration: false,
      })
      expect(resolveDueDateMock).toHaveBeenCalledWith(mockSupabase, 'company-1', '2026-12-14', '2026-11-24')
    })

    it('reads a payment of everything due that day as paying it', async () => {
      // Betala allt som förfaller: the moms and the AGI as one payment.
      resolveDueDateMock.mockResolvedValue(DUE_DAY)
      enqueue({ data: FILED })
      enqueue({ data: SETTINGS })
      enqueue(accepted('84568.00'))

      const { body } = await parseJsonResponse<{ data: Record<string, unknown> }>(await get('2026-11'))

      expect(body.data.bank_payment).toMatchObject({ amount: 84568, pays_declaration: true })
    })

    it('does not read the day\'s sum as paying an AGI that is not part of it', async () => {
      resolveDueDateMock.mockResolvedValue({
        ...DUE_DAY,
        combined: { ...DUE_DAY.combined, components: [{ source: 'vat_declaration', period: '2026-Q3', amount: 84568 }] },
      })
      enqueue({ data: FILED })
      enqueue({ data: SETTINGS })
      enqueue(accepted('84568.00'))

      const { body } = await parseJsonResponse<{ data: Record<string, unknown> }>(await get('2026-11'))

      expect(body.data.bank_payment).toMatchObject({ pays_declaration: false })
    })

    it('still shows the payment when the day cannot be read, and offers the button', async () => {
      resolveDueDateMock.mockRejectedValue(new Error('vat report failed'))
      enqueue({ data: FILED })
      enqueue({ data: SETTINGS })
      enqueue(accepted('84568.00'))

      const { status, body } = await parseJsonResponse<{ data: Record<string, unknown> }>(await get('2026-11'))

      expect(status).toBe(200)
      expect(body.data.bank_payment).toMatchObject({ amount: 84568, pays_declaration: false })
    })

    it('still finds it on its own day and once the bank has executed it', async () => {
      // 11 December: the bank takes nothing before the 14th now, so both days are read.
      vi.setSystemTime(new Date('2026-12-11T09:00:00+01:00'))
      enqueue({ data: FILED })
      enqueue({ data: SETTINGS })
      enqueue({
        data: [{ id: 'order-1', status: 'executed', amount: '24568.00', batch_id: 'batch-1', requested_execution_date: '2026-12-11' }],
      })

      const { body } = await parseJsonResponse<{ data: Record<string, unknown> }>(await get('2026-11'))

      expect(body.data.bank_payment).toEqual({
        status: 'executed',
        amount: 24568,
        requested_execution_date: '2026-12-11',
        pays_declaration: true,
      })
      expect(findCalls('payment_orders', 'in')[0]).toEqual(['requested_execution_date', ['2026-12-11', '2026-12-14']])
    })

    it('leaves out a draft nobody signed: a new payment joins it', async () => {
      enqueue({ data: FILED })
      enqueue({ data: SETTINGS })
      enqueue({ data: [{ id: 'order-1', status: 'draft', amount: '24568.00', batch_id: null, requested_execution_date: '2026-12-11' }] })

      const { body } = await parseJsonResponse<{ data: Record<string, unknown> }>(await get('2026-11'))

      expect(body.data.bank_payment).toBeNull()
    })

    it('counts an approved payment once it is claimed for signing', async () => {
      enqueue({ data: FILED })
      enqueue({ data: SETTINGS })
      enqueue({ data: [{ id: 'order-1', status: 'approved', amount: '24568.00', batch_id: 'batch-1', requested_execution_date: '2026-12-11' }] })

      const { body } = await parseJsonResponse<{ data: Record<string, unknown> }>(await get('2026-11'))

      expect(body.data.bank_payment).toMatchObject({ status: 'approved' })
    })

    it('reads no payments for a period marked paid', async () => {
      enqueue({ data: { ...FILED, tax_paid_at: '2026-11-24T20:00:00Z' } })
      enqueue({ data: SETTINGS })

      const { body } = await parseJsonResponse<{ data: Record<string, unknown> }>(await get('2026-11'))

      expect(body.data.bank_payment).toBeNull()
      expect(findCalls('payment_orders', 'select')).toEqual([])
    })

    it('answers without it when the payments cannot be read: it only informs', async () => {
      enqueue({ data: FILED })
      enqueue({ data: SETTINGS })
      enqueue({ data: null, error: { message: 'connection reset', code: '08006' } })

      const { status, body } = await parseJsonResponse<{ data: Record<string, unknown> }>(await get('2026-11'))

      expect(status).toBe(200)
      expect(body.data).toMatchObject({ total_tax: 12000, payment_due_date: '2026-12-14', bank_payment: null })
    })
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
})
