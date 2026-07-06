import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  createMockRequest,
  parseJsonResponse,
  createMockRouteParams,
  createQueuedMockSupabase,
  makeTransaction,
  makeJournalEntry,
} from '@/tests/helpers'
import { eventBus } from '@/lib/events'

const { supabase: mockSupabase, enqueue, reset } = createQueuedMockSupabase()
vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve(mockSupabase),
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

const mockCreateJournalEntry = vi.fn()
vi.mock('@/lib/bookkeeping/engine', () => ({
  createJournalEntry: (...args: unknown[]) => mockCreateJournalEntry(...args),
}))

// Booking-time duplicate guard: mocked so route tests exercise the WIRING
// (warn / force / mismatch); the detection query itself is unit-tested in
// lib/transactions/__tests__/booking-duplicate-detection.test.ts.
const mockDetectDup = vi.fn()
vi.mock('@/lib/transactions/booking-duplicate-detection', () => ({
  detectBookingDuplicate: (...args: unknown[]) => mockDetectDup(...args),
}))

// Behandlingshistorik append: mocked so we can assert the dismissal is
// persisted without reaching the service-role client.
const mockAppendProcessingHistory = vi.fn()
vi.mock('@/lib/processing-history/append', () => ({
  appendProcessingHistory: (...args: unknown[]) => mockAppendProcessingHistory(...args),
}))

import { POST } from '../route'

const VALID_UUID = '550e8400-e29b-41d4-a716-446655440000'
const SIBLING_UUID = '660e8400-e29b-41d4-a716-446655440111'
const OTHER_UUID = '770e8400-e29b-41d4-a716-446655440222'
const VOUCHER_JE_UUID = '880e8400-e29b-41d4-a716-446655440333'

describe('POST /api/transactions/[id]/book', () => {
  const mockUser = { id: 'user-1', email: 'test@test.se' }
  const validBody = {
    fiscal_period_id: VALID_UUID,
    entry_date: '2025-01-15',
    description: 'Test booking',
    lines: [
      { account_number: '6200', debit_amount: 500, credit_amount: 0 },
      { account_number: '1930', debit_amount: 0, credit_amount: 500 },
    ],
  }

  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    eventBus.clear()
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: mockUser } })
    // No booking-duplicate by default; guard tests override per-case.
    mockDetectDup.mockResolvedValue(null)
    mockAppendProcessingHistory.mockResolvedValue('evt-1')
  })

  it('returns 401 when not authenticated', async () => {
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: null } })

    const request = createMockRequest('/api/transactions/tx-1/book', {
      method: 'POST',
      body: validBody,
    })
    const response = await POST(request, createMockRouteParams({ id: 'tx-1' }))
    const { status, body } = await parseJsonResponse(response)

    expect(status).toBe(401)
    expect(body).toEqual({ error: 'Unauthorized' })
  })

  it('returns 400 when missing required fields', async () => {
    const request = createMockRequest('/api/transactions/tx-1/book', {
      method: 'POST',
      body: { fiscal_period_id: VALID_UUID },
    })
    const response = await POST(request, createMockRouteParams({ id: 'tx-1' }))
    const { status, body } = await parseJsonResponse<{ error: string }>(response)

    expect(status).toBe(400)
    expect(body.error).toBe('Validation failed')
  })

  it('returns 404 when transaction not found', async () => {
    enqueue({ data: null, error: { message: 'Not found' } })

    const request = createMockRequest('/api/transactions/tx-999/book', {
      method: 'POST',
      body: validBody,
    })
    const response = await POST(request, createMockRouteParams({ id: 'tx-999' }))
    const { status, body } = await parseJsonResponse<{ error: string }>(response)

    expect(status).toBe(404)
    expect(body.error).toBe('Transaction not found')
  })

  it('returns 409 when transaction already has a journal entry', async () => {
    const tx = makeTransaction({
      id: 'tx-1',
      journal_entry_id: 'je-existing',
    })
    enqueue({ data: tx, error: null })

    const request = createMockRequest('/api/transactions/tx-1/book', {
      method: 'POST',
      body: validBody,
    })
    const response = await POST(request, createMockRouteParams({ id: 'tx-1' }))
    const { status, body } = await parseJsonResponse<{ error: string }>(response)

    expect(status).toBe(409)
    expect(body.error).toBe('Transaction already has a journal entry')
  })

  it('returns 400 when journal entry creation fails (engine error)', async () => {
    const tx = makeTransaction({ id: 'tx-1', journal_entry_id: null })
    enqueue({ data: tx, error: null })

    mockCreateJournalEntry.mockRejectedValue(new Error('Entry is not balanced'))

    const request = createMockRequest('/api/transactions/tx-1/book', {
      method: 'POST',
      body: validBody,
    })
    const response = await POST(request, createMockRouteParams({ id: 'tx-1' }))
    const { status, body } = await parseJsonResponse<{ error: string }>(response)

    expect(status).toBe(400)
    expect(body.error).toBe('Entry is not balanced')
  })

  it('creates journal entry and links to transaction (happy path)', async () => {
    const tx = makeTransaction({
      id: 'tx-1',
      amount: -500,
      journal_entry_id: null,
    })
    const je = makeJournalEntry({ id: 'je-new' })

    // Fetch transaction
    enqueue({ data: tx, error: null })

    mockCreateJournalEntry.mockResolvedValue(je)

    // Update transaction
    enqueue({ data: null, error: null })

    const emitSpy = vi.spyOn(eventBus, 'emit')

    const request = createMockRequest('/api/transactions/tx-1/book', {
      method: 'POST',
      body: validBody,
    })
    const response = await POST(request, createMockRouteParams({ id: 'tx-1' }))
    const { status, body } = await parseJsonResponse<{
      success: boolean
      journal_entry_id: string
      data: { id: string }
    }>(response)

    expect(status).toBe(200)
    expect(body.success).toBe(true)
    expect(body.journal_entry_id).toBe('je-new')
    expect(body.data.id).toBe('je-new')

    expect(mockCreateJournalEntry).toHaveBeenCalledWith(expect.anything(), 'company-1', 'user-1', {
      fiscal_period_id: VALID_UUID,
      entry_date: '2025-01-15',
      description: 'Test booking',
      source_type: 'bank_transaction',
      source_id: 'tx-1',
      lines: validBody.lines,
    })

    expect(emitSpy).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'transaction.categorized' })
    )
  })

  it('returns 500 when transaction update fails', async () => {
    const tx = makeTransaction({ id: 'tx-1', journal_entry_id: null })
    const je = makeJournalEntry({ id: 'je-new' })

    enqueue({ data: tx, error: null })
    mockCreateJournalEntry.mockResolvedValue(je)
    // Update fails
    enqueue({ data: null, error: { message: 'Update failed' } })

    const request = createMockRequest('/api/transactions/tx-1/book', {
      method: 'POST',
      body: validBody,
    })
    const response = await POST(request, createMockRouteParams({ id: 'tx-1' }))
    const { status, body } = await parseJsonResponse<{ error: string }>(response)

    expect(status).toBe(500)
    expect(body.error).toBe('Failed to update transaction')
  })

  // ── Booking-time duplicate guard ──────────────────────────────────────

  it('returns 409 duplicate warning when a booked sibling shares date+amount', async () => {
    const tx = makeTransaction({ id: 'tx-1', amount: -500, journal_entry_id: null })
    enqueue({ data: tx, error: null }) // fetch
    mockDetectDup.mockResolvedValue({
      transaction_id: SIBLING_UUID,
      journal_entry_id: 'je-existing',
      voucher_label: 'A142',
      entry_date: '2025-01-15',
      description: 'redan bokförd',
      amount: -500,
    })

    const request = createMockRequest('/api/transactions/tx-1/book', { method: 'POST', body: validBody })
    const response = await POST(request, createMockRouteParams({ id: 'tx-1' }))
    const { status, body } = await parseJsonResponse<{
      error: { code: string; details: { candidate: { transaction_id: string; voucher_label: string } } }
    }>(response)

    expect(status).toBe(409)
    expect(body.error.code).toBe('TRANSACTION_BOOK_POSSIBLE_DUPLICATE')
    expect(body.error.details.candidate.transaction_id).toBe(SIBLING_UUID)
    expect(body.error.details.candidate.voucher_label).toBe('A142')
    // Critically: no verifikat is created when a duplicate is flagged.
    expect(mockCreateJournalEntry).not.toHaveBeenCalled()
    // Blocking a duplicate is not a dismissal: nothing is logged.
    expect(mockAppendProcessingHistory).not.toHaveBeenCalled()
  })

  it('books when force=true and the expected sibling still matches', async () => {
    const tx = makeTransaction({ id: 'tx-1', amount: -500, journal_entry_id: null })
    const je = makeJournalEntry({ id: 'je-new' })
    enqueue({ data: tx, error: null }) // fetch
    enqueue({ data: null, error: null }) // update
    mockDetectDup.mockResolvedValue({
      transaction_id: SIBLING_UUID,
      journal_entry_id: 'je-existing',
      voucher_label: 'A142',
      entry_date: '2025-01-15',
      description: null,
      amount: -500,
    })
    mockCreateJournalEntry.mockResolvedValue(je)

    const request = createMockRequest('/api/transactions/tx-1/book', {
      method: 'POST',
      body: { ...validBody, force: true, expected_duplicate_transaction_id: SIBLING_UUID },
    })
    const response = await POST(request, createMockRouteParams({ id: 'tx-1' }))
    const { status, body } = await parseJsonResponse<{ success: boolean; journal_entry_id: string }>(response)

    expect(status).toBe(200)
    expect(body.success).toBe(true)
    expect(body.journal_entry_id).toBe('je-new')
    expect(mockCreateJournalEntry).toHaveBeenCalledTimes(1)
    // The dismissal is recorded to behandlingshistorik (BFNAR 2013:2 kap 8).
    expect(mockAppendProcessingHistory).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'BankTransactionDuplicateDismissed',
        aggregateType: 'BankTransaction',
        aggregateId: 'tx-1',
        actor: { type: 'user', id: 'user-1' },
        payload: expect.objectContaining({
          transaction_id: 'tx-1',
          dismissed_transaction_id: SIBLING_UUID,
        }),
      }),
    )
  })

  it('returns 409 when a ledger-only voucher (no sibling transaction) already books this movement', async () => {
    const tx = makeTransaction({ id: 'tx-1', amount: 98565, journal_entry_id: null })
    enqueue({ data: tx, error: null }) // fetch
    // A voucher-keyed candidate has no transaction_id: it's bound by je id.
    mockDetectDup.mockResolvedValue({
      transaction_id: null,
      journal_entry_id: VOUCHER_JE_UUID,
      voucher_label: 'A2',
      entry_date: '2026-03-30',
      description: 'Inbetalning kundfaktura 2026001',
      amount: 98565,
    })

    const request = createMockRequest('/api/transactions/tx-1/book', { method: 'POST', body: validBody })
    const response = await POST(request, createMockRouteParams({ id: 'tx-1' }))
    const { status, body } = await parseJsonResponse<{
      error: { code: string; details: { candidate: { transaction_id: string | null; journal_entry_id: string } } }
    }>(response)

    expect(status).toBe(409)
    expect(body.error.code).toBe('TRANSACTION_BOOK_POSSIBLE_DUPLICATE')
    expect(body.error.details.candidate.transaction_id).toBeNull()
    expect(body.error.details.candidate.journal_entry_id).toBe(VOUCHER_JE_UUID)
    expect(mockCreateJournalEntry).not.toHaveBeenCalled()
  })

  it('books a voucher-keyed duplicate when force=true binds the expected journal_entry_id', async () => {
    const tx = makeTransaction({ id: 'tx-1', amount: 98565, journal_entry_id: null })
    const je = makeJournalEntry({ id: 'je-new' })
    enqueue({ data: tx, error: null }) // fetch
    enqueue({ data: null, error: null }) // update
    mockDetectDup.mockResolvedValue({
      transaction_id: null,
      journal_entry_id: VOUCHER_JE_UUID,
      voucher_label: 'A2',
      entry_date: '2026-03-30',
      description: null,
      amount: 98565,
    })
    mockCreateJournalEntry.mockResolvedValue(je)

    const request = createMockRequest('/api/transactions/tx-1/book', {
      method: 'POST',
      body: { ...validBody, force: true, expected_duplicate_journal_entry_id: VOUCHER_JE_UUID },
    })
    const response = await POST(request, createMockRouteParams({ id: 'tx-1' }))
    const { status, body } = await parseJsonResponse<{ success: boolean; journal_entry_id: string }>(response)

    expect(status).toBe(200)
    expect(body.success).toBe(true)
    expect(mockCreateJournalEntry).toHaveBeenCalledTimes(1)
    expect(mockAppendProcessingHistory).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'BankTransactionDuplicateDismissed',
        payload: expect.objectContaining({
          dismissed_transaction_id: null,
          dismissed_journal_entry_id: VOUCHER_JE_UUID,
        }),
      }),
    )
  })

  it('rejects force=true when the expected sibling no longer matches the detected one', async () => {
    const tx = makeTransaction({ id: 'tx-1', amount: -500, journal_entry_id: null })
    enqueue({ data: tx, error: null }) // fetch
    mockDetectDup.mockResolvedValue({
      transaction_id: SIBLING_UUID, // server detects this one…
      journal_entry_id: 'je-existing',
      voucher_label: 'A142',
      entry_date: '2025-01-15',
      description: null,
      amount: -500,
    })

    const request = createMockRequest('/api/transactions/tx-1/book', {
      method: 'POST',
      body: { ...validBody, force: true, expected_duplicate_transaction_id: OTHER_UUID }, // …caller claims another
    })
    const response = await POST(request, createMockRouteParams({ id: 'tx-1' }))
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(response)

    expect(status).toBe(409)
    expect(body.error.code).toBe('TRANSACTION_BOOK_FORCE_CANDIDATE_MISMATCH')
    expect(mockCreateJournalEntry).not.toHaveBeenCalled()
  })

  it('returns 400 when force=true is sent without expected_duplicate_transaction_id', async () => {
    const request = createMockRequest('/api/transactions/tx-1/book', {
      method: 'POST',
      body: { ...validBody, force: true },
    })
    const response = await POST(request, createMockRouteParams({ id: 'tx-1' }))
    const { status } = await parseJsonResponse<{ error: string }>(response)

    expect(status).toBe(400)
  })
})
