import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import {
  createMockRequest,
  parseJsonResponse,
  createQueuedMockSupabase,
} from '@/tests/helpers'
import { eventBus } from '@/lib/events/bus'
import { getErrorEntry } from '@/lib/errors/structured-errors'

const { supabase: mockSupabase, enqueue, reset } = createQueuedMockSupabase()

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))

vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))

vi.mock('@/lib/company/context', () => ({
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

const requireWriteMock = vi.fn()
vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: (...args: unknown[]) => requireWriteMock(...args),
}))

const mockCommit = vi.fn()
vi.mock('@/lib/pending-operations/commit', () => ({
  commitPendingOperation: (...args: unknown[]) => mockCommit(...args),
}))
const mockRecordAppApproval = vi.fn()
vi.mock('@/lib/pending-operations/record-app-approval', () => ({
  recordAppApproval: (...args: unknown[]) => mockRecordAppApproval(...args),
}))

// The staged attests' answers: one batch per request, flushed once after the loop.
const attestBatch = vi.hoisted(() => ({ add: vi.fn(), size: 0, flush: vi.fn() }))
vi.mock('@/lib/supplier-invoices/attest-decision-notify', () => ({
  createAttestDecisionBatch: () => attestBatch,
}))

import { POST } from '../route'

const emptyParams = { params: Promise.resolve({}) }

const VALID_ID_1 = '11111111-1111-4111-8111-111111111111'
const VALID_ID_2 = '22222222-2222-4222-8222-222222222222'
const VALID_ID_3 = '33333333-3333-4333-8333-333333333333'
const VALID_ID_4 = '44444444-4444-4444-8444-444444444444'
const VALID_ID_5 = '55555555-5555-4555-8555-555555555555'

function makeOp(overrides: Record<string, unknown> = {}) {
  return {
    id: VALID_ID_1,
    company_id: 'company-1',
    user_id: 'user-1',
    operation_type: 'categorize_transaction',
    status: 'pending',
    risk_level: 'low',
    title: 'Kategorisera test',
    params: {},
    preview_data: {},
    ...overrides,
  }
}

describe('POST /api/pending-operations/bulk-commit', () => {
  const mockUser = { id: 'user-1', email: 'test@test.se' }

  beforeEach(() => {
    vi.clearAllMocks()
    eventBus.clear()
    reset()
    requireAuthMock.mockResolvedValue({ user: mockUser, supabase: mockSupabase, error: null })
    requireWriteMock.mockResolvedValue({ ok: true })
  })

  it('returns 401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase: mockSupabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })

    const request = createMockRequest('/api/pending-operations/bulk-commit', {
      method: 'POST',
      body: { ids: [VALID_ID_1] },
    })
    const response = await POST(request)
    const { status, body } = await parseJsonResponse(response)

    expect(status).toBe(401)
    expect(body).toEqual({ error: 'Unauthorized' })
  })

  it('returns 403 for a viewer without write permission', async () => {
    requireWriteMock.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }),
    })

    const request = createMockRequest('/api/pending-operations/bulk-commit', {
      method: 'POST',
      body: { ids: [VALID_ID_1] },
    })
    const response = await POST(request)
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(403)
  })

  it('returns 400 when ids array is empty', async () => {
    const request = createMockRequest('/api/pending-operations/bulk-commit', {
      method: 'POST',
      body: { ids: [] },
    })
    const response = await POST(request)
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(400)
    expect(mockCommit).not.toHaveBeenCalled()
  })

  it('returns 400 when ids contain non-UUID values', async () => {
    const request = createMockRequest('/api/pending-operations/bulk-commit', {
      method: 'POST',
      body: { ids: ['not-a-uuid'] },
    })
    const response = await POST(request)
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(400)
    expect(mockCommit).not.toHaveBeenCalled()
  })

  it('returns 400 when ids exceed 100 items', async () => {
    const ids = Array.from({ length: 101 }, (_, i) => {
      const hex = i.toString(16).padStart(4, '0')
      return `${hex}${hex}${hex}${hex}-${hex}${hex}-4${hex.slice(1)}-8${hex.slice(1)}-${hex}${hex}${hex}${hex}${hex}${hex}`
    })
    const request = createMockRequest('/api/pending-operations/bulk-commit', {
      method: 'POST',
      body: { ids },
    })
    const response = await POST(request)
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(400)
    expect(mockCommit).not.toHaveBeenCalled()
  })

  it('returns 500 when fetching pending operations fails', async () => {
    enqueue({ data: null, error: { message: 'db connection lost' } })

    const request = createMockRequest('/api/pending-operations/bulk-commit', {
      method: 'POST',
      body: { ids: [VALID_ID_1] },
    })
    const response = await POST(request)
    const { status, body } = await parseJsonResponse<{ error: string }>(response)

    expect(status).toBe(500)
    // Raw Supabase messages never reach the response field (issue #337).
    expect(body.error).toBe('Åtgärderna kunde inte hämtas. Försök igen.')
  })

  it('reports per-item not-found as failed without calling commit', async () => {
    enqueue({ data: [] })

    const request = createMockRequest('/api/pending-operations/bulk-commit', {
      method: 'POST',
      body: { ids: [VALID_ID_1] },
    })
    const response = await POST(request)
    const { status, body } = await parseJsonResponse<{
      data: {
        results: Array<{ id: string; status: string; error?: string }>
        summary: { total: number; committed: number; failed: number; skipped: number; rejected: number }
      }
    }>(response)

    expect(status).toBe(200)
    expect(body.data.results).toEqual([
      { id: VALID_ID_1, status: 'failed', error: 'Åtgärden kunde inte hittas.' },
    ])
    expect(body.data.summary).toEqual({
      total: 1,
      committed: 0,
      failed: 1,
      skipped: 0,
      rejected: 0,
    })
    expect(mockCommit).not.toHaveBeenCalled()
  })

  it('skips non-pending operations and high-risk operations', async () => {
    enqueue({
      data: [
        makeOp({ id: VALID_ID_1, status: 'committed' }),
        makeOp({ id: VALID_ID_2, status: 'pending', risk_level: 'high' }),
      ],
    })

    const request = createMockRequest('/api/pending-operations/bulk-commit', {
      method: 'POST',
      body: { ids: [VALID_ID_1, VALID_ID_2] },
    })
    const response = await POST(request)
    const { status, body } = await parseJsonResponse<{
      data: {
        results: Array<{ id: string; status: string; error?: string }>
        summary: { total: number; committed: number; failed: number; skipped: number; rejected: number }
      }
    }>(response)

    expect(status).toBe(200)
    expect(body.data.results).toEqual([
      { id: VALID_ID_1, status: 'skipped', error: 'Redan hanterad (godkänd)' },
      {
        id: VALID_ID_2,
        status: 'skipped',
        error: 'Hög risk: kräver individuellt godkännande',
      },
    ])
    expect(body.data.summary).toEqual({
      total: 2,
      committed: 0,
      failed: 0,
      skipped: 2,
      rejected: 0,
    })
    expect(mockCommit).not.toHaveBeenCalled()
    expect(mockRecordAppApproval).not.toHaveBeenCalled()
  })

  it('hands every commit one batch for the staged attests\' answers and flushes it once, after the loop', async () => {
    enqueue({
      data: [VALID_ID_1, VALID_ID_2, VALID_ID_3].map((id, i) =>
        makeOp({ id, operation_type: 'approve_supplier_invoice', params: { supplier_invoice_id: `si-${i}` } }),
      ),
    })
    mockCommit.mockResolvedValue({ status: 'committed', data: {} })
    attestBatch.flush.mockResolvedValue(undefined)

    const request = createMockRequest('/api/pending-operations/bulk-commit', {
      method: 'POST',
      body: { ids: [VALID_ID_1, VALID_ID_2, VALID_ID_3] },
    })
    const { status } = await parseJsonResponse(await POST(request, emptyParams))

    expect(status).toBe(200)
    expect(mockCommit).toHaveBeenCalledTimes(3)
    for (const call of mockCommit.mock.calls) {
      expect(call[4]).toMatchObject({ commitMethod: 'bulk_accept', attestDecisions: attestBatch })
    }
    // One flush for the whole approval: one mail per company and attester, not one per invoice.
    expect(attestBatch.flush).toHaveBeenCalledTimes(1)
    expect(attestBatch.flush.mock.invocationCallOrder[0]).toBeGreaterThan(mockCommit.mock.invocationCallOrder[2])
  })

  it('still tells the answers already stored when an approval throws: the flush is in a finally', async () => {
    enqueue({
      data: [VALID_ID_1, VALID_ID_2].map((id, i) =>
        makeOp({ id, operation_type: 'approve_supplier_invoice', params: { supplier_invoice_id: `si-${i}` } }),
      ),
    })
    mockCommit.mockResolvedValueOnce({ status: 'committed', data: {} }).mockRejectedValueOnce(new Error('connection reset'))
    attestBatch.flush.mockResolvedValue(undefined)

    const request = createMockRequest('/api/pending-operations/bulk-commit', {
      method: 'POST',
      body: { ids: [VALID_ID_1, VALID_ID_2] },
    })
    const response = await POST(request, emptyParams)

    expect(response.status).toBe(500)
    expect(mockCommit).toHaveBeenCalledTimes(2)
    expect(attestBatch.flush).toHaveBeenCalledTimes(1)
  })

  describe('one acknowledgment for routine high-risk operations (crm#1489)', () => {
    const samlingsverifikat = (id: string, params: Record<string, unknown> = {}, preview: Record<string, unknown> = {}) =>
      makeOp({
        id,
        operation_type: 'bulk_book_transactions',
        risk_level: 'high',
        params: { tx_ids: ['tx-1'], entry_description: 'Stripe 2026-06-29', manual_lines: [], ...params },
        preview_data: { mode: 'create_new', tx_sum: 199, tx_date: '2026-06-29', ...preview },
      })

    it('commits new samlingsverifikat in an acknowledged group and records the shared acknowledgment', async () => {
      enqueue({ data: [samlingsverifikat(VALID_ID_1), samlingsverifikat(VALID_ID_2)] })
      mockCommit.mockResolvedValue({ status: 'committed', data: {} })

      const request = createMockRequest('/api/pending-operations/bulk-commit', {
        method: 'POST',
        body: { ids: [VALID_ID_1, VALID_ID_2], acknowledged_groups: ['bulk_book_create_new'] },
      })
      const { status, body } = await parseJsonResponse<{
        data: { results: Array<{ id: string; status: string }> }
      }>(await POST(request, emptyParams))

      expect(status).toBe(200)
      expect(body.data.results).toEqual([
        { id: VALID_ID_1, status: 'committed' },
        { id: VALID_ID_2, status: 'committed' },
      ])
      expect(mockCommit).toHaveBeenCalledTimes(2)
      expect(mockRecordAppApproval).toHaveBeenCalledWith(
        expect.objectContaining({
          operation: expect.objectContaining({ id: VALID_ID_1 }),
          commitMethod: 'bulk_accept',
          sharedAcknowledgment: 'bulk_book_create_new',
        }),
      )
    })

    it('still skips a samlingsverifikat when the group was not acknowledged', async () => {
      enqueue({ data: [samlingsverifikat(VALID_ID_1)] })

      const request = createMockRequest('/api/pending-operations/bulk-commit', {
        method: 'POST',
        body: { ids: [VALID_ID_1] },
      })
      const { body } = await parseJsonResponse<{
        data: { results: Array<{ id: string; status: string; error?: string }> }
      }>(await POST(request, emptyParams))

      expect(body.data.results).toEqual([
        { id: VALID_ID_1, status: 'skipped', error: 'Hög risk: kräver individuellt godkännande' },
      ])
      expect(mockCommit).not.toHaveBeenCalled()
    })

    it('keeps individual risk individual under an acknowledgment: link, duplicate override, warning, other types', async () => {
      enqueue({
        data: [
          samlingsverifikat(VALID_ID_1, { existing_journal_entry_id: 'je-1' }),
          samlingsverifikat(VALID_ID_2, { force: true }),
          samlingsverifikat(VALID_ID_3, {}, { compliance_warning: 'Underlag saknas' }),
          makeOp({ id: VALID_ID_4, operation_type: 'create_voucher', risk_level: 'high' }),
        ],
      })

      const request = createMockRequest('/api/pending-operations/bulk-commit', {
        method: 'POST',
        body: {
          ids: [VALID_ID_1, VALID_ID_2, VALID_ID_3, VALID_ID_4],
          acknowledged_groups: ['bulk_book_create_new'],
        },
      })
      const { body } = await parseJsonResponse<{
        data: { results: Array<{ id: string; status: string }>; summary: { skipped: number } }
      }>(await POST(request, emptyParams))

      expect(body.data.results.map((r) => r.status)).toEqual(['skipped', 'skipped', 'skipped', 'skipped'])
      expect(body.data.summary.skipped).toBe(4)
      expect(mockCommit).not.toHaveBeenCalled()
    })

    it('commits acknowledged webshop orders and keeps one with a warning individual (I12)', async () => {
      const order = (id: string, warnings: string[]) =>
        makeOp({
          id,
          operation_type: 'book_webshop_order',
          risk_level: 'high',
          params: { webshop_order_id: 'o-1', lines: [] },
          preview_data: {
            row_type: 'order',
            total_sek: 125,
            warnings,
            journal_entry: { entry_date: '2026-10-14', lines: [{ account_number: '1686', debit_amount: 125, credit_amount: 0 }] },
          },
        })
      enqueue({ data: [order(VALID_ID_1, []), order(VALID_ID_2, ['foreign_vat'])] })
      mockCommit.mockResolvedValue({ status: 'committed', data: {} })

      const request = createMockRequest('/api/pending-operations/bulk-commit', {
        method: 'POST',
        body: { ids: [VALID_ID_1, VALID_ID_2], acknowledged_groups: ['webshop_order_book'] },
      })
      const { status, body } = await parseJsonResponse<{
        data: { results: Array<{ id: string; status: string }> }
      }>(await POST(request, emptyParams))

      expect(status).toBe(200)
      expect(body.data.results.map((r) => r.status)).toEqual(['committed', 'skipped'])
      expect(mockCommit).toHaveBeenCalledTimes(1)
      expect(mockRecordAppApproval).toHaveBeenCalledWith(
        expect.objectContaining({ sharedAcknowledgment: 'webshop_order_book' }),
      )
    })

    it('does not let the webshop acknowledgment approve a samlingsverifikat', async () => {
      enqueue({ data: [samlingsverifikat(VALID_ID_1)] })

      const request = createMockRequest('/api/pending-operations/bulk-commit', {
        method: 'POST',
        body: { ids: [VALID_ID_1], acknowledged_groups: ['webshop_order_book'] },
      })
      const { body } = await parseJsonResponse<{
        data: { results: Array<{ id: string; status: string }> }
      }>(await POST(request, emptyParams))

      expect(body.data.results.map((r) => r.status)).toEqual(['skipped'])
      expect(mockCommit).not.toHaveBeenCalled()
    })

    it('answers 400 for a group name it does not know', async () => {
      const request = createMockRequest('/api/pending-operations/bulk-commit', {
        method: 'POST',
        body: { ids: [VALID_ID_1], acknowledged_groups: ['create_voucher'] },
      })
      const { status } = await parseJsonResponse(await POST(request, emptyParams))

      expect(status).toBe(400)
      expect(mockCommit).not.toHaveBeenCalled()
    })
  })

  it('commits pending operations and aggregates summary on the happy path', async () => {
    enqueue({
      data: [
        makeOp({ id: VALID_ID_1 }),
        makeOp({ id: VALID_ID_2 }),
      ],
    })

    mockCommit.mockResolvedValue({ status: 'committed', data: {} })

    const request = createMockRequest('/api/pending-operations/bulk-commit', {
      method: 'POST',
      body: { ids: [VALID_ID_1, VALID_ID_2] },
    })
    const response = await POST(request)
    const { status, body } = await parseJsonResponse<{
      data: {
        results: Array<{ id: string; status: string }>
        summary: { total: number; committed: number; failed: number; skipped: number; rejected: number }
      }
    }>(response)

    expect(status).toBe(200)
    expect(body.data.results).toEqual([
      { id: VALID_ID_1, status: 'committed' },
      { id: VALID_ID_2, status: 'committed' },
    ])
    expect(body.data.summary).toEqual({
      total: 2,
      committed: 2,
      failed: 0,
      skipped: 0,
      rejected: 0,
    })
    expect(mockCommit).toHaveBeenCalledTimes(2)
    expect(mockCommit).toHaveBeenCalledWith(
      mockSupabase,
      'user-1',
      'company-1',
      expect.objectContaining({ id: VALID_ID_1 }),
      // commit_method must be 'bulk_accept' so any journal_entries created
      // during bulk approval are tagged distinctly from single-approval ones
      // (BFNAR 2013:2 behandlingshistorik). The actor option attributes the
      // commits to the approving user (migration 20260619120000). The staged
      // attests' answers go to one batch, mailed once after the loop.
      {
        userEmail: 'test@test.se',
        commitMethod: 'bulk_accept',
        actor: { type: 'user', label: 'test@test.se' },
        attestDecisions: attestBatch,
      }
    )
    // Each approved item leaves the same approval record as the MCP and API
    // doors, so the approval channel is never unknown.
    expect(mockRecordAppApproval).toHaveBeenCalledTimes(2)
    expect(mockRecordAppApproval).toHaveBeenCalledWith({
      companyId: 'company-1',
      userId: 'user-1',
      operation: expect.objectContaining({ id: VALID_ID_2 }),
      commitMethod: 'bulk_accept',
      outcome: 'committed',
    })
  })

  it('commits oldest staged first, whatever order the ids arrive in (crm#1815)', async () => {
    // The list shows the newest proposal first by default, and the page sends
    // the ids in that order: a chain staged register, book, pay must still run
    // in that order, and voucher numbers follow the commit order.
    enqueue({
      data: [
        makeOp({ id: VALID_ID_3, created_at: '2026-03-02T10:00:03.000000+00:00' }),
        makeOp({ id: VALID_ID_1, created_at: '2026-03-02T10:00:01.000000+00:00' }),
        makeOp({ id: VALID_ID_2, created_at: '2026-03-02T10:00:02.000000+00:00' }),
      ],
    })
    mockCommit.mockResolvedValue({ status: 'committed', data: {} })

    const request = createMockRequest('/api/pending-operations/bulk-commit', {
      method: 'POST',
      body: { ids: [VALID_ID_3, VALID_ID_2, VALID_ID_1, VALID_ID_4] },
    })
    const response = await POST(request, emptyParams)
    const { status, body } = await parseJsonResponse<{
      data: { results: Array<{ id: string; status: string }> }
    }>(response)

    expect(status).toBe(200)
    expect(mockCommit.mock.calls.map((call) => (call[3] as { id: string }).id)).toEqual([
      VALID_ID_1,
      VALID_ID_2,
      VALID_ID_3,
    ])
    // An id without a row is still reported, after the ones that ran.
    expect(body.data.results.map((r) => [r.id, r.status])).toEqual([
      [VALID_ID_1, 'committed'],
      [VALID_ID_2, 'committed'],
      [VALID_ID_3, 'committed'],
      [VALID_ID_4, 'failed'],
    ])
  })

  it('routes auto_rejected results into the rejected bucket', async () => {
    enqueue({ data: [makeOp({ id: VALID_ID_1 })] })

    mockCommit.mockResolvedValue({
      status: 'rejected',
      auto_rejected: true,
      error: 'Resource already deleted',
      http_status: 409,
    })

    const request = createMockRequest('/api/pending-operations/bulk-commit', {
      method: 'POST',
      body: { ids: [VALID_ID_1] },
    })
    const response = await POST(request)
    const { status, body } = await parseJsonResponse<{
      data: {
        results: Array<{ id: string; status: string; error?: string }>
        summary: { total: number; committed: number; failed: number; skipped: number; rejected: number }
      }
    }>(response)

    expect(status).toBe(200)
    // English executor message → Swedish HTTP-409 fallback (issue #337).
    expect(body.data.results).toEqual([
      { id: VALID_ID_1, status: 'rejected', error: 'En konflikt uppstod. Ladda om sidan och försök igen.' },
    ])
    expect(body.data.summary).toEqual({
      total: 1,
      committed: 0,
      failed: 0,
      skipped: 0,
      rejected: 1,
    })
  })

  // #248: the per-item answer is one Swedish sentence for the person; a
  // refusal that speaks another entry's answer than its code's (a document on
  // a locked year, PERIOD_LOCKED) reaches the item with its own sentence.
  it('answers a refusal with its own Swedish sentence, not the one for its code', async () => {
    enqueue({ data: [makeOp({ id: VALID_ID_1, operation_type: 'attach_document_to_transaction' })] })
    const answer = getErrorEntry('DOC_UPLOAD_PERIOD_LOCKED')!
    mockCommit.mockResolvedValue({
      status: 'failed',
      error: answer.message_sv,
      http_status: 400,
      code: 'PERIOD_LOCKED',
      data: { journal_entry_id: 'je-1', message_en: answer.message_en, remediation: answer.remediation },
      operation_status: 'rejected',
    })
    const request = createMockRequest('/api/pending-operations/bulk-commit', {
      method: 'POST',
      body: { ids: [VALID_ID_1] },
    })
    const { body } = await parseJsonResponse<{ data: { results: Array<{ id: string; status: string; error?: string }> } }>(
      await POST(request, emptyParams),
    )
    expect(body.data.results).toEqual([{ id: VALID_ID_1, status: 'failed', error: answer.message_sv }])
  })

  it('reports commit failures as failed and aggregates a mixed summary', async () => {
    enqueue({
      data: [
        makeOp({ id: VALID_ID_1 }),
        makeOp({ id: VALID_ID_2 }),
        makeOp({ id: VALID_ID_3, status: 'rejected' }),
        makeOp({ id: VALID_ID_4 }),
      ],
    })

    mockCommit
      .mockResolvedValueOnce({ status: 'committed', data: {} })
      .mockResolvedValueOnce({ status: 'failed', error: 'boom', http_status: 500 })
      .mockResolvedValueOnce({
        status: 'rejected',
        auto_rejected: true,
        error: 'gone',
        http_status: 404,
      })

    const request = createMockRequest('/api/pending-operations/bulk-commit', {
      method: 'POST',
      body: { ids: [VALID_ID_1, VALID_ID_2, VALID_ID_3, VALID_ID_4, VALID_ID_5] },
    })
    const response = await POST(request)
    const { status, body } = await parseJsonResponse<{
      data: {
        results: Array<{ id: string; status: string; error?: string }>
        summary: { total: number; committed: number; failed: number; skipped: number; rejected: number }
      }
    }>(response)

    expect(status).toBe(200)
    // English executor strings map to the status-appropriate Swedish
    // fallbacks; skip/not-found strings are now Swedish at the source (#337).
    expect(body.data.results).toEqual([
      { id: VALID_ID_1, status: 'committed' },
      { id: VALID_ID_2, status: 'failed', error: 'Ett oväntat serverfel uppstod. Försök igen senare.' },
      { id: VALID_ID_3, status: 'skipped', error: 'Redan hanterad (avvisad)' },
      { id: VALID_ID_4, status: 'rejected', error: 'Resursen kunde inte hittas.' },
      { id: VALID_ID_5, status: 'failed', error: 'Åtgärden kunde inte hittas.' },
    ])
    expect(body.data.summary).toEqual({
      total: 5,
      committed: 1,
      failed: 2,
      skipped: 1,
      rejected: 1,
    })
    expect(mockCommit).toHaveBeenCalledTimes(3)
  })
})
