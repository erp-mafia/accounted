import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'
import { createMockRequest, createQueuedMockSupabase, parseJsonResponse } from '@/tests/helpers'

const { supabase, enqueue, reset, findCalls } = createQueuedMockSupabase()
const requireAuthMock = vi.fn()

vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))
vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))
vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))

import { GET } from '../route'

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const ORDER = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'

interface Answer {
  data: { warnings: Array<{ code: string; message_sv: string; message_en: string; payment_order_id?: string; supplier_invoice_id?: string }>; failed: boolean }
}

function get(searchParams: Record<string, string>) {
  return GET(createMockRequest('/api/supplier-invoices/bank-held-payments', { searchParams }), { params: Promise.resolve({}) })
}

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase })
})

describe('GET /api/supplier-invoices/bank-held-payments', () => {
  it('returns 401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({ error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) })
    const res = await get({ ids: A, via: 'bank_row' })
    expect(res.status).toBe(401)
  })

  it.each([
    ['ids that are not uuids', { ids: 'nope', via: 'bank_row' }],
    ['no ids', { ids: '', via: 'bank_row' }],
    ['no via', { ids: A }],
    ['an unknown via', { ids: A, via: 'cash' }],
    ['more ids than one read takes', { ids: Array.from({ length: 101 }, () => A).join(','), via: 'bank_row' }],
  ])('returns 400 VALIDATION_ERROR for %s, and reads nothing', async (_case, searchParams) => {
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(await get(searchParams))
    expect(status).toBe(400)
    expect(body.error.code).toBe('VALIDATION_ERROR')
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('answers a warning per payment the bank holds, naming the order and the invoice', async () => {
    enqueue({
      data: [
        {
          id: ORDER,
          supplier_invoice_id: B,
          status: 'accepted',
          requested_execution_date: '2026-12-10',
          amount: 12500,
          currency: 'SEK',
          payee_name: 'Leverantören AB',
          supplier_invoice: { supplier_invoice_number: 'F-7731' },
        },
      ],
    })

    const { status, body } = await parseJsonResponse<Answer>(await get({ ids: `${A},${B}`, via: 'bank_row' }))

    expect(status).toBe(200)
    expect(body.data.failed).toBe(false)
    expect(body.data.warnings).toHaveLength(1)
    expect(body.data.warnings[0]).toMatchObject({ code: 'SI_SIGNED_BANK_PAYMENT', payment_order_id: ORDER, supplier_invoice_id: B })
    expect(body.data.warnings[0]!.message_sv).toContain('med betalningsdag 2026-12-10')
    expect(body.data.warnings[0]!.message_sv).toContain('välj en annan rad')
    // Asked inside the active company, for exactly these invoices.
    expect(findCalls('payment_orders', 'eq')).toContainEqual(['company_id', 'company-1'])
    expect(findCalls('payment_orders', 'in')).toContainEqual(['supplier_invoice_id', [A, B]])
  })

  it('says a signed payment the way another way of paying is told it', async () => {
    enqueue({
      data: [
        {
          id: ORDER,
          supplier_invoice_id: A,
          status: 'awaiting_second_signer',
          requested_execution_date: '2026-12-10',
          amount: 400,
          currency: 'SEK',
          payee_name: 'Leverantören AB',
          supplier_invoice: null,
        },
      ],
    })

    const { body } = await parseJsonResponse<Answer>(await get({ ids: A, via: 'other' }))

    expect(body.data.warnings[0]!.message_sv).toContain('avbryt den under Betalningar först')
  })

  it('answers no warning when the bank holds no payment for the invoices', async () => {
    enqueue({ data: [] })

    const { status, body } = await parseJsonResponse<Answer>(await get({ ids: A, via: 'bank_row' }))

    expect(status).toBe(200)
    expect(body.data).toEqual({ warnings: [], failed: false })
  })

  it('says so when the orders could not be read: a warning, never "none"', async () => {
    enqueue({ data: null, error: { message: 'timeout' } })

    const { status, body } = await parseJsonResponse<Answer>(await get({ ids: A, via: 'bank_row' }))

    expect(status).toBe(200)
    expect(body.data.failed).toBe(true)
    expect(body.data.warnings.map((w) => w.code)).toEqual(['SI_BANK_PAYMENT_CHECK_FAILED'])
  })
})
