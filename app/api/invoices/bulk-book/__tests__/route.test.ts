import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import {
  createMockRequest,
  parseJsonResponse,
  createQueuedMockSupabase,
  makeInvoice,
  makeCompanySettings,
} from '@/tests/helpers'

const { supabase: mockSupabase, enqueue, reset } = createQueuedMockSupabase()

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

const mockIssueAndBook = vi.fn()
vi.mock('@/lib/invoices/issue-and-book-invoice', () => ({
  issueAndBookInvoice: (...args: unknown[]) => mockIssueAndBook(...args),
}))

const mockBookDeferred = vi.fn()
vi.mock('@/lib/invoices/book-invoice-deferred', () => ({
  bookInvoiceDeferred: (...args: unknown[]) => mockBookDeferred(...args),
  INVOICE_BOOKABLE_STATUSES: ['sent', 'overdue'],
}))

import { POST } from '../route'

const mockUser = { id: 'user-1', email: 'test@test.se' }

const UUID_1 = '11111111-1111-4111-8111-111111111111'
const UUID_2 = '22222222-2222-4222-8222-222222222222'

const accrualSettings = makeCompanySettings({
  accounting_method: 'accrual',
  entity_type: 'aktiebolag',
})

function bulkRequest(ids: unknown) {
  return POST(createMockRequest('/api/invoices/bulk-book', { method: 'POST', body: { ids } }))
}

function makeDraft(id: string) {
  return {
    ...makeInvoice({ id, status: 'draft' }),
    document_type: 'invoice',
    credited_invoice_id: null,
    journal_entry_id: null,
    customer: { name: 'Kunden AB' },
    items: [],
  }
}

describe('POST /api/invoices/bulk-book', () => {
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

    const { status } = await parseJsonResponse(await bulkRequest([UUID_1]))
    expect(status).toBe(401)
  })

  it('returns 400 for an invalid body', async () => {
    const { status } = await parseJsonResponse(await bulkRequest([]))
    expect(status).toBe(400)
    expect(mockIssueAndBook).not.toHaveBeenCalled()
  })

  it('returns 400 for non-uuid ids', async () => {
    const { status } = await parseJsonResponse(await bulkRequest(['not-a-uuid']))
    expect(status).toBe(400)
  })

  it('rejects the whole batch under kontantmetoden', async () => {
    enqueue({ data: { ...accrualSettings, accounting_method: 'cash' }, error: null })

    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(
      await bulkRequest([UUID_1]),
    )
    expect(status).toBe(400)
    expect(body.error.code).toBe('INVOICE_BOOK_CASH_METHOD')
    expect(mockIssueAndBook).not.toHaveBeenCalled()
    expect(mockBookDeferred).not.toHaveBeenCalled()
  })

  it('reports unknown ids as per-item INVOICE_NOT_FOUND failures', async () => {
    enqueue({ data: accrualSettings, error: null })
    enqueue({ data: [], error: null }) // invoices fetch finds nothing

    const { status, body } = await parseJsonResponse<{
      data: {
        results: Array<{ id: string; status: string; error_code?: string; error?: string }>
        summary: { total: number; booked: number; failed: number }
      }
    }>(await bulkRequest([UUID_1]))

    expect(status).toBe(200)
    expect(body.data.results).toEqual([
      expect.objectContaining({
        id: UUID_1,
        status: 'failed',
        error_code: 'INVOICE_NOT_FOUND',
        error: expect.stringContaining('hittas'),
      }),
    ])
    expect(body.data.summary).toEqual({ total: 1, booked: 0, failed: 1 })
  })

  it('issues and books drafts via issueAndBookInvoice', async () => {
    enqueue({ data: accrualSettings, error: null })
    enqueue({ data: [makeDraft(UUID_1)], error: null })
    mockIssueAndBook.mockResolvedValue({ ok: true, journalEntryId: 'je-1', partialFailures: [] })

    const { status, body } = await parseJsonResponse<{
      data: {
        results: Array<{ id: string; status: string; journal_entry_id?: string | null }>
        summary: { total: number; booked: number; failed: number }
      }
    }>(await bulkRequest([UUID_1]))

    expect(status).toBe(200)
    expect(mockIssueAndBook).toHaveBeenCalledWith(
      expect.objectContaining({
        supabase: mockSupabase,
        companyId: 'company-1',
        userId: 'user-1',
        invoice: expect.objectContaining({ id: UUID_1 }),
      }),
    )
    // No email path and no custom lines from bulk.
    expect(mockIssueAndBook.mock.calls[0][0]).not.toHaveProperty('customLines')
    expect(body.data.results).toEqual([
      { id: UUID_1, status: 'booked', journal_entry_id: 'je-1' },
    ])
    expect(body.data.summary).toEqual({ total: 1, booked: 1, failed: 0 })
  })

  it('rejects drafts per item under deferred booking without issuing them', async () => {
    // accrual + defer_invoice_booking: issuing the draft would consume an
    // F-number and mark it sent WITHOUT booking anything. The sent invoice in
    // the same batch must still book: deferred is exactly the /book case.
    enqueue({ data: { ...accrualSettings, defer_invoice_booking: true }, error: null })
    enqueue({
      data: [makeDraft(UUID_1), { ...makeDraft(UUID_2), status: 'sent' }],
      error: null,
    })
    mockBookDeferred.mockResolvedValue({
      ok: true,
      invoice: { id: UUID_2 },
      journalEntryId: 'je-3',
      warnings: [],
    })

    const { status, body } = await parseJsonResponse<{
      data: {
        results: Array<{ id: string; status: string; error_code?: string; error?: string }>
        summary: { total: number; booked: number; failed: number }
      }
    }>(await bulkRequest([UUID_1, UUID_2]))

    expect(status).toBe(200)
    // The draft is never touched: no issuance side effects at all.
    expect(mockIssueAndBook).not.toHaveBeenCalled()
    expect(body.data.results).toEqual([
      expect.objectContaining({
        id: UUID_1,
        status: 'failed',
        error_code: 'INVOICE_BOOK_DEFERRED_DRAFT',
        error: expect.stringContaining('separat steg'),
      }),
      { id: UUID_2, status: 'booked', journal_entry_id: 'je-3' },
    ])
    expect(body.data.summary).toEqual({ total: 2, booked: 1, failed: 1 })
  })

  it('processes duplicated ids exactly once (no second voucher)', async () => {
    enqueue({ data: accrualSettings, error: null })
    enqueue({ data: [makeDraft(UUID_1)], error: null })
    mockIssueAndBook.mockResolvedValue({ ok: true, journalEntryId: 'je-1', partialFailures: [] })

    const { status, body } = await parseJsonResponse<{
      data: {
        results: Array<{ id: string; status: string; journal_entry_id?: string | null }>
        summary: { total: number; booked: number; failed: number }
      }
    }>(await bulkRequest([UUID_1, UUID_1]))

    expect(status).toBe(200)
    // Without dedupe the second iteration reads the stale pre-loop snapshot,
    // passes the already-booked check, and mints a voucher the CAS claim then
    // cancels: one cancelled verifikat + gap explanation per duplicate.
    expect(mockIssueAndBook).toHaveBeenCalledTimes(1)
    expect(body.data.results).toEqual([
      { id: UUID_1, status: 'booked', journal_entry_id: 'je-1' },
    ])
    expect(body.data.summary).toEqual({ total: 1, booked: 1, failed: 0 })
  })

  it('books sent unbooked invoices via bookInvoiceDeferred', async () => {
    enqueue({ data: accrualSettings, error: null })
    enqueue({
      data: [{ ...makeDraft(UUID_1), status: 'sent' }],
      error: null,
    })
    mockBookDeferred.mockResolvedValue({
      ok: true,
      invoice: { id: UUID_1 },
      journalEntryId: 'je-2',
      warnings: [],
    })

    const { status, body } = await parseJsonResponse<{
      data: { results: Array<{ id: string; status: string; journal_entry_id?: string | null }> }
    }>(await bulkRequest([UUID_1]))

    expect(status).toBe(200)
    expect(mockBookDeferred).toHaveBeenCalledWith(
      expect.objectContaining({
        invoice: expect.objectContaining({ id: UUID_1 }),
        entityType: 'aktiebolag',
      }),
    )
    expect(mockIssueAndBook).not.toHaveBeenCalled()
    expect(body.data.results).toEqual([
      { id: UUID_1, status: 'booked', journal_entry_id: 'je-2' },
    ])
  })

  it('skips already-booked sent invoices without touching the engine', async () => {
    enqueue({ data: accrualSettings, error: null })
    enqueue({
      data: [{ ...makeDraft(UUID_1), status: 'sent', journal_entry_id: 'je-old' }],
      error: null,
    })

    const { body } = await parseJsonResponse<{
      data: { results: Array<{ status: string; error_code?: string }> }
    }>(await bulkRequest([UUID_1]))

    expect(body.data.results[0]).toEqual(
      expect.objectContaining({ status: 'failed', error_code: 'INVOICE_BOOK_ALREADY_BOOKED' }),
    )
    expect(mockBookDeferred).not.toHaveBeenCalled()
  })

  it('rejects credit notes and non-invoice document types per item', async () => {
    enqueue({ data: accrualSettings, error: null })
    enqueue({
      data: [
        { ...makeDraft(UUID_1), credited_invoice_id: 'inv-0' },
        { ...makeDraft(UUID_2), document_type: 'proforma' },
      ],
      error: null,
    })

    const { body } = await parseJsonResponse<{
      data: { results: Array<{ id: string; status: string; error_code?: string }> }
    }>(await bulkRequest([UUID_1, UUID_2]))

    expect(body.data.results).toEqual([
      expect.objectContaining({ id: UUID_1, status: 'failed', error_code: 'INVOICE_BOOK_NOT_BOOKABLE' }),
      expect.objectContaining({ id: UUID_2, status: 'failed', error_code: 'INVOICE_BOOK_NOT_BOOKABLE' }),
    ])
    expect(mockIssueAndBook).not.toHaveBeenCalled()
  })

  it('rejects paid invoices per item with INVOICE_BOOK_INVALID_STATUS', async () => {
    enqueue({ data: accrualSettings, error: null })
    enqueue({ data: [{ ...makeDraft(UUID_1), status: 'paid' }], error: null })

    const { body } = await parseJsonResponse<{
      data: { results: Array<{ status: string; error_code?: string }> }
    }>(await bulkRequest([UUID_1]))

    expect(body.data.results[0]).toEqual(
      expect.objectContaining({ status: 'failed', error_code: 'INVOICE_BOOK_INVALID_STATUS' }),
    )
  })

  it('continues past failures and reports a mixed summary', async () => {
    enqueue({ data: accrualSettings, error: null })
    enqueue({ data: [makeDraft(UUID_1), makeDraft(UUID_2)], error: null })
    mockIssueAndBook
      .mockResolvedValueOnce({ ok: false, errorCode: 'INVOICE_MARK_SENT_RACE' })
      .mockResolvedValueOnce({ ok: true, journalEntryId: 'je-9', partialFailures: [] })

    const { status, body } = await parseJsonResponse<{
      data: {
        results: Array<{ id: string; status: string; error_code?: string; error?: string }>
        summary: { total: number; booked: number; failed: number }
      }
    }>(await bulkRequest([UUID_1, UUID_2]))

    expect(status).toBe(200)
    expect(mockIssueAndBook).toHaveBeenCalledTimes(2)
    expect(body.data.results).toEqual([
      expect.objectContaining({
        id: UUID_1,
        status: 'failed',
        error_code: 'INVOICE_MARK_SENT_RACE',
        // Per-item errors are Swedish user strings, never raw codes.
        error: expect.any(String),
      }),
      { id: UUID_2, status: 'booked', journal_entry_id: 'je-9' },
    ])
    expect(body.data.summary).toEqual({ total: 2, booked: 1, failed: 1 })
  })
})
