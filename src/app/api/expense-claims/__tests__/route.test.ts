/**
 * Auth-wiring + contract tests for /api/expense-claims (GET list, POST
 * register). The service is mocked; these tests pin the route's 401/403,
 * validation 400s, the result-code → status mapping, and the 201 shape.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import { createQueuedMockSupabase, createMockRequest, parseJsonResponse } from '@/tests/helpers'

const { supabase, reset } = createQueuedMockSupabase()

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))

vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

const requireWriteMock = vi.fn()
vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: (...args: unknown[]) => requireWriteMock(...args),
}))

vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))

const registerMock = vi.fn()
const listMock = vi.fn()
vi.mock('@/lib/expenses/expense-claims-service', () => ({
  registerExpenseClaim: (...args: unknown[]) => registerMock(...args),
  listExpenseClaims: (...args: unknown[]) => listMock(...args),
}))

import { GET, POST } from '../route'

function post(body: unknown) {
  return createMockRequest('/api/expense-claims', { method: 'POST', body })
}

const validClaim = {
  description: 'USB-hubb',
  expense_date: '2026-09-01',
  amount: 500,
  vat_amount: 100,
  expense_account: '5410',
  claimant_name: 'Joakim Hansson',
}

describe('/api/expense-claims', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase })
    requireWriteMock.mockResolvedValue({ ok: true })
    listMock.mockResolvedValue([])
    registerMock.mockResolvedValue({ ok: true, claim: { id: 'claim-1' } })
  })

  it('GET returns 401 when unauthenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })
    const response = await GET(createMockRequest('/api/expense-claims'), {} as never)
    expect(response.status).toBe(401)
  })

  it('GET lists claims and passes a valid status filter', async () => {
    listMock.mockResolvedValue([{ id: 'claim-1' }])
    const response = await GET(
      createMockRequest('/api/expense-claims?status=registered'),
      {} as never,
    )
    const { status, body } = await parseJsonResponse<{ data: { id: string }[] }>(response)
    expect(status).toBe(200)
    expect(body.data).toHaveLength(1)
    expect(listMock).toHaveBeenCalledWith(supabase, 'company-1', { status: 'registered' })
  })

  it('POST returns 403 for a viewer', async () => {
    requireWriteMock.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }),
    })
    const response = await POST(post(validClaim), {} as never)
    expect(response.status).toBe(403)
  })

  it('POST registers a claim (201)', async () => {
    const response = await POST(post(validClaim), {} as never)
    const { status, body } = await parseJsonResponse<{ data: { id: string } }>(response)
    expect(status).toBe(201)
    expect(body.data.id).toBe('claim-1')
  })

  it('POST rejects VAT >= amount with a field-level 400', async () => {
    const response = await POST(post({ ...validClaim, vat_amount: 500 }), {} as never)
    const { status, body } = await parseJsonResponse<{ errors: { field: string }[] }>(response)
    expect(status).toBe(400)
    expect(body.errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ field: 'vat_amount' })]),
    )
    expect(registerMock).not.toHaveBeenCalled()
  })

  it('POST rejects a claim without employee or claimant name', async () => {
    const { claimant_name: _omitted, ...rest } = validClaim
    const response = await POST(post(rest), {} as never)
    expect(response.status).toBe(400)
  })

  it.each([
    ['EMPLOYEE_NOT_FOUND', 404],
    ['RATE_UNAVAILABLE', 400],
    ['FISCAL_PERIOD_NOT_FOUND', 400],
    ['CLAIM_INSERT_FAILED', 500],
  ] as const)('POST maps service code %s to %d', async (code, expected) => {
    registerMock.mockResolvedValue({ ok: false, code })
    const response = await POST(post(validClaim), {} as never)
    const { status, body } = await parseJsonResponse<{ code: string }>(response)
    expect(status).toBe(expected)
    expect(body.code).toBe(code)
  })
})
