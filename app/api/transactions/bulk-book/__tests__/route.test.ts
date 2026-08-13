import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  createMockRequest,
  parseJsonResponse,
  createQueuedMockSupabase,
} from '@/tests/helpers'

const { supabase: mockSupabase, enqueue, reset } = createQueuedMockSupabase()
vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve(mockSupabase),
}))

vi.mock('@/lib/events/bus', () => ({
  eventBus: { emit: vi.fn().mockResolvedValue(undefined) },
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

// applyTemplate is the pure ratio/VAT expander used by the route. The
// route test stubs it so we don't need a real template object.
vi.mock('@/lib/bookkeeping/template-library', () => ({
  applyTemplate: vi.fn(),
}))

// Stubbed so the queued mock stays aligned with the route's own
// queries; the helper's behaviour is covered in
// lib/transactions/__tests__/inbox-underlag.test.ts.
vi.mock('@/lib/transactions/inbox-underlag', () => ({
  propagateUnderlagForBookedTransaction: vi.fn().mockResolvedValue(undefined),
}))

// The booking-time duplicate guard runs several queries of its own per tx;
// stubbing it keeps the queued supabase mock aligned with the route's queries.
// Detection behaviour is covered in
// lib/transactions/__tests__/booking-duplicate-detection.test.ts.
vi.mock('@/lib/transactions/booking-duplicate-detection', () => ({
  detectBookingDuplicate: vi.fn().mockResolvedValue(null),
}))
vi.mock('@/lib/processing-history/append', () => ({
  appendProcessingHistory: vi.fn().mockResolvedValue(undefined),
}))

import { POST } from '../route'
import { applyTemplate } from '@/lib/bookkeeping/template-library'
import { propagateUnderlagForBookedTransaction } from '@/lib/transactions/inbox-underlag'
import { detectBookingDuplicate } from '@/lib/transactions/booking-duplicate-detection'
import { appendProcessingHistory } from '@/lib/processing-history/append'
import type { BookedDuplicateCandidate } from '@/lib/transactions/booking-duplicate-detection'

const TX1 = '11111111-1111-4111-8111-111111111111'
const TX2 = '22222222-2222-4222-8222-222222222222'
const TPL = '33333333-3333-4333-8333-333333333333'
const JE = '44444444-4444-4444-8444-444444444444'

describe('POST /api/transactions/bulk-book', () => {
  const mockUser = { id: 'user-1', email: 'test@test.se' }

  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: mockUser } })
    vi.mocked(detectBookingDuplicate).mockResolvedValue(null)
  })

  it('returns 401 when unauthenticated', async () => {
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: null }, error: null })
    const request = createMockRequest('/api/transactions/bulk-book', {
      method: 'POST',
      body: { tx_ids: [TX1], existing_journal_entry_id: JE },
    })
    const response = await POST(request)
    expect(response.status).toBe(401)
  })

  it('returns 400 when neither template_id nor existing_journal_entry_id is set', async () => {
    const request = createMockRequest('/api/transactions/bulk-book', {
      method: 'POST',
      body: { tx_ids: [TX1] },
    })
    const response = await POST(request)
    expect(response.status).toBe(400)
  })

  it('returns 400 when both template_id and existing_journal_entry_id are set', async () => {
    const request = createMockRequest('/api/transactions/bulk-book', {
      method: 'POST',
      body: {
        tx_ids: [TX1],
        template_id: TPL,
        existing_journal_entry_id: JE,
        mode: 'one_line_per_tx',
        entry_description: 'Test',
      },
    })
    const response = await POST(request)
    expect(response.status).toBe(400)
  })

  it('link path passes through to RPC and returns the success envelope', async () => {
    // Currency gate tx fetch (hoisted: runs on every path).
    enqueue({
      data: [
        { id: TX1, amount: 100, currency: 'SEK', description: 'Swish 1', date: '2026-06-05' },
        { id: TX2, amount: 200, currency: 'SEK', description: 'Swish 2', date: '2026-06-05' },
      ],
      error: null,
    })
    // RPC returns the link-existing happy path.
    enqueue({
      data: {
        ok: true,
        mode: 'link_existing',
        journal_entry_id: JE,
        voucher_series: 'A',
        voucher_number: 12,
        linked_tx_count: 2,
        tx_sum: 300,
      },
      error: null,
    })
    // Event re-fetch (empty is fine for the test).
    enqueue({ data: [], error: null })

    const request = createMockRequest('/api/transactions/bulk-book', {
      method: 'POST',
      body: {
        tx_ids: [TX1, TX2],
        existing_journal_entry_id: JE,
      },
    })
    const response = await POST(request)
    const { status, body } = await parseJsonResponse<{
      data: { mode: string; journal_entry_id: string; linked_tx_count: number }
    }>(response)
    expect(status).toBe(200)
    expect(body.data.mode).toBe('link_existing')
    expect(body.data.journal_entry_id).toBe(JE)
    expect(body.data.linked_tx_count).toBe(2)
    // Every booked tx gets its matched inbox items completed against the
    // samlingsverifikat (underlag link + consumed stamp).
    expect(propagateUnderlagForBookedTransaction).toHaveBeenCalledWith(
      expect.anything(),
      'company-1',
      TX1,
      JE,
    )
    expect(propagateUnderlagForBookedTransaction).toHaveBeenCalledWith(
      expect.anything(),
      'company-1',
      TX2,
      JE,
    )
  })

  it('create-new path fetches template, expands per mode, and calls RPC', async () => {
    // Tx fetch (hoisted for the currency gate): 2 incomes totalling 300.
    enqueue({
      data: [
        { id: TX1, amount: 100, currency: 'SEK', description: 'Swish 1', date: '2026-06-05' },
        { id: TX2, amount: 200, currency: 'SEK', description: 'Swish 2', date: '2026-06-05' },
      ],
      error: null,
    })
    // Template fetch.
    enqueue({
      data: {
        id: TPL,
        name: 'Försäljning 25%',
        lines: [
          { account: '1930', label: 'Bank', side: 'debit', type: 'settlement' },
          { account: '3001', label: 'Försäljning', side: 'credit', type: 'business', ratio: 0.8 },
          { account: '2611', label: 'Utg moms 25%', side: 'credit', type: 'vat', vat_rate: 0.25 },
        ],
        is_active: true,
      },
      error: null,
    })

    // applyTemplate stub: return a balanced 3-line set per call.
    vi.mocked(applyTemplate).mockImplementation((_lines, total) => [
      { account_number: '1930', debit_amount: String(total), credit_amount: '', line_description: 'Bank' },
      { account_number: '3001', debit_amount: '', credit_amount: String(total * 0.8), line_description: 'Försäljning' },
      { account_number: '2611', debit_amount: '', credit_amount: String(total * 0.2), line_description: 'Utg moms 25%' },
    ])

    // Account dimension rules pre-check (PR10) — none configured.
    enqueue({ data: [], error: null })
    // RPC returns happy path.
    enqueue({
      data: {
        ok: true,
        mode: 'create_new',
        journal_entry_id: JE,
        voucher_series: 'A',
        voucher_number: 13,
        linked_tx_count: 2,
        tx_sum: 300,
      },
      error: null,
    })
    // Event re-fetch.
    enqueue({ data: [], error: null })

    const request = createMockRequest('/api/transactions/bulk-book', {
      method: 'POST',
      body: {
        tx_ids: [TX1, TX2],
        template_id: TPL,
        mode: 'one_line_per_tx',
        entry_description: 'Samlingsverifikation 2026-06-05',
      },
    })
    const response = await POST(request)
    const { status, body } = await parseJsonResponse<{
      data: { mode: string; journal_entry_id: string }
    }>(response)
    expect(status).toBe(200)
    expect(body.data.mode).toBe('create_new')
    expect(body.data.journal_entry_id).toBe(JE)
    // Template expansion was invoked once per tx in one_line_per_tx mode.
    expect(vi.mocked(applyTemplate)).toHaveBeenCalledTimes(2)
  })

  it('maps RPC structured failure code to errorResponseFromCode', async () => {
    // Currency gate tx fetch.
    enqueue({
      data: [
        { id: TX1, amount: 100, currency: 'SEK', description: 'Swish 1', date: '2026-06-05' },
        { id: TX2, amount: 200, currency: 'SEK', description: 'Swish 2', date: '2026-06-06' },
      ],
      error: null,
    })
    enqueue({
      data: { ok: false, code: 'BULK_BOOK_DATE_MISMATCH', details: { expected: '2026-06-05', got: '2026-06-06' } },
      error: null,
    })

    const request = createMockRequest('/api/transactions/bulk-book', {
      method: 'POST',
      body: { tx_ids: [TX1, TX2], existing_journal_entry_id: JE },
    })
    const response = await POST(request)
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(response)
    expect(status).toBe(400)
    expect(body.error.code).toBe('BULK_BOOK_DATE_MISMATCH')
  })
})

/**
 * Mixed-currency guard (BFL 4 kap 6 §: one redovisningsvaluta). A
 * samlingsverifikation spanning SEK and EUR has no representable single
 * belopp, so all three request shapes must refuse it with the SAME code the
 * MCP twin uses. Before this, only the template branch checked; manual_lines
 * and existing_journal_entry_id went straight to the RPC, which summed
 * 100 EUR + 100 SEK into the scalar 200.
 */
describe('POST /api/transactions/bulk-book: mixed-currency guard', () => {
  const mockUser = { id: 'user-1', email: 'test@test.se' }

  const MIXED_TXS = [
    { id: TX1, amount: 100, currency: 'SEK', description: 'Swish', date: '2026-06-05' },
    { id: TX2, amount: 100, currency: 'EUR', description: 'Stripe', date: '2026-06-05' },
  ]

  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: mockUser } })
  })

  it('refuses a mixed-currency selection on the template branch', async () => {
    enqueue({ data: MIXED_TXS, error: null })

    const request = createMockRequest('/api/transactions/bulk-book', {
      method: 'POST',
      body: {
        tx_ids: [TX1, TX2],
        template_id: TPL,
        mode: 'sum_per_account',
        entry_description: 'Samlingsverifikation',
      },
    })
    const response = await POST(request)
    const { status, body } = await parseJsonResponse<{
      error: { code: string; details?: { currencies?: string[] } }
    }>(response)
    expect(status).toBe(400)
    expect(body.error.code).toBe('BULK_BOOK_MIXED_CURRENCY')
  })

  it('refuses a mixed-currency selection on the manual_lines branch', async () => {
    enqueue({ data: MIXED_TXS, error: null })

    const request = createMockRequest('/api/transactions/bulk-book', {
      method: 'POST',
      body: {
        tx_ids: [TX1, TX2],
        entry_description: 'Samlingsverifikation',
        manual_lines: [
          { account_number: '1930', debit_amount: 200, credit_amount: 0, currency: 'SEK' },
          { account_number: '3001', debit_amount: 0, credit_amount: 200, currency: 'SEK' },
        ],
      },
    })
    const response = await POST(request)
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(response)
    expect(status).toBe(400)
    expect(body.error.code).toBe('BULK_BOOK_MIXED_CURRENCY')
    // Refused before the RPC: the chart-of-accounts lookup never ran either.
    expect(mockSupabase.rpc).not.toHaveBeenCalled()
  })

  it('refuses a mixed-currency selection on the existing_journal_entry_id branch', async () => {
    enqueue({ data: MIXED_TXS, error: null })

    const request = createMockRequest('/api/transactions/bulk-book', {
      method: 'POST',
      body: { tx_ids: [TX1, TX2], existing_journal_entry_id: JE },
    })
    const response = await POST(request)
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(response)
    expect(status).toBe(400)
    expect(body.error.code).toBe('BULK_BOOK_MIXED_CURRENCY')
    expect(mockSupabase.rpc).not.toHaveBeenCalled()
  })

  it('refuses a homogeneous non-SEK selection with BULK_BOOK_FOREIGN_CURRENCY', async () => {
    // Same currency throughout, but not kronor: the RPC would write the
    // foreign magnitudes into the always-SEK debit/credit columns, so the
    // route refuses before the RPC just like the mixed-currency case.
    enqueue({
      data: [
        { id: TX1, amount: 100, currency: 'EUR', description: 'Stripe 1', date: '2026-06-05' },
        { id: TX2, amount: 200, currency: 'EUR', description: 'Stripe 2', date: '2026-06-05' },
      ],
      error: null,
    })

    const request = createMockRequest('/api/transactions/bulk-book', {
      method: 'POST',
      body: {
        tx_ids: [TX1, TX2],
        entry_description: 'Samlingsverifikation',
        manual_lines: [
          { account_number: '1930', debit_amount: 300, credit_amount: 0, currency: 'EUR' },
          { account_number: '3001', debit_amount: 0, credit_amount: 300, currency: 'EUR' },
        ],
      },
    })
    const response = await POST(request)
    const { status, body } = await parseJsonResponse<{
      error: { code: string; details?: { currency?: string } }
    }>(response)
    expect(status).toBe(400)
    expect(body.error.code).toBe('BULK_BOOK_FOREIGN_CURRENCY')
    expect(body.error.details?.currency).toBe('EUR')
    expect(mockSupabase.rpc).not.toHaveBeenCalled()
  })

  it('books a single-currency manual_lines selection', async () => {
    // Tx fetch: both SEK.
    enqueue({
      data: [
        { id: TX1, amount: 100, currency: 'SEK', description: 'Swish', date: '2026-06-05' },
        { id: TX2, amount: 100, currency: 'SEK', description: 'Swish', date: '2026-06-05' },
      ],
      error: null,
    })
    // chart_of_accounts allowlist.
    enqueue({
      data: [{ account_number: '1930' }, { account_number: '3001' }],
      error: null,
    })
    // Dimension rules: none configured.
    enqueue({ data: [], error: null })
    // RPC happy path.
    enqueue({
      data: {
        ok: true,
        mode: 'create_new',
        journal_entry_id: JE,
        voucher_series: 'A',
        voucher_number: 14,
        linked_tx_count: 2,
        tx_sum: 200,
      },
      error: null,
    })
    // Event re-fetch.
    enqueue({ data: [], error: null })

    const request = createMockRequest('/api/transactions/bulk-book', {
      method: 'POST',
      body: {
        tx_ids: [TX1, TX2],
        entry_description: 'Samlingsverifikation',
        manual_lines: [
          { account_number: '1930', debit_amount: 200, credit_amount: 0, currency: 'SEK' },
          { account_number: '3001', debit_amount: 0, credit_amount: 200, currency: 'SEK' },
        ],
      },
    })
    const response = await POST(request)
    const { status, body } = await parseJsonResponse<{ data: { mode: string } }>(response)
    expect(status).toBe(200)
    expect(body.data.mode).toBe('create_new')
  })

  it('treats NULL currency as SEK and still books', async () => {
    enqueue({
      data: [
        { id: TX1, amount: 100, currency: null, description: 'Legacy row', date: '2026-06-05' },
        { id: TX2, amount: 100, currency: 'SEK', description: 'Swish', date: '2026-06-05' },
      ],
      error: null,
    })
    enqueue({ data: [{ account_number: '1930' }, { account_number: '3001' }], error: null })
    enqueue({ data: [], error: null })
    enqueue({
      data: {
        ok: true,
        mode: 'create_new',
        journal_entry_id: JE,
        voucher_series: 'A',
        voucher_number: 15,
        linked_tx_count: 2,
        tx_sum: 200,
      },
      error: null,
    })
    enqueue({ data: [], error: null })

    const request = createMockRequest('/api/transactions/bulk-book', {
      method: 'POST',
      body: {
        tx_ids: [TX1, TX2],
        entry_description: 'Samlingsverifikation',
        manual_lines: [
          { account_number: '1930', debit_amount: 200, credit_amount: 0, currency: 'SEK' },
          { account_number: '3001', debit_amount: 0, credit_amount: 200, currency: 'SEK' },
        ],
      },
    })
    const response = await POST(request)
    expect(response.status).toBe(200)
  })
})

/**
 * Booking-time duplicate guard on the samlingsverifikation path (parity with
 * /categorize and /book): before this, bulk-book never called
 * detectBookingDuplicate at all, so a batch containing an already-booked
 * twin minted a second verifikat with no warning.
 */
describe('POST /api/transactions/bulk-book: duplicate guard', () => {
  const mockUser = { id: 'user-1', email: 'test@test.se' }

  const SEK_TXS = [
    { id: TX1, amount: 100, currency: 'SEK', description: 'Swish 1', date: '2026-06-05' },
    { id: TX2, amount: 200, currency: 'SEK', description: 'Swish 2', date: '2026-06-05' },
  ]

  const CANDIDATE: BookedDuplicateCandidate = {
    transaction_id: null,
    journal_entry_id: '55555555-5555-4555-8555-555555555555',
    voucher_label: 'A17',
    entry_date: '2026-06-05',
    description: 'Swish inbetalning',
    amount: 200,
    account_number: '1930',
    currency: null,
    amount_in_currency: null,
    amount_verified: true,
    unverified_reason: null,
  }

  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: mockUser } })
    vi.mocked(detectBookingDuplicate).mockResolvedValue(null)
  })

  it('returns 409 with the candidate and the flagged tx, before the RPC', async () => {
    enqueue({ data: SEK_TXS, error: null })
    // TX1 clean, TX2 flagged (checked in tx_ids order).
    vi.mocked(detectBookingDuplicate)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(CANDIDATE)

    const request = createMockRequest('/api/transactions/bulk-book', {
      method: 'POST',
      body: { tx_ids: [TX1, TX2], existing_journal_entry_id: JE },
    })
    const response = await POST(request)
    const { status, body } = await parseJsonResponse<{
      error: { code: string; details?: { transaction_id?: string; candidate?: { journal_entry_id: string } } }
    }>(response)
    expect(status).toBe(409)
    expect(body.error.code).toBe('TRANSACTION_BOOK_POSSIBLE_DUPLICATE')
    expect(body.error.details?.transaction_id).toBe(TX2)
    expect(body.error.details?.candidate?.journal_entry_id).toBe(CANDIDATE.journal_entry_id)
    expect(mockSupabase.rpc).not.toHaveBeenCalled()
  })

  it('passes intra-batch exclusions so siblings and the link target never flag each other', async () => {
    enqueue({ data: SEK_TXS, error: null })
    // RPC + event re-fetch for the clean pass-through.
    enqueue({
      data: {
        ok: true, mode: 'link_existing', journal_entry_id: JE,
        voucher_series: 'A', voucher_number: 12, linked_tx_count: 2, tx_sum: 300,
      },
      error: null,
    })
    enqueue({ data: [], error: null })

    const request = createMockRequest('/api/transactions/bulk-book', {
      method: 'POST',
      body: { tx_ids: [TX1, TX2], existing_journal_entry_id: JE },
    })
    const response = await POST(request)
    expect(response.status).toBe(200)
    expect(detectBookingDuplicate).toHaveBeenCalledTimes(2)
    expect(detectBookingDuplicate).toHaveBeenCalledWith(
      expect.anything(),
      'company-1',
      expect.objectContaining({ id: TX1, date: '2026-06-05', amount: 100 }),
      { excludeTransactionIds: [TX1, TX2], excludeJournalEntryIds: [JE] },
    )
  })

  it('force=true books through and records each dismissed candidate in behandlingshistorik', async () => {
    enqueue({ data: SEK_TXS, error: null })
    enqueue({
      data: {
        ok: true, mode: 'link_existing', journal_entry_id: JE,
        voucher_series: 'A', voucher_number: 12, linked_tx_count: 2, tx_sum: 300,
      },
      error: null,
    })
    enqueue({ data: [], error: null })
    // Re-detection under force: TX1 clean, TX2 had the candidate.
    vi.mocked(detectBookingDuplicate)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(CANDIDATE)

    const request = createMockRequest('/api/transactions/bulk-book', {
      method: 'POST',
      body: { tx_ids: [TX1, TX2], existing_journal_entry_id: JE, force: true },
    })
    const response = await POST(request)
    expect(response.status).toBe(200)
    expect(appendProcessingHistory).toHaveBeenCalledTimes(1)
    expect(appendProcessingHistory).toHaveBeenCalledWith(
      expect.objectContaining({
        aggregateId: TX2,
        eventType: 'BankTransactionDuplicateDismissed',
        payload: expect.objectContaining({
          dismissed_journal_entry_id: CANDIDATE.journal_entry_id,
          via: 'bulk_book_force',
        }),
      }),
    )
  })

  it('fails open when detection itself throws (a guard failure never blocks a booking)', async () => {
    enqueue({ data: SEK_TXS, error: null })
    enqueue({
      data: {
        ok: true, mode: 'link_existing', journal_entry_id: JE,
        voucher_series: 'A', voucher_number: 12, linked_tx_count: 2, tx_sum: 300,
      },
      error: null,
    })
    enqueue({ data: [], error: null })
    vi.mocked(detectBookingDuplicate).mockRejectedValue(new Error('detector down'))

    const request = createMockRequest('/api/transactions/bulk-book', {
      method: 'POST',
      body: { tx_ids: [TX1, TX2], existing_journal_entry_id: JE },
    })
    const response = await POST(request)
    expect(response.status).toBe(200)
  })
})
