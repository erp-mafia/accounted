/**
 * Unit tests for gnubok_query_journal.
 *
 * Verifies tool registration, the post-fetch amount filter, the full-match
 * aggregate pass (totals/groups over ALL matching lines via fetchAllRows,
 * totals_scope='full_match'), and the slice-scoped free-text path
 * (totals_scope='returned_slice'). The supabase query-builder chain is
 * exercised by the live MCP smoke test; here we check the result-shape
 * pipeline.
 */
import { describe, it, expect, vi } from 'vitest'
import { tools } from '../server'
import { TOOL_SCOPE_MAP } from '@/lib/auth/api-keys'

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

/**
 * Richer mock for the text-search path: returns queued results across
 * successive .from() calls and records every .ilike(column, pattern) call so
 * tests can assert what was actually sent to PostgREST.
 *
 * The text branch issues TWO parallel .from('journal_entry_lines') queries:
 * one filtered by line_description, one by journal_entries.description. The
 * first .from() call gets `results[0]`, the second gets `results[1]`.
 */
function makeQueueMock(results: Array<{ data: unknown[]; count: number }>) {
  const ilikeCalls: Array<{ column: string; pattern: string }> = []
  // Each entry is one leg's recorded .eq calls. Index lines up with
  // .from() invocation order, so tests can assert per-leg tenant scoping.
  const eqCallsByLeg: Array<Array<{ column: string; value: unknown }>> = []
  let callIndex = 0

  const buildChain = (
    result: { data: unknown[]; error: null; count: number },
    legEqCalls: Array<{ column: string; value: unknown }>,
  ): unknown => {
    return new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === 'then') {
            return (resolve: (v: unknown) => void) => resolve(result)
          }
          if (prop === 'ilike') {
            return (column: string, pattern: string) => {
              ilikeCalls.push({ column, pattern })
              return buildChain(result, legEqCalls)
            }
          }
          if (prop === 'eq') {
            return (column: string, value: unknown) => {
              legEqCalls.push({ column, value })
              return buildChain(result, legEqCalls)
            }
          }
          return () => buildChain(result, legEqCalls)
        },
      },
    )
  }

  const supabase = {
    from: vi.fn().mockImplementation(() => {
      const next = results[callIndex] ?? { data: [], count: 0 }
      callIndex += 1
      const legEqCalls: Array<{ column: string; value: unknown }> = []
      eqCallsByLeg.push(legEqCalls)
      return buildChain({ data: next.data, error: null, count: next.count }, legEqCalls)
    }),
  } as never

  return { supabase, ilikeCalls, eqCallsByLeg, callCount: () => callIndex }
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

describe('gnubok_query_journal: free-text search', () => {
  it('merges non-overlapping results from line_description and journal_entries.description', async () => {
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

    const { supabase, callCount } = makeQueueMock([
      { data: [byLineHit], count: 1 },
      { data: [byEntryHit], count: 1 },
    ])

    const result = (await tool.execute(
      { text: 'Google', limit: 50 },
      'company-1',
      'user-1',
      supabase,
    )) as { lines: Array<{ line_id: string }>; returned_lines: number; totals_scope: string }

    expect(callCount()).toBe(2)
    expect(result.returned_lines).toBe(2)
    const ids = result.lines.map((l) => l.line_id).sort()
    expect(ids).toEqual(['L1', 'L2'])
    // Free-text path never runs the full aggregate pass: the output says so.
    expect(result.totals_scope).toBe('returned_slice')
  })

  it('deduplicates rows returned by both query legs', async () => {
    const tool = tools.find((t) => t.name === 'gnubok_query_journal')!
    const dupHit = makeLineRow({
      id: 'LDUP',
      line_description: 'Google Cloud',
      entry_description: 'Google Cloud invoice',
      entry_date: '2026-05-15',
      voucher_number: 100,
    })

    const { supabase } = makeQueueMock([
      { data: [dupHit], count: 1 },
      { data: [dupHit], count: 1 },
    ])

    const result = (await tool.execute(
      { text: 'Google', limit: 50 },
      'company-1',
      'user-1',
      supabase,
    )) as { lines: Array<{ line_id: string }>; returned_lines: number }

    expect(result.returned_lines).toBe(1)
    expect(result.lines[0].line_id).toBe('LDUP')
  })

  it('issues .ilike against both line_description and journal_entries.description with escaped pattern', async () => {
    const tool = tools.find((t) => t.name === 'gnubok_query_journal')!
    const { supabase, ilikeCalls } = makeQueueMock([
      { data: [], count: 0 },
      { data: [], count: 0 },
    ])

    await tool.execute(
      { text: 'Google', limit: 50 },
      'company-1',
      'user-1',
      supabase,
    )

    const columns = ilikeCalls.map((c) => c.column).sort()
    expect(columns).toEqual(['journal_entries.description', 'line_description'])
    expect(ilikeCalls.every((c) => c.pattern === '%Google%')).toBe(true)
  })

  it('escapes LIKE wildcards (% and _) in the search pattern', async () => {
    const tool = tools.find((t) => t.name === 'gnubok_query_journal')!
    const { supabase, ilikeCalls } = makeQueueMock([
      { data: [], count: 0 },
      { data: [], count: 0 },
    ])

    await tool.execute(
      { text: '2_441%foo', limit: 50 },
      'company-1',
      'user-1',
      supabase,
    )

    // Both legs see the same escaped pattern.
    expect(new Set(ilikeCalls.map((c) => c.pattern)).size).toBe(1)
    expect(ilikeCalls[0].pattern).toBe('%2\\_441\\%foo%')
  })

  it('escapes a literal backslash so it does not swallow the next character', async () => {
    // `\` is LIKE's own escape character. Before this was handled, a search for
    // `a\b` reached Postgres as `%a\b%`, where `\b` means "literal b", so the
    // filter silently matched rows containing `ab` and missed the ones the user
    // actually asked for. Flagged by CodeQL as js/incomplete-sanitization.
    const tool = tools.find((t) => t.name === 'gnubok_query_journal')!
    const { supabase, ilikeCalls } = makeQueueMock([
      { data: [], count: 0 },
      { data: [], count: 0 },
    ])

    await tool.execute({ text: 'a\\b', limit: 50 }, 'company-1', 'user-1', supabase)

    expect(new Set(ilikeCalls.map((c) => c.pattern)).size).toBe(1)
    expect(ilikeCalls[0].pattern).toBe('%a\\\\b%')
  })

  it('escapes backslash before the wildcard rules, not after', async () => {
    // Order matters: escaping `\` last would also double the backslashes the
    // % / _ rules just introduced, turning `50%` into `50\\%` (a literal
    // backslash followed by a wildcard) instead of `50\%` (a literal percent).
    const tool = tools.find((t) => t.name === 'gnubok_query_journal')!
    const { supabase, ilikeCalls } = makeQueueMock([
      { data: [], count: 0 },
      { data: [], count: 0 },
    ])

    await tool.execute({ text: '50%', limit: 50 }, 'company-1', 'user-1', supabase)

    expect(ilikeCalls[0].pattern).toBe('%50\\%%')
  })

  it('does NOT flag truncated when an overlap row is hit by both legs and merged set fits limit', async () => {
    // Greptile / Compliance V2.3 regression: previously, dbMatched = sum of
    // leg counts and a row matching both legs would inflate the count and
    // force truncated=true even though every distinct match was returned.
    const tool = tools.find((t) => t.name === 'gnubok_query_journal')!
    const dupHit = makeLineRow({
      id: 'LDUP',
      line_description: 'Google Cloud',
      entry_description: 'Google Cloud invoice',
    })

    const { supabase } = makeQueueMock([
      { data: [dupHit], count: 1 },
      { data: [dupHit], count: 1 },
    ])

    const result = (await tool.execute(
      { text: 'Google', limit: 50 },
      'company-1',
      'user-1',
      supabase,
    )) as { lines: unknown[]; truncated: boolean; total_lines: number; returned_lines: number }

    expect(result.returned_lines).toBe(1)
    expect(result.total_lines).toBe(1)
    expect(result.truncated).toBe(false)
  })

  it('flags truncated when a leg fills its per-leg fetch window', async () => {
    // Per-leg cap is limit*2. With limit=2 → legLimit=4. Returning 4 rows on
    // one leg signals "this leg's window filled, more may exist DB-side".
    const tool = tools.find((t) => t.name === 'gnubok_query_journal')!
    const fullLeg = [
      makeLineRow({ id: 'L1', entry_date: '2026-05-10', voucher_number: 4 }),
      makeLineRow({ id: 'L2', entry_date: '2026-05-09', voucher_number: 3 }),
      makeLineRow({ id: 'L3', entry_date: '2026-05-08', voucher_number: 2 }),
      makeLineRow({ id: 'L4', entry_date: '2026-05-07', voucher_number: 1 }),
    ]

    const { supabase } = makeQueueMock([
      { data: fullLeg, count: 4 },
      { data: [], count: 0 },
    ])

    const result = (await tool.execute(
      { text: 'Google', limit: 2 },
      'company-1',
      'user-1',
      supabase,
    )) as { returned_lines: number; truncated: boolean }

    expect(result.returned_lines).toBe(2)
    expect(result.truncated).toBe(true)
  })

  it('scopes BOTH parallel legs to the caller company_id (tenant isolation)', async () => {
    // Defence-in-depth against a future refactor that splits the legs and
    // accidentally drops .eq('journal_entries.company_id', companyId) from
    // one of them. RLS would still block cross-tenant reads, but losing the
    // app-level filter would mean a wider scan than intended.
    const tool = tools.find((t) => t.name === 'gnubok_query_journal')!
    const { supabase, eqCallsByLeg, callCount } = makeQueueMock([
      { data: [], count: 0 },
      { data: [], count: 0 },
    ])

    await tool.execute(
      { text: 'Google', limit: 50 },
      'company-xyz',
      'user-1',
      supabase,
    )

    expect(callCount()).toBe(2)
    for (const legEqs of eqCallsByLeg) {
      const scoped = legEqs.some(
        (c) => c.column === 'journal_entries.company_id' && c.value === 'company-xyz',
      )
      expect(scoped).toBe(true)
    }
  })

  it('rejects text longer than 200 characters', async () => {
    const tool = tools.find((t) => t.name === 'gnubok_query_journal')!
    const { supabase } = makeQueueMock([])
    const oversized = 'x'.repeat(201)

    await expect(
      tool.execute({ text: oversized, limit: 50 }, 'company-1', 'user-1', supabase),
    ).rejects.toThrow(/200 characters or shorter/)
  })

  it('does not surface raw PostgREST error text on text-search failure', async () => {
    const tool = tools.find((t) => t.name === 'gnubok_query_journal')!

    // Custom mock that returns an error from the first leg.
    const supabase = {
      from: vi.fn().mockImplementation(() => {
        const result = {
          data: null,
          error: { message: 'relation "journal_entries" does not exist in schema "private_internal"' },
          count: null,
        }
        const buildChain = (): unknown =>
          new Proxy(
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
        return buildChain()
      }),
    } as never

    await expect(
      tool.execute({ text: 'Google', limit: 50 }, 'company-1', 'user-1', supabase),
    ).rejects.toThrow(/Database error while running text search/)

    // And the schema-leak text never reaches the caller.
    await expect(
      tool.execute({ text: 'Google', limit: 50 }, 'company-1', 'user-1', supabase),
    ).rejects.not.toThrow(/private_internal/)
  })
})

/**
 * Hosts don't always enforce inputSchema, so `accounts` arrives as a bare
 * number or string in the wild. Before the normalizer, `accounts: 1630`
 * silently dropped the filter (a number has no `.length`) while
 * applied_filters still echoed it, and `accounts: "1630"` was spread into its
 * digits by `.in()`. Record every `.in()` call on journal_entry_lines so the
 * assertion is on the actual predicate, not just the echo.
 */
function makeRecordingEntryLinesMock() {
  const inCalls: Array<{ table: string; column: string; values: unknown }> = []
  // One parent entry so the two-step fetch actually issues the lines query
  // (fetchEntryLines short-circuits on zero entries); the lines page is empty.
  const rowsFor = (table: string) =>
    table === 'journal_entries'
      ? [{ id: 'je-1', entry_date: '2026-01-15', voucher_series: 'A', voucher_number: 1, status: 'posted' }]
      : []
  const chain = (table: string): unknown =>
    new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === 'then') {
            return (resolve: (v: unknown) => void) =>
              resolve({ data: rowsFor(table), error: null, count: rowsFor(table).length })
          }
          if (prop === 'range') return () => ({ data: rowsFor(table), error: null, count: rowsFor(table).length })
          if (prop === 'in') {
            return (column: string, values: unknown) => {
              inCalls.push({ table, column, values })
              return chain(table)
            }
          }
          return () => chain(table)
        },
      },
    )
  const supabase = { from: vi.fn().mockImplementation((table: string) => chain(table)) } as never
  return { supabase, inCalls }
}

describe('gnubok_query_journal: accounts argument normalization', () => {
  const tool = () => tools.find((t) => t.name === 'gnubok_query_journal')!
  const lineAccountFilters = (calls: Array<{ table: string; column: string; values: unknown }>) =>
    calls.filter((c) => c.table === 'journal_entry_lines' && c.column === 'account_number')

  it('applies a bare number `accounts: 1630` as ["1630"] and echoes the normalized value', async () => {
    const { supabase, inCalls } = makeRecordingEntryLinesMock()
    const result = (await tool().execute(
      { accounts: 1630 },
      'company-1', 'user-1', supabase,
    )) as { applied_filters: { accounts: unknown } }

    const filters = lineAccountFilters(inCalls)
    expect(filters.length).toBeGreaterThan(0)
    for (const f of filters) expect(f.values).toEqual(['1630'])
    expect(result.applied_filters.accounts).toEqual(['1630'])
  })

  it('applies a bare string `accounts: "1630"` as ["1630"], not as its digits', async () => {
    const { supabase, inCalls } = makeRecordingEntryLinesMock()
    await tool().execute({ accounts: '1630' }, 'company-1', 'user-1', supabase)
    const filters = lineAccountFilters(inCalls)
    expect(filters.length).toBeGreaterThan(0)
    for (const f of filters) expect(f.values).toEqual(['1630'])
  })

  it('accepts a comma-separated string and integer array items', async () => {
    const { supabase, inCalls } = makeRecordingEntryLinesMock()
    await tool().execute({ accounts: '1930, 1940' }, 'company-1', 'user-1', supabase)
    expect(lineAccountFilters(inCalls)[0]?.values).toEqual(['1930', '1940'])

    const second = makeRecordingEntryLinesMock()
    await tool().execute({ accounts: [1930, '1940'] }, 'company-1', 'user-1', second.supabase)
    expect(lineAccountFilters(second.inCalls)[0]?.values).toEqual(['1930', '1940'])
  })

  it('rejects non-account values instead of dropping the filter', async () => {
    const { supabase } = makeRecordingEntryLinesMock()
    await expect(
      tool().execute({ accounts: 'kontorsmaterial' }, 'company-1', 'user-1', supabase),
    ).rejects.toThrow(/accounts must be an account number/)
    await expect(
      tool().execute({ account_from: 4000 as unknown as string, account_to: { x: 1 } }, 'company-1', 'user-1', supabase),
    ).rejects.toThrow(/account_to must be an account number/)
  })

  it('still caps accounts at 50 after normalization', async () => {
    const { supabase } = makeRecordingEntryLinesMock()
    const accounts = Array.from({ length: 51 }, (_, i) => 1000 + i).join(',')
    await expect(
      tool().execute({ accounts }, 'company-1', 'user-1', supabase),
    ).rejects.toThrow(/capped at 50/)
  })
})
