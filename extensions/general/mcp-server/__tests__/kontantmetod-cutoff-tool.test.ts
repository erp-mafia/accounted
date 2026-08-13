import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/core/bookkeeping/period-service', async () => {
  const actual = await vi.importActual<typeof import('@/lib/core/bookkeeping/period-service')>(
    '@/lib/core/bookkeeping/period-service',
  )
  return { ...actual, findNextPeriod: vi.fn() }
})

vi.mock('@/lib/core/bookkeeping/kontantmetod-cutoff', async () => {
  const actual = await vi.importActual<
    typeof import('@/lib/core/bookkeeping/kontantmetod-cutoff')
  >('@/lib/core/bookkeeping/kontantmetod-cutoff')
  return { ...actual, assessKontantmetodCutoff: vi.fn() }
})

import { tools, deriveToolMeta } from '../server'
import { TOOL_SCOPE_MAP } from '@/lib/auth/api-keys'
import { findNextPeriod } from '@/lib/core/bookkeeping/period-service'
import {
  assessKontantmetodCutoff,
  buildCutoffLines,
} from '@/lib/core/bookkeeping/kontantmetod-cutoff'

const tool = tools.find((candidate) => candidate.name === 'gnubok_post_kontantmetod_cutoff')!
const searchTool = tools.find((candidate) => candidate.name === 'gnubok_search_tools')!

function makeSupabase(settings: Record<string, unknown> = {
  accounting_method: 'cash', entity_type: 'aktiebolag',
}) {
  const inserts: unknown[] = []
  const rows: Record<string, unknown> = {
    fiscal_periods: {
      id: 'fp-1', name: '2026', period_start: '2026-01-01', period_end: '2026-12-31',
      is_closed: false, locked_at: null,
    },
    company_settings: settings,
    pending_operations: { id: 'op-1' },
  }
  const from = vi.fn((table: string) => {
    const chain: Record<string, unknown> = {}
    for (const name of ['select', 'eq', 'in', 'gte', 'lte', 'order', 'limit']) {
      chain[name] = () => chain
    }
    chain.insert = (value: unknown) => {
      inserts.push(value)
      return chain
    }
    chain.maybeSingle = async () => ({ data: rows[table] ?? null, error: null })
    chain.single = async () => ({ data: rows[table] ?? null, error: null })
    chain.then = (resolve: (value: unknown) => unknown) =>
      resolve({ data: rows[table] ?? null, error: null })
    return chain
  })
  return { auth: {}, from, inserts }
}

const collection = {
  receivables: [{
    id: 'inv-1', reference: 'F-1', vatTreatment: 'standard_25' as const,
    outstanding: 1250, vat: 250,
  }],
  payables: [{
    id: 'si-1', reference: 'L-1', outstanding: 625, vat: 125,
    netByAccount: [{ account: '5410', amount: 500 }],
  }],
  unknownVatTreatment: [],
  strayVatOnZeroRate: [],
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2027-02-01T12:00:00Z'))
  vi.mocked(findNextPeriod).mockResolvedValue({
    id: 'fp-2', period_start: '2027-01-01', period_end: '2027-12-31',
    is_closed: false, locked_at: null,
  } as never)
  vi.mocked(assessKontantmetodCutoff).mockResolvedValue({
    collection,
    lines: buildCutoffLines(collection.receivables, collection.payables),
    postings: {
      complete: false, hasAny: false, receivableEntryId: null,
      receivableReversalId: null, payableEntryId: null, payableReversalId: null,
      missing: ['receivable', 'receivable_reversal', 'payable', 'payable_reversal'],
      duplicates: [],
    },
  })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('gnubok_post_kontantmetod_cutoff', () => {
  it('is a discoverable high-risk staged bookkeeping write with readiness preflight', () => {
    expect(tool).toBeDefined()
    expect(tool.catalogVisibility).toBe('search')
    expect(tool.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true })
    expect(TOOL_SCOPE_MAP.gnubok_post_kontantmetod_cutoff).toBe('bookkeeping:write')
    expect(deriveToolMeta(tool)).toMatchObject({
      requires_approval: true,
      approve_tool: 'gnubok_approve_pending_operation',
      preflight: 'gnubok_year_end_readiness',
    })
  })

  it('is returned by full catalog search with its approval metadata', async () => {
    const result = await searchTool.execute(
      {
        query: 'kontantmetod cutoff',
        detail: 'full',
        __keyScopes: ['bookkeeping:write'],
      },
      'company-1',
      'user-1',
      makeSupabase() as never,
    ) as { tools: Array<Record<string, unknown>> }
    expect(result.tools).toContainEqual(expect.objectContaining({
      name: 'gnubok_post_kontantmetod_cutoff',
      scope: 'bookkeeping:write',
      _meta: expect.objectContaining({
        requires_approval: true,
        approve_tool: 'gnubok_approve_pending_operation',
        preflight: 'gnubok_year_end_readiness',
      }),
    }))
  })

  it('stages the exact two cut-offs and two day-one reversals without posting', async () => {
    const supabase = makeSupabase()
    const result = (await tool.execute(
      { fiscal_period_id: 'fp-1' },
      'company-1', 'user-1', supabase as never, { type: 'api_key' },
    )) as { staged: boolean; risk_level: string; preview: { entries: Array<Record<string, unknown>> } }

    expect(result.staged).toBe(true)
    expect(result.risk_level).toBe('high')
    expect(result.preview.entries).toHaveLength(4)
    expect(result.preview.entries.map((entry) => entry.entry_date)).toEqual([
      '2026-12-31', '2027-01-01', '2026-12-31', '2027-01-01',
    ])
    expect(result.preview.entries[0]?.lines).toEqual(buildCutoffLines(collection.receivables, []).receivableLines)
    expect(supabase.inserts).toHaveLength(1)
    expect(supabase.inserts[0]).toMatchObject({
      operation_type: 'post_kontantmetod_cutoff',
      risk_level: 'high',
      params: {
        fiscal_period_id: 'fp-1',
        next_fiscal_period_id: 'fp-2',
        period_end: '2026-12-31',
        entity_type: 'aktiebolag',
        preview_fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    })
  })

  it('refuses accrual companies, missing next periods, invalid VAT, duplicates, and empty previews', async () => {
    const accrual = makeSupabase({ accounting_method: 'accrual', entity_type: 'aktiebolag' })
    await expect(tool.execute(
      { fiscal_period_id: 'fp-1' }, 'company-1', 'user-1', accrual as never,
    )).rejects.toThrow(/inte kontantmetoden/i)

    vi.mocked(findNextPeriod).mockResolvedValueOnce(null)
    await expect(tool.execute(
      { fiscal_period_id: 'fp-1' }, 'company-1', 'user-1', makeSupabase() as never,
    )).rejects.toThrow(/nästa räkenskapsår/i)

    vi.mocked(assessKontantmetodCutoff).mockResolvedValueOnce({
      collection: { ...collection, unknownVatTreatment: ['F-9'] },
      lines: buildCutoffLines([], []),
      postings: { complete: false, hasAny: false, receivableEntryId: null, receivableReversalId: null, payableEntryId: null, payableReversalId: null, missing: [], duplicates: [] },
    })
    await expect(tool.execute(
      { fiscal_period_id: 'fp-1' }, 'company-1', 'user-1', makeSupabase() as never,
    )).rejects.toThrow(/saknar momsinställning/i)

    vi.mocked(assessKontantmetodCutoff).mockResolvedValueOnce({
      collection,
      lines: buildCutoffLines(collection.receivables, collection.payables),
      postings: { complete: true, hasAny: true, receivableEntryId: 'je-1', receivableReversalId: 'je-2', payableEntryId: 'je-3', payableReversalId: 'je-4', missing: [], duplicates: [] },
    })
    await expect(tool.execute(
      { fiscal_period_id: 'fp-1' }, 'company-1', 'user-1', makeSupabase() as never,
    )).rejects.toThrow(/redan bokförd/i)

    vi.mocked(assessKontantmetodCutoff).mockResolvedValueOnce({
      collection: { receivables: [], payables: [], unknownVatTreatment: [], strayVatOnZeroRate: [] },
      lines: buildCutoffLines([], []),
      postings: { complete: true, hasAny: false, receivableEntryId: null, receivableReversalId: null, payableEntryId: null, payableReversalId: null, missing: [], duplicates: [] },
    })
    await expect(tool.execute(
      { fiscal_period_id: 'fp-1' }, 'company-1', 'user-1', makeSupabase() as never,
    )).rejects.toThrow(/Inga obetalda/i)
  })

  it('refuses to stage before the fiscal period has ended', async () => {
    vi.setSystemTime(new Date('2026-12-01T12:00:00Z'))
    await expect(tool.execute(
      { fiscal_period_id: 'fp-1' }, 'company-1', 'user-1', makeSupabase() as never,
    )).rejects.toThrow(/först efter periodens slut/i)
  })
})
