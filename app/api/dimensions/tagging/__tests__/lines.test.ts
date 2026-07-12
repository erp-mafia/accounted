/**
 * Tests for GET /api/dimensions/tagging/lines (bulk retro-tagging browser,
 * voucher-level rework).
 *
 * Covers: 401, query validation (400), the voucher-grouped happy path (two
 * queries: qualifying entries → complete line sets), the hard-cap contract
 * (limit+1 entries → total_capped true, second query only for the page), the
 * empty result short-circuit (no line query), and the DB error paths.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import { createQueuedMockSupabase, createMockRequest, parseJsonResponse } from '@/tests/helpers'

const { supabase, enqueue, reset } = createQueuedMockSupabase()

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))

vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: vi.fn().mockResolvedValue({ ok: true }),
}))

vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))

import { GET } from '../lines/route'

const noParams = { params: Promise.resolve({}) }
const request = (searchParams?: Record<string, string>) =>
  createMockRequest('/api/dimensions/tagging/lines', { searchParams })

interface VoucherLine {
  id: string
  account_number: string
  debit_amount: number
  credit_amount: number
  dimensions: Record<string, string>
}

interface Voucher {
  journal_entry_id: string
  entry_date: string
  voucher_number: number | null
  voucher_series: string | null
  description: string
  annulled: boolean
  reversed_by_id: string | null
  reverses_id: string | null
  fiscal_period_id: string
  lines: VoucherLine[]
}

type VouchersBody = { data: { vouchers: Voucher[]; total_capped: boolean } }

/** Raw entry row as the Supabase step-1 select returns it. */
function makeRawEntry(overrides: Record<string, unknown> = {}) {
  return {
    id: 'entry-1',
    entry_date: '2026-03-10',
    voucher_number: 42,
    voucher_series: 'A',
    description: 'Inköp material',
    reversed_by_id: null,
    reverses_id: null,
    fiscal_period_id: 'period-1',
    journal_entry_lines: [{ id: 'line-1' }],
    ...overrides,
  }
}

/** Raw line row as the Supabase step-2 select returns it. */
function makeRawLine(overrides: Record<string, unknown> = {}) {
  return {
    id: 'line-1',
    account_number: '4010',
    debit_amount: 100,
    credit_amount: 0,
    dimensions: { '1': 'KS01' },
    journal_entry_id: 'entry-1',
    sort_order: 0,
    ...overrides,
  }
}

describe('GET /api/dimensions/tagging/lines', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase })
  })

  it('returns 401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })

    const response = await GET(request(), noParams)

    expect(response.status).toBe(401)
  })

  it('returns 400 for an out-of-range limit', async () => {
    const response = await GET(request({ limit: '9999' }), noParams)

    expect(response.status).toBe(400)
  })

  it('returns 400 for a malformed account filter', async () => {
    const response = await GET(request({ account_from: '30' }), noParams)

    expect(response.status).toBe(400)
  })

  it('returns 400 for a malformed date filter', async () => {
    const response = await GET(request({ date_from: '2026-13-45' }), noParams)

    expect(response.status).toBe(400)
  })

  it('groups complete line sets under their vouchers', async () => {
    // Step 1: qualifying entries (annulled linkage rides along for the pair
    // guard in the opt-in view).
    enqueue({
      data: [
        makeRawEntry(),
        makeRawEntry({
          id: 'entry-2',
          entry_date: '2026-04-01',
          voucher_number: 50,
          description: 'Senare verifikat',
          reversed_by_id: 'entry-9',
        }),
      ],
    })
    // Step 2: the COMPLETE line sets; entry-1 has a line the account filter
    // would not have matched; it must still be present (whole-verifikat
    // contract, null dimensions normalized to {}).
    enqueue({
      data: [
        makeRawLine(),
        makeRawLine({ id: 'line-2', account_number: '1930', debit_amount: 0, credit_amount: 100, dimensions: null, sort_order: 1 }),
        makeRawLine({ id: 'line-3', journal_entry_id: 'entry-2', dimensions: {} }),
      ],
    })

    const response = await GET(request(), noParams)
    const { status, body } = await parseJsonResponse<VouchersBody>(response)

    expect(status).toBe(200)
    expect(body.data.total_capped).toBe(false)
    expect(body.data.vouchers).toHaveLength(2)

    const [first, second] = body.data.vouchers
    expect(first).toMatchObject({
      journal_entry_id: 'entry-1',
      entry_date: '2026-03-10',
      voucher_number: 42,
      voucher_series: 'A',
      description: 'Inköp material',
      annulled: false,
    })
    expect(first.lines).toHaveLength(2)
    expect(first.lines[0]).toMatchObject({ id: 'line-1', dimensions: { '1': 'KS01' } })
    expect(first.lines[1]).toMatchObject({ id: 'line-2', account_number: '1930', dimensions: {} })

    expect(second.annulled).toBe(true)
    expect(second.reversed_by_id).toBe('entry-9')
    expect(second.lines.map((l) => l.id)).toEqual(['line-3'])
  })

  it('caps the result at limit vouchers and reports total_capped', async () => {
    // limit=2 → route fetches 3 entries; a third means "there is more".
    enqueue({
      data: [
        makeRawEntry({ id: 'entry-1' }),
        makeRawEntry({ id: 'entry-2' }),
        makeRawEntry({ id: 'entry-3' }),
      ],
    })
    enqueue({
      data: [
        makeRawLine({ id: 'line-1', journal_entry_id: 'entry-1' }),
        makeRawLine({ id: 'line-2', journal_entry_id: 'entry-2' }),
      ],
    })

    const response = await GET(request({ limit: '2' }), noParams)
    const { status, body } = await parseJsonResponse<VouchersBody>(response)

    expect(status).toBe(200)
    expect(body.data.vouchers).toHaveLength(2)
    expect(body.data.vouchers.map((v) => v.journal_entry_id)).toEqual(['entry-1', 'entry-2'])
    expect(body.data.total_capped).toBe(true)
  })

  it('short-circuits an empty entry page without a line query', async () => {
    enqueue({ data: [] })

    const response = await GET(request({ only_untagged: '1' }), noParams)
    const { status, body } = await parseJsonResponse<VouchersBody>(response)

    expect(status).toBe(200)
    expect(body.data.vouchers).toEqual([])
    expect(body.data.total_capped).toBe(false)
  })

  it('include_annulled=1 pulls in a counter-voucher that fell outside the filters', async () => {
    // Step 1 returns only the storno leg (its original, entry-0, is outside
    // the date range). The route must fetch entry-0 anyway: otherwise the
    // workbench's motverifikat guard cannot see the missing leg and one-sided
    // tagging slips through silently.
    enqueue({ data: [makeRawEntry({ reverses_id: 'entry-0', entry_date: '2026-05-01' })] })
    // Counter-voucher fetch by id.
    enqueue({
      data: [
        makeRawEntry({
          id: 'entry-0',
          entry_date: '2026-02-01',
          voucher_number: 40,
          description: 'Original',
          reversed_by_id: 'entry-1',
        }),
      ],
    })
    // Complete line sets for BOTH vouchers.
    enqueue({
      data: [
        makeRawLine({ id: 'line-0', journal_entry_id: 'entry-0' }),
        makeRawLine(),
      ],
    })

    const response = await GET(request({ include_annulled: '1' }), noParams)
    const { status, body } = await parseJsonResponse<VouchersBody>(response)

    expect(status).toBe(200)
    expect(body.data.vouchers).toHaveLength(2)
    // Sorted by entry_date: the pulled-in original first.
    expect(body.data.vouchers[0]).toMatchObject({
      journal_entry_id: 'entry-0',
      annulled: true,
      lines: [{ id: 'line-0' }],
    })
    expect(body.data.vouchers[1].annulled).toBe(true)
  })

  it('include_annulled=1 skips the counter fetch when both legs already qualified', async () => {
    enqueue({
      data: [
        makeRawEntry({ reversed_by_id: 'entry-2' }),
        makeRawEntry({ id: 'entry-2', reverses_id: 'entry-1', voucher_number: 43 }),
      ],
    })
    // No counter query: next enqueued result is the line fetch.
    enqueue({
      data: [
        makeRawLine(),
        makeRawLine({ id: 'line-2', journal_entry_id: 'entry-2' }),
      ],
    })

    const response = await GET(request({ include_annulled: '1' }), noParams)
    const { status, body } = await parseJsonResponse<VouchersBody>(response)

    expect(status).toBe(200)
    expect(body.data.vouchers).toHaveLength(2)
    expect(body.data.vouchers.every((v) => v.annulled)).toBe(true)
  })

  it('returns 500 when the entry query fails', async () => {
    enqueue({ error: { message: 'relation missing' } })

    const response = await GET(request(), noParams)

    expect(response.status).toBe(500)
  })

  it('returns 500 when the line query fails', async () => {
    enqueue({ data: [makeRawEntry()] })
    enqueue({ error: { message: 'relation missing' } })

    const response = await GET(request(), noParams)

    expect(response.status).toBe(500)
  })
})
