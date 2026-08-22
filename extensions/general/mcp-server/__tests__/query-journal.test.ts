/**
 * Unit tests for gnubok_query_journal.
 *
 * Verifies tool registration, the post-fetch amount filter, the full-match
 * aggregate pass (totals/groups over ALL matching lines via the two-step
 * entry-lines fetch, totals_scope='full_match'), and the free-text path,
 * which runs the same two-step fetch once per leg (entry description, line
 * description) instead of a `journal_entries!inner` embed. The supabase
 * query-builder chain is exercised by the live MCP smoke test; here we
 * check the filters sent and the result-shape pipeline.
 */
import { describe, it, expect, vi } from 'vitest'
import { tools } from '../server'
import { TOOL_SCOPE_MAP } from '@/lib/auth/api-keys'
import { getStructuredError } from '@/lib/errors/get-structured-error'

describe('gnubok_query_journal: registration', () => {
  it('is registered and read-only', () => {
    const tool = tools.find((t) => t.name === 'gnubok_query_journal')
    expect(tool).toBeDefined()
    expect(tool?.annotations.readOnlyHint).toBe(true)
    expect(tool?.annotations.destructiveHint).toBe(false)
  })

  it('declares the expected output fields', () => {
    const tool = tools.find((t) => t.name === 'gnubok_query_journal')!
    const schema = tool.outputSchema as { required?: string[]; properties?: Record<string, unknown> }
    expect(schema.required).toContain('lines')
    expect(schema.required).toContain('totals')
    expect(schema.required).toContain('total_lines')
    expect(schema.required).toContain('totals_scope')
    expect(schema.properties?.groups).toBeDefined()
  })

  it('is mapped to reports:read scope', () => {
    expect(TOOL_SCOPE_MAP.gnubok_query_journal).toBe('reports:read')
  })
})

/**
 * Build a minimal supabase mock that returns a fixed line set when the chain
 * is awaited. Uses a chainable proxy whose every method returns itself, with
 * the terminal awaitable resolving to { data, error, count }. Every .from()
 * call sees the SAME rows, so on the non-text path both the display query and
 * the fetchAllRows full-match aggregate pass read one identical match set.
 */
function makeChainMock(lines: unknown[], count: number) {
  const result = { data: lines, error: null, count }
  const buildChain = (): unknown => {
    return new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === 'then') {
            return (resolve: (v: unknown) => void) => resolve(result)
          }
          return () => buildChain()
        },
      },
    )
  }
  return {
    from: vi.fn().mockImplementation(() => buildChain()),
  } as never
}

/**
 * Mock for the NON-text path, which uses the two-step entry-lines fetch
 * (lib/bookkeeping/entry-lines.ts): journal_entries is queried first, then
 * journal_entry_lines by parent id, and the parent is reattached under
 * `journal_entries`. Both steps page with `.order('id').range(from, to)`, so
 * `.range()` is the terminal and one short page ends the paging loop.
 *
 * Fixtures stay embed-shaped (a line with its `journal_entries` parent); the
 * mock splits them into the two row sets the helper actually fetches, so the
 * value the tool sees is byte-identical to the old embed result.
 */
function makeEntryLinesMock(rows: Array<Record<string, unknown>>) {
  const tables: string[] = []
  const entries = [
    ...new Map(
      rows.map((r) => {
        const e = r.journal_entries as { id: string }
        return [e.id, e]
      }),
    ).values(),
  ]
  const bareLines = rows.map((r) => {
    const { journal_entries: parent, ...line } = r
    return { ...line, journal_entry_id: (parent as { id: string }).id }
  })

  const chain = (data: unknown[]): unknown =>
    new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === 'then') {
            return (resolve: (v: unknown) => void) =>
              resolve({ data, error: null, count: data.length })
          }
          if (prop === 'range') return () => ({ data, error: null, count: data.length })
          return () => chain(data)
        },
      },
    )

  const supabase = {
    from: vi.fn().mockImplementation((table: string) => {
      tables.push(table)
      return chain(table === 'journal_entries' ? entries : bareLines)
    }),
  } as never

  return { supabase, tables }
}

type FakeFilter = { op: string; column: string; value: unknown }
type FakeQuery = { table: string; filters: FakeFilter[] }

/** Translate a LIKE pattern (with `\`-escaped `%`, `_`, `\`) into a regex. */
function likeToRegex(pattern: string): RegExp {
  const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  let re = ''
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]
    if (ch === '\\' && i + 1 < pattern.length) {
      re += escapeRe(pattern[++i])
    } else if (ch === '%') {
      re += '.*'
    } else if (ch === '_') {
      re += '.'
    } else {
      re += escapeRe(ch)
    }
  }
  return new RegExp(`^${re}$`, 'is')
}

/**
 * Filter-aware fake for the free-text path. Both text legs run the two-step
 * entry-lines fetch (journal_entries first, then journal_entry_lines by
 * parent id) with the .ilike() on the entry side (leg A: description) or
 * the line side (leg B: line_description). The legs run in parallel, so
 * .from() call ORDER is not something a test should pin; instead this fake
 * evaluates the recorded filters (eq/in/gte/lte/ilike) against embed-shaped
 * fixtures like a tiny PostgREST, and records every query (table + filters)
 * so tests can assert on scoping and on what was sent.
 *
 * `failLinesWith` makes every journal_entry_lines page fail with that raw
 * message (the helper re-throws it as a plain Error), for the error-path
 * tests.
 */
function makeTwoStepTextMock(
  rows: Array<Record<string, unknown>>,
  opts: { failLinesWith?: string } = {},
) {
  const entries = [
    ...new Map(
      rows.map((r) => {
        const e = r.journal_entries as { id: string }
        return [e.id, e as Record<string, unknown>]
      }),
    ).values(),
  ]
  const bareLines = rows.map((r) => {
    const { journal_entries: parent, ...line } = r
    return { ...line, journal_entry_id: (parent as { id: string }).id } as Record<string, unknown>
  })
  const queries: FakeQuery[] = []

  const passes = (row: Record<string, unknown>, f: FakeFilter): boolean => {
    // Columns the fixture does not carry (company_id, status defaults, ...)
    // are unconstrained: the tests that care assert on the recorded filters.
    if (!(f.column in row)) return true
    const v = row[f.column]
    switch (f.op) {
      case 'eq':
        return v === f.value
      case 'in':
        return (f.value as unknown[]).includes(v)
      case 'gte':
        return typeof v === typeof f.value && (v as string | number) >= (f.value as string | number)
      case 'lte':
        return typeof v === typeof f.value && (v as string | number) <= (f.value as string | number)
      case 'ilike':
        return typeof v === 'string' && likeToRegex(f.value as string).test(v)
      default:
        return true
    }
  }

  const chain = (query: FakeQuery, data: Record<string, unknown>[]): unknown => {
    const evaluate = () => {
      if (query.table === 'journal_entry_lines' && opts.failLinesWith) {
        return { data: null, error: { message: opts.failLinesWith }, count: null }
      }
      const out = data.filter((row) => query.filters.every((f) => passes(row, f)))
      return { data: out, error: null, count: out.length }
    }
    return new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === 'then') {
            return (resolve: (v: unknown) => void) => resolve(evaluate())
          }
          if (prop === 'range') return () => evaluate()
          if (prop === 'eq' || prop === 'in' || prop === 'gte' || prop === 'lte' || prop === 'ilike' || prop === 'contains') {
            return (column: string, value: unknown) => {
              query.filters.push({ op: prop, column, value })
              return chain(query, data)
            }
          }
          return () => chain(query, data)
        },
      },
    )
  }

  const supabase = {
    from: vi.fn().mockImplementation((table: string) => {
      const query: FakeQuery = { table, filters: [] }
      queries.push(query)
      return chain(query, table === 'journal_entries' ? entries : bareLines)
    }),
  } as never

  const ilikeCalls = () =>
    queries.flatMap((q) =>
      q.filters
        .filter((f) => f.op === 'ilike')
        .map((f) => ({ table: q.table, column: f.column, pattern: f.value as string })),
    )
  const entryQueries = () => queries.filter((q) => q.table === 'journal_entries')
  const lineQueries = () => queries.filter((q) => q.table === 'journal_entry_lines')

  return { supabase, queries, ilikeCalls, entryQueries, lineQueries }
}

/** Build a LineRow fixture inline: keeps the per-test data dense and readable. */
function makeLineRow(opts: {
  id: string
  account_number?: string
  debit_amount?: number
  credit_amount?: number
  line_description?: string | null
  entry_description?: string
  entry_notes?: string | null
  voucher_number?: number
  entry_date?: string
}) {
  return {
    id: opts.id,
    account_number: opts.account_number ?? '4010',
    debit_amount: opts.debit_amount ?? 1000,
    credit_amount: opts.credit_amount ?? 0,
    currency: 'SEK',
    line_description: opts.line_description ?? null,
    project: null,
    cost_center: null,
    sort_order: 0,
    journal_entries: {
      id: `e-${opts.id}`,
      voucher_number: opts.voucher_number ?? 1,
      voucher_series: 'A',
      entry_date: opts.entry_date ?? '2026-03-15',
      description: opts.entry_description ?? '',
      notes: opts.entry_notes ?? null,
      source_type: 'bank_transaction',
      status: 'posted',
    },
  }
}

describe('gnubok_query_journal: entry notes (verifikat-anteckningar)', () => {
  it('surfaces journal_entries.notes as entry_notes on every returned line', async () => {
    const tool = tools.find((t) => t.name === 'gnubok_query_journal')!
    const rows = [
      makeLineRow({ id: 'l1', entry_notes: 'Avser Q1-hyran, se mail 12/3' }),
      makeLineRow({ id: 'l2' }),
    ]
    const { supabase, tables } = makeEntryLinesMock(rows)

    const result = (await tool.execute(
      { accounts: ['4010'] },
      'company-1', 'user-1', supabase,
    )) as { lines: Array<{ line_id: string; entry_notes: string | null }> }

    // The parent entry is reattached under the same key the old embed used,
    // so every mapped field still resolves.
    expect(tables).toEqual(['journal_entries', 'journal_entry_lines'])
    expect(result.lines.find((l) => l.line_id === 'l1')?.entry_notes).toBe(
      'Avser Q1-hyran, se mail 12/3',
    )
    expect(result.lines.find((l) => l.line_id === 'l2')?.entry_notes).toBeNull()
  })
})

describe('gnubok_query_journal: execute', () => {
  it('applies amount_min filter and computes totals on the filtered set', async () => {
    const tool = tools.find((t) => t.name === 'gnubok_query_journal')!
    const lines = [
      // Line 1: large debit: should pass amount_min: 1000
      {
        id: 'l1', account_number: '4010',
        debit_amount: 5000, credit_amount: 0,
        currency: 'SEK', line_description: 'Hyra', project: null, cost_center: null, sort_order: 0,
        journal_entries: {
          id: 'e1', voucher_number: 1, voucher_series: 'A',
          entry_date: '2026-03-15', description: 'Marshyra',
          source_type: 'supplier_invoice', status: 'posted',
        },
      },
      // Line 2: small debit: should fail amount_min: 1000
      {
        id: 'l2', account_number: '4010',
        debit_amount: 50, credit_amount: 0,
        currency: 'SEK', line_description: 'Småinköp', project: null, cost_center: null, sort_order: 0,
        journal_entries: {
          id: 'e2', voucher_number: 2, voucher_series: 'A',
          entry_date: '2026-03-16', description: 'Reseutlägg',
          source_type: 'bank_transaction', status: 'posted',
        },
      },
    ]
    const { supabase } = makeEntryLinesMock(lines)

    const result = (await tool.execute(
      { account_from: '4000', account_to: '4999', amount_min: 1000, limit: 100 },
      'company-1',
      'user-1',
      supabase,
    )) as {
      lines: { line_id: string }[]
      totals: { debit: number; credit: number; net: number }
      totals_scope: string
      truncated: boolean
      total_lines: number
      returned_lines: number
      db_matched_pre_amount_filter: number | null
    }

    // amount_min: 1000 should filter out the 50-line
    expect(result.returned_lines).toBe(1)
    expect(result.lines[0].line_id).toBe('l1')
    expect(result.totals.debit).toBe(5000)
    expect(result.totals.credit).toBe(0)
    expect(result.totals.net).toBe(5000)
    // Non-text path: totals come from the full-match aggregate pass.
    expect(result.totals_scope).toBe('full_match')
    expect(result.total_lines).toBe(1)
    expect(result.db_matched_pre_amount_filter).toBe(2)
  })

  it('caps accounts list at 50', async () => {
    const tool = tools.find((t) => t.name === 'gnubok_query_journal')!
    const supabase = makeChainMock([], 0)
    const accounts = Array.from({ length: 51 }, (_, i) => String(1000 + i))

    await expect(
      tool.execute({ accounts }, 'company-1', 'user-1', supabase),
    ).rejects.toThrow(/capped at 50/)
  })

  it('marks truncated=true and computes totals over the FULL match set when the slice is capped', async () => {
    // Regression for the slice-totals bug: the returned lines are capped at
    // `limit`, but totals/total_lines must cover ALL matching lines
    // (totals_scope='full_match'). One two-step fetch feeds both: the full
    // match set is sorted and sliced in JS for the display window.
    const tool = tools.find((t) => t.name === 'gnubok_query_journal')!
    const fullMatchSet = [
      makeLineRow({ id: 'l1', account_number: '1930', debit_amount: 100 }),
      makeLineRow({ id: 'l2', account_number: '1930', debit_amount: 200 }),
      makeLineRow({ id: 'l3', account_number: '1930', debit_amount: 300 }),
    ]

    const { supabase, tables } = makeEntryLinesMock(fullMatchSet)

    const result = (await tool.execute(
      { accounts: ['1930'], limit: 1 },
      'company-1',
      'user-1',
      supabase,
    )) as {
      truncated: boolean
      total_lines: number
      returned_lines: number
      totals: { debit: number; credit: number; net: number }
      totals_scope: string
    }

    // Entry side first, then the lines: no query starts on
    // journal_entry_lines with the tenant scope hidden in an embed.
    expect(tables).toEqual(['journal_entries', 'journal_entry_lines'])
    expect(result.truncated).toBe(true)
    expect(result.total_lines).toBe(3)
    expect(result.returned_lines).toBe(1)
    expect(result.totals).toEqual({ debit: 600, credit: 0, net: 600 })
    expect(result.totals_scope).toBe('full_match')
  })

  it('rejects group_by + group_by_dimension together', async () => {
    const tool = tools.find((t) => t.name === 'gnubok_query_journal')!
    const supabase = makeChainMock([], 0)

    await expect(
      tool.execute(
        { group_by: 'account_number', group_by_dimension: '6' },
        'company-1',
        'user-1',
        supabase,
      ),
    ).rejects.toThrow(/either group_by or group_by_dimension/)
  })

  it('group_by buckets the full match set and sorts by |net| descending', async () => {
    const tool = tools.find((t) => t.name === 'gnubok_query_journal')!
    const rows = [
      makeLineRow({ id: 'l1', account_number: '4010', debit_amount: 100 }),
      makeLineRow({ id: 'l2', account_number: '4010', debit_amount: 50 }),
      makeLineRow({ id: 'l3', account_number: '5010', debit_amount: 0, credit_amount: 30 }),
    ]
    // One two-step fetch feeds both the display slice and the aggregate.
    const { supabase } = makeEntryLinesMock(rows)

    const result = (await tool.execute(
      { group_by: 'account_number', limit: 100 },
      'company-1',
      'user-1',
      supabase,
    )) as {
      groups: Array<{ key: string; debit: number; credit: number; net: number; line_count: number }>
      totals_scope: string
      applied_filters: { group_by: string | null; group_by_dimension: string | null }
    }

    expect(result.totals_scope).toBe('full_match')
    expect(result.groups).toEqual([
      { key: '4010', debit: 150, credit: 0, net: 150, line_count: 2 },
      { key: '5010', debit: 0, credit: 30, net: -30, line_count: 1 },
    ])
    expect(result.applied_filters.group_by).toBe('account_number')
    expect(result.applied_filters.group_by_dimension).toBeNull()
  })

  it('group_by_dimension buckets by the dimensions jsonb with an untagged fallback', async () => {
    const tool = tools.find((t) => t.name === 'gnubok_query_journal')!
    const rows = [
      { ...makeLineRow({ id: 'l1', account_number: '4010', debit_amount: 100 }), dimensions: { '6': 'P001' } },
      { ...makeLineRow({ id: 'l2', account_number: '4011', debit_amount: 50 }), dimensions: { '6': 'P001', '1': 'KS01' } },
      { ...makeLineRow({ id: 'l3', account_number: '5010', debit_amount: 0, credit_amount: 30 }), dimensions: null },
    ]
    const { supabase } = makeEntryLinesMock(rows)

    const result = (await tool.execute(
      { group_by_dimension: '6', limit: 100 },
      'company-1',
      'user-1',
      supabase,
    )) as {
      groups: Array<{ key: string; debit: number; credit: number; net: number; line_count: number }>
      totals_scope: string
      applied_filters: { group_by: string | null; group_by_dimension: string | null }
    }

    expect(result.totals_scope).toBe('full_match')
    expect(result.groups).toEqual([
      { key: 'P001', debit: 150, credit: 0, net: 150, line_count: 2 },
      { key: '(utan dimension)', debit: 0, credit: 30, net: -30, line_count: 1 },
    ])
    expect(result.applied_filters.group_by_dimension).toBe('6')
  })

  it('include_dimensions returns each line\'s bag with an empty-object fallback', async () => {
    const tool = tools.find((t) => t.name === 'gnubok_query_journal')!
    const rows = [
      { ...makeLineRow({ id: 'l1', account_number: '4010', debit_amount: 100 }), dimensions: { '6': 'P001' } },
      { ...makeLineRow({ id: 'l2', account_number: '5010', debit_amount: 50 }), dimensions: null },
    ]
    const { supabase } = makeEntryLinesMock(rows)

    const result = (await tool.execute(
      { include_dimensions: true, limit: 100 },
      'company-1',
      'user-1',
      supabase,
    )) as { lines: Array<{ line_id: string; dimensions?: Record<string, string> }> }

    const byId = new Map(result.lines.map((l) => [l.line_id, l]))
    expect(byId.get('l1')?.dimensions).toEqual({ '6': 'P001' })
    expect(byId.get('l2')?.dimensions).toEqual({})
  })

  it('omits the dimensions key from lines by default (width guard)', async () => {
    const tool = tools.find((t) => t.name === 'gnubok_query_journal')!
    const rows = [
      { ...makeLineRow({ id: 'l1', account_number: '4010', debit_amount: 100 }), dimensions: { '6': 'P001' } },
    ]
    const { supabase } = makeEntryLinesMock(rows)

    const result = (await tool.execute(
      { limit: 100 },
      'company-1',
      'user-1',
      supabase,
    )) as { lines: Array<Record<string, unknown>> }

    expect(result.lines[0]).not.toHaveProperty('dimensions')
  })

  it('applies the dimensions bag filter via jsonb containment and echoes it', async () => {
    const tool = tools.find((t) => t.name === 'gnubok_query_journal')!
    // Table-aware chain mock recording .contains calls: company_settings
    // (resolver, dimensions disabled → free-text passthrough), then the
    // two-step entry-lines fetch.
    const containsCalls: Array<{ column: string; value: unknown }> = []
    const row = { ...makeLineRow({ id: 'l1', debit_amount: 100 }), dimensions: { '6': 'P001' } }
    const entryParent = row.journal_entries
    const bareLine = { ...row, journal_entries: undefined, journal_entry_id: entryParent.id }
    const chain = (data: unknown): unknown =>
      new Proxy(
        {},
        {
          get(_t, prop) {
            if (prop === 'then') {
              return (resolve: (v: unknown) => void) =>
                resolve({ data, error: null, count: Array.isArray(data) ? data.length : null })
            }
            if (prop === 'range') return () => ({ data, error: null, count: Array.isArray(data) ? data.length : null })
            if (prop === 'contains') {
              return (column: string, value: unknown) => {
                containsCalls.push({ column, value })
                return chain(data)
              }
            }
            return () => chain(data)
          },
        },
      )
    const supabase = {
      from: vi.fn().mockImplementation((table: string) => {
        if (table === 'company_settings') return chain({ dimensions_enabled: false })
        if (table === 'journal_entries') return chain([entryParent])
        return chain([bareLine])
      }),
    } as never

    const result = (await tool.execute(
      { dimensions: { '6': 'P001' }, limit: 100 },
      'company-1',
      'user-1',
      supabase,
    )) as {
      dimension_filter?: Record<string, string>
      applied_filters: { dimensions: Record<string, string> | null }
      lines: Array<{ line_id: string }>
    }

    expect(containsCalls).toContainEqual({ column: 'dimensions', value: { '6': 'P001' } })
    expect(result.dimension_filter).toEqual({ '6': 'P001' })
    expect(result.applied_filters.dimensions).toEqual({ '6': 'P001' })
    expect(result.lines).toHaveLength(1)
  })

  it('rejects a non-numeric group_by_dimension', async () => {
    const tool = tools.find((t) => t.name === 'gnubok_query_journal')!
    const supabase = makeChainMock([], 0)

    await expect(
      tool.execute({ group_by_dimension: 'projekt' }, 'company-1', 'user-1', supabase),
    ).rejects.toThrow(/positive SIE dimension number/)
  })
})

describe('gnubok_query_journal: amount filter vs limit', () => {
  it('applies the amount filter before the display slice so `limit` returns matching lines', async () => {
    // Old behaviour sliced the first `limit` rows and THEN dropped the ones
    // failing amount_min, so limit=1 could return zero lines while matches
    // existed. Now the full match set is filtered first.
    const tool = tools.find((t) => t.name === 'gnubok_query_journal')!
    const rows = [
      makeLineRow({ id: 'l1', debit_amount: 50, voucher_number: 3 }),
      makeLineRow({ id: 'l2', debit_amount: 5000, voucher_number: 2 }),
      makeLineRow({ id: 'l3', debit_amount: 6000, voucher_number: 1 }),
    ]
    const { supabase } = makeEntryLinesMock(rows)

    const result = (await tool.execute(
      { amount_min: 1000, limit: 1 },
      'company-1',
      'user-1',
      supabase,
    )) as {
      lines: Array<{ line_id: string }>
      returned_lines: number
      total_lines: number
      truncated: boolean
      db_matched_pre_amount_filter: number | null
    }

    expect(result.returned_lines).toBe(1)
    expect(result.lines[0].line_id).toBe('l2')
    expect(result.total_lines).toBe(2)
    expect(result.truncated).toBe(true)
    expect(result.db_matched_pre_amount_filter).toBe(3)
  })
})

describe('gnubok_query_journal: free-text search', () => {
  it('merges results from the entry-description leg and the line-description leg', async () => {
    const tool = tools.find((t) => t.name === 'gnubok_query_journal')!
    const byLineHit = makeLineRow({
      id: 'L1',
      line_description: 'GOOGLE*CLOUD EMEA',
      entry_description: 'Bank kostnad',
      entry_date: '2026-05-10',
      voucher_number: 42,
    })
    const byEntryHit = makeLineRow({
      id: 'L2',
      line_description: null,
      entry_description: 'Google Workspace månadsavgift',
      entry_date: '2026-05-12',
      voucher_number: 43,
    })
    const noise = makeLineRow({
      id: 'L3',
      line_description: 'Hyra maj',
      entry_description: 'Lokalhyra',
      entry_date: '2026-05-01',
      voucher_number: 40,
    })

    const { supabase, entryQueries, lineQueries } = makeTwoStepTextMock([byLineHit, byEntryHit, noise])

    const result = (await tool.execute(
      { text: 'Google', limit: 50 },
      'company-1',
      'user-1',
      supabase,
    )) as { lines: Array<{ line_id: string }>; returned_lines: number; total_lines: number; totals_scope: string }

    // Two legs, each a two-step fetch: two entry-side queries, and one line
    // chunk per leg (both legs found at least one entry in scope).
    expect(entryQueries()).toHaveLength(2)
    expect(lineQueries()).toHaveLength(2)
    expect(result.returned_lines).toBe(2)
    expect(result.total_lines).toBe(2)
    // Newest first.
    expect(result.lines.map((l) => l.line_id)).toEqual(['L2', 'L1'])
    // Free-text search now aggregates the full match set like every other path.
    expect(result.totals_scope).toBe('full_match')
  })

  it('deduplicates a line hit by both legs', async () => {
    const tool = tools.find((t) => t.name === 'gnubok_query_journal')!
    const dupHit = makeLineRow({
      id: 'LDUP',
      line_description: 'Google Cloud',
      entry_description: 'Google Cloud invoice',
      entry_date: '2026-05-15',
      voucher_number: 100,
    })

    const { supabase } = makeTwoStepTextMock([dupHit])

    const result = (await tool.execute(
      { text: 'Google', limit: 50 },
      'company-1',
      'user-1',
      supabase,
    )) as { lines: Array<{ line_id: string }>; returned_lines: number; total_lines: number; truncated: boolean }

    expect(result.returned_lines).toBe(1)
    expect(result.total_lines).toBe(1)
    expect(result.truncated).toBe(false)
    expect(result.lines[0].line_id).toBe('LDUP')
  })

  it('never queries journal_entry_lines through a journal_entries embed', async () => {
    // The `journal_entries!inner(...)` embed compiled to a correlated LATERAL
    // join over every tenant's lines (statement timeouts in production).
    // Both legs must drive from journal_entries and hit lines by parent id.
    const tool = tools.find((t) => t.name === 'gnubok_query_journal')!
    const { supabase, queries, lineQueries } = makeTwoStepTextMock([
      makeLineRow({ id: 'L1', line_description: 'Google Cloud' }),
    ])
    const selects: string[] = []
    const originalFrom = (supabase as { from: (t: string) => unknown }).from
    ;(supabase as { from: unknown }).from = vi.fn().mockImplementation((table: string) => {
      const chain = originalFrom(table) as Record<string, (...a: unknown[]) => unknown>
      return new Proxy(chain, {
        get(target, prop) {
          if (prop === 'select') {
            return (cols: string) => {
              selects.push(cols)
              return target.select(cols)
            }
          }
          return target[prop as string]
        },
      })
    })

    await tool.execute({ text: 'Google', limit: 50 }, 'company-1', 'user-1', supabase)

    expect(queries.length).toBeGreaterThan(0)
    expect(selects.length).toBe(queries.length)
    expect(selects.some((s) => s.includes('journal_entries!inner'))).toBe(false)
    for (const q of lineQueries()) {
      expect(q.filters.some((f) => f.op === 'in' && f.column === 'journal_entry_id')).toBe(true)
    }
  })

  it('issues .ilike on journal_entries.description (entry side) and journal_entry_lines.line_description (line side) with the escaped pattern', async () => {
    const tool = tools.find((t) => t.name === 'gnubok_query_journal')!
    const { supabase, ilikeCalls } = makeTwoStepTextMock([
      makeLineRow({ id: 'L1', line_description: 'x', entry_description: 'y' }),
    ])

    await tool.execute({ text: 'Google', limit: 50 }, 'company-1', 'user-1', supabase)

    const calls = ilikeCalls()
    expect(calls.filter((c) => c.table === 'journal_entries' && c.column === 'description')).toHaveLength(1)
    expect(calls.filter((c) => c.table === 'journal_entry_lines' && c.column === 'line_description')).toHaveLength(1)
    expect(calls.every((c) => c.pattern === '%Google%')).toBe(true)
  })

  it('escapes LIKE wildcards (% and _) in the search pattern', async () => {
    const tool = tools.find((t) => t.name === 'gnubok_query_journal')!
    const { supabase, ilikeCalls } = makeTwoStepTextMock([
      makeLineRow({ id: 'L1', line_description: 'x', entry_description: 'y' }),
    ])

    await tool.execute({ text: '2_441%foo', limit: 50 }, 'company-1', 'user-1', supabase)

    // Both legs see the same escaped pattern.
    const patterns = new Set(ilikeCalls().map((c) => c.pattern))
    expect(patterns.size).toBe(1)
    expect([...patterns][0]).toBe('%2\\_441\\%foo%')
  })

  it('escapes a literal backslash so it does not swallow the next character', async () => {
    // `\` is LIKE's own escape character. Before this was handled, a search for
    // `a\b` reached Postgres as `%a\b%`, where `\b` means "literal b", so the
    // filter silently matched rows containing `ab` and missed the ones the user
    // actually asked for. Flagged by CodeQL as js/incomplete-sanitization.
    const tool = tools.find((t) => t.name === 'gnubok_query_journal')!
    const { supabase, ilikeCalls } = makeTwoStepTextMock([
      makeLineRow({ id: 'L1', line_description: 'x', entry_description: 'y' }),
    ])

    await tool.execute({ text: 'a\\b', limit: 50 }, 'company-1', 'user-1', supabase)

    const patterns = new Set(ilikeCalls().map((c) => c.pattern))
    expect(patterns.size).toBe(1)
    expect([...patterns][0]).toBe('%a\\\\b%')
  })

  it('escapes backslash before the wildcard rules, not after', async () => {
    // Order matters: escaping `\` last would also double the backslashes the
    // % / _ rules just introduced, turning `50%` into `50\\%` (a literal
    // backslash followed by a wildcard) instead of `50\%` (a literal percent).
    const tool = tools.find((t) => t.name === 'gnubok_query_journal')!
    const { supabase, ilikeCalls } = makeTwoStepTextMock([
      makeLineRow({ id: 'L1', line_description: 'x', entry_description: 'y' }),
    ])

    await tool.execute({ text: '50%', limit: 50 }, 'company-1', 'user-1', supabase)

    expect(ilikeCalls()[0].pattern).toBe('%50\\%%')
  })

  it('computes totals, total_lines and truncated over the FULL text match set', async () => {
    // The per-leg window (legLimit/legCapHit) is gone: both legs pull their
    // whole match set, so the text path reports exact counts and totals and
    // `truncated` is simply "more matches than returned".
    const tool = tools.find((t) => t.name === 'gnubok_query_journal')!
    const rows = [
      makeLineRow({ id: 'L1', line_description: 'Google a', debit_amount: 100, entry_date: '2026-05-10', voucher_number: 4 }),
      makeLineRow({ id: 'L2', line_description: 'Google b', debit_amount: 200, entry_date: '2026-05-09', voucher_number: 3 }),
      makeLineRow({ id: 'L3', line_description: null, entry_description: 'Google c', debit_amount: 300, entry_date: '2026-05-08', voucher_number: 2 }),
      makeLineRow({ id: 'L4', line_description: null, entry_description: 'Google d', debit_amount: 400, entry_date: '2026-05-07', voucher_number: 1 }),
      makeLineRow({ id: 'L5', line_description: 'Hyra', entry_description: 'Hyra', debit_amount: 9999, entry_date: '2026-05-06', voucher_number: 0 }),
    ]
    const { supabase } = makeTwoStepTextMock(rows)

    const result = (await tool.execute(
      { text: 'Google', limit: 2 },
      'company-1',
      'user-1',
      supabase,
    )) as {
      lines: Array<{ line_id: string }>
      returned_lines: number
      total_lines: number
      truncated: boolean
      totals: { debit: number; credit: number; net: number }
      totals_scope: string
    }

    expect(result.returned_lines).toBe(2)
    expect(result.lines.map((l) => l.line_id)).toEqual(['L1', 'L2'])
    expect(result.total_lines).toBe(4)
    expect(result.truncated).toBe(true)
    expect(result.totals).toEqual({ debit: 1000, credit: 0, net: 1000 })
    expect(result.totals_scope).toBe('full_match')
  })

  it('scopes BOTH legs to the caller company_id on the entry side (tenant isolation)', async () => {
    // Defence-in-depth against a future refactor that drops
    // .eq('company_id', companyId) from one leg's entry query. RLS would
    // still block cross-tenant reads, but losing the app-level filter would
    // mean a wider scan than intended.
    const tool = tools.find((t) => t.name === 'gnubok_query_journal')!
    const { supabase, entryQueries } = makeTwoStepTextMock([
      makeLineRow({ id: 'L1', line_description: 'Google' }),
    ])

    await tool.execute({ text: 'Google', limit: 50 }, 'company-xyz', 'user-1', supabase)

    const legs = entryQueries()
    expect(legs).toHaveLength(2)
    for (const leg of legs) {
      expect(
        leg.filters.some((f) => f.op === 'eq' && f.column === 'company_id' && f.value === 'company-xyz'),
      ).toBe(true)
    }
  })

  it('applies date_from/date_to on the entry side of both legs and excludes out-of-range matches', async () => {
    const tool = tools.find((t) => t.name === 'gnubok_query_journal')!
    const rows = [
      makeLineRow({ id: 'IN1', line_description: 'DLE Sverige', entry_date: '2026-03-15', voucher_number: 2 }),
      makeLineRow({ id: 'IN2', entry_description: 'DLE faktura', entry_date: '2026-03-20', voucher_number: 3 }),
      makeLineRow({ id: 'OUT1', line_description: 'DLE Sverige', entry_date: '2025-11-02', voucher_number: 1 }),
      makeLineRow({ id: 'OUT2', entry_description: 'DLE faktura', entry_date: '2026-07-01', voucher_number: 9 }),
    ]
    const { supabase, entryQueries } = makeTwoStepTextMock(rows)

    const result = (await tool.execute(
      { text: 'DLE', date_from: '2026-01-01', date_to: '2026-06-30', limit: 50 },
      'company-1',
      'user-1',
      supabase,
    )) as { lines: Array<{ line_id: string }>; total_lines: number }

    for (const leg of entryQueries()) {
      expect(leg.filters).toEqual(
        expect.arrayContaining([
          { op: 'gte', column: 'entry_date', value: '2026-01-01' },
          { op: 'lte', column: 'entry_date', value: '2026-06-30' },
        ]),
      )
    }
    expect(result.total_lines).toBe(2)
    expect(result.lines.map((l) => l.line_id).sort()).toEqual(['IN1', 'IN2'])
  })

  it('rejects text longer than 200 characters', async () => {
    const tool = tools.find((t) => t.name === 'gnubok_query_journal')!
    const { supabase } = makeTwoStepTextMock([])
    const oversized = 'x'.repeat(201)

    await expect(
      tool.execute({ text: oversized, limit: 50 }, 'company-1', 'user-1', supabase),
    ).rejects.toThrow(/200 characters or shorter/)
  })

  it('does not surface raw PostgREST error text on text-search failure', async () => {
    const tool = tools.find((t) => t.name === 'gnubok_query_journal')!
    const { supabase } = makeTwoStepTextMock(
      [makeLineRow({ id: 'L1', line_description: 'Google' })],
      { failLinesWith: 'relation "journal_entries" does not exist in schema "private_internal"' },
    )

    const thrown = await tool
      .execute({ text: 'Google', limit: 50 }, 'company-1', 'user-1', supabase)
      .then(() => null, (e: unknown) => e as Error & { code?: string })
    expect(thrown).toBeInstanceOf(Error)
    expect(thrown!.message).toMatch(/Database error while running text search/)
    // The schema-leak text never reaches the caller, and a non-transient
    // failure carries no retry hint.
    expect(thrown!.message).not.toMatch(/private_internal/)
    expect(thrown!.code).toBeUndefined()
  })

  it('surfaces a statement timeout as a retryable TRANSIENT_ERROR instead of a generic failure', async () => {
    // Production symptom: SQLSTATE 57014 on the text legs reached the agent
    // as UNKNOWN_ERROR / "Något gick fel". The sanitised error must still
    // carry the transient code so the structured-error layer maps it to the
    // retryable envelope, and tell the agent how to narrow the query.
    const tool = tools.find((t) => t.name === 'gnubok_query_journal')!
    const { supabase } = makeTwoStepTextMock(
      [makeLineRow({ id: 'L1', line_description: 'Google' })],
      { failLinesWith: 'canceling statement due to statement timeout' },
    )

    const thrown = await tool
      .execute({ text: 'Google', limit: 50 }, 'company-1', 'user-1', supabase)
      .then(() => null, (e: unknown) => e as Error & { code?: string })
    expect(thrown).toBeInstanceOf(Error)
    expect(thrown!.code).toBe('TRANSIENT_ERROR')
    expect(thrown!.message).toMatch(/Database error while running text search/)
    expect(thrown!.message).toMatch(/date_from\/date_to/)
    expect(thrown!.message).not.toMatch(/canceling statement/)

    const structured = getStructuredError(thrown)
    expect(structured.code).toBe('TRANSIENT_ERROR')
    expect(structured.retryable).toBe(true)
  })
})
