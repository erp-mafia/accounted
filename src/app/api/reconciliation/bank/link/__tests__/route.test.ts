/**
 * Tests for POST /api/reconciliation/bank/link.
 *
 * Exercises the route through the real withRouteContext wrapper, mocking only
 * its auth/company/write dependencies plus the manualLink service. Covers:
 * 401, 403 viewer, validation (400), service failure (400), and happy path.
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

const manualLinkMock = vi.fn()
const linkToVouchersMock = vi.fn()
vi.mock('@/lib/reconciliation/bank-reconciliation', () => ({
  manualLink: (...args: unknown[]) => manualLinkMock(...args),
  linkTransactionToVouchers: (...args: unknown[]) => linkToVouchersMock(...args),
}))

import { POST } from '../route'

const emptyParams = { params: Promise.resolve({}) }
const TX_ID = '11111111-1111-4111-8111-111111111111'
const JE_ID = '22222222-2222-4222-8222-222222222222'
const JE_ID_2 = '33333333-3333-4333-8333-333333333333'

describe('POST /api/reconciliation/bank/link', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase })
    requireWriteMock.mockResolvedValue({ ok: true })
    manualLinkMock.mockResolvedValue({ success: true })
    linkToVouchersMock.mockResolvedValue({ success: true, allocations: [] })
  })

  it('returns 401 when unauthenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })

    const request = createMockRequest('/api/reconciliation/bank/link', {
      method: 'POST',
      body: { transaction_id: TX_ID, journal_entry_id: JE_ID },
    })

    const response = await POST(request, emptyParams)
    expect(response.status).toBe(401)
  })

  it('returns 403 for a viewer', async () => {
    requireWriteMock.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }),
    })

    const request = createMockRequest('/api/reconciliation/bank/link', {
      method: 'POST',
      body: { transaction_id: TX_ID, journal_entry_id: JE_ID },
    })

    const response = await POST(request, emptyParams)
    expect(response.status).toBe(403)
  })

  it('rejects a non-uuid transaction_id with 400', async () => {
    const request = createMockRequest('/api/reconciliation/bank/link', {
      method: 'POST',
      body: { transaction_id: 'not-a-uuid', journal_entry_id: JE_ID },
    })

    const response = await POST(request, emptyParams)
    expect(response.status).toBe(400)
    expect(manualLinkMock).not.toHaveBeenCalled()
  })

  it('surfaces a manualLink failure as 400 with the service error', async () => {
    manualLinkMock.mockResolvedValue({
      success: false,
      error: 'Transaktionen är redan kopplad till en verifikation.',
    })

    const request = createMockRequest('/api/reconciliation/bank/link', {
      method: 'POST',
      body: { transaction_id: TX_ID, journal_entry_id: JE_ID },
    })

    const response = await POST(request, emptyParams)
    const { status, body } = await parseJsonResponse<{ error: string }>(response)

    expect(status).toBe(400)
    expect(body.error).toBe('Transaktionen är redan kopplad till en verifikation.')
  })

  it('links the transaction, defaulting the account to 1930', async () => {
    const request = createMockRequest('/api/reconciliation/bank/link', {
      method: 'POST',
      body: { transaction_id: TX_ID, journal_entry_id: JE_ID },
    })

    const response = await POST(request, emptyParams)
    const { status, body } = await parseJsonResponse<{ data: { success: boolean } }>(response)

    expect(status).toBe(200)
    expect(body.data.success).toBe(true)
    expect(manualLinkMock).toHaveBeenCalledWith(
      supabase,
      'company-1',
      TX_ID,
      JE_ID,
      'user-1',
      '1930',
    )
  })

  it('splits the transaction over several verifikat when allocations are given instead of journal_entry_id (1:N, #1553)', async () => {
    linkToVouchersMock.mockResolvedValue({
      success: true,
      allocations: [
        { journal_entry_id: JE_ID, amount: -500 },
        { journal_entry_id: JE_ID_2, amount: -300 },
      ],
    })
    const request = createMockRequest('/api/reconciliation/bank/link', {
      method: 'POST',
      body: {
        transaction_id: TX_ID,
        account_number: '1940',
        allocations: [
          { journal_entry_id: JE_ID, amount: -500 },
          { journal_entry_id: JE_ID_2, amount: -300 },
        ],
      },
    })

    const response = await POST(request, emptyParams)
    const { status, body } = await parseJsonResponse<{ data: { success: boolean; allocations: unknown[] } }>(response)

    expect(status).toBe(200)
    expect(body.data.success).toBe(true)
    expect(body.data.allocations).toHaveLength(2)
    expect(linkToVouchersMock).toHaveBeenCalledWith(
      supabase,
      'company-1',
      TX_ID,
      [
        { journal_entry_id: JE_ID, amount: -500 },
        { journal_entry_id: JE_ID_2, amount: -300 },
      ],
      'user-1',
      '1940',
    )
    expect(manualLinkMock).not.toHaveBeenCalled()
  })

  it('rejects a body with both journal_entry_id and allocations, with neither, or with a single allocation (400)', async () => {
    const both = await POST(
      createMockRequest('/api/reconciliation/bank/link', {
        method: 'POST',
        body: {
          transaction_id: TX_ID,
          journal_entry_id: JE_ID,
          allocations: [
            { journal_entry_id: JE_ID, amount: -500 },
            { journal_entry_id: JE_ID_2, amount: -300 },
          ],
        },
      }),
      emptyParams,
    )
    expect(both.status).toBe(400)

    const neither = await POST(
      createMockRequest('/api/reconciliation/bank/link', { method: 'POST', body: { transaction_id: TX_ID } }),
      emptyParams,
    )
    expect(neither.status).toBe(400)

    const single = await POST(
      createMockRequest('/api/reconciliation/bank/link', {
        method: 'POST',
        body: { transaction_id: TX_ID, allocations: [{ journal_entry_id: JE_ID, amount: -800 }] },
      }),
      emptyParams,
    )
    expect(single.status).toBe(400)
    expect(manualLinkMock).not.toHaveBeenCalled()
    expect(linkToVouchersMock).not.toHaveBeenCalled()
  })

  it('surfaces a refused split as 400 with the service error', async () => {
    linkToVouchersMock.mockResolvedValue({
      success: false,
      error: 'Fördelningen (-700) stämmer inte med transaktionens belopp (-800).',
    })
    const response = await POST(
      createMockRequest('/api/reconciliation/bank/link', {
        method: 'POST',
        body: {
          transaction_id: TX_ID,
          allocations: [
            { journal_entry_id: JE_ID, amount: -400 },
            { journal_entry_id: JE_ID_2, amount: -300 },
          ],
        },
      }),
      emptyParams,
    )
    const { status, body } = await parseJsonResponse<{ error: string }>(response)
    expect(status).toBe(400)
    expect(body.error).toBe('Fördelningen (-700) stämmer inte med transaktionens belopp (-800).')
  })
})
