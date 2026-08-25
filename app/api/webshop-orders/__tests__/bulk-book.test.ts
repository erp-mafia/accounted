import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import {
  createMockRequest,
  parseJsonResponse,
  createQueuedMockSupabase,
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

const mockCreateDraftEntry = vi.fn()
const mockCommitEntry = vi.fn()
const mockFindFiscalPeriod = vi.fn()
vi.mock('@/lib/bookkeeping/engine', () => ({
  createDraftEntry: (...args: unknown[]) => mockCreateDraftEntry(...args),
  commitEntry: (...args: unknown[]) => mockCommitEntry(...args),
  findFiscalPeriod: (...args: unknown[]) => mockFindFiscalPeriod(...args),
}))

const mockFetchExchangeRate = vi.fn()
vi.mock('@/lib/currency/riksbanken', () => ({
  fetchExchangeRate: (...args: unknown[]) => mockFetchExchangeRate(...args),
}))

const mockEnsureAccounts = vi.fn().mockResolvedValue(undefined)
vi.mock('@/lib/webshop-orders/ensure-accounts', () => ({
  ensureWebshopPrefillAccounts: (...args: unknown[]) => mockEnsureAccounts(...args),
}))

import { POST } from '../bulk-book/route'

const PERIOD_UUID = '550e8400-e29b-41d4-a716-446655440000'
const ORDER_1 = '11111111-1111-4111-8111-111111111111'
const ORDER_2 = '22222222-2222-4222-8222-222222222222'
const ORDER_3 = '33333333-3333-4333-8333-333333333333'

function makeOrderRow(overrides: Record<string, unknown> = {}) {
  return {
    id: ORDER_1,
    company_id: 'company-1',
    platform: 'woocommerce',
    store_scope: 'butik.example.se',
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
    payment_method_title: 'Swish',
    journal_entry_id: null,
    invoice_id: null,
    manually_booked_at: null,
    legacy_transaction_id: null,
    ...overrides,
  }
}

interface BulkResult {
  order_id: string
  order_number: string | null
  success: boolean
  journal_entry_id?: string
  error?: { code: string; message: string; message_en: string }
}

interface BulkResponse {
  data: { results: BulkResult[]; booked_count: number; failed_count: number }
}

function postBulk(body: unknown = { order_ids: [ORDER_1, ORDER_2] }) {
  const request = createMockRequest('/api/webshop-orders/bulk-book', {
    method: 'POST',
    body,
  })
  return POST(request)
}

describe('POST /api/webshop-orders/bulk-book', () => {
  const mockUser = { id: 'user-1', email: 'test@test.se' }
  let draftCounter = 0

  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    eventBus.clear()
    draftCounter = 0
    requireAuthMock.mockResolvedValue({ user: mockUser, supabase: mockSupabase })
    requireWriteMock.mockResolvedValue({ ok: true })
    mockEnsureAccounts.mockResolvedValue(undefined)
    mockCreateDraftEntry.mockImplementation(() => {
      draftCounter += 1
      return Promise.resolve(
        makeJournalEntry({ id: `draft-${draftCounter}`, status: 'draft' }),
      )
    })
    mockCommitEntry.mockImplementation((_s, _c, _u, entryId: string) =>
      Promise.resolve(
        makeJournalEntry({
          id: `je-${entryId}`,
          voucher_series: 'A',
          voucher_number: 100 + draftCounter,
        }),
      ),
    )
    mockFindFiscalPeriod.mockResolvedValue(PERIOD_UUID)
  })

  it('returns 401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase: mockSupabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })
    const { status } = await parseJsonResponse(await postBulk())
    expect(status).toBe(401)
    expect(mockCreateDraftEntry).not.toHaveBeenCalled()
  })

  it('returns 403 when the caller is a viewer (requireWrite)', async () => {
    requireWriteMock.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }),
    })
    const { status } = await parseJsonResponse(await postBulk())
    expect(status).toBe(403)
    expect(mockCreateDraftEntry).not.toHaveBeenCalled()
  })

  it('returns 400 on invalid body (empty selection)', async () => {
    const { status } = await parseJsonResponse(await postBulk({ order_ids: [] }))
    expect(status).toBe(400)
  })

  it('returns 400 on a non-uuid order id', async () => {
    const { status } = await parseJsonResponse(
      await postBulk({ order_ids: ['not-a-uuid'] }),
    )
    expect(status).toBe(400)
  })

  it('returns 404 when none of the orders exist for the company', async () => {
    enqueue({ data: [] }) // orders fetch
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(
      await postBulk(),
    )
    expect(status).toBe(404)
    expect(body.error.code).toBe('WEBSHOP_ORDER_NOT_FOUND')
    expect(mockCreateDraftEntry).not.toHaveBeenCalled()
  })

  it('books every selected order as its own verifikat (happy path)', async () => {
    enqueue({
      data: [
        makeOrderRow(),
        makeOrderRow({ id: ORDER_2, order_number: '1002', external_id: 'x2' }),
      ],
    })
    enqueue({ data: [] }) // store settings
    enqueue({ data: [{ id: ORDER_1 }] }) // claim order 1
    enqueue({ data: [{ id: ORDER_2 }] }) // claim order 2
    const { status, body } = await parseJsonResponse<BulkResponse>(await postBulk())
    expect(status).toBe(200)
    expect(body.data.booked_count).toBe(2)
    expect(body.data.failed_count).toBe(0)
    expect(body.data.results).toHaveLength(2)
    expect(body.data.results.every((r) => r.success)).toBe(true)
    expect(mockCreateDraftEntry).toHaveBeenCalledTimes(2)
    expect(mockCommitEntry).toHaveBeenCalledTimes(2)
    const firstInput = mockCreateDraftEntry.mock.calls[0][3] as {
      source_type: string
      source_id: string
      fiscal_period_id: string
      description: string
      lines: { account_number: string; debit_amount: number }[]
    }
    expect(firstInput.source_type).toBe('webshop_order')
    expect(firstInput.source_id).toBe(ORDER_1)
    expect(firstInput.fiscal_period_id).toBe(PERIOD_UUID)
    expect(firstInput.description).toBe('Order 1001 (Swish)')
    // No mapping saved: the payment leg defaults to the 1686 clearing account.
    expect(firstInput.lines[0]).toMatchObject({
      account_number: '1686',
      debit_amount: 500,
    })
    const secondInput = mockCreateDraftEntry.mock.calls[1][3] as { source_id: string }
    expect(secondInput.source_id).toBe(ORDER_2)
  })

  it('applies the payment_account override to every order', async () => {
    enqueue({ data: [makeOrderRow()] })
    enqueue({ data: [] }) // store settings
    enqueue({ data: [{ id: ORDER_1 }] }) // claim
    const { status } = await parseJsonResponse(
      await postBulk({ order_ids: [ORDER_1], payment_account: '1930' }),
    )
    expect(status).toBe(200)
    const input = mockCreateDraftEntry.mock.calls[0][3] as {
      lines: { account_number: string }[]
    }
    expect(input.lines[0].account_number).toBe('1930')
  })

  it('uses the per-store payment-method mapping when no override is sent', async () => {
    enqueue({ data: [makeOrderRow()] })
    enqueue({
      data: [
        {
          id: 'settings-1',
          company_id: 'company-1',
          platform: 'woocommerce',
          store_scope: 'butik.example.se',
          payment_method_account_map: { swish: { mode: 'book', account: '1580' } },
        },
      ],
    })
    enqueue({ data: [{ id: ORDER_1 }] }) // claim
    const { status } = await parseJsonResponse(await postBulk({ order_ids: [ORDER_1] }))
    expect(status).toBe(200)
    const input = mockCreateDraftEntry.mock.calls[0][3] as {
      lines: { account_number: string }[]
    }
    expect(input.lines[0].account_number).toBe('1580')
  })

  it('reports per-order failure without aborting the batch (guard failure)', async () => {
    enqueue({
      data: [
        makeOrderRow({ journal_entry_id: 'je-existing' }),
        makeOrderRow({ id: ORDER_2, order_number: '1002' }),
      ],
    })
    enqueue({ data: [] }) // store settings
    enqueue({ data: [{ id: ORDER_2 }] }) // claim order 2
    const { status, body } = await parseJsonResponse<BulkResponse>(await postBulk())
    expect(status).toBe(200)
    expect(body.data.booked_count).toBe(1)
    expect(body.data.failed_count).toBe(1)
    const failed = body.data.results.find((r) => r.order_id === ORDER_1)
    expect(failed?.success).toBe(false)
    expect(failed?.error?.code).toBe('WEBSHOP_ORDER_ALREADY_BOOKED')
    expect(failed?.error?.message).toBeTruthy()
    const succeeded = body.data.results.find((r) => r.order_id === ORDER_2)
    expect(succeeded?.success).toBe(true)
    expect(mockCommitEntry).toHaveBeenCalledTimes(1)
  })

  it('refuses an order marked as booked outside the integration (per-order)', async () => {
    enqueue({
      data: [
        makeOrderRow({ manually_booked_at: '2026-08-01T00:00:00Z' }),
        makeOrderRow({ id: ORDER_2, order_number: '1002' }),
      ],
    })
    enqueue({ data: [] }) // store settings
    enqueue({ data: [{ id: ORDER_2 }] }) // claim order 2
    const { status, body } = await parseJsonResponse<BulkResponse>(await postBulk())
    expect(status).toBe(200)
    const failed = body.data.results.find((r) => r.order_id === ORDER_1)
    expect(failed?.error?.code).toBe('WEBSHOP_ORDER_MANUALLY_BOOKED')
    expect(body.data.booked_count).toBe(1)
  })

  it('continues after an engine failure and cleans up that order alone', async () => {
    mockCommitEntry.mockRejectedValueOnce(new Error('period locked'))
    enqueue({
      data: [
        makeOrderRow(),
        makeOrderRow({ id: ORDER_2, order_number: '1002' }),
      ],
    })
    enqueue({ data: [] }) // store settings
    enqueue({ data: [{ id: ORDER_1 }] }) // claim order 1
    enqueue({ data: null }) // unlink order 1
    enqueue({ data: null }) // cancel draft 1
    enqueue({ data: [{ id: ORDER_2 }] }) // claim order 2
    const { status, body } = await parseJsonResponse<BulkResponse>(await postBulk())
    expect(status).toBe(200)
    expect(body.data.booked_count).toBe(1)
    expect(body.data.failed_count).toBe(1)
    expect(body.data.results[0].success).toBe(false)
    expect(body.data.results[1].success).toBe(true)
    // The failed order was unlinked so it does not point at a cancelled draft.
    const orderUpdates = findCalls('webshop_orders', 'update')
    expect(
      orderUpdates.some(
        (args) => (args[0] as Record<string, unknown>).journal_entry_id === null,
      ),
    ).toBe(true)
  })

  it('reports ids that do not exist for the company as per-order failures', async () => {
    enqueue({ data: [makeOrderRow()] }) // only ORDER_1 exists
    enqueue({ data: [] }) // store settings
    enqueue({ data: [{ id: ORDER_1 }] }) // claim order 1
    const { status, body } = await parseJsonResponse<BulkResponse>(
      await postBulk({ order_ids: [ORDER_1, ORDER_3] }),
    )
    expect(status).toBe(200)
    expect(body.data.booked_count).toBe(1)
    const missing = body.data.results.find((r) => r.order_id === ORDER_3)
    expect(missing?.success).toBe(false)
    expect(missing?.error?.code).toBe('WEBSHOP_ORDER_NOT_FOUND')
  })

  it('fails the order when no open fiscal period covers its date', async () => {
    mockFindFiscalPeriod.mockResolvedValue(null)
    enqueue({ data: [makeOrderRow()] })
    enqueue({ data: [] }) // store settings
    const { status, body } = await parseJsonResponse<BulkResponse>(
      await postBulk({ order_ids: [ORDER_1] }),
    )
    expect(status).toBe(200)
    expect(body.data.failed_count).toBe(1)
    expect(body.data.results[0].error?.code).toBe('NO_OPEN_PERIOD_FOR_DATE')
    expect(mockCreateDraftEntry).not.toHaveBeenCalled()
  })

  it('fails a non-SEK order whose rate cannot be resolved, books the rest', async () => {
    mockFetchExchangeRate.mockResolvedValue(null)
    enqueue({
      data: [
        makeOrderRow({
          currency: 'EUR',
          total_sek: null,
          exchange_rate: null,
        }),
        makeOrderRow({ id: ORDER_2, order_number: '1002' }),
      ],
    })
    enqueue({ data: [] }) // store settings
    enqueue({ data: [{ id: ORDER_2 }] }) // claim order 2
    const { status, body } = await parseJsonResponse<BulkResponse>(await postBulk())
    expect(status).toBe(200)
    const failed = body.data.results.find((r) => r.order_id === ORDER_1)
    expect(failed?.error?.code).toBe('WEBSHOP_ORDER_FX_UNRESOLVED')
    const succeeded = body.data.results.find((r) => r.order_id === ORDER_2)
    expect(succeeded?.success).toBe(true)
  })

  it('reports a raced claim as WEBSHOP_ORDER_ALREADY_BOOKED and cancels that draft', async () => {
    enqueue({ data: [makeOrderRow()] })
    enqueue({ data: [] }) // store settings
    enqueue({ data: [] }) // claim matched ZERO rows: raced
    enqueue({ data: null }) // draft cancel update
    const { status, body } = await parseJsonResponse<BulkResponse>(
      await postBulk({ order_ids: [ORDER_1] }),
    )
    expect(status).toBe(200)
    expect(body.data.results[0].error?.code).toBe('WEBSHOP_ORDER_ALREADY_BOOKED')
    expect(mockCommitEntry).not.toHaveBeenCalled()
    const cancels = findCalls('journal_entries', 'update')
    expect(cancels.length).toBeGreaterThan(0)
    expect((cancels[0][0] as Record<string, unknown>).status).toBe('cancelled')
  })

  it('deduplicates repeated ids in the selection', async () => {
    enqueue({ data: [makeOrderRow()] })
    enqueue({ data: [] }) // store settings
    enqueue({ data: [{ id: ORDER_1 }] }) // claim once
    const { status, body } = await parseJsonResponse<BulkResponse>(
      await postBulk({ order_ids: [ORDER_1, ORDER_1] }),
    )
    expect(status).toBe(200)
    expect(body.data.results).toHaveLength(1)
    expect(mockCreateDraftEntry).toHaveBeenCalledTimes(1)
  })
})
