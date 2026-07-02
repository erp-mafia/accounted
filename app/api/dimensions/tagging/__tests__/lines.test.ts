/**
 * Tests for GET /api/dimensions/tagging/lines (bulk retro-tagging browser).
 *
 * Covers: 401, query validation (400), the happy path (flattened DTO,
 * date-sorted, total_capped false), the hard-cap contract (limit+1 fetch →
 * total_capped true), and the DB error path.
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

interface FlatLine {
  id: string
  account_number: string
  debit_amount: number
  credit_amount: number
  dimensions: Record<string, string>
  journal_entry_id: string
  entry_date: string
  voucher_number: number | null
  voucher_series: string | null
  description: string
  reversed_by_id: string | null
  reverses_id: string | null
  fiscal_period_id: string
}

type LinesBody = { data: { lines: FlatLine[]; total_capped: boolean } }

/** Raw row as the Supabase select returns it (nested journal_entries). */
function makeRawLine(overrides: Record<string, unknown> = {}) {
  return {
    id: 'line-1',
    account_number: '4010',
    debit_amount: 100,
    credit_amount: 0,
    dimensions: { '1': 'KS01' },
    journal_entry_id: 'entry-1',
    journal_entries: {
      entry_date: '2026-03-10',
      voucher_number: 42,
      voucher_series: 'A',
      description: 'Inköp material',
      reversed_by_id: null,
      reverses_id: null,
      fiscal_period_id: 'period-1',
    },
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

  it('returns flattened lines sorted by entry date, total_capped false', async () => {
    enqueue({
      data: [
        makeRawLine({
          id: 'line-2',
          journal_entries: {
            entry_date: '2026-04-01',
            voucher_number: 50,
            voucher_series: 'A',
            description: 'Senare verifikat',
            reversed_by_id: 'entry-9',
            reverses_id: null,
            fiscal_period_id: 'period-1',
          },
        }),
        makeRawLine({ id: 'line-1', dimensions: {} }),
      ],
    })

    const response = await GET(request(), noParams)
    const { status, body } = await parseJsonResponse<LinesBody>(response)

    expect(status).toBe(200)
    expect(body.data.total_capped).toBe(false)
    expect(body.data.lines).toHaveLength(2)
    // Sorted by entry_date: line-1 (2026-03-10) before line-2 (2026-04-01).
    expect(body.data.lines[0]).toMatchObject({
      id: 'line-1',
      account_number: '4010',
      debit_amount: 100,
      credit_amount: 0,
      dimensions: {},
      journal_entry_id: 'entry-1',
      entry_date: '2026-03-10',
      voucher_number: 42,
      voucher_series: 'A',
      description: 'Inköp material',
      fiscal_period_id: 'period-1',
    })
    // Reversal linkage rides along for the storno-pair warning.
    expect(body.data.lines[1].reversed_by_id).toBe('entry-9')
  })

  it('normalizes a null dimensions map to {}', async () => {
    enqueue({ data: [makeRawLine({ dimensions: null })] })

    const response = await GET(request(), noParams)
    const { status, body } = await parseJsonResponse<LinesBody>(response)

    expect(status).toBe(200)
    expect(body.data.lines[0].dimensions).toEqual({})
  })

  it('caps the result at limit and reports total_capped', async () => {
    // limit=2 → route fetches 3; a third row means "there is more".
    enqueue({
      data: [
        makeRawLine({ id: 'line-1' }),
        makeRawLine({ id: 'line-2' }),
        makeRawLine({ id: 'line-3' }),
      ],
    })

    const response = await GET(request({ limit: '2' }), noParams)
    const { status, body } = await parseJsonResponse<LinesBody>(response)

    expect(status).toBe(200)
    expect(body.data.lines).toHaveLength(2)
    expect(body.data.total_capped).toBe(true)
  })

  it('returns an empty list when nothing matches', async () => {
    enqueue({ data: [] })

    const response = await GET(request({ only_untagged: '1' }), noParams)
    const { status, body } = await parseJsonResponse<LinesBody>(response)

    expect(status).toBe(200)
    expect(body.data.lines).toEqual([])
    expect(body.data.total_capped).toBe(false)
  })

  it('returns 500 when the query fails', async () => {
    enqueue({ error: { message: 'relation missing' } })

    const response = await GET(request(), noParams)

    expect(response.status).toBe(500)
  })
})
