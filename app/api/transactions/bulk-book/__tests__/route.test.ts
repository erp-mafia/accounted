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

import { POST } from '../route'
import { applyTemplate } from '@/lib/bookkeeping/template-library'

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
  })

  it('create-new path fetches template, expands per mode, and calls RPC', async () => {
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
    // Tx fetch: 2 incomes totalling 300.
    enqueue({
      data: [
        { id: TX1, amount: 100, currency: 'SEK', description: 'Swish 1', date: '2026-06-05' },
        { id: TX2, amount: 200, currency: 'SEK', description: 'Swish 2', date: '2026-06-05' },
      ],
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
