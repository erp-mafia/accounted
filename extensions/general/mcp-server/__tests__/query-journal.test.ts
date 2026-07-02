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

describe('gnubok_query_journal — registration', () => {
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
 * Richer mock for the text-search path: returns queued results across
 * successive .from() calls and records every .ilike(column, pattern) call so
 * tests can assert what was actually sent to PostgREST.
 *
 * The text branch issues TWO parallel .from('journal_entry_lines') queries —
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

/** Build a LineRow fixture inline — keeps the per-test data dense and readable. */
function makeLineRow(opts: {
  id: string
  account_number?: string
  debit_amount?: number
  credit_amount?: number
  line_description?: string | null
  entry_description?: string
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
      source_type: 'bank_transaction',
      status: 'posted',
    },
  }
}

describe('gnubok_query_journal — execute', () => {
  it('applies amount_min filter and computes totals on the filtered set', async () => {
    const tool = tools.find((t) => t.name === 'gnubok_query_journal')!
    const lines = [
      // Line 1: large debit — should pass amount_min: 1000
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
      // Line 2: small debit — should fail amount_min: 1000
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
    const supabase = makeChainMock(lines, 2)

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
    // Regression for the slice-totals bug: the display query is capped at
    // `limit`, but totals/total_lines must come from the fetchAllRows
    // aggregate pass over ALL matching lines (totals_scope='full_match').
    const tool = tools.find((t) => t.name === 'gnubok_query_journal')!
    const displaySlice = [makeLineRow({ id: 'l1', account_number: '1930', debit_amount: 100 })]
    const fullMatchSet = [
      makeLineRow({ id: 'l1', account_number: '1930', debit_amount: 100 }),
      makeLineRow({ id: 'l2', account_number: '1930', debit_amount: 200 }),
      makeLineRow({ id: 'l3', account_number: '1930', debit_amount: 300 }),
    ]

    // .from() call order: display query first, then the aggregate pass
    // (single page — 3 rows < PAGE_SIZE ends the fetchAllRows loop).
    const { supabase, callCount } = makeQueueMock([
      { data: displaySlice, count: 1 },
      { data: fullMatchSet, count: 3 },
    ])

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

    expect(callCount()).toBe(2)
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
    // makeChainMock feeds the SAME rows to display + aggregate passes.
    const supabase = makeChainMock(rows, 3)

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
    const supabase = makeChainMock(rows, 3)

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

  it('rejects a non-numeric group_by_dimension', async () => {
    const tool = tools.find((t) => t.name === 'gnubok_query_journal')!
    const supabase = makeChainMock([], 0)

    await expect(
      tool.execute({ group_by_dimension: 'projekt' }, 'company-1', 'user-1', supabase),
    ).rejects.toThrow(/positive SIE dimension number/)
  })
})

describe('gnubok_query_journal — free-text search', () => {
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
    // Free-text path never runs the full aggregate pass — the output says so.
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
