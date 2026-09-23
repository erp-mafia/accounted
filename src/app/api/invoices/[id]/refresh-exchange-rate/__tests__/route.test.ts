import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createMockRequest, parseJsonResponse, createMockRouteParams, makeInvoice } from '@/tests/helpers'

/**
 * Minimal recording Supabase mock: the queue behaviour of
 * createQueuedMockSupabase plus captured table/op/payload/filters, so the
 * "only the SEK columns are rewritten" contract can actually be asserted.
 */
interface QueryResult {
  data: unknown
  error: unknown
}
interface RecordedQuery {
  table: string
  op: 'select' | 'update' | 'insert' | 'upsert' | 'delete'
  payload?: unknown
  filters: Record<string, unknown>
}

function createRecordingSupabase() {
  const queue: QueryResult[] = []
  const recorded: RecordedQuery[] = []

  const enqueue = (r: { data?: unknown; error?: unknown }) =>
    queue.push({ data: r.data ?? null, error: r.error ?? null })
  const reset = () => {
    queue.length = 0
    recorded.length = 0
  }

  const from = (table: string) => {
    const result = queue.shift() ?? { data: null, error: null }
    const rec: RecordedQuery = { table, op: 'select', filters: {} }
    recorded.push(rec)

    const api: unknown = new Proxy(
      {},
      {
        get(_target, prop) {
          if (prop === 'then') {
            return (onFulfilled: (v: QueryResult) => void) => onFulfilled(result)
          }
          return (...args: unknown[]) => {
            if (prop === 'update' || prop === 'insert' || prop === 'upsert') {
              rec.op = prop
              rec.payload = args[0]
            } else if (prop === 'delete') {
              rec.op = 'delete'
            } else if (prop === 'eq' || prop === 'is') {
              rec.filters[String(args[0])] = args[1]
            }
            return api
          }
        },
      },
    )
    return api
  }

  const supabase = {
    from: vi.fn(from),
    rpc: vi.fn(),
    auth: { getUser: vi.fn() },
  }

  return { supabase, enqueue, reset, recorded }
}

const { supabase: mockSupabase, enqueue, reset, recorded } = createRecordingSupabase()

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve(mockSupabase),
}))

vi.mock('@/lib/company/context', () => ({
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: vi.fn().mockResolvedValue({ ok: true }),
}))

const mockFetchExchangeRate = vi.fn()
vi.mock('@/lib/currency/riksbanken', () => ({
  fetchExchangeRate: (...args: unknown[]) => mockFetchExchangeRate(...args),
}))

const mockResolvePeriodStatus = vi.fn()
vi.mock('@/lib/core/bookkeeping/period-service', () => ({
  resolvePeriodStatusForDate: (...args: unknown[]) => mockResolvePeriodStatus(...args),
}))

import { POST } from '../route'

const INVOICE_ID = '11111111-2222-4333-8444-555555555555'

const sentEurInvoice = makeInvoice({
  id: INVOICE_ID,
  status: 'sent',
  invoice_number: 'F-2026001',
  currency: 'EUR',
  invoice_date: '2026-06-15',
  delivery_date: null,
  subtotal: 1000,
  vat_amount: 0,
  total: 1000,
  subtotal_sek: null,
  vat_amount_sek: null,
  total_sek: null,
  exchange_rate: null,
  exchange_rate_date: null,
  journal_entry_id: null,
})

function post(id = INVOICE_ID) {
  const request = createMockRequest(`/api/invoices/${id}/refresh-exchange-rate`, { method: 'POST' })
  return POST(request, createMockRouteParams({ id }))
}

describe('POST /api/invoices/[id]/refresh-exchange-rate', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: { id: 'user-1' } } })
    mockResolvePeriodStatus.mockResolvedValue({ period_id: 'fp-1', status: 'open', lock_date: null })
    mockFetchExchangeRate.mockResolvedValue({ currency: 'EUR', rate: 11.5, date: '2026-06-15' })
  })

  it('returns 401 when not authenticated', async () => {
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: null } })

    const { status, body } = await parseJsonResponse(await post())

    expect(status).toBe(401)
    expect(body).toEqual({ error: 'Unauthorized' })
  })

  it('returns 400 when the invoice id is not a uuid', async () => {
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(
      await post('not-a-uuid'),
    )

    expect(status).toBe(400)
    expect(body.error.code).toBe('VALIDATION_ERROR')
    // Rejected before any DB work, including the sandbox lookup.
    expect(mockSupabase.from).not.toHaveBeenCalled()
  })

  it('returns 404 when the invoice does not exist for the company', async () => {
    enqueue({ data: { is_sandbox: false } })
    enqueue({ data: null, error: { message: 'Not found' } })

    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(await post())

    expect(status).toBe(404)
    expect(body.error.code).toBe('INVOICE_NOT_FOUND')
  })

  it('fills in the taxable-event rate on an unbooked SENT invoice without touching its currency amounts', async () => {
    enqueue({ data: { is_sandbox: false } })
    enqueue({ data: sentEurInvoice })
    enqueue({ data: [] }) // journal_entries: nothing references the invoice
    enqueue({
      data: [{ ...sentEurInvoice, exchange_rate: 11.5, exchange_rate_date: '2026-06-15', total_sek: 11500 }],
    })

    const { status, body } = await parseJsonResponse<{ data: { exchange_rate: number } }>(await post())

    expect(status).toBe(200)
    expect(body.data.exchange_rate).toBe(11.5)

    // The rate is fetched for the invoice date (the taxable event here, since
    // delivery_date is null) and WITH the supabase client, so the shared
    // exchange_rates cache backs both the read-through and the 429 fallback.
    expect(mockFetchExchangeRate).toHaveBeenCalledTimes(1)
    const [currency, date, client] = mockFetchExchangeRate.mock.calls[0]
    expect(currency).toBe('EUR')
    expect((date as Date).toISOString().slice(0, 10)).toBe('2026-06-15')
    expect(client).toBe(mockSupabase)

    const update = recorded.find((q) => q.op === 'update')
    expect(update?.table).toBe('invoices')
    expect(update?.payload).toEqual({
      exchange_rate: 11.5,
      exchange_rate_date: '2026-06-15',
      subtotal_sek: 11500,
      vat_amount_sek: 0,
      total_sek: 11500,
      updated_at: expect.any(String),
    })
    // The debt stays denominated in the invoice currency.
    const payloadKeys = Object.keys(update?.payload as Record<string, unknown>)
    expect(payloadKeys).not.toContain('subtotal')
    expect(payloadKeys).not.toContain('vat_amount')
    expect(payloadKeys).not.toContain('total')
    expect(payloadKeys).not.toContain('remaining_amount')
    expect(payloadKeys).not.toContain('currency')
    // TOCTOU guard: the write loses to a concurrent send/book.
    expect(update?.filters).toMatchObject({ journal_entry_id: null, company_id: 'company-1' })
  })

  it('uses delivery_date as the rate date when it differs from the invoice date', async () => {
    enqueue({ data: { is_sandbox: false } })
    enqueue({ data: { ...sentEurInvoice, delivery_date: '2026-05-20' } })
    enqueue({ data: [] })
    enqueue({ data: [sentEurInvoice] })

    await post()

    const [, date] = mockFetchExchangeRate.mock.calls[0]
    expect((date as Date).toISOString().slice(0, 10)).toBe('2026-05-20')
  })

  it('refuses a booked invoice and points at the rättelse tracks', async () => {
    enqueue({ data: { is_sandbox: false } })
    enqueue({ data: { ...sentEurInvoice, journal_entry_id: 'je-1' } })

    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(await post())

    expect(status).toBe(409)
    expect(body.error.code).toBe('INVOICE_FX_REFRESH_BOOKED')
    // Nothing was fetched or written: the SEK amounts are in a verifikat.
    expect(mockFetchExchangeRate).not.toHaveBeenCalled()
    expect(recorded.some((q) => q.op === 'update')).toBe(false)
  })

  it('refuses when a verifikat references the invoice even though journal_entry_id is null (legacy rows)', async () => {
    enqueue({ data: { is_sandbox: false } })
    enqueue({ data: sentEurInvoice })
    enqueue({ data: [{ id: 'je-9', voucher_series: 'A', voucher_number: 17 }] })

    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(await post())

    expect(status).toBe(409)
    expect(body.error.code).toBe('INVOICE_FX_REFRESH_BOOKED')
    expect(recorded.some((q) => q.op === 'update')).toBe(false)
  })

  it('refuses when the fiscal period covering the invoice date is locked', async () => {
    mockResolvePeriodStatus.mockResolvedValue({
      period_id: 'fp-1',
      status: 'locked',
      lock_date: '2026-06-30',
    })
    enqueue({ data: { is_sandbox: false } })
    enqueue({ data: sentEurInvoice })
    enqueue({ data: [] })

    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(await post())

    expect(status).toBe(409)
    expect(body.error.code).toBe('INVOICE_FX_REFRESH_PERIOD_LOCKED')
    expect(mockResolvePeriodStatus).toHaveBeenCalledWith(mockSupabase, 'company-1', '2026-06-15')
    expect(mockFetchExchangeRate).not.toHaveBeenCalled()
    expect(recorded.some((q) => q.op === 'update')).toBe(false)
  })

  it('refuses fail-closed when the period lock state could not be read', async () => {
    mockResolvePeriodStatus.mockResolvedValue({
      period_id: null,
      status: 'locked',
      lock_date: null,
      lookup_failed: true,
    })
    enqueue({ data: { is_sandbox: false } })
    enqueue({ data: sentEurInvoice })
    enqueue({ data: [] })

    const { status, body } = await parseJsonResponse<{
      error: { code: string; details: { lookup_failed: boolean } }
    }>(await post())

    expect(status).toBe(409)
    expect(body.error.code).toBe('INVOICE_FX_REFRESH_PERIOD_LOCKED')
    expect(body.error.details.lookup_failed).toBe(true)
  })

  it('returns 502 and writes nothing when Riksbanken and the cache both fail', async () => {
    mockFetchExchangeRate.mockResolvedValue(null)
    enqueue({ data: { is_sandbox: false } })
    enqueue({ data: sentEurInvoice })
    enqueue({ data: [] })

    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(await post())

    expect(status).toBe(502)
    expect(body.error.code).toBe('INVOICE_FX_REFRESH_RATE_UNAVAILABLE')
    // Never an invented rate: the invoice is left untouched and retryable.
    expect(recorded.some((q) => q.op === 'update')).toBe(false)
  })

  it('is a no-op for a SEK invoice', async () => {
    enqueue({ data: { is_sandbox: false } })
    enqueue({ data: makeInvoice({ id: INVOICE_ID, status: 'sent', currency: 'SEK' }) })

    const { status } = await parseJsonResponse(await post())

    expect(status).toBe(200)
    expect(mockFetchExchangeRate).not.toHaveBeenCalled()
    expect(recorded.some((q) => q.op === 'update')).toBe(false)
  })

  it('writes nothing when the stored rate is already the taxable-event rate', async () => {
    enqueue({ data: { is_sandbox: false } })
    enqueue({
      data: { ...sentEurInvoice, exchange_rate: 11.5, exchange_rate_date: '2026-06-15' },
    })
    enqueue({ data: [] })

    const { status } = await parseJsonResponse(await post())

    expect(status).toBe(200)
    expect(recorded.some((q) => q.op === 'update')).toBe(false)
  })

  it('reports the concurrent-booking race instead of silently succeeding', async () => {
    enqueue({ data: { is_sandbox: false } })
    enqueue({ data: sentEurInvoice })
    enqueue({ data: [] })
    enqueue({ data: [] }) // update matched 0 rows: journal_entry_id was set meanwhile

    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(await post())

    expect(status).toBe(409)
    expect(body.error.code).toBe('INVOICE_FX_REFRESH_BOOKED')
  })

  it('reverts the update with the prior values when a verifikat appears between the guard and the write', async () => {
    // TOCTOU: a booking flow that read the invoice at the OLD rate commits
    // its journal entry AFTER the source_id guard but BEFORE journal_entry_id
    // is stamped on the invoice. The route must detect the entry on the
    // post-update recheck, put the previous rate/SEK values back via a CAS on
    // what it just wrote, and answer with the booked conflict.
    const previouslyRated = {
      ...sentEurInvoice,
      exchange_rate: 11.2,
      exchange_rate_date: '2026-06-10',
      subtotal_sek: 11200,
      vat_amount_sek: 0,
      total_sek: 11200,
    }
    enqueue({ data: { is_sandbox: false } })
    enqueue({ data: previouslyRated })
    enqueue({ data: [] }) // pre-write guard: no entry references the invoice yet
    enqueue({ data: [{ ...previouslyRated, exchange_rate: 11.5 }] }) // guarded update succeeds
    enqueue({ data: [{ id: 'je-race' }] }) // post-update recheck: an entry appeared
    enqueue({ data: [] }) // revert update

    const { status, body } = await parseJsonResponse<{
      error: { code: string; details: { journal_entry_id: string; reason: string } }
    }>(await post())

    expect(status).toBe(409)
    expect(body.error.code).toBe('INVOICE_FX_REFRESH_BOOKED')
    expect(body.error.details.journal_entry_id).toBe('je-race')
    expect(body.error.details.reason).toBe('booked_concurrently_reverted')

    const updates = recorded.filter((q) => q.op === 'update')
    expect(updates).toHaveLength(2)
    // The revert restores exactly the values read before the update.
    expect(updates[1].table).toBe('invoices')
    expect(updates[1].payload).toEqual({
      exchange_rate: 11.2,
      exchange_rate_date: '2026-06-10',
      subtotal_sek: 11200,
      vat_amount_sek: 0,
      total_sek: 11200,
      updated_at: expect.any(String),
    })
    // CAS: the revert only touches the row if it still holds the values this
    // request wrote, so a later legitimate write is never clobbered.
    expect(updates[1].filters).toMatchObject({
      id: INVOICE_ID,
      company_id: 'company-1',
      exchange_rate: 11.5,
      exchange_rate_date: '2026-06-15',
    })
  })

  it('does not revert when the post-update recheck finds no verifikat', async () => {
    enqueue({ data: { is_sandbox: false } })
    enqueue({ data: sentEurInvoice })
    enqueue({ data: [] }) // pre-write guard
    enqueue({ data: [{ ...sentEurInvoice, exchange_rate: 11.5 }] }) // update
    enqueue({ data: [] }) // recheck: still unbooked

    const { status } = await parseJsonResponse(await post())

    expect(status).toBe(200)
    expect(recorded.filter((q) => q.op === 'update')).toHaveLength(1)
  })

  it('is blocked in the sandbox', async () => {
    enqueue({ data: { is_sandbox: true } })

    const { status, body } = await parseJsonResponse<{ sandbox_blocked: boolean }>(await post())

    expect(status).toBe(403)
    expect(body.sandbox_blocked).toBe(true)
    expect(mockFetchExchangeRate).not.toHaveBeenCalled()
  })
})
