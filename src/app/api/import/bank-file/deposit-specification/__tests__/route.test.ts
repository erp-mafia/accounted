/**
 * Tests for POST /api/import/bank-file/deposit-specification (crm#1170): a
 * BG Max file is parsed here and handed to attachBgMaxDeposits (its matching
 * and writes are tested in lib/import/bgmax/__tests__/attach.test.ts). Covers
 * 401, the 400 refusals (no file, not a BG Max file, a test file, nothing to
 * attach), the read-only preview and the apply.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { septemberFile, start, opening, payment, depositRecord, end } from '@/lib/import/bgmax/__tests__/bgmax-fixture'

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
  getCompanyRole: vi.fn().mockResolvedValue({ ok: true, role: 'owner', companyId: 'company-1' }),
  requireWritePermission: (...args: unknown[]) => requireWriteMock(...args),
}))

const attachMock = vi.fn()
vi.mock('@/lib/import/bgmax/attach', () => ({
  attachBgMaxDeposits: (...args: unknown[]) => attachMock(...args),
}))

import { POST } from '../route'

const emptyParams = { params: Promise.resolve({}) }

function makeRequest(content: string | null, apply?: boolean) {
  const formData = new FormData()
  if (content !== null) formData.append('file', new File([content], 'BGMAX_20260930.txt', { type: 'text/plain' }))
  if (apply !== undefined) formData.append('apply', String(apply))
  return new Request('http://localhost:3000/api/import/bank-file/deposit-specification', { method: 'POST', body: formData })
}

const summary = (applied: boolean) => ({
  applied,
  deposits: 4,
  payments: 6,
  matched_deposits: 3,
  matched_payments: 5,
  suggested_payments: applied ? 4 : 0,
  ready_rows: applied ? 2 : 0,
  no_row: 1,
  ambiguous: 0,
  outcomes: [],
})

describe('POST /api/import/bank-file/deposit-specification', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase })
    requireWriteMock.mockResolvedValue({ ok: true })
    attachMock.mockImplementation(async (_supabase, input: { apply: boolean }) => summary(input.apply))
  })

  it('returns 401 when unauthenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })
    const response = await POST(makeRequest(septemberFile()), emptyParams)
    expect(response.status).toBe(401)
    expect(attachMock).not.toHaveBeenCalled()
  })

  it('refuses a request without a file', async () => {
    const response = await POST(makeRequest(null), emptyParams)
    expect(response.status).toBe(400)
    expect((await response.json()).error.code).toBe('BANK_FILE_NO_FILE')
  })

  it('refuses a file that is not a BG Max file', async () => {
    const response = await POST(makeRequest('Bokföringsdag;Text;Belopp\n2026-09-14;BG 123-4567;1500,00'), emptyParams)
    expect(response.status).toBe(400)
    expect((await response.json()).error.code).toBe('BGMAX_NOT_DEPOSIT_FILE')
    expect(attachMock).not.toHaveBeenCalled()
  })

  it('refuses a Bankgirot test file', async () => {
    const response = await POST(makeRequest(septemberFile().replace(start(), start('T')), true), emptyParams)
    expect(response.status).toBe(400)
    expect((await response.json()).error.code).toBe('BGMAX_TEST_FILE')
    expect(attachMock).not.toHaveBeenCalled()
  })

  it('refuses a file whose deposits do not add up', async () => {
    const broken = [
      start(),
      opening(),
      payment({ ore: 10000, reference: '10017' }),
      depositRecord({ date: '20260914', serial: 1, ore: 20000, count: 1 }),
      end({ payments: 1, deductions: 0, extra: 0, deposits: 1 }),
    ].join('\r\n')
    const response = await POST(makeRequest(broken, true), emptyParams)
    expect(response.status).toBe(400)
    expect((await response.json()).error.code).toBe('BGMAX_NO_DEPOSITS')
  })

  it('previews by default: matches the deposits without writing', async () => {
    const response = await POST(makeRequest(septemberFile()), emptyParams)
    expect(response.status).toBe(200)
    const { data } = await response.json()
    expect(attachMock).toHaveBeenCalledWith(
      supabase,
      expect.objectContaining({ companyId: 'company-1', userId: 'user-1', apply: false }),
    )
    expect(attachMock.mock.calls[0]![1].deposits).toHaveLength(4)
    expect(data).toMatchObject({ applied: false, date_from: '2026-09-14', date_to: '2026-09-30', matched_deposits: 3, no_row: 1 })
  })

  it('attaches when asked to apply', async () => {
    const response = await POST(makeRequest(septemberFile(), true), emptyParams)
    expect(response.status).toBe(200)
    const { data } = await response.json()
    expect(attachMock).toHaveBeenCalledWith(supabase, expect.objectContaining({ apply: true }))
    expect(data).toMatchObject({ applied: true, matched_payments: 5, ready_rows: 2, filename: 'BGMAX_20260930.txt' })
  })

  it('is closed to a viewer', async () => {
    requireWriteMock.mockResolvedValue({ ok: false, response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) })
    const response = await POST(makeRequest(septemberFile(), true), emptyParams)
    expect(response.status).toBe(403)
    expect(attachMock).not.toHaveBeenCalled()
  })
})
