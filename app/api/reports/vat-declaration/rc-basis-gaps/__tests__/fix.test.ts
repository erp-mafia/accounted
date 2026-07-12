/**
 * Tests for POST /api/reports/vat-declaration/rc-basis-gaps/fix.
 *
 * Exercises the route through the real withRouteContext wrapper, mocking its
 * auth/company/write dependencies and correctEntry(). Covers: 401, viewer 403
 * (the route corrects posted entries, so requireWrite must gate it),
 * validation 400, entry 404, and the happy-path correction.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import { createQueuedMockSupabase, createMockRequest, parseJsonResponse } from '@/tests/helpers'

const { supabase, enqueue, reset } = createQueuedMockSupabase()

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

const correctEntryMock = vi.fn()
vi.mock('@/lib/core/bookkeeping/storno-service', () => ({
  correctEntry: (...args: unknown[]) => correctEntryMock(...args),
}))

import { POST } from '../fix/route'

const ENTRY_ID = '11111111-1111-4111-8111-111111111111'

function fixRequest(body: Record<string, unknown>) {
  return createMockRequest('/api/reports/vat-declaration/rc-basis-gaps/fix', {
    method: 'POST',
    body,
  })
}

const validBody = {
  entryId: ENTRY_ID,
  supplierType: 'eu_business',
  supplyType: 'service',
}

describe('POST /api/reports/vat-declaration/rc-basis-gaps/fix', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase })
    requireWriteMock.mockResolvedValue({ ok: true })
  })

  it('returns 401 when unauthenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })

    const response = await POST(fixRequest(validBody), { params: Promise.resolve({}) })
    expect(response.status).toBe(401)
  })

  it('returns 403 for a viewer-role member (requireWrite gate)', async () => {
    requireWriteMock.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }),
    })

    const response = await POST(fixRequest(validBody), { params: Promise.resolve({}) })
    expect(response.status).toBe(403)
    expect(correctEntryMock).not.toHaveBeenCalled()
  })

  it('returns 400 for an invalid body (bad supplierType)', async () => {
    const response = await POST(
      fixRequest({ ...validBody, supplierType: 'martian_business' }),
      { params: Promise.resolve({}) },
    )
    const { status } = await parseJsonResponse(response)
    expect(status).toBe(400)
  })

  it('returns 404 when the entry does not exist in the company', async () => {
    enqueue({ data: null, error: { message: 'not found' } })

    const response = await POST(fixRequest(validBody), { params: Promise.resolve({}) })
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(response)

    expect(status).toBe(404)
    expect(body.error.code).toBe('JOURNAL_ENTRY_NOT_FOUND')
  })

  it('corrects a posted entry with missing basis lines (happy path)', async () => {
    enqueue({
      data: {
        id: ENTRY_ID,
        status: 'posted',
        lines: [
          {
            account_number: '2614',
            debit_amount: 0,
            credit_amount: 2500,
            line_description: 'Beräknad utgående moms EU-tjänst',
          },
          {
            account_number: '2645',
            debit_amount: 2500,
            credit_amount: 0,
            line_description: 'Beräknad ingående moms',
          },
        ],
      },
    })
    correctEntryMock.mockResolvedValue({
      reversal: { id: 'rev-1' },
      corrected: { id: 'cor-1' },
    })

    const response = await POST(fixRequest(validBody), { params: Promise.resolve({}) })
    const { status, body } = await parseJsonResponse<{
      data: { reversalId: string; correctedId: string; basisAccount: string; basisAmount: number }
    }>(response)

    expect(status).toBe(200)
    expect(body.data.reversalId).toBe('rev-1')
    expect(body.data.correctedId).toBe('cor-1')
    expect(correctEntryMock).toHaveBeenCalledWith(
      supabase,
      'company-1',
      'user-1',
      ENTRY_ID,
      expect.any(Array),
    )
  })
})
