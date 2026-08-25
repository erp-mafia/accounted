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

// Underlag rendering/archiving behaviour lives in
// lib/webshop-orders/__tests__/order-underlag.test.ts; here we only assert
// that every booked order gets one archive call through the shared flow.
const mockArchiveUnderlag = vi.fn()
vi.mock('@/lib/webshop-orders/order-underlag', () => ({
  archiveWebshopOrderUnderlag: (...args: unknown[]) => mockArchiveUnderlag(...args),
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
  underlag_archived?: boolean
  error?: {
    code: string
    message: string
    message_en: string
    details?: Record<string, unknown>
  }
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
    mockArchiveUnderlag.mockResolvedValue({ ok: true, documentId: 'doc-1' })
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
    // Each booked order gets its orderunderlag through the shared flow
    // (#1881); the per-order result reports it.
    expect(mockArchiveUnderlag).toHaveBeenCalledTimes(2)
    expect(mockArchiveUnderlag).toHaveBeenCalledWith(
      expect.objectContaining({
        companyId: 'company-1',
        userId: 'user-1',
        order: expect.objectContaining({ id: ORDER_1 }),
      }),
    )
    expect(body.data.results.every((r) => r.underlag_archived === true)).toBe(true)
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

  it('routes revenue through the revenue template and keeps VAT derived', async () => {
    enqueue({
      data: [
        makeOrderRow(),
        makeOrderRow({
          id: ORDER_2,
          order_number: '1002',
          external_id: 'x2',
          total: 112,
          total_tax: 12,
          total_sek: 112,
          vat_breakdown: [{ rate: 12, net: 100, tax: 12 }],
        }),
      ],
    })
    enqueue({ data: [] }) // store settings
    enqueue({
      data: [
        {
          account_number: '3041',
          account_name: 'Försäljning tjänster',
          is_active: true,
          default_vat_rate: 0.25,
          default_vat_treatment: null,
        },
      ],
    }) // chart check
    enqueue({ data: [{ id: ORDER_1 }] }) // claim order 1
    enqueue({ data: [{ id: ORDER_2 }] }) // claim order 2
    const { status, body } = await parseJsonResponse<BulkResponse>(
      await postBulk({
        order_ids: [ORDER_1, ORDER_2],
        revenue_accounts: { '25': '3041' },
      }),
    )
    expect(status).toBe(200)
    expect(body.data.booked_count).toBe(2)
    const firstLines = (
      mockCreateDraftEntry.mock.calls[0][3] as {
        lines: { account_number: string; credit_amount: number }[]
      }
    ).lines
    // 25% revenue re-routed to the chosen account; VAT stays on 2611.
    expect(firstLines.find((l) => l.account_number === '3041')?.credit_amount).toBe(400)
    expect(firstLines.some((l) => l.account_number === '3001')).toBe(false)
    expect(firstLines.find((l) => l.account_number === '2611')?.credit_amount).toBe(100)
    // The 12% order is untouched by a 25%-only template.
    const secondLines = (
      mockCreateDraftEntry.mock.calls[1][3] as {
        lines: { account_number: string; credit_amount: number }[]
      }
    ).lines
    expect(secondLines.find((l) => l.account_number === '3002')?.credit_amount).toBe(100)
  })

  it('aborts the whole sweep when a template account is not active in the chart', async () => {
    enqueue({ data: [makeOrderRow()] })
    enqueue({ data: [] }) // store settings
    enqueue({
      data: [
        {
          account_number: '3041',
          account_name: 'Försäljning tjänster',
          is_active: false,
          default_vat_rate: 0.25,
          default_vat_treatment: null,
        },
      ],
    }) // chart check
    const { status, body } = await parseJsonResponse<{
      error: { code: string; details?: { accounts?: string[] } }
    }>(
      await postBulk({
        order_ids: [ORDER_1],
        revenue_accounts: { '25': '3041' },
      }),
    )
    expect(status).toBe(422)
    expect(body.error.code).toBe('WEBSHOP_ORDER_REVENUE_ACCOUNT_UNKNOWN')
    expect(body.error.details?.accounts).toEqual(['3041'])
    // Nothing may book on a template the user has to fix first.
    expect(mockCreateDraftEntry).not.toHaveBeenCalled()
  })

  it('returns 400 for a non-class-3 revenue-template account', async () => {
    const { status } = await parseJsonResponse(
      await postBulk({
        order_ids: [ORDER_1],
        revenue_accounts: { '25': '1930' },
      }),
    )
    expect(status).toBe(400)
    expect(mockCreateDraftEntry).not.toHaveBeenCalled()
  })

  it('returns 400 for 3740 as a revenue-template account (residual guard integrity)', async () => {
    // Skeptic counterexample: a 3740 revenue line would be found first by an
    // account-keyed residual lookup and let a mangled order book its gap as
    // öresavrundning. The schema bans it outright.
    const { status } = await parseJsonResponse(
      await postBulk({
        order_ids: [ORDER_1],
        revenue_accounts: { '25': '3740' },
      }),
    )
    expect(status).toBe(400)
    expect(mockCreateDraftEntry).not.toHaveBeenCalled()
  })

  it('refuses a default-set account templated onto the wrong rate', async () => {
    // 3002 is the 12% default; routing 25% revenue to it would book a
    // taxable 25% sale on a 12% account while VAT still books 2611.
    enqueue({ data: [makeOrderRow()] })
    enqueue({ data: [] }) // store settings
    const { status, body } = await parseJsonResponse<{
      error: { code: string; details?: { accounts?: unknown[] } }
    }>(
      await postBulk({
        order_ids: [ORDER_1],
        revenue_accounts: { '25': '3002' },
      }),
    )
    expect(status).toBe(422)
    expect(body.error.code).toBe('WEBSHOP_ORDER_REVENUE_ACCOUNT_RATE_MISMATCH')
    expect(body.error.details?.accounts).toEqual([{ rate: 25, account: '3002' }])
    expect(mockCreateDraftEntry).not.toHaveBeenCalled()
  })

  it('refuses a custom account not configured for the rate (ruta 05 integrity)', async () => {
    // Swedish accounting review finding: an account with no momssats, no
    // treatment and no rate-conforming name drops the sale's base out of
    // ruta 05 while the VAT books ruta 10. The sweep refuses and names it.
    enqueue({ data: [makeOrderRow()] })
    enqueue({ data: [] }) // store settings
    enqueue({
      data: [
        {
          account_number: '3051',
          account_name: 'Försäljning tjänster',
          is_active: true,
          default_vat_rate: null,
          default_vat_treatment: null,
        },
      ],
    }) // chart check
    const { status, body } = await parseJsonResponse<{
      error: { code: string; details?: { accounts?: unknown[] } }
    }>(
      await postBulk({
        order_ids: [ORDER_1],
        revenue_accounts: { '25': '3051' },
      }),
    )
    expect(status).toBe(422)
    expect(body.error.code).toBe('WEBSHOP_ORDER_REVENUE_ACCOUNT_RATE_MISMATCH')
    expect(body.error.details?.accounts).toEqual([{ rate: 25, account: '3051' }])
    expect(mockCreateDraftEntry).not.toHaveBeenCalled()
  })

  it('accepts a custom account qualified by its rate-conforming number and name', async () => {
    // No explicit momssats, but 3041 + a name naming exactly "25 % moms"
    // is what the ruta 05 report logic itself accepts (inferDomesticSalesRate).
    enqueue({ data: [makeOrderRow()] })
    enqueue({ data: [] }) // store settings
    enqueue({
      data: [
        {
          account_number: '3041',
          account_name: 'Försäljning tjänster 25 % moms',
          is_active: true,
          default_vat_rate: null,
          default_vat_treatment: null,
        },
      ],
    }) // chart check
    enqueue({ data: [{ id: ORDER_1 }] }) // claim
    const { status, body } = await parseJsonResponse<BulkResponse>(
      await postBulk({
        order_ids: [ORDER_1],
        revenue_accounts: { '25': '3041' },
      }),
    )
    expect(status).toBe(200)
    expect(body.data.booked_count).toBe(1)
  })

  it('still bounds the residual when the revenue is templated (mangled order)', async () => {
    // Skeptic scenario, post-fix: gift-card order whose gross (500) exceeds
    // its VAT breakdown (0.80 + 0.20). The residual line is identified
    // structurally (last line), so the templated revenue line can never
    // shadow it and the order is refused, exactly as without a template.
    enqueue({
      data: [
        makeOrderRow({
          total: 500,
          total_sek: 500,
          total_tax: 0.2,
          vat_breakdown: [{ rate: 25, net: 0.8, tax: 0.2 }],
        }),
      ],
    })
    enqueue({ data: [] }) // store settings
    enqueue({
      data: [
        {
          account_number: '3041',
          account_name: 'Försäljning tjänster',
          is_active: true,
          default_vat_rate: 0.25,
          default_vat_treatment: null,
        },
      ],
    }) // chart check
    const { status, body } = await parseJsonResponse<BulkResponse>(
      await postBulk({
        order_ids: [ORDER_1],
        revenue_accounts: { '25': '3041' },
      }),
    )
    expect(status).toBe(200)
    expect(body.data.results[0].error?.code).toBe('WEBSHOP_ORDER_RESIDUAL_TOO_LARGE')
    expect(mockCreateDraftEntry).not.toHaveBeenCalled()
  })

  it('composes the revenue template with the payment_account override', async () => {
    enqueue({ data: [makeOrderRow()] })
    enqueue({ data: [] }) // store settings
    enqueue({
      data: [
        {
          account_number: '3041',
          account_name: 'Försäljning tjänster',
          is_active: true,
          default_vat_rate: 0.25,
          default_vat_treatment: null,
        },
      ],
    }) // chart check
    enqueue({ data: [{ id: ORDER_1 }] }) // claim
    const { status } = await parseJsonResponse(
      await postBulk({
        order_ids: [ORDER_1],
        payment_account: '1930',
        revenue_accounts: { '25': '3041' },
      }),
    )
    expect(status).toBe(200)
    const lines = (
      mockCreateDraftEntry.mock.calls[0][3] as {
        lines: { account_number: string; debit_amount: number; credit_amount: number }[]
      }
    ).lines
    expect(lines[0]).toMatchObject({ account_number: '1930', debit_amount: 500 })
    expect(lines.find((l) => l.account_number === '3041')?.credit_amount).toBe(400)
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
    // Guard details survive into the per-order envelope (skeptic finding).
    expect(failed?.error?.details?.journal_entry_id).toBe('je-existing')
    const succeeded = body.data.results.find((r) => r.order_id === ORDER_2)
    expect(succeeded?.success).toBe(true)
    expect(mockCommitEntry).toHaveBeenCalledTimes(1)
  })

  it('refuses an order with no VAT breakdown instead of booking the guessed split', async () => {
    // Skeptic counterexample: 25%+6% mixed sale whose sync stored no per-rate
    // breakdown; the ratio fallback would classify it as a 12% sale. The
    // sweep must refuse it (only the single dialog may show the guess) and
    // still book the healthy order.
    enqueue({
      data: [
        makeOrderRow({ total: 1117, total_tax: 117, vat_breakdown: [] }),
        makeOrderRow({ id: ORDER_2, order_number: '1002' }),
      ],
    })
    enqueue({ data: [] }) // store settings
    enqueue({ data: [{ id: ORDER_2 }] }) // claim order 2
    const { status, body } = await parseJsonResponse<BulkResponse>(await postBulk())
    expect(status).toBe(200)
    const failed = body.data.results.find((r) => r.order_id === ORDER_1)
    expect(failed?.error?.code).toBe('WEBSHOP_ORDER_VAT_BREAKDOWN_MISSING')
    expect(body.data.booked_count).toBe(1)
    // The guessed lines must never have reached the engine.
    expect(mockCreateDraftEntry).toHaveBeenCalledTimes(1)
    const input = mockCreateDraftEntry.mock.calls[0][3] as { source_id: string }
    expect(input.source_id).toBe(ORDER_2)
  })

  it('refuses a refund row with no VAT breakdown (zero-moms reversal guard)', async () => {
    enqueue({
      data: [
        makeOrderRow({
          row_type: 'refund',
          parent_order_id: null,
          total: -500,
          total_sek: -500,
          total_tax: 0,
          vat_breakdown: [],
        }),
      ],
    })
    enqueue({ data: [] }) // store settings
    const { status, body } = await parseJsonResponse<BulkResponse>(
      await postBulk({ order_ids: [ORDER_1] }),
    )
    expect(status).toBe(200)
    expect(body.data.results[0].error?.code).toBe('WEBSHOP_ORDER_VAT_BREAKDOWN_MISSING')
    expect(mockCreateDraftEntry).not.toHaveBeenCalled()
  })

  it('refuses a bucket with a non-Swedish VAT rate (foreign OSS bucket)', async () => {
    // Skeptic counterexample: a German 19% bucket passes the non-empty gate
    // and yields zero residual, but REVENUE/VAT_ACCOUNT_BY_RATE[19] would
    // fall back to the 25% accounts and book German VAT as Swedish
    // utgaende moms. The sweep must refuse; only the single dialog may show
    // that prefill for correction.
    enqueue({
      data: [
        makeOrderRow({
          total: 1190,
          total_tax: 190,
          vat_breakdown: [{ rate: 19, net: 1000, tax: 190 }],
        }),
        makeOrderRow({ id: ORDER_2, order_number: '1002' }),
      ],
    })
    enqueue({ data: [] }) // store settings
    enqueue({ data: [{ id: ORDER_2 }] }) // claim order 2
    const { status, body } = await parseJsonResponse<BulkResponse>(await postBulk())
    expect(status).toBe(200)
    const failed = body.data.results.find((r) => r.order_id === ORDER_1)
    expect(failed?.error?.code).toBe('WEBSHOP_ORDER_UNSUPPORTED_VAT_RATE')
    expect(failed?.error?.details?.rates).toEqual([19])
    expect(body.data.booked_count).toBe(1)
    // The 19% prefill must never have reached the engine.
    expect(mockCreateDraftEntry).toHaveBeenCalledTimes(1)
    const input = mockCreateDraftEntry.mock.calls[0][3] as { source_id: string }
    expect(input.source_id).toBe(ORDER_2)
  })

  it('refuses invoice-mode payment methods even with an account override', async () => {
    enqueue({
      data: [
        makeOrderRow({ payment_method: 'bacs', payment_method_title: 'Bank transfer' }),
      ],
    })
    enqueue({
      data: [
        {
          id: 'settings-1',
          company_id: 'company-1',
          platform: 'woocommerce',
          store_scope: 'butik.example.se',
          payment_method_account_map: { bacs: { mode: 'invoice' } },
        },
      ],
    })
    const { status, body } = await parseJsonResponse<BulkResponse>(
      await postBulk({ order_ids: [ORDER_1], payment_account: '1930' }),
    )
    expect(status).toBe(200)
    expect(body.data.results[0].error?.code).toBe('WEBSHOP_ORDER_INVOICE_MODE_METHOD')
    expect(mockCreateDraftEntry).not.toHaveBeenCalled()
  })

  it('refuses an order whose 3740 residual is above ore scale', async () => {
    // Gift-card-style gap: gross 880 but the breakdown sums to 1000, so the
    // builder would dump 120 kr on 3740 "oresavrundning". Not öre: refuse.
    enqueue({
      data: [
        makeOrderRow({
          total: 880,
          total_tax: 200,
          vat_breakdown: [{ rate: 25, net: 800, tax: 200 }],
        }),
      ],
    })
    enqueue({ data: [] }) // store settings
    const { status, body } = await parseJsonResponse<BulkResponse>(
      await postBulk({ order_ids: [ORDER_1] }),
    )
    expect(status).toBe(200)
    expect(body.data.results[0].error?.code).toBe('WEBSHOP_ORDER_RESIDUAL_TOO_LARGE')
    expect(mockCreateDraftEntry).not.toHaveBeenCalled()
  })

  it('aborts the whole sweep when the settings fetch fails (no silent 1686 fallback)', async () => {
    enqueue({ data: [makeOrderRow()] })
    enqueue({ data: null, error: { message: 'connection reset' } }) // settings fetch fails
    const { status } = await parseJsonResponse(await postBulk({ order_ids: [ORDER_1] }))
    expect(status).toBe(500)
    expect(mockCreateDraftEntry).not.toHaveBeenCalled()
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
