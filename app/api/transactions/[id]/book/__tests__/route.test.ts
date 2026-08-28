import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import {
  createMockRequest,
  parseJsonResponse,
  createMockRouteParams,
  createQueuedMockSupabase,
  makeTransaction,
  makeJournalEntry,
} from '@/tests/helpers'
import { eventBus } from '@/lib/events'

const { supabase: mockSupabase, enqueue, reset, findCalls } = createQueuedMockSupabase()

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

const requireWriteMock = vi.fn()
vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: (...args: unknown[]) => requireWriteMock(...args),
}))

const mockCreateJournalEntry = vi.fn()
vi.mock('@/lib/bookkeeping/engine', () => ({
  createJournalEntry: (...args: unknown[]) => mockCreateJournalEntry(...args),
}))

const mockReverseOrphanedJournalEntry = vi.fn()
vi.mock('@/lib/bookkeeping/cancel-orphaned-entry', () => ({
  reverseOrphanedJournalEntry: (...args: unknown[]) => mockReverseOrphanedJournalEntry(...args),
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
    requireAuthMock.mockResolvedValue({ user: mockUser, supabase: mockSupabase })
    requireWriteMock.mockResolvedValue({ ok: true })
    // No booking-duplicate by default; guard tests override per-case.
    mockDetectDup.mockResolvedValue(null)
    mockAppendProcessingHistory.mockResolvedValue('evt-1')
    mockReverseOrphanedJournalEntry.mockResolvedValue(undefined)
  })

  it('returns 401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase: mockSupabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })

    const request = createMockRequest('/api/transactions/tx-1/book', {
      method: 'POST',
      body: validBody,
    })
    const response = await POST(request, createMockRouteParams({ id: 'tx-1' }))
    const { status, body } = await parseJsonResponse(response)

    expect(status).toBe(401)
    expect(body).toEqual({ error: 'Unauthorized' })
  })

  it('returns 403 when the caller is a viewer', async () => {
    requireWriteMock.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }),
    })

    const request = createMockRequest('/api/transactions/tx-1/book', {
      method: 'POST',
      body: validBody,
    })
    const response = await POST(request, createMockRouteParams({ id: 'tx-1' }))
    const { status, body } = await parseJsonResponse(response)

    expect(status).toBe(403)
    expect(body).toEqual({ error: 'Forbidden' })
    expect(mockCreateJournalEntry).not.toHaveBeenCalled()
  })

  it('returns 400 when missing required fields', async () => {
    const request = createMockRequest('/api/transactions/tx-1/book', {
      method: 'POST',
      body: { fiscal_period_id: VALID_UUID },
    })
    const response = await POST(request, createMockRouteParams({ id: 'tx-1' }))
    const { status, body } = await parseJsonResponse<{ error: string }>(response)

    expect(status).toBe(400)
    // Inverted from `toBe('Validation failed')`: the constant was the bug.
    expect(body.error).toMatch(/^Valideringsfel: /)
    expect(body.error).toContain('entry_date')
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
    // Untyped engine errors map to the Swedish context fallback; the raw
    // English message must never reach the response field (issue #337).
    expect(body.error).toBe('Kunde inte hantera transaktionen. Försök igen.')
    expect(body.error).not.toContain('not balanced')
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
    enqueue({ data: [{ id: 'tx-1' }], error: null })

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

  it('returns 400 TX_CATEGORIZE_ORPHANED_COUNTER_ACCOUNT when a line books the settlement row against its active twin (#1643)', async () => {
    // The issue's dialog shape: 1930 and 1931 both enabled on one active
    // connection; "Ändra rader" pre-filled 1930 debit / 1931 credit from a
    // template learned on 1931. Booking it would move money between two
    // ledgers of one physical account with nothing reaching the P&L.
    const iban = 'SE4550000000058398257466'
    const tx = makeTransaction({ id: 'tx-1', amount: 500, journal_entry_id: null, cash_account_id: 'ca-1930' })
    enqueue({ data: tx, error: null }) // fetch transaction
    enqueue({
      data: [
        { id: 'ca-1930', ledger_account: '1930', iban, currency: 'SEK', enabled: true, bank_connection_id: 'conn-live' },
        { id: 'ca-1931', ledger_account: '1931', iban, currency: 'SEK', enabled: true, bank_connection_id: 'conn-live' },
      ],
    }) // cash_accounts topology
    enqueue({ data: [{ id: 'conn-live', status: 'active' }] }) // bank_connections statuses

    const request = createMockRequest('/api/transactions/tx-1/book', {
      method: 'POST',
      body: {
        ...validBody,
        lines: [
          { account_number: '1930', debit_amount: 500, credit_amount: 0 },
          { account_number: '1931', debit_amount: 0, credit_amount: 500 },
        ],
      },
    })
    const response = await POST(request, createMockRouteParams({ id: 'tx-1' }))
    const { status, body } = await parseJsonResponse<{ error: { code: string; details: { accountNumber: string } } }>(response)

    expect(status).toBe(400)
    expect(body.error.code).toBe('TX_CATEGORIZE_ORPHANED_COUNTER_ACCOUNT')
    expect(body.error.details.accountNumber).toBe('1931')
    expect(mockCreateJournalEntry).not.toHaveBeenCalled()
  })

  it('atomically unignores an ignored transaction when booking it', async () => {
    const tx = makeTransaction({
      id: 'tx-1',
      amount: -500,
      journal_entry_id: null,
      is_ignored: true,
    })
    enqueue({ data: tx, error: null })
    mockCreateJournalEntry.mockResolvedValue(makeJournalEntry({ id: 'je-new' }))
    enqueue({ data: [{ id: 'tx-1' }], error: null })

    const response = await POST(
      createMockRequest('/api/transactions/tx-1/book', { method: 'POST', body: validBody }),
      createMockRouteParams({ id: 'tx-1' }),
    )

    expect(response.status).toBe(200)
    expect(findCalls('transactions', 'update')).toContainEqual([
      expect.objectContaining({
        journal_entry_id: 'je-new',
        is_business: true,
        is_ignored: false,
      }),
    ])
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
    const { status, body } = await parseJsonResponse<{
      error: { code: string; message: string }
    }>(response)

    expect(status).toBe(500)
    expect(body.error).toMatchObject({
      code: 'INTERNAL_ERROR',
      message: 'Ett oväntat serverfel uppstod. Försök igen senare.',
    })
    expect(mockReverseOrphanedJournalEntry).toHaveBeenCalledWith(
      expect.anything(),
      'company-1',
      'user-1',
      'je-new',
      expect.any(String),
    )
  })

  it('stornos the posted orphan when another booking wins the transaction-link race', async () => {
    const tx = makeTransaction({ id: 'tx-1', journal_entry_id: null })
    const je = makeJournalEntry({ id: 'je-new' })

    enqueue({ data: tx, error: null })
    mockCreateJournalEntry.mockResolvedValue(je)
    enqueue({ data: [], error: null })

    const response = await POST(
      createMockRequest('/api/transactions/tx-1/book', { method: 'POST', body: validBody }),
      createMockRouteParams({ id: 'tx-1' }),
    )
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(response)

    expect(status).toBe(409)
    expect(body.error.code).toBe('TX_CATEGORIZE_RACE')
    expect(mockReverseOrphanedJournalEntry).toHaveBeenCalledWith(
      expect.anything(),
      'company-1',
      'user-1',
      'je-new',
      expect.any(String),
    )
  })

  it('maps the ignored-row constraint to a typed conflict and stornos the posted orphan', async () => {
    const tx = makeTransaction({ id: 'tx-1', journal_entry_id: null, is_ignored: true })
    enqueue({ data: tx, error: null })
    mockCreateJournalEntry.mockResolvedValue(makeJournalEntry({ id: 'je-new' }))
    enqueue({
      data: null,
      error: {
        code: '23514',
        message:
          'new row for relation "transactions" violates check constraint "transactions_is_ignored_no_journal_entry"',
      },
    })

    const response = await POST(
      createMockRequest('/api/transactions/tx-1/book', { method: 'POST', body: validBody }),
      createMockRouteParams({ id: 'tx-1' }),
    )
    const { status, body } = await parseJsonResponse<{ error: { code: string; message: string } }>(response)

    expect(status).toBe(409)
    expect(body.error.code).toBe('TX_CATEGORIZE_IGNORED_CONFLICT')
    expect(body.error.message).not.toContain('check constraint')
    expect(mockReverseOrphanedJournalEntry).toHaveBeenCalledTimes(1)
  })

  // ── Underlag propagation (pinned document + matched inbox items) ──────
  // Attach-before-book: a document pinned to the transaction (or an inbox
  // item hand-matched to it) must land on the new verifikat, or every
  // underlag surface reads "Underlag saknas" for a booking that HAS its
  // underlag (the 2026-08-13 user report).

  it('anchors the pinned document to the new verifikat (attach-before-book)', async () => {
    const tx = makeTransaction({ id: 'tx-1', amount: -500, journal_entry_id: null })
    const je = makeJournalEntry({ id: 'je-new' })
    enqueue({ data: tx, error: null }) // fetch transaction
    mockCreateJournalEntry.mockResolvedValue(je)
    enqueue({ data: [{ id: 'tx-1' }], error: null }) // update transaction
    enqueue({ data: { document_id: 'doc-1' } }) // propagate: tx pin lookup
    enqueue({ data: { journal_entry_id: null } }) // pinned doc unanchored
    enqueue({ data: { id: 'je-new' } }) // linkToJournalEntry: entry ownership check
    enqueue({ data: { id: 'doc-1', journal_entry_id: 'je-new' } }) // doc update
    enqueue({ data: [] }) // no matched inbox items

    const request = createMockRequest('/api/transactions/tx-1/book', {
      method: 'POST',
      body: validBody,
    })
    const response = await POST(request, createMockRouteParams({ id: 'tx-1' }))
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(200)
    expect(findCalls('document_attachments', 'update')).toContainEqual([
      { journal_entry_id: 'je-new', journal_entry_line_id: null },
    ])
  })

  it('stamps a matched inbox item consumed by the booking', async () => {
    const tx = makeTransaction({ id: 'tx-1', amount: -500, journal_entry_id: null })
    const je = makeJournalEntry({ id: 'je-new' })
    enqueue({ data: tx, error: null }) // fetch transaction
    mockCreateJournalEntry.mockResolvedValue(je)
    enqueue({ data: [{ id: 'tx-1' }], error: null }) // update transaction
    enqueue({ data: { document_id: null } }) // propagate: nothing pinned
    enqueue({ data: [{ id: 'i1', document_id: null }] }) // matched inbox item
    enqueue({ data: null }) // stamp update

    const request = createMockRequest('/api/transactions/tx-1/book', {
      method: 'POST',
      body: validBody,
    })
    const response = await POST(request, createMockRouteParams({ id: 'tx-1' }))
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(200)
    expect(findCalls('invoice_inbox_items', 'update')).toContainEqual([
      { created_journal_entry_id: 'je-new' },
    ])
  })

  it('still returns success when underlag propagation fails (best-effort)', async () => {
    const tx = makeTransaction({ id: 'tx-1', amount: -500, journal_entry_id: null })
    const je = makeJournalEntry({ id: 'je-new' })
    enqueue({ data: tx, error: null }) // fetch transaction
    mockCreateJournalEntry.mockResolvedValue(je)
    enqueue({ data: [{ id: 'tx-1' }], error: null }) // update transaction
    enqueue({ data: { document_id: 'doc-1' } }) // propagate: tx pin lookup
    enqueue({ data: { journal_entry_id: null } }) // pinned doc unanchored
    enqueue({ data: null }) // linkToJournalEntry: entry lookup fails -> throws
    enqueue({ data: [] }) // no matched inbox items

    const request = createMockRequest('/api/transactions/tx-1/book', {
      method: 'POST',
      body: validBody,
    })
    const response = await POST(request, createMockRouteParams({ id: 'tx-1' }))
    const { status, body } = await parseJsonResponse<{ success: boolean }>(response)

    // The verifikat is already posted: a propagation failure is logged and
    // repaired by re-running, never allowed to fail the booking.
    expect(status).toBe(200)
    expect(body.success).toBe(true)
    expect(findCalls('document_attachments', 'update')).toEqual([])
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
    enqueue({ data: [{ id: 'tx-1' }], error: null }) // update
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
    enqueue({ data: [{ id: 'tx-1' }], error: null }) // update
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
