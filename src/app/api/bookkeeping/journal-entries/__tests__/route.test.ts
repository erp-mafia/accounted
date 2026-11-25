import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  createMockRequest,
  parseJsonResponse,
  createQueuedMockSupabase,
  makeJournalEntry,
} from '@/tests/helpers'

// Mock dependencies
const { supabase: mockSupabase, enqueue, reset, findCalls } = createQueuedMockSupabase()
vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve(mockSupabase),
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

const { mockLogError, mockLogWarn, logChildContexts } = vi.hoisted(() => ({
  mockLogError: vi.fn(),
  mockLogWarn: vi.fn(),
  logChildContexts: [] as Record<string, unknown>[],
}))
vi.mock('@/lib/logger', () => {
  const logger = {
    info: vi.fn(),
    warn: mockLogWarn,
    error: mockLogError,
    child: (context: Record<string, unknown>): unknown => {
      logChildContexts.push(context)
      return logger
    },
  }
  return { createLogger: () => logger }
})

const { mockCountUnderlag } = vi.hoisted(() => ({ mockCountUnderlag: vi.fn() }))
vi.mock('@/lib/core/documents/underlag-counts', () => ({
  countUnderlagForJournalEntries: (...args: unknown[]) => mockCountUnderlag(...args),
}))

const mockCreateJournalEntry = vi.fn()
vi.mock('@/lib/bookkeeping/engine', () => ({
  createJournalEntry: (...args: unknown[]) => mockCreateJournalEntry(...args),
}))

import { GET, POST } from '../route'
import { BookkeepingDatabaseError } from '@/lib/bookkeeping/errors'

describe('GET /api/bookkeeping/journal-entries', () => {
  const mockUser = { id: 'user-1', email: 'test@test.se' }

  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    logChildContexts.length = 0
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: mockUser } })
  })

  it('returns 401 when not authenticated', async () => {
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: null } })

    const request = createMockRequest('/api/bookkeeping/journal-entries')
    const response = await GET(request)
    const { status, body } = await parseJsonResponse(response)

    expect(status).toBe(401)
    expect(body).toEqual({ error: 'Unauthorized' })
  })

  it('returns entries list', async () => {
    const entries = [makeJournalEntry(), makeJournalEntry()]
    enqueue({ data: entries, error: null, count: 2 })

    const request = createMockRequest('/api/bookkeeping/journal-entries')
    const response = await GET(request)
    const { status, body } = await parseJsonResponse<{ data: unknown[]; count: number }>(response)

    expect(status).toBe(200)
    expect(body.data).toEqual(entries)
    expect(body.count).toBe(2)
  })

  it('passes filters to query', async () => {
    enqueue({ data: [], error: null, count: 0 })

    const request = createMockRequest('/api/bookkeeping/journal-entries', {
      searchParams: {
        period_id: 'period-1',
        status: 'posted',
        date_from: '2024-01-01',
        date_to: '2024-12-31',
        limit: '10',
        offset: '5',
        // Strict period filtering: exercises the PostgREST path, not the RPC.
        include_related: 'false',
      },
    })
    const response = await GET(request)
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(200)
    expect(mockSupabase.from).toHaveBeenCalledWith('journal_entries')
  })

  it('uses RPC with include_related when period_id is set', async () => {
    const rpcRows = [
      {
        entry: { ...makeJournalEntry({ id: 'je-1' }), out_of_period: false },
        total_count: 2,
      },
      {
        entry: { ...makeJournalEntry({ id: 'je-2' }), out_of_period: true },
        total_count: 2,
      },
    ]
    enqueue({ data: rpcRows, error: null })

    const request = createMockRequest('/api/bookkeeping/journal-entries', {
      searchParams: { period_id: 'period-1' },
    })
    const response = await GET(request)
    const { status, body } = await parseJsonResponse<{
      data: Array<{ id: string; out_of_period?: boolean }>
      count: number
    }>(response)

    expect(status).toBe(200)
    expect(mockSupabase.rpc).toHaveBeenCalledWith(
      'list_fiscal_period_entries_with_related',
      expect.objectContaining({
        p_company_id: 'company-1',
        p_period_id: 'period-1',
        p_include_related: true,
      })
    )
    expect(body.data).toHaveLength(2)
    expect(body.data[1].out_of_period).toBe(true)
    expect(body.count).toBe(2)
  })

  it('forwards explicit ?status=cancelled to the RPC', async () => {
    enqueue({ data: [], error: null })

    const request = createMockRequest('/api/bookkeeping/journal-entries', {
      searchParams: { period_id: 'period-1', status: 'cancelled' },
    })
    await GET(request)

    // The RPC itself hides cancelled entries unless p_status='cancelled' is
    // passed explicitly (see migration 20260428153500). The behavior of the
    // hide-by-default logic lives in SQL and is covered by pg-real tests.
    expect(mockSupabase.rpc).toHaveBeenCalledWith(
      'list_fiscal_period_entries_with_related',
      expect.objectContaining({ p_status: 'cancelled' })
    )
  })

  it('uses the direct query path (not the RPC) when a search term is set', async () => {
    enqueue({ data: [], error: null, count: 0 })

    const request = createMockRequest('/api/bookkeeping/journal-entries', {
      searchParams: { period_id: 'period-1', search: 'luftfyllning' },
    })
    const response = await GET(request)
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(200)
    // Free-text search needs an ILIKE the include_related RPC can't express, so
    // the route must fall through to the direct PostgREST query.
    expect(mockSupabase.from).toHaveBeenCalledWith('journal_entries')
    expect(mockSupabase.rpc).not.toHaveBeenCalled()
  })

  it('keeps a pure storno visible under collapse_corrections and folds only corrected groups (#3149)', async () => {
    // The list builder is created before the corrections prefetch, and the
    // queued mock binds a result at from() time: list result first.
    enqueue({ data: [], error: null, count: 0 })
    enqueue({ data: [{ correction_of_id: 'orig-1' }], error: null })

    const request = createMockRequest('/api/bookkeeping/journal-entries', {
      searchParams: { period_id: 'period-1', include_related: 'false', collapse_corrections: 'true' },
    })
    const response = await GET(request, {} as never)
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(200)
    // No blanket storno filter: a storno that no correction replaced is the
    // only row carrying its voucher number and must stay in the series.
    expect(findCalls('journal_entries', 'neq').map((c) => c[0])).not.toContain('source_type')
    // The corrected original folds, and so does its storno: a storno drops
    // only when reverses_id points at a corrected original.
    expect(findCalls('journal_entries', 'not')).toContainEqual(['id', 'in', '(orig-1)'])
    expect(findCalls('journal_entries', 'or').map((c) => c[0])).toContain(
      'source_type.neq.storno,reverses_id.is.null,reverses_id.not.in.(orig-1)',
    )
  })

  it('applies no collapse filter when the company has no posted correction', async () => {
    enqueue({ data: [], error: null, count: 0 })
    enqueue({ data: [], error: null })

    const request = createMockRequest('/api/bookkeeping/journal-entries', {
      searchParams: { period_id: 'period-1', include_related: 'false', collapse_corrections: 'true' },
    })
    const response = await GET(request, {} as never)
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(200)
    expect(findCalls('journal_entries', 'neq').map((c) => c[0])).not.toContain('source_type')
    expect(findCalls('journal_entries', 'or')).toEqual([])
    expect(findCalls('journal_entries', 'not').filter((c) => c[0] === 'id')).toEqual([])
  })

  it('hides every storno and reversed original under hide_reversed, pure pairs included (PH 231)', async () => {
    enqueue({ data: [], error: null, count: 0 })

    const request = createMockRequest('/api/bookkeeping/journal-entries', {
      // The list's default shape (year selected, date sort) plus the option.
      searchParams: { period_id: 'period-1', sort_by: 'date_desc', exclude_draft: 'true', hide_reversed: 'true' },
    })
    const response = await GET(request, {} as never)
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(200)
    // The include_related RPC has no such filter: the direct query serves it.
    expect(mockSupabase.rpc).not.toHaveBeenCalled()
    const neq = findCalls('journal_entries', 'neq')
    expect(neq).toContainEqual(['status', 'reversed'])
    expect(neq).toContainEqual(['source_type', 'storno'])
    expect(neq).toContainEqual(['status', 'cancelled'])
    expect(neq).toContainEqual(['status', 'draft'])
    // Column filters only: no corrections prefetch, no collapse or-filter.
    expect(findCalls('journal_entries', 'select').map((c) => c[0])).not.toContain('correction_of_id')
    expect(findCalls('journal_entries', 'or')).toEqual([])
    expect(findCalls('journal_entries', 'eq')).toContainEqual(['fiscal_period_id', 'period-1'])
  })

  it('does not hide a pure storno pair without hide_reversed, so the default series stays gapless (#3149)', async () => {
    enqueue({ data: [], error: null, count: 0 })
    enqueue({ data: [], error: null })

    const request = createMockRequest('/api/bookkeeping/journal-entries', {
      searchParams: { period_id: 'period-1', include_related: 'false', collapse_corrections: 'true' },
    })
    const response = await GET(request, {} as never)
    await parseJsonResponse(response)

    const neq = findCalls('journal_entries', 'neq')
    expect(neq).not.toContainEqual(['status', 'reversed'])
    expect(neq).not.toContainEqual(['source_type', 'storno'])
  })

  it('matches a voucher label like "A209" on series+number as well as description', async () => {
    enqueue({ data: [], error: null, count: 0 })

    const request = createMockRequest('/api/bookkeeping/journal-entries', {
      searchParams: { period_id: 'period-1', search: 'A209' },
    })
    const response = await GET(request)
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(200)
    const orCalls = findCalls('journal_entries', 'or')
    expect(orCalls).toHaveLength(1)
    expect(orCalls[0][0]).toBe(
      'description.ilike."%A209%",and(voucher_series.eq.A,voucher_number.eq.209)',
    )
    // The plain ilike path must not ALSO run, or the OR would be ANDed away.
    expect(findCalls('journal_entries', 'ilike')).toHaveLength(0)
  })

  it('accepts "a 209" and "A-209" as voucher labels', async () => {
    for (const needle of ['a 209', 'A-209']) {
      reset()
      mockSupabase.auth.getUser.mockResolvedValue({ data: { user: mockUser } })
      enqueue({ data: [], error: null, count: 0 })
      const request = createMockRequest('/api/bookkeeping/journal-entries', {
        searchParams: { period_id: 'period-1', search: needle },
      })
      await GET(request)
      const orCalls = findCalls('journal_entries', 'or')
      expect(orCalls, needle).toHaveLength(1)
      expect(String(orCalls[0][0])).toContain('and(voucher_series.eq.A,voucher_number.eq.209)')
    }
  })

  it('keeps the plain description ilike for non-label needles', async () => {
    enqueue({ data: [], error: null, count: 0 })

    const request = createMockRequest('/api/bookkeeping/journal-entries', {
      searchParams: { period_id: 'period-1', search: 'hyra, kvartal 1 (50%)' },
    })
    await GET(request)

    expect(findCalls('journal_entries', 'or')).toHaveLength(0)
    const ilikeCalls = findCalls('journal_entries', 'ilike')
    expect(ilikeCalls).toHaveLength(1)
    expect(ilikeCalls[0][0]).toBe('description')
    expect(ilikeCalls[0][1]).toBe('%hyra, kvartal 1 (50\\%)%')
  })

  describe('account number search (crm#1847)', () => {
    const emptyParams = { params: Promise.resolve({}) }
    // Four digits are an account number and an amount: both joins, both arms.
    const ACCOUNT_SELECT =
      '*, lines:journal_entry_lines(*), account_match:journal_entry_lines(), amount_match:journal_entry_lines()'

    it('finds verifikat with a line on a four-digit account, next to the text match', async () => {
      enqueue({ data: [], error: null, count: 0 })

      const request = createMockRequest('/api/bookkeeping/journal-entries', {
        searchParams: { period_id: 'period-1', search: ' 1630 ' },
      })
      const response = await GET(request, emptyParams)
      const { status } = await parseJsonResponse(response)

      expect(status).toBe(200)
      expect(mockSupabase.rpc).not.toHaveBeenCalled()
      // The lines are joined again under their own aliases, with no
      // columns: `lines` still carries every line of each verifikat.
      const selectCalls = findCalls('journal_entries', 'select')
      expect(selectCalls).toHaveLength(1)
      expect(selectCalls[0]).toEqual([ACCOUNT_SELECT, { count: 'exact' }])
      // The alias is narrowed to the account (a string, never a number)...
      const eqCalls = findCalls('journal_entries', 'eq')
      expect(eqCalls).toContainEqual(['account_match.account_number', '1630'])
      // ...and a row matches on its text OR on having such a line (or, the
      // needle being 1 630 kr too, a line of that amount).
      const orCalls = findCalls('journal_entries', 'or').filter(([, options]) => !options)
      expect(orCalls).toHaveLength(1)
      expect(orCalls[0][0]).toBe('description.ilike."%1630%",account_match.not.is.null,amount_match.not.is.null')
      // The plain ilike must not also run, or it would AND the account arm away.
      expect(findCalls('journal_entries', 'ilike')).toHaveLength(0)
      // Still the caller's company and fiscal year only.
      expect(eqCalls).toContainEqual(['company_id', 'company-1'])
      expect(eqCalls).toContainEqual(['fiscal_period_id', 'period-1'])
    })

    it('counts and pages the widened set in the same statement', async () => {
      const entries = [makeJournalEntry(), makeJournalEntry()]
      enqueue({ data: entries, error: null, count: 137 })

      const request = createMockRequest('/api/bookkeeping/journal-entries', {
        searchParams: { period_id: 'period-1', search: '1630', limit: '2', offset: '4' },
      })
      const response = await GET(request, emptyParams)
      const { status, body } = await parseJsonResponse<{ data: unknown[]; count: number }>(response)

      expect(status).toBe(200)
      // One read: no id list is fetched first, so the exact count and the
      // page window both apply to text matches and account matches together.
      expect(mockSupabase.from).toHaveBeenCalledTimes(1)
      expect(findCalls('journal_entries', 'select')[0][1]).toEqual({ count: 'exact' })
      expect(findCalls('journal_entries', 'range')).toEqual([[4, 5]])
      expect(body.data).toEqual(entries)
      expect(body.count).toBe(137)
    })

    it('keeps the other list filters on an account search', async () => {
      enqueue({ data: [], error: null, count: 0 })

      const request = createMockRequest('/api/bookkeeping/journal-entries', {
        searchParams: {
          period_id: 'period-1',
          search: '1630',
          series: 'B',
          exclude_draft: 'true',
          hide_reversed: 'true',
          date_from: '2026-01-01',
        },
      })
      await GET(request, emptyParams)

      expect(findCalls('journal_entries', 'eq')).toContainEqual(['voucher_series', 'B'])
      expect(findCalls('journal_entries', 'gte')).toContainEqual(['entry_date', '2026-01-01'])
      const neqCalls = findCalls('journal_entries', 'neq')
      expect(neqCalls).toContainEqual(['status', 'draft'])
      expect(neqCalls).toContainEqual(['status', 'reversed'])
    })

    it('reads only exactly four digits as an account number', async () => {
      for (const needle of ['163', '16300', '16 30', '1630a', 'konto 1630']) {
        reset()
        mockSupabase.auth.getUser.mockResolvedValue({ data: { user: mockUser } })
        enqueue({ data: [], error: null, count: 0 })
        const request = createMockRequest('/api/bookkeeping/journal-entries', {
          searchParams: { period_id: 'period-1', search: needle },
        })
        await GET(request, emptyParams)

        expect(String(findCalls('journal_entries', 'select')[0][0]), needle).not.toContain('account_match')
        expect(
          findCalls('journal_entries', 'eq').some(([column]) => String(column).startsWith('account_match')),
          needle,
        ).toBe(false)
        expect(
          findCalls('journal_entries', 'or').some(([filters]) => String(filters).includes('account_match')),
          needle,
        ).toBe(false)
      }
    })

    it('leaves a search that is neither a label, an account, an amount nor a date as it was', async () => {
      for (const needle of ['1630a', 'konto 1630', 'hyra mars', '12 500 kronor', '2026-3-15']) {
        reset()
        mockSupabase.auth.getUser.mockResolvedValue({ data: { user: mockUser } })
        enqueue({ data: [], error: null, count: 0 })
        const request = createMockRequest('/api/bookkeeping/journal-entries', {
          searchParams: { period_id: 'period-1', search: needle },
        })
        await GET(request, emptyParams)

        expect(findCalls('journal_entries', 'select')[0][0], needle).toBe('*, lines:journal_entry_lines(*)')
        expect(findCalls('journal_entries', 'or'), needle).toHaveLength(0)
        expect(findCalls('journal_entries', 'ilike'), needle).toHaveLength(1)
      }
    })

    it('does not join the lines a second time when there is no search', async () => {
      enqueue({ data: [], error: null, count: 0 })

      const request = createMockRequest('/api/bookkeeping/journal-entries', {
        searchParams: { include_related: 'false' },
      })
      await GET(request, emptyParams)

      expect(findCalls('journal_entries', 'select')[0][0]).toBe('*, lines:journal_entry_lines(*)')
    })
  })

  describe('amount search', () => {
    const emptyParams = { params: Promise.resolve({}) }
    const AMOUNT_SELECT = '*, lines:journal_entry_lines(*), amount_match:journal_entry_lines()'

    it('finds verifikat with a line of that debit or credit amount, next to the text match', async () => {
      enqueue({ data: [], error: null, count: 0 })

      const request = createMockRequest('/api/bookkeeping/journal-entries', {
        searchParams: { period_id: 'period-1', search: '12 500' },
      })
      const response = await GET(request, emptyParams)
      const { status } = await parseJsonResponse(response)

      expect(status).toBe(200)
      expect(mockSupabase.rpc).not.toHaveBeenCalled()
      // One more join of the lines, under its own alias and with no columns.
      expect(findCalls('journal_entries', 'select')).toEqual([[AMOUNT_SELECT, { count: 'exact' }]])
      const orCalls = findCalls('journal_entries', 'or')
      // The alias keeps the lines whose debit or credit is the amount...
      expect(orCalls).toContainEqual([
        'debit_amount.eq.12500,credit_amount.eq.12500',
        { referencedTable: 'amount_match' },
      ])
      // ...and a row matches on its text (as typed) OR on having such a line.
      expect(orCalls).toContainEqual(['description.ilike."%12 500%",amount_match.not.is.null'])
      expect(orCalls).toHaveLength(2)
      // The plain ilike must not also run, or it would AND the amount arm away.
      expect(findCalls('journal_entries', 'ilike')).toHaveLength(0)
      // Still the caller's company and fiscal year only.
      const eqCalls = findCalls('journal_entries', 'eq')
      expect(eqCalls).toContainEqual(['company_id', 'company-1'])
      expect(eqCalls).toContainEqual(['fiscal_period_id', 'period-1'])
    })

    it('reads the amount in every form the box promises, to the öre', async () => {
      const forms: Array<[string, string]> = [
        ['12500', '12500'],
        ['12 500', '12500'],
        ['12 500,50', '12500.5'],
        ['12500.5', '12500.5'],
        ['12 500 kr', '12500'],
        ['-12500', '12500'],
      ]
      for (const [needle, amount] of forms) {
        reset()
        mockSupabase.auth.getUser.mockResolvedValue({ data: { user: mockUser } })
        enqueue({ data: [], error: null, count: 0 })
        const request = createMockRequest('/api/bookkeeping/journal-entries', {
          searchParams: { period_id: 'period-1', search: needle },
        })
        await GET(request, emptyParams)

        const orCalls = findCalls('journal_entries', 'or')
        expect(orCalls, needle).toContainEqual([
          `debit_amount.eq.${amount},credit_amount.eq.${amount}`,
          { referencedTable: 'amount_match' },
        ])
        // The text arm keeps the needle as typed, quoted: its decimal comma
        // must not read as the or() list's separator.
        expect(orCalls, needle).toContainEqual([`description.ilike."%${needle}%",amount_match.not.is.null`])
      }
    })

    it('does not search for zero: every line has one side at zero', async () => {
      enqueue({ data: [], error: null, count: 0 })

      const request = createMockRequest('/api/bookkeeping/journal-entries', {
        searchParams: { period_id: 'period-1', search: '0,00' },
      })
      await GET(request, emptyParams)

      expect(findCalls('journal_entries', 'select')[0][0]).toBe('*, lines:journal_entry_lines(*)')
      expect(findCalls('journal_entries', 'or')).toHaveLength(0)
      expect(findCalls('journal_entries', 'ilike')).toEqual([['description', '%0,00%']])
    })

    it('counts and pages the widened set in one statement, under the other list filters', async () => {
      const entries = [makeJournalEntry(), makeJournalEntry()]
      enqueue({ data: entries, error: null, count: 61 })

      const request = createMockRequest('/api/bookkeeping/journal-entries', {
        searchParams: {
          period_id: 'period-1',
          search: '12 500 kr',
          series: 'B',
          exclude_draft: 'true',
          date_from: '2026-01-01',
          limit: '2',
          offset: '4',
        },
      })
      const response = await GET(request, emptyParams)
      const { status, body } = await parseJsonResponse<{ data: unknown[]; count: number }>(response)

      expect(status).toBe(200)
      // One read: no id list is fetched first, so the exact count and the
      // page window both apply to text matches and amount matches together.
      expect(mockSupabase.from).toHaveBeenCalledTimes(1)
      expect(findCalls('journal_entries', 'range')).toEqual([[4, 5]])
      expect(findCalls('journal_entries', 'eq')).toContainEqual(['voucher_series', 'B'])
      expect(findCalls('journal_entries', 'gte')).toContainEqual(['entry_date', '2026-01-01'])
      expect(findCalls('journal_entries', 'neq')).toContainEqual(['status', 'draft'])
      expect(body.data).toEqual(entries)
      expect(body.count).toBe(61)
    })
  })

  describe('an amount is read only inside a fiscal period', () => {
    const emptyParams = { params: Promise.resolve({}) }
    const PLAIN_SELECT = '*, lines:journal_entry_lines(*)'
    const aliasFilters = () =>
      findCalls('journal_entries', 'eq').filter(([column]) => String(column).includes('_match'))

    it('sends the query main sends for a number typed with no period (an order number in the order dialog)', async () => {
      enqueue({ data: [], error: null, count: 0 })

      // What MarkOrderBookedDialog sends once a person types: no period, no dates.
      const request = createMockRequest('/api/bookkeeping/journal-entries', {
        searchParams: { status: 'posted', exclude_draft: 'true', limit: '50', sort_by: 'date_desc', search: '10432' },
      })
      const response = await GET(request, emptyParams)
      const { status } = await parseJsonResponse(response)

      expect(status).toBe(200)
      // No join on the lines, no filter on a join, no or(): the plain text
      // search it was before amounts were read, over every year.
      expect(findCalls('journal_entries', 'select')).toEqual([[PLAIN_SELECT, { count: 'exact' }]])
      expect(findCalls('journal_entries', 'or')).toHaveLength(0)
      expect(aliasFilters()).toHaveLength(0)
      expect(findCalls('journal_entries', 'ilike')).toEqual([['description', '%10432%']])
    })

    it('keeps the account arm for four digits typed with no period, and adds no amount to it', async () => {
      enqueue({ data: [], error: null, count: 0 })

      const request = createMockRequest('/api/bookkeeping/journal-entries', {
        searchParams: { status: 'posted', exclude_draft: 'true', sort_by: 'date_desc', search: '1930' },
      })
      await GET(request, emptyParams)

      // The account search as crm#1847 put it live, alias for alias.
      expect(findCalls('journal_entries', 'select')).toEqual([
        ['*, lines:journal_entry_lines(*), account_match:journal_entry_lines()', { count: 'exact' }],
      ])
      expect(aliasFilters()).toEqual([['account_match.account_number', '1930']])
      expect(findCalls('journal_entries', 'or')).toEqual([
        ['description.ilike."%1930%",account_match.not.is.null'],
      ])
    })

    it('reads the amount once a fiscal period bounds the same request', async () => {
      enqueue({ data: [], error: null, count: 0 })

      const request = createMockRequest('/api/bookkeeping/journal-entries', {
        searchParams: {
          period_id: 'period-1', status: 'posted', exclude_draft: 'true', limit: '50', sort_by: 'date_desc', search: '10432',
        },
      })
      await GET(request, emptyParams)

      expect(findCalls('journal_entries', 'select')).toEqual([
        ['*, lines:journal_entry_lines(*), amount_match:journal_entry_lines()', { count: 'exact' }],
      ])
      expect(findCalls('journal_entries', 'or')).toEqual([
        ['debit_amount.eq.10432,credit_amount.eq.10432', { referencedTable: 'amount_match' }],
        ['description.ilike."%10432%",amount_match.not.is.null'],
      ])
      expect(findCalls('journal_entries', 'eq')).toContainEqual(['fiscal_period_id', 'period-1'])
    })

    it('does not take a date range for a bound: it can span every year', async () => {
      enqueue({ data: [], error: null, count: 0 })

      const request = createMockRequest('/api/bookkeeping/journal-entries', {
        searchParams: { exclude_draft: 'true', date_from: '2019-01-01', date_to: '2026-12-31', search: '12 500 kr' },
      })
      await GET(request, emptyParams)

      expect(findCalls('journal_entries', 'select')).toEqual([[PLAIN_SELECT, { count: 'exact' }]])
      expect(findCalls('journal_entries', 'or')).toHaveLength(0)
      expect(findCalls('journal_entries', 'ilike')).toEqual([['description', '%12 500 kr%']])
      // The range still narrows the list, as a filter of its own.
      expect(findCalls('journal_entries', 'gte')).toContainEqual(['entry_date', '2019-01-01'])
      expect(findCalls('journal_entries', 'lte')).toContainEqual(['entry_date', '2026-12-31'])
    })

    it('keeps reading a date with no period: it is a column of the verifikat, not a probe of its lines', async () => {
      enqueue({ data: [], error: null, count: 0 })

      const request = createMockRequest('/api/bookkeeping/journal-entries', {
        searchParams: { status: 'posted', exclude_draft: 'true', search: '2026-03-15' },
      })
      await GET(request, emptyParams)

      expect(findCalls('journal_entries', 'select')).toEqual([[PLAIN_SELECT, { count: 'exact' }]])
      expect(findCalls('journal_entries', 'or')).toEqual([
        ['description.ilike."%2026-03-15%",entry_date.eq.2026-03-15'],
      ])
    })
  })

  describe('date search', () => {
    const emptyParams = { params: Promise.resolve({}) }

    it('finds the verifikat of one bokföringsdatum, next to the text match', async () => {
      enqueue({ data: [], error: null, count: 0 })

      const request = createMockRequest('/api/bookkeeping/journal-entries', {
        searchParams: { period_id: 'period-1', search: '2026-03-15' },
      })
      const response = await GET(request, emptyParams)
      const { status } = await parseJsonResponse(response)

      expect(status).toBe(200)
      expect(mockSupabase.rpc).not.toHaveBeenCalled()
      // A date reads no lines: the select stays the list's own.
      expect(findCalls('journal_entries', 'select')[0][0]).toBe('*, lines:journal_entry_lines(*)')
      expect(findCalls('journal_entries', 'or')).toEqual([
        ['description.ilike."%2026-03-15%",entry_date.eq.2026-03-15'],
      ])
      expect(findCalls('journal_entries', 'ilike')).toHaveLength(0)
      expect(findCalls('journal_entries', 'eq')).toContainEqual(['fiscal_period_id', 'period-1'])
    })

    it('reads a month as its first to its last day', async () => {
      enqueue({ data: [], error: null, count: 0 })

      const request = createMockRequest('/api/bookkeeping/journal-entries', {
        searchParams: { period_id: 'period-1', search: '2026-02' },
      })
      await GET(request, emptyParams)

      expect(findCalls('journal_entries', 'or')).toEqual([
        ['description.ilike."%2026-02%",and(entry_date.gte.2026-02-01,entry_date.lte.2026-02-28)'],
      ])
    })

    it('narrows inside the date range of the filter dialog, never past it', async () => {
      enqueue({ data: [], error: null, count: 0 })

      const request = createMockRequest('/api/bookkeeping/journal-entries', {
        searchParams: { period_id: 'period-1', search: '2026-03-15', date_from: '2026-03-01', date_to: '2026-03-31' },
      })
      await GET(request, emptyParams)

      // The dialog's bounds are ANDed filters of their own; the search arm
      // sits inside the or() and cannot widen them.
      expect(findCalls('journal_entries', 'gte')).toContainEqual(['entry_date', '2026-03-01'])
      expect(findCalls('journal_entries', 'lte')).toContainEqual(['entry_date', '2026-03-31'])
    })

    it('does not read a date that does not exist', async () => {
      enqueue({ data: [], error: null, count: 0 })

      const request = createMockRequest('/api/bookkeeping/journal-entries', {
        searchParams: { period_id: 'period-1', search: '2026-02-31' },
      })
      await GET(request, emptyParams)

      expect(findCalls('journal_entries', 'or')).toHaveLength(0)
      expect(findCalls('journal_entries', 'ilike')).toEqual([['description', '%2026-02-31%']])
    })
  })

  it('orders by description on description sort, bypassing the RPC', async () => {
    enqueue({ data: [], error: null, count: 0 })

    const request = createMockRequest('/api/bookkeeping/journal-entries', {
      searchParams: { period_id: 'period-1', sort_by: 'description_asc' },
    })
    const response = await GET(request)
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(200)
    expect(mockSupabase.rpc).not.toHaveBeenCalled()
    expect(findCalls('journal_entries', 'order')[0]).toEqual([
      'description',
      { ascending: true },
    ])
  })

  it('chains stacked sort keys in priority order and bypasses the RPC', async () => {
    enqueue({ data: [], error: null, count: 0 })

    const request = createMockRequest('/api/bookkeeping/journal-entries', {
      searchParams: { period_id: 'period-1', sort_by: 'description_desc,date_asc' },
    })
    const response = await GET(request)
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(200)
    expect(mockSupabase.rpc).not.toHaveBeenCalled()
    // Priority order preserved, then the voucher tiebreak in the LAST key's
    // direction (ascending here), then the globally unique id tiebreak:
    // series+number repeat across fiscal years, so equal keys need a total
    // order for stable pagination.
    expect(findCalls('journal_entries', 'order')).toEqual([
      ['description', { ascending: false }],
      ['entry_date', { ascending: true }],
      ['voucher_series', { ascending: true }],
      ['voucher_number', { ascending: true }],
      ['id', { ascending: true }],
    ])
  })

  it('dedupes repeated sort columns and caps the stack at three keys', async () => {
    enqueue({ data: { ok: true, total_count: 0, ids: [] }, error: null })

    const request = createMockRequest('/api/bookkeeping/journal-entries', {
      searchParams: {
        include_related: 'false',
        sort_by: 'date_desc,date_asc,nonsense,voucher_desc,total_asc,description_asc',
      },
    })
    const response = await GET(request)
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(200)
    // date deduped (first token wins), the unknown token is ignored, and the
    // stack caps at three keys (date, voucher, total): description never
    // makes it in. Voucher is in the stack, so no series+number tiebreak is
    // appended; the id tiebreak always is (duplicate series+number across
    // fiscal years on the all-years scope). An amount key in the stack takes
    // the Belopp sort's RPC, which gets the same order.
    expect(mockSupabase.rpc).toHaveBeenCalledWith(
      'list_verifikat_by_amount',
      expect.objectContaining({
        p_order: ['entry_date.desc', 'voucher_series.desc', 'voucher_number.desc', 'display_amount.asc', 'id.asc'],
      }),
    )
  })

  it('appends the id tiebreak on the all-years scope where voucher identifiers repeat', async () => {
    enqueue({ data: [], error: null, count: 0 })

    // No period_id: the "Alla räkenskapsår" scope, where A-1 exists once per
    // fiscal year. Without a globally unique final key, rows with equal
    // (entry_date, series, number) can swap between page requests and be
    // duplicated or dropped at page boundaries.
    const request = createMockRequest('/api/bookkeeping/journal-entries', {
      searchParams: { include_related: 'false', sort_by: 'date_desc' },
    })
    const response = await GET(request)
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(200)
    const orderCalls = findCalls('journal_entries', 'order')
    expect(orderCalls[orderCalls.length - 1]).toEqual(['id', { ascending: false }])
  })

  it('still serves a single date sort key through the include_related RPC', async () => {
    enqueue({ data: [], error: null })

    const request = createMockRequest('/api/bookkeeping/journal-entries', {
      searchParams: { period_id: 'period-1', sort_by: 'date_asc' },
    })
    const response = await GET(request)
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(200)
    expect(mockSupabase.rpc).toHaveBeenCalledWith(
      'list_fiscal_period_entries_with_related',
      expect.objectContaining({ p_sort_date: 'asc' }),
    )
  })

  it('clamps a large limit to the 1,000 rows one request can return, and floors a negative offset', async () => {
    enqueue({ data: [], error: null, count: 0 })

    const request = createMockRequest('/api/bookkeeping/journal-entries', {
      // PostgREST cuts every response at 1,000 rows, so a larger limit would
      // come back truncated under a count that claims more. "Alla" collects
      // the list in 1,000-row chunks instead. Both bounds are server-side
      // (ASVS V1.2.5).
      searchParams: { limit: '999999', offset: '-5', include_related: 'false' },
    })
    const response = await GET(request, { params: Promise.resolve({}) })
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(200)
    expect(mockSupabase.from).toHaveBeenCalledWith('journal_entries')
    expect(findCalls('journal_entries', 'range')).toEqual([[0, 999]])
  })

  it('passes the clamped limit to the fiscal-period RPC as well', async () => {
    enqueue({ data: [], error: null })

    const request = createMockRequest('/api/bookkeeping/journal-entries', {
      searchParams: { period_id: 'period-1', limit: '100000', offset: '2000' },
    })
    const response = await GET(request, { params: Promise.resolve({}) })
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(200)
    expect(mockSupabase.rpc).toHaveBeenCalledWith(
      'list_fiscal_period_entries_with_related',
      expect.objectContaining({ p_limit: 1000, p_offset: 2000 }),
    )
  })

  it('returns 500 INTERNAL_ERROR on database error', async () => {
    enqueue({ data: null, error: { message: 'DB error' } })

    const request = createMockRequest('/api/bookkeeping/journal-entries')
    const response = await GET(request)
    const { status, body } = await parseJsonResponse<{ error: { code: string; message: string } }>(response)

    expect(status).toBe(500)
    expect(body.error.code).toBe('INTERNAL_ERROR')
    // Raw Supabase messages never reach the response field (issue #337).
    expect(body.error.message).not.toContain('DB error')
  })

  it('answers a statement timeout as a retryable 503 TRANSIENT_ERROR and logs the database message', async () => {
    enqueue({ data: null, error: { message: 'canceling statement due to statement timeout', code: '57014', details: null, hint: null } })

    const request = createMockRequest('/api/bookkeeping/journal-entries', {
      searchParams: { exclude_draft: 'true', sort_date: 'desc' },
    })
    const { status, body } = await parseJsonResponse<{ error: { code: string; message: string } }>(await GET(request))

    expect(status).toBe(503)
    expect(body.error.code).toBe('TRANSIENT_ERROR')
    expect(body.error.message).not.toContain('statement timeout')
    const call = mockLogError.mock.calls.find(([msg]) => msg === 'TRANSIENT_ERROR')
    expect(call).toBeDefined()
    expect((call![1] as Error).message).toBe('Journal entries: canceling statement due to statement timeout')
  })

  describe('include_counts=true (the verifikat list asks for its underlag counts with its rows)', () => {
    type Body = {
      data: { id: string }[]
      count: number
      attachment_counts?: Record<string, number>
      invoice_references?: Record<string, number>
      no_doc_required?: Record<string, string | null>
    }
    const counted = { counts: { 'je-1': 2 }, invoice_references: { 'je-2': 1 }, no_doc_required: { 'je-2': 'Bankavgift' } }
    const noParams = { params: Promise.resolve({}) }

    it('leaves the counts out unless asked, and reads none', async () => {
      enqueue({ data: [makeJournalEntry({ id: 'je-1' })], error: null, count: 1 })

      const { status, body } = await parseJsonResponse<Body>(await GET(createMockRequest('/api/bookkeeping/journal-entries'), noParams))

      expect(status).toBe(200)
      expect(body.attachment_counts).toBeUndefined()
      expect(body.invoice_references).toBeUndefined()
      expect(mockCountUnderlag).not.toHaveBeenCalled()
    })

    it('carries the counts for the page rows on the direct path', async () => {
      enqueue({ data: [makeJournalEntry({ id: 'je-1' }), makeJournalEntry({ id: 'je-2' })], error: null, count: 2 })
      mockCountUnderlag.mockResolvedValueOnce(counted)

      const request = createMockRequest('/api/bookkeeping/journal-entries', { searchParams: { include_counts: 'true' } })
      const { status, body } = await parseJsonResponse<Body>(await GET(request, noParams))

      expect(status).toBe(200)
      expect(body.data.map((e) => e.id)).toEqual(['je-1', 'je-2'])
      expect(body.count).toBe(2)
      expect(body.attachment_counts).toEqual({ 'je-1': 2 })
      expect(body.invoice_references).toEqual({ 'je-2': 1 })
      // The rows' "Inget underlag krävs" marks ride along too: the list no
      // longer reads the company's whole exemption list on mount.
      expect(body.no_doc_required).toEqual({ 'je-2': 'Bankavgift' })
      expect(mockCountUnderlag).toHaveBeenCalledWith(mockSupabase, 'company-1', ['je-1', 'je-2'])
    })

    it('carries them on the include_related RPC path too', async () => {
      enqueue({
        data: [
          { entry: makeJournalEntry({ id: 'je-1' }), total_count: 2 },
          { entry: makeJournalEntry({ id: 'je-2' }), total_count: 2 },
        ],
        error: null,
      })
      mockCountUnderlag.mockResolvedValueOnce(counted)

      const request = createMockRequest('/api/bookkeeping/journal-entries', {
        searchParams: { period_id: 'period-1', include_counts: 'true' },
      })
      const { body } = await parseJsonResponse<Body>(await GET(request, noParams))

      expect(mockSupabase.rpc).toHaveBeenCalledWith('list_fiscal_period_entries_with_related', expect.anything())
      expect(mockCountUnderlag).toHaveBeenCalledWith(mockSupabase, 'company-1', ['je-1', 'je-2'])
      expect(body.attachment_counts).toEqual({ 'je-1': 2 })
    })

    it('carries them on the missing_underlag path, in the page order', async () => {
      const E1 = '11111111-1111-4111-8111-111111111111'
      const E3 = '33333333-3333-4333-8333-333333333333'
      enqueue({ data: { ok: true, total_count: 2, ids: [E3, E1] }, error: null })
      enqueue({ data: [makeJournalEntry({ id: E1 }), makeJournalEntry({ id: E3 })], error: null })
      mockCountUnderlag.mockResolvedValueOnce({ counts: {}, invoice_references: {} })

      const request = createMockRequest('/api/bookkeeping/journal-entries', {
        searchParams: { missing_underlag: 'true', exclude_draft: 'true', include_counts: 'true' },
      })
      const { body } = await parseJsonResponse<Body>(await GET(request, noParams))

      expect(mockCountUnderlag).toHaveBeenCalledWith(mockSupabase, 'company-1', [E3, E1])
      expect(body.attachment_counts).toEqual({})
      expect(body.invoice_references).toEqual({})
    })

    it('reads no counts for an empty page', async () => {
      enqueue({ data: [], error: null, count: 0 })

      const request = createMockRequest('/api/bookkeeping/journal-entries', { searchParams: { include_counts: 'true' } })
      const { status, body } = await parseJsonResponse<Body>(await GET(request, noParams))

      expect(status).toBe(200)
      expect(body.data).toEqual([])
      expect(mockCountUnderlag).not.toHaveBeenCalled()
    })

    it('still answers the rows when the count reads fail, without the counts (the list falls back)', async () => {
      enqueue({ data: [makeJournalEntry({ id: 'je-1' })], error: null, count: 1 })
      mockCountUnderlag.mockRejectedValueOnce(new Error('statement timeout'))

      const request = createMockRequest('/api/bookkeeping/journal-entries', { searchParams: { include_counts: 'true' } })
      const { status, body } = await parseJsonResponse<Body>(await GET(request, noParams))

      expect(status).toBe(200)
      expect(body.data.map((e) => e.id)).toEqual(['je-1'])
      expect(body.attachment_counts).toBeUndefined()
      expect(body.invoice_references).toBeUndefined()
      expect(body.no_doc_required).toBeUndefined()
    })
  })

  describe('sorted by Belopp (list_verifikat_by_amount)', () => {
    // UUID-shaped ids, as journal_entries.id produces them.
    const E1 = '11111111-1111-4111-8111-111111111111'
    const E2 = '22222222-2222-4222-8222-222222222222'
    const E3 = '33333333-3333-4333-8333-333333333333'
    const RPC = 'list_verifikat_by_amount'
    const rpcArgs = () =>
      (mockSupabase.rpc.mock.calls.find(([name]) => name === RPC) as unknown[] | undefined)?.[1] as
        | Record<string, unknown>
        | undefined
    const listQuery = () => logChildContexts.find((c) => 'list_query' in c)?.list_query

    it('returns 401 when not authenticated, before any read', async () => {
      mockSupabase.auth.getUser.mockResolvedValue({ data: { user: null } })

      const request = createMockRequest('/api/bookkeeping/journal-entries', {
        searchParams: { sort_by: 'total_desc', exclude_draft: 'true' },
      })
      const { status } = await parseJsonResponse(await GET(request))

      expect(status).toBe(401)
      expect(mockSupabase.rpc).not.toHaveBeenCalled()
      expect(mockSupabase.from).not.toHaveBeenCalled()
    })

    it('answers a malformed period_id as 400 VALIDATION_ERROR', async () => {
      enqueue({
        data: null,
        error: { message: 'invalid input syntax for type uuid: "inte-ett-id"', code: '22P02', details: null, hint: null },
      })

      const request = createMockRequest('/api/bookkeeping/journal-entries', {
        searchParams: { sort_by: 'total_desc', period_id: 'inte-ett-id' },
      })
      const { status, body } = await parseJsonResponse<{ error: { code: string } }>(await GET(request))

      expect(status).toBe(400)
      expect(body.error.code).toBe('VALIDATION_ERROR')
      expect(mockSupabase.from).not.toHaveBeenCalled()
    })

    it('returns the page the RPC sorted, in its order, with the full total, from one RPC call and one row read', async () => {
      enqueue({ data: { ok: true, total_count: 70500, ids: [E3, E1, E2] }, error: null }) // the RPC
      // The page's rows: the .in() read has no order of its own.
      enqueue({
        data: [makeJournalEntry({ id: E1 }), makeJournalEntry({ id: E2 }), makeJournalEntry({ id: E3 })],
        error: null,
      })

      const request = createMockRequest('/api/bookkeeping/journal-entries', {
        searchParams: { sort_by: 'total_desc', exclude_draft: 'true', collapse_corrections: 'true', limit: '3', offset: '20' },
      })
      const { status, body } = await parseJsonResponse<{ data: { id: string }[]; count: number }>(await GET(request))

      expect(status).toBe(200)
      expect(body.data.map((e) => e.id)).toEqual([E3, E1, E2])
      expect(body.count).toBe(70500)
      expect(mockSupabase.rpc).toHaveBeenCalledTimes(1)
      expect(mockSupabase.from).toHaveBeenCalledTimes(1)
      expect(findCalls('journal_entries', 'select')).toEqual([['*, lines:journal_entry_lines(*)']])
      expect(findCalls('journal_entries', 'eq')).toEqual([['company_id', 'company-1']])
      expect(findCalls('journal_entries', 'in')).toEqual([['id', [E3, E1, E2]]])
      // Nothing orders by the per-row computed column any more.
      expect(findCalls('journal_entries', 'order')).toEqual([])
    })

    it('sends the order the direct query built for every sort stack (today\'s order)', async () => {
      // route.ts on main: the keys in priority order, the series+number
      // tiebreak in the last key's direction unless voucher is a key, the id.
      const stacks: Array<[string, string[]]> = [
        ['total_desc', ['display_amount.desc', 'voucher_series.desc', 'voucher_number.desc', 'id.desc']],
        ['total_asc', ['display_amount.asc', 'voucher_series.asc', 'voucher_number.asc', 'id.asc']],
        [
          'total_desc,description_asc',
          ['display_amount.desc', 'description.asc', 'voucher_series.asc', 'voucher_number.asc', 'id.asc'],
        ],
        ['voucher_asc,total_desc', ['voucher_series.asc', 'voucher_number.asc', 'display_amount.desc', 'id.desc']],
        ['date_desc,total_asc', ['entry_date.desc', 'display_amount.asc', 'voucher_series.asc', 'voucher_number.asc', 'id.asc']],
      ]
      for (const [sortBy, order] of stacks) {
        vi.clearAllMocks()
        reset()
        enqueue({ data: { ok: true, total_count: 0, ids: [] }, error: null })
        const request = createMockRequest('/api/bookkeeping/journal-entries', {
          searchParams: { sort_by: sortBy, period_id: 'period-1', exclude_draft: 'true' },
        })
        const { status } = await parseJsonResponse(await GET(request))
        expect(status).toBe(200)
        expect({ sortBy, order: rpcArgs()?.p_order }).toEqual({ sortBy, order })
      }
    })

    it('passes the direct query\'s filters through, one for one', async () => {
      enqueue({ data: { ok: true, total_count: 0, ids: [] }, error: null })

      const request = createMockRequest('/api/bookkeeping/journal-entries', {
        searchParams: {
          sort_by: 'total_asc',
          period_id: 'period-1',
          exclude_draft: 'true',
          date_from: '2026-01-01',
          date_to: '2026-06-30',
          series: 'B',
          collapse_corrections: 'true',
          // Four digits inside a fiscal year: text, account and amount.
          search: '1930',
          limit: '50',
          offset: '100',
        },
      })
      const { status, body } = await parseJsonResponse(await GET(request))

      expect(status).toBe(200)
      expect(body).toEqual({ data: [], count: 0 })
      expect(rpcArgs()).toEqual({
        p_company_id: 'company-1',
        p_period_id: 'period-1',
        p_status: null,
        p_exclude_draft: true,
        p_date_from: '2026-01-01',
        p_date_to: '2026-06-30',
        p_series: 'B',
        p_search_pattern: '%1930%',
        p_search_voucher_series: null,
        p_search_voucher_number: null,
        p_search_account: '1930',
        p_search_amount: 1930,
        p_search_date_from: null,
        p_search_date_to: null,
        p_hide_reversed: false,
        p_collapse_corrections: true,
        p_order: ['display_amount.asc', 'voucher_series.asc', 'voucher_number.asc', 'id.asc'],
        p_limit: 50,
        p_offset: 100,
      })
      // No page rows to read for an empty page.
      expect(mockSupabase.from).not.toHaveBeenCalled()
    })

    it('reads no amount without a fiscal year, and folds nothing it already hides', async () => {
      enqueue({ data: { ok: true, total_count: 0, ids: [] }, error: null })

      const request = createMockRequest('/api/bookkeeping/journal-entries', {
        searchParams: {
          sort_by: 'total_desc',
          status: 'posted',
          hide_reversed: 'true',
          collapse_corrections: 'true',
          search: 'a*b 50%',
        },
      })
      await GET(request)

      expect(rpcArgs()).toMatchObject({
        p_period_id: null,
        p_status: 'posted',
        p_hide_reversed: true,
        p_collapse_corrections: false,
        // LIKE wildcards typed are literals; * is a wildcard, as PostgREST reads it.
        p_search_pattern: '%a%b 50\\%%',
        p_search_amount: null,
      })
    })

    it('answers a statement timeout as 503 and logs the query shape, never the needle', async () => {
      enqueue({
        data: null,
        error: { message: 'canceling statement due to statement timeout', code: '57014', details: null, hint: null },
      })

      const request = createMockRequest('/api/bookkeeping/journal-entries', {
        searchParams: {
          sort_by: 'total_desc,description_asc',
          period_id: 'period-1',
          search: 'Hemlig hyra',
          exclude_draft: 'true',
          limit: '20',
          offset: '40',
        },
      })
      const { status, body } = await parseJsonResponse<{ error: { code: string } }>(await GET(request))

      expect(status).toBe(503)
      expect(body.error.code).toBe('TRANSIENT_ERROR')
      expect(mockLogError.mock.calls.map(([msg]) => msg)).toContain('TRANSIENT_ERROR')
      expect(listQuery()).toEqual({
        sort_by: 'total_desc,description_asc',
        period: true,
        search: ['text'],
        offset: 40,
        limit: 20,
      })
      expect(JSON.stringify(logChildContexts)).not.toContain('Hemlig')
    })

    it('names each reading of the needle in the shape', async () => {
      enqueue({ data: { ok: true, total_count: 0, ids: [] }, error: null })

      const request = createMockRequest('/api/bookkeeping/journal-entries', {
        searchParams: { sort_by: 'total_desc', period_id: 'period-1', search: '1930' },
      })
      await GET(request)

      expect(listQuery()).toEqual({ sort_by: 'total_desc', period: true, search: ['text', 'account', 'amount'], offset: 0, limit: 50 })
    })

    it('answers a refusal of the RPC as a 500 and logs it', async () => {
      enqueue({ data: { ok: false, code: 'LIST_VERIFIKAT_BY_AMOUNT_INVALID_ORDER' }, error: null })

      const request = createMockRequest('/api/bookkeeping/journal-entries', {
        searchParams: { sort_by: 'total_desc' },
      })
      const { status, body } = await parseJsonResponse<{ error: { code: string } }>(await GET(request))

      expect(status).toBe(500)
      expect(body.error.code).toBe('INTERNAL_ERROR')
      expect(mockLogError).toHaveBeenCalled()
      expect(mockSupabase.from).not.toHaveBeenCalled()
    })
  })

  describe('missing_underlag=true (the dashboard deep-link filter)', () => {
    // UUID-shaped ids, as journal_entries.id produces them.
    const E1 = '11111111-1111-4111-8111-111111111111'
    const E2 = '22222222-2222-4222-8222-222222222222'
    const E3 = '33333333-3333-4333-8333-333333333333'
    const RPC = 'list_verifikat_missing_underlag'
    const rpcArgs = () =>
      (mockSupabase.rpc.mock.calls.find(([name]) => name === RPC) as unknown[] | undefined)?.[1] as
        | Record<string, unknown>
        | undefined

    it('returns the page the RPC resolved, in its order, with the full-set count', async () => {
      enqueue({ data: { ok: true, total_count: 3, ids: [E3, E1] }, error: null }) // the RPC
      enqueue({ data: [makeJournalEntry({ id: E1 }), makeJournalEntry({ id: E3 })], error: null }) // page rows

      const request = createMockRequest('/api/bookkeeping/journal-entries', {
        searchParams: { missing_underlag: 'true', exclude_draft: 'true', limit: '2' },
      })
      const { status, body } = await parseJsonResponse<{ data: { id: string }[]; count: number }>(
        await GET(request)
      )

      expect(status).toBe(200)
      // Reassembled in the RPC's order (the .in() row fetch has none).
      expect(body.data.map((e) => e.id)).toEqual([E3, E1])
      expect(body.count).toBe(3)
    })

    it('costs one RPC call and one page-row read, however long the ledger (crm#1390)', async () => {
      enqueue({ data: { ok: true, total_count: 4600, ids: [E1, E2] }, error: null })
      enqueue({ data: [makeJournalEntry({ id: E1 }), makeJournalEntry({ id: E2 })], error: null })

      const request = createMockRequest('/api/bookkeeping/journal-entries', {
        searchParams: { missing_underlag: 'true', exclude_draft: 'true', limit: '20' },
      })
      const { status, body } = await parseJsonResponse<{ data: unknown[]; count: number }>(await GET(request))

      expect(status).toBe(200)
      expect(body.count).toBe(4600)
      // Before: every candidate read into the server, then 7 lookups per
      // 150 ids, chunk after chunk; a 4,600-verifikat ledger paid ~100
      // sequential round trips before this page could render.
      expect(mockSupabase.rpc.mock.calls.filter(([name]) => name === RPC)).toHaveLength(1)
      expect(mockSupabase.from).toHaveBeenCalledTimes(1)
      expect(mockSupabase.from).toHaveBeenCalledWith('journal_entries')
      expect(mockSupabase.from).not.toHaveBeenCalledWith('document_attachments')
      expect(mockSupabase.from).not.toHaveBeenCalledWith('journal_entry_no_doc_required')
    })

    it('passes the scope, page and the list sort through to the RPC', async () => {
      enqueue({ data: { ok: true, total_count: 0, ids: [] }, error: null })

      const request = createMockRequest('/api/bookkeeping/journal-entries', {
        searchParams: {
          missing_underlag: 'true',
          period_id: 'period-1',
          series: 'B',
          date_from: '2026-01-01',
          date_to: '2026-06-30',
          exclude_draft: 'true',
          sort_by: 'total_desc',
          limit: '50',
          offset: '100',
        },
      })
      const { status, body } = await parseJsonResponse<{ data: unknown[]; count: number }>(await GET(request))

      expect(status).toBe(200)
      expect(body).toEqual({ data: [], count: 0 })
      expect(rpcArgs()).toMatchObject({
        p_company_id: 'company-1',
        p_period_id: 'period-1',
        p_series: 'B',
        p_date_from: '2026-01-01',
        p_date_to: '2026-06-30',
        // Amount sorts order by the amount the list shows (crm#1280).
        p_order: ['display_amount.desc', 'voucher_series.desc', 'voucher_number.desc', 'id.desc'],
        p_limit: 50,
        p_offset: 100,
      })
      // No page rows to read for an empty page.
      expect(mockSupabase.from).not.toHaveBeenCalled()
    })

    it('takes this path instead of the include_related RPC when a period is selected', async () => {
      enqueue({ data: { ok: true, total_count: 0, ids: [] }, error: null })

      const request = createMockRequest('/api/bookkeeping/journal-entries', {
        searchParams: { missing_underlag: 'true', period_id: 'period-1', exclude_draft: 'true' },
      })
      const { status } = await parseJsonResponse(await GET(request))

      expect(status).toBe(200)
      expect(mockSupabase.rpc).not.toHaveBeenCalledWith(
        'list_fiscal_period_entries_with_related',
        expect.anything(),
      )
    })

    it('matches a voucher-label search against series+number, like the direct path', async () => {
      enqueue({ data: { ok: true, total_count: 1, ids: [E1] }, error: null })
      enqueue({ data: [makeJournalEntry({ id: E1 })], error: null })

      const request = createMockRequest('/api/bookkeeping/journal-entries', {
        searchParams: { missing_underlag: 'true', exclude_draft: 'true', search: 'A209' },
      })
      const { status, body } = await parseJsonResponse<{ data: { id: string }[]; count: number }>(
        await GET(request)
      )

      expect(status).toBe(200)
      expect(body.data.map((e) => e.id)).toEqual([E1])
      expect(rpcArgs()).toMatchObject({
        p_search_pattern: '%A209%',
        p_search_voucher_series: 'A',
        p_search_voucher_number: 209,
      })
    })

    it('logs the driver error and answers with the Swedish text when the RPC fails (#2395)', async () => {
      const driverError = { message: 'canceling statement due to statement timeout', code: '57014', details: null, hint: null }
      enqueue({ data: null, error: driverError })

      const request = createMockRequest('/api/bookkeeping/journal-entries', {
        searchParams: { missing_underlag: 'true', exclude_draft: 'true' },
      })
      const { status, body } = await parseJsonResponse<{ error: string }>(await GET(request, { params: Promise.resolve({}) }))

      expect(status).toBe(500)
      expect(body.error).toBe('Verifikationerna kunde inte hämtas. Försök igen.')
      const call = mockLogError.mock.calls.find(([msg]) => msg === 'failed to resolve missing-underlag entries')
      expect(call).toBeDefined()
      expect(call![2]).toEqual({ cause: driverError })
    })

    it('is ignored for the drafts view', async () => {
      enqueue({ data: [], error: null, count: 0 })

      const request = createMockRequest('/api/bookkeeping/journal-entries', {
        searchParams: { missing_underlag: 'true', status: 'draft' },
      })
      const { status } = await parseJsonResponse(await GET(request))

      expect(status).toBe(200)
      // The drafts view goes through the normal direct query, not the RPC.
      expect(mockSupabase.from).toHaveBeenCalledWith('journal_entries')
      expect(mockSupabase.rpc).not.toHaveBeenCalledWith(RPC, expect.anything())
    })
  })
})

const VALID_UUID = '550e8400-e29b-41d4-a716-446655440000'

describe('POST /api/bookkeeping/journal-entries', () => {
  const mockUser = { id: 'user-1', email: 'test@test.se' }

  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: mockUser } })
  })

  it('returns 401 when not authenticated', async () => {
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: null } })

    const request = createMockRequest('/api/bookkeeping/journal-entries', {
      method: 'POST',
      body: {},
    })
    const response = await POST(request)
    const { status, body } = await parseJsonResponse(response)

    expect(status).toBe(401)
    expect(body).toEqual({ error: 'Unauthorized' })
  })

  it('creates journal entry and returns it', async () => {
    const entry = makeJournalEntry()
    mockCreateJournalEntry.mockResolvedValue(entry)

    const input = {
      fiscal_period_id: VALID_UUID,
      entry_date: '2024-06-15',
      description: 'Test entry',
      source_type: 'manual',
      lines: [
        { account_number: '1930', debit_amount: 1000, credit_amount: 0 },
        { account_number: '3001', debit_amount: 0, credit_amount: 1000 },
      ],
    }

    const request = createMockRequest('/api/bookkeeping/journal-entries', {
      method: 'POST',
      body: input,
    })
    const response = await POST(request)
    const { status, body } = await parseJsonResponse<{ data: unknown }>(response)

    expect(status).toBe(200)
    expect(body.data).toEqual(entry)
    // Through the posting port, whose ledger adapter always passes the
    // commitMethod and rubricVersion positions (undefined here).
    expect(mockCreateJournalEntry).toHaveBeenCalledWith(expect.anything(), 'company-1', 'user-1', input, undefined, undefined)
  })

  it('returns 400 when engine throws', async () => {
    mockCreateJournalEntry.mockRejectedValue(new Error('Unbalanced entry'))

    const request = createMockRequest('/api/bookkeeping/journal-entries', {
      method: 'POST',
      body: {
        fiscal_period_id: VALID_UUID,
        entry_date: '2024-06-15',
        description: 'Bad entry',
        source_type: 'manual',
        lines: [
          { account_number: '1930', debit_amount: 1000, credit_amount: 0 },
          { account_number: '3001', debit_amount: 0, credit_amount: 500 },
        ],
      },
    })
    const response = await POST(request)
    const { status, body } = await parseJsonResponse<{ error: string }>(response)

    expect(status).toBe(400)
    // Untyped engine errors map to the Swedish context fallback (issue #337).
    expect(body.error).toBe('Kunde inte hantera verifikationen. Försök igen.')
  })

  it('answers a verifikat dated in a locked year as 400 PERIOD_LOCKED, not a 500 database failure', async () => {
    // Production 2026-11-22: the year was locked three minutes before; the
    // period-lock trigger refused the draft insert (P0001) and this door
    // answered 500 BOOKKEEPING_DATABASE_ERROR.
    mockCreateJournalEntry.mockRejectedValue(new BookkeepingDatabaseError(
      'create_draft_entry',
      'Cannot write to locked/closed fiscal period "Räkenskapsår 2025" (is_closed=t, locked_at=2026-11-22 11:03:58.82+00)',
      'P0001',
    ))

    const request = createMockRequest('/api/bookkeeping/journal-entries', {
      method: 'POST',
      body: {
        fiscal_period_id: VALID_UUID,
        entry_date: '2025-11-30',
        description: 'Bokat efter låsningen',
        source_type: 'manual',
        lines: [
          { account_number: '6570', debit_amount: 100, credit_amount: 0 },
          { account_number: '1930', debit_amount: 0, credit_amount: 100 },
        ],
      },
    })
    const response = await POST(request, { params: Promise.resolve({}) })
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(response)

    expect(status).toBe(400)
    expect(body.error.code).toBe('PERIOD_LOCKED')
  })
})

/**
 * The dashboard route accepts only the source types the dashboard's own forms
 * author ('manual', and 'vat_settlement' for the reviewed momsredovisning
 * proposal and VAT templates). An engine-owned label would let a business
 * voucher claim that type's dimension-policy exemption ('system' skips every
 * rule, 'accrual' skips registry validation) and show a false source.
 */
describe('POST /api/bookkeeping/journal-entries: source_type allowlist', () => {
  const mockUser = { id: 'user-1', email: 'test@test.se' }
  const emptyParams = { params: Promise.resolve({}) }
  const baseBody = {
    fiscal_period_id: VALID_UUID,
    entry_date: '2024-06-15',
    description: 'Test entry',
    lines: [
      { account_number: '6570', debit_amount: 100, credit_amount: 0 },
      { account_number: '1930', debit_amount: 0, credit_amount: 100 },
    ],
  }

  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: mockUser } })
  })

  it.each([
    'system',
    'accrual',
    'storno',
    'correction',
    'year_end',
    'import',
    'opening_balance',
    'credit_note',
    'invoice_paid',
  ])('rejects the engine-owned source_type %s with 400 before the engine runs', async (sourceType) => {
    const request = createMockRequest('/api/bookkeeping/journal-entries', {
      method: 'POST',
      body: { ...baseBody, source_type: sourceType },
    })
    const response = await POST(request, emptyParams)
    const { status, body } = await parseJsonResponse<{ error: string; errors: Array<{ field: string }> }>(response)

    expect(status).toBe(400)
    expect(body.errors.map((e) => e.field)).toEqual(['source_type'])
    expect(body.error).toContain('"manual" eller "vat_settlement"')
    expect(mockCreateJournalEntry).not.toHaveBeenCalled()
  })

  it('books the reviewed VAT settlement with source_type vat_settlement', async () => {
    mockCreateJournalEntry.mockResolvedValue(makeJournalEntry())

    const request = createMockRequest('/api/bookkeeping/journal-entries', {
      method: 'POST',
      body: { ...baseBody, source_type: 'vat_settlement' },
    })
    const response = await POST(request, emptyParams)

    expect(response.status).toBe(200)
    expect(mockCreateJournalEntry).toHaveBeenCalledWith(
      expect.anything(),
      'company-1',
      'user-1',
      expect.objectContaining({ source_type: 'vat_settlement' }),
      undefined,
      undefined,
    )
  })

  it('defaults an omitted source_type to manual', async () => {
    mockCreateJournalEntry.mockResolvedValue(makeJournalEntry())

    const request = createMockRequest('/api/bookkeeping/journal-entries', {
      method: 'POST',
      body: baseBody,
    })
    const response = await POST(request, emptyParams)

    expect(response.status).toBe(200)
    expect(mockCreateJournalEntry).toHaveBeenCalledWith(
      expect.anything(),
      'company-1',
      'user-1',
      expect.objectContaining({ source_type: 'manual' }),
      undefined,
      undefined,
    )
  })
})
