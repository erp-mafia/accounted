import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import {
  createMockRequest,
  parseJsonResponse,
  createMockRouteParams,
  createQueuedMockSupabase,
} from '@/tests/helpers'

const { supabase: mockSupabase, reset } = createQueuedMockSupabase()

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))

vi.mock('@/lib/init', () => ({
  ensureInitialized: vi.fn(),
}))

vi.mock('@/lib/company/context', () => ({
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: vi.fn().mockResolvedValue({ ok: true }),
}))

const uncreditInvoiceMock = vi.fn()
vi.mock('@/lib/invoices/uncredit-invoice', () => ({
  uncreditInvoice: (...args: unknown[]) => uncreditInvoiceMock(...args),
}))

import { eventBus } from '@/lib/events'
import { POST } from '../route'

const INVOICE_ID = '7b1f3c2e-9a4d-4e8b-8c1a-2f5d6e7a8b9c'

function post(body: unknown, id = INVOICE_ID) {
  const request = createMockRequest(`/api/invoices/${id}/uncredit`, { method: 'POST', body })
  return POST(request, createMockRouteParams({ id }))
}

describe('POST /api/invoices/[id]/uncredit', () => {
  const mockUser = { id: 'user-1', email: 'test@test.se' }

  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    eventBus.clear()
    requireAuthMock.mockResolvedValue({ user: mockUser, supabase: mockSupabase, error: null })
  })

  it('returns 401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase: mockSupabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })
    const { status } = await parseJsonResponse(await post({}))
    expect(status).toBe(401)
    expect(uncreditInvoiceMock).not.toHaveBeenCalled()
  })

  it('returns 400 for an id that is not a uuid', async () => {
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(await post({}, 'not-a-uuid'))
    expect(status).toBe(400)
    expect(body.error.code).toBe('VALIDATION_ERROR')
    expect(uncreditInvoiceMock).not.toHaveBeenCalled()
  })

  it('returns 400 for a body of the wrong shape', async () => {
    const { status } = await parseJsonResponse(await post({ attest_not_delivered: 'yes' }))
    expect(status).toBe(400)
    expect(uncreditInvoiceMock).not.toHaveBeenCalled()
  })

  it('returns 404 when the invoice is not found', async () => {
    uncreditInvoiceMock.mockResolvedValue({ ok: false, code: 'INVOICE_NOT_FOUND' })
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(await post({}))
    expect(status).toBe(404)
    expect(body.error.code).toBe('INVOICE_NOT_FOUND')
  })

  it('answers a delivered credit note with 409 INVOICE_UNCREDIT_DELIVERED and its details', async () => {
    uncreditInvoiceMock.mockResolvedValue({
      ok: false,
      code: 'INVOICE_UNCREDIT_DELIVERED',
      details: { credit_note_id: 'credit-1', credit_note_number: 'KR-1042', copy_from_invoice_id: INVOICE_ID },
    })
    const { status, body } = await parseJsonResponse<{
      error: { code: string; message: string; details: Record<string, unknown> }
    }>(await post({ attest_not_delivered: true }))
    expect(status).toBe(409)
    expect(body.error.code).toBe('INVOICE_UNCREDIT_DELIVERED')
    expect(body.error.message).toContain('kopia')
    expect(body.error.details).toMatchObject({ copy_from_invoice_id: INVOICE_ID })
  })

  it('dry run: hands the flag through and answers the preview', async () => {
    uncreditInvoiceMock.mockResolvedValue({
      ok: true,
      dryRun: true,
      preview: { changed: true, attestation_required: true, posts_storno: true },
    })
    const { status, body } = await parseJsonResponse<{ data: Record<string, unknown> }>(await post({ dry_run: true }))
    expect(status).toBe(200)
    expect(body.data).toMatchObject({ attestation_required: true, posts_storno: true })
    expect(uncreditInvoiceMock).toHaveBeenCalledWith(
      expect.objectContaining({ companyId: 'company-1', userId: 'user-1' }),
      INVOICE_ID,
      { attestNotDelivered: false },
      { dryRun: true },
    )
  })

  it('undoes the credit with the attestation and answers the restored invoice', async () => {
    uncreditInvoiceMock.mockResolvedValue({
      ok: true,
      data: {
        invoice: { id: INVOICE_ID, status: 'paid' },
        changed: true,
        credit_note_id: 'credit-1',
        reversal_entry_id: 'je-storno',
      },
    })
    const { status, body } = await parseJsonResponse<{
      data: { status: string }
      changed: boolean
      credit_note_id: string
      reversal_entry_id: string
    }>(await post({ attest_not_delivered: true }))
    expect(status).toBe(200)
    expect(body).toMatchObject({
      data: { status: 'paid' },
      changed: true,
      credit_note_id: 'credit-1',
      reversal_entry_id: 'je-storno',
    })
    expect(uncreditInvoiceMock).toHaveBeenCalledWith(
      expect.anything(),
      INVOICE_ID,
      { attestNotDelivered: true },
      { dryRun: false },
    )
  })
})
