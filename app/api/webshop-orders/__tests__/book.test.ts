import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import {
  createMockRequest,
  parseJsonResponse,
  createMockRouteParams,
  createQueuedMockSupabase,
  makeJournalEntry,
} from '@/tests/helpers'
import { eventBus } from '@/lib/events'

const { supabase: mockSupabase, enqueue, reset, findCall, findCalls } =
  createQueuedMockSupabase()

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

const mockCreateDraftEntry = vi.fn()
const mockCommitEntry = vi.fn()
vi.mock('@/lib/bookkeeping/engine', () => ({
  createDraftEntry: (...args: unknown[]) => mockCreateDraftEntry(...args),
  commitEntry: (...args: unknown[]) => mockCommitEntry(...args),
}))

const mockFetchExchangeRate = vi.fn()
vi.mock('@/lib/currency/riksbanken', () => ({
  fetchExchangeRate: (...args: unknown[]) => mockFetchExchangeRate(...args),
}))

// Behaviour lives in lib/webshop-orders/__tests__/ensure-accounts.test.ts; here
// we only assert that the route hands it the accounts it is about to book.
const mockEnsureAccounts = vi.fn().mockResolvedValue(undefined)
vi.mock('@/lib/webshop-orders/ensure-accounts', () => ({
  ensureWebshopPrefillAccounts: (...args: unknown[]) => mockEnsureAccounts(...args),
}))

import { POST } from '../[id]/book/route'

const PERIOD_UUID = '550e8400-e29b-41d4-a716-446655440000'

function makeOrderRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'order-1',
    company_id: 'company-1',
    row_type: 'order',
    parent_order_id: null,
    external_id: 'woo_butik.example.se_order_1001',
    order_number: '1001',
    status: 'processing',
    is_paid: true,
    order_date: '2026-08-01',
    paid_date: '2026-08-01',
    currency: 'SEK',
    total: 500,
    total_tax: 100,
    total_sek: 500,
    exchange_rate: 1,
    vat_breakdown: [{ rate: 25, net: 400, tax: 100 }],
    line_items: [],
    payment_method: 'swish',
    journal_entry_id: null,
    invoice_id: null,
    legacy_transaction_id: null,
    manually_booked_at: null,
    ...overrides,
  }
}

const validBody = {
  fiscal_period_id: PERIOD_UUID,
  entry_date: '2026-08-01',
  description: 'Order 1001 (Swish)',
  lines: [
    { account_number: '1930', debit_amount: 500, credit_amount: 0 },
    { account_number: '3001', debit_amount: 0, credit_amount: 400 },
    { account_number: '2611', debit_amount: 0, credit_amount: 100 },
  ],
}

function postBook(body: unknown = validBody, id = 'order-1') {
  const request = createMockRequest(`/api/webshop-orders/${id}/book`, {
    method: 'POST',
    body,
  })
  return POST(request, createMockRouteParams({ id }))
}

describe('POST /api/webshop-orders/[id]/book', () => {
  const mockUser = { id: 'user-1', email: 'test@test.se' }

  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    eventBus.clear()
    requireAuthMock.mockResolvedValue({ user: mockUser, supabase: mockSupabase })
    requireWriteMock.mockResolvedValue({ ok: true })
    mockCreateDraftEntry.mockResolvedValue(makeJournalEntry({ id: 'draft-1', status: 'draft' }))
    mockCommitEntry.mockResolvedValue(makeJournalEntry({ id: 'je-1' }))
  })

  it('returns 401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase: mockSupabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })
    const { status } = await parseJsonResponse(await postBook())
    expect(status).toBe(401)
    expect(mockCreateDraftEntry).not.toHaveBeenCalled()
  })

  it('returns 403 when the caller is a viewer (requireWrite)', async () => {
    requireWriteMock.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }),
    })
    const { status } = await parseJsonResponse(await postBook())
    expect(status).toBe(403)
    expect(mockCreateDraftEntry).not.toHaveBeenCalled()
  })

  it('returns 400 on invalid body', async () => {
    const { status } = await parseJsonResponse(
      await postBook({ fiscal_period_id: PERIOD_UUID }),
    )
    expect(status).toBe(400)
  })

  it('returns 404 when the order does not exist for the company', async () => {
    enqueue({ data: null, error: { message: 'not found' } })
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(
      await postBook(),
    )
    expect(status).toBe(404)
    expect(body.error.code).toBe('WEBSHOP_ORDER_NOT_FOUND')
  })

  it('returns 409 when already booked', async () => {
    enqueue({ data: makeOrderRow({ journal_entry_id: 'je-9' }) })
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(
      await postBook(),
    )
    expect(status).toBe(409)
    expect(body.error.code).toBe('WEBSHOP_ORDER_ALREADY_BOOKED')
  })

  it('returns 409 when linked to an invoice', async () => {
    enqueue({ data: makeOrderRow({ invoice_id: 'inv-1' }) })
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(
      await postBook(),
    )
    expect(status).toBe(409)
    expect(body.error.code).toBe('WEBSHOP_ORDER_ALREADY_INVOICED')
  })

  it('returns 409 when marked as booked outside the integration', async () => {
    enqueue({ data: makeOrderRow({ manually_booked_at: '2026-08-01T00:00:00Z' }) })
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(
      await postBook(),
    )
    expect(status).toBe(409)
    expect(body.error.code).toBe('WEBSHOP_ORDER_MANUALLY_BOOKED')
    expect(mockCreateDraftEntry).not.toHaveBeenCalled()
  })

  it('excludes manually marked rows in the atomic claim', async () => {
    enqueue({ data: makeOrderRow() }) // fetch
    enqueue({ data: [{ id: 'order-1' }] }) // claim
    const { status } = await parseJsonResponse(await postBook())
    expect(status).toBe(200)
    const isFilters = findCalls('webshop_orders', 'is')
    expect(isFilters).toEqual(
      expect.arrayContaining([
        ['journal_entry_id', null],
        ['invoice_id', null],
        ['manually_booked_at', null],
      ]),
    )
  })

  it('returns 409 for unpaid orders', async () => {
    enqueue({ data: makeOrderRow({ is_paid: false, paid_date: null }) })
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(
      await postBook(),
    )
    expect(status).toBe(409)
    expect(body.error.code).toBe('WEBSHOP_ORDER_NOT_PAID')
  })

  it('returns 409 when the legacy feed transaction is still open', async () => {
    enqueue({ data: makeOrderRow({ legacy_transaction_id: 'txn-1' }) })
    enqueue({ data: { id: 'txn-1', journal_entry_id: null, is_ignored: false } })
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(
      await postBook(),
    )
    expect(status).toBe(409)
    expect(body.error.code).toBe('WEBSHOP_ORDER_LEGACY_TRANSACTION_OPEN')
    expect(mockCreateDraftEntry).not.toHaveBeenCalled()
  })

  it('returns 409 when the legacy feed transaction is already booked', async () => {
    enqueue({ data: makeOrderRow({ legacy_transaction_id: 'txn-1' }) })
    enqueue({ data: { id: 'txn-1', journal_entry_id: 'je-77', is_ignored: false } })
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(
      await postBook(),
    )
    expect(status).toBe(409)
    expect(body.error.code).toBe('WEBSHOP_ORDER_LEGACY_TRANSACTION_BOOKED')
  })

  it('books when the legacy feed transaction was IGNORED (the 409 message honored)', async () => {
    enqueue({ data: makeOrderRow({ legacy_transaction_id: 'txn-1' }) })
    enqueue({ data: { id: 'txn-1', journal_entry_id: null, is_ignored: true } }) // legacy check
    enqueue({ data: [{ id: 'order-1' }] }) // claim
    const { status } = await parseJsonResponse(await postBook())
    expect(status).toBe(200)
    expect(mockCommitEntry).toHaveBeenCalled()
  })

  it('ensures the prefill accounts exist in the chart before drafting', async () => {
    // Regression: seed_chart_of_accounts() does not seed 1686/3740/3004, so a
    // fresh company used to hit AccountsNotInChartError on its first Bokför.
    enqueue({ data: makeOrderRow() })
    enqueue({ data: [{ id: 'order-1' }] }) // claim
    const { status } = await parseJsonResponse(await postBook())
    expect(status).toBe(200)
    expect(mockEnsureAccounts).toHaveBeenCalledWith(
      expect.anything(),
      'company-1',
      'user-1',
      validBody.lines.map((l) => l.account_number),
      expect.anything(),
    )
    // Order matters: the chart must be repaired before the engine reads it.
    expect(mockEnsureAccounts.mock.invocationCallOrder[0]).toBeLessThan(
      mockCreateDraftEntry.mock.invocationCallOrder[0],
    )
  })

  it('returns 422 when a non-SEK order has no rate and the retry fails', async () => {
    enqueue({ data: makeOrderRow({ currency: 'EUR', total_sek: null, exchange_rate: null }) })
    mockFetchExchangeRate.mockResolvedValue(null)
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(
      await postBook(),
    )
    expect(status).toBe(422)
    expect(body.error.code).toBe('WEBSHOP_ORDER_FX_UNRESOLVED')
  })

  it('drafts, claims atomically, then commits with source_type webshop_order', async () => {
    enqueue({ data: makeOrderRow() }) // fetch
    enqueue({ data: [{ id: 'order-1' }] }) // claim matched one row
    const { status, body } = await parseJsonResponse<{ journal_entry_id: string }>(
      await postBook(),
    )
    expect(status).toBe(200)
    expect(body.journal_entry_id).toBe('je-1')
    expect(mockCreateDraftEntry).toHaveBeenCalledWith(
      expect.anything(),
      'company-1',
      'user-1',
      expect.objectContaining({
        source_type: 'webshop_order',
        source_id: 'order-1',
        fiscal_period_id: PERIOD_UUID,
      }),
    )
    expect(mockCommitEntry).toHaveBeenCalledWith(
      expect.anything(),
      'company-1',
      'user-1',
      'draft-1',
    )
  })

  it('returns 409 and cancels the draft when another request wins the claim', async () => {
    enqueue({ data: makeOrderRow() }) // fetch (sees unbooked)
    enqueue({ data: [] }) // claim matched ZERO rows: raced
    enqueue({ data: null }) // draft cancel update
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(
      await postBook(),
    )
    expect(status).toBe(409)
    expect(body.error.code).toBe('WEBSHOP_ORDER_ALREADY_BOOKED')
    expect(mockCommitEntry).not.toHaveBeenCalled()
    const cancel = findCall('journal_entries', 'update')
    expect(cancel).toBeDefined()
    expect((cancel![0] as Record<string, unknown>).status).toBe('cancelled')
  })

  it('unlinks and cancels the draft when the commit fails', async () => {
    mockCommitEntry.mockRejectedValueOnce(new Error('period locked'))
    enqueue({ data: makeOrderRow() }) // fetch
    enqueue({ data: [{ id: 'order-1' }] }) // claim
    enqueue({ data: null }) // unlink
    enqueue({ data: null }) // cancel draft
    const { status } = await parseJsonResponse(await postBook())
    expect(status).toBeGreaterThanOrEqual(400)
    const orderUpdates = findCalls('webshop_orders', 'update')
    expect(
      orderUpdates.some(
        (args) => (args[0] as Record<string, unknown>).journal_entry_id === null,
      ),
    ).toBe(true)
  })

  it('books a refund row whose parent is not invoiced', async () => {
    enqueue({
      data: makeOrderRow({
        row_type: 'refund',
        parent_order_id: 'parent-1',
        total: -500,
        total_sek: -500,
      }),
    })
    enqueue({ data: { invoice_id: null } }) // parent check
    enqueue({ data: [{ id: 'order-1' }] }) // claim
    const { status } = await parseJsonResponse(await postBook())
    expect(status).toBe(200)
  })

  it('refuses a refund row whose parent was invoiced', async () => {
    enqueue({
      data: makeOrderRow({
        row_type: 'refund',
        parent_order_id: 'parent-1',
        total: -500,
        total_sek: -500,
      }),
    })
    enqueue({ data: { invoice_id: 'inv-5' } })
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(
      await postBook(),
    )
    expect(status).toBe(409)
    expect(body.error.code).toBe('WEBSHOP_ORDER_REFUND_PARENT_INVOICED')
  })
})
