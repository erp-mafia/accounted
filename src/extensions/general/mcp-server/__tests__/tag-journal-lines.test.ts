/**
 * Dimensions PR6: gnubok_tag_journal_lines (bulk retag staging) tests.
 *
 * Covers registration (scope map, strict schema, staged-operation output
 * contract via deriveToolMeta), the filter gates (no filters / 0 matches /
 * >500 matches), the staging happy paths (free-text passthrough +
 * registry name resolution), and the period locks: the preview counts the
 * matched lines an approval can tag apart from the ones it will leave, and
 * says why (crm#1908). Executor-side coverage
 * (commitRetagLineDimensions incl. partial failure) lives in
 * lib/pending-operations/__tests__/retag-line-dimensions-executor.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { TOOL_SCOPE_MAP } from '@/lib/auth/api-keys'
import { tools, deriveToolMeta } from '../server'

const tagJournalLines = tools.find((t) => t.name === 'gnubok_tag_journal_lines')!

beforeEach(() => {
  vi.clearAllMocks()
})

function makeLineRow(i: number, overrides: Record<string, unknown> = {}) {
  return {
    // Real UUID shape: the staged params are re-validated against
    // RetagLineDimensionsParamsSchema (line_ids must be UUIDs) before insert.
    id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    account_number: '4010',
    debit_amount: 250,
    credit_amount: 0,
    sort_order: 1,
    journal_entries: {
      id: `je-${i}`,
      entry_date: '2024-03-01',
      voucher_number: i,
      voucher_series: 'A',
      status: 'posted',
      company_id: 'company-1',
    },
    ...overrides,
  }
}

/** No company lock date: what the lock check reads when nothing is locked. */
const NO_LOCK_DATE = { data: { bookkeeping_locked_through: null }, error: null }

/**
 * Enqueue the two pages the two-step entry-lines fetch reads
 * (lib/bookkeeping/entry-lines.ts): the parent entries first, then the bare
 * lines keyed by journal_entry_id. Fixtures stay embed-shaped; the helper
 * reattaches the parent under `journal_entries`, so the tool sees exactly
 * what the old `journal_entries!inner` embed produced.
 *
 * Then the lock state the tool reads for the matched lines
 * (lib/dimensions/retag-lock.ts): the company lock date, and the periods
 * when a matched verifikat names one.
 */
function enqueueMatchedLines(
  enqueue: (result: { data?: unknown; error?: unknown }) => void,
  rows: ReturnType<typeof makeLineRow>[],
  locks: { lockThrough?: string | null; periods?: unknown[] } = {},
) {
  const entries = [
    ...new Map(rows.map((r) => [r.journal_entries.id, r.journal_entries])).values(),
  ]
  enqueue({ data: entries, error: null })
  enqueue({
    data: rows.map(({ journal_entries: parent, ...line }) => ({
      ...line,
      journal_entry_id: parent.id,
    })),
    error: null,
  })
  enqueue({ data: { bookkeeping_locked_through: locks.lockThrough ?? null }, error: null })
  if (entries.some((entry) => 'fiscal_period_id' in entry)) enqueue({ data: locks.periods ?? [], error: null })
}

/** A matched line whose verifikat sits in the given fiscal period on the given date. */
function makeLineIn(i: number, period: string, date: string) {
  const row = makeLineRow(i)
  return { ...row, journal_entries: { ...row.journal_entries, entry_date: date, fiscal_period_id: period } }
}

const PERIOD_2023 = { id: 'period-2023', is_closed: true, locked_at: '2024-02-01T00:00:00Z' }
const PERIOD_2024 = { id: 'period-2024', is_closed: false, locked_at: null }
const PERIOD_CLOSED_SV = 'Perioden är stängd: använd rättelseverifikat (storno) för att ändra dimensioner.'

// ── Registration + contracts ─────────────────────────────────────────────────

describe('gnubok_tag_journal_lines registration', () => {
  it('exists, is scoped bookkeeping:write, and keeps a strict input schema', () => {
    expect(tagJournalLines).toBeDefined()
    expect(TOOL_SCOPE_MAP.gnubok_tag_journal_lines).toBe('bookkeeping:write')
    expect((tagJournalLines.inputSchema as { additionalProperties?: boolean }).additionalProperties).toBe(false)
    expect(tagJournalLines.description.length).toBeLessThanOrEqual(280)
    expect(tagJournalLines.description).toMatch(/stag(e|ing)/i)
  })

  it('uses the staged-operation output schema so the _meta staging contract derives', () => {
    // deriveToolMeta keys off reference identity with STAGED_OPERATION_SCHEMA:
    // a defined meta proves the tool shares THE schema, not a lookalike copy.
    const meta = deriveToolMeta(tagJournalLines)
    expect(meta).toBeDefined()
    expect(meta?.requires_approval).toBe(true)
    expect(meta?.approve_tool).toBe('gnubok_approve_pending_operation')
    const schema = tagJournalLines.outputSchema as { required?: string[] }
    expect(schema?.required).toContain('staged')
  })
})

// ── Filter gates ─────────────────────────────────────────────────────────────

describe('gnubok_tag_journal_lines: filter gates', () => {
  it('rejects an empty filter block before any DB work', async () => {
    const { supabase } = createQueuedMockSupabase()
    await expect(
      tagJournalLines.execute(
        { dimensions: { '6': 'P01' }, reason: 'Retro-taggning', filters: {} },
        'company-1',
        'user-1',
        supabase as never,
      ),
    ).rejects.toThrow(/minst ett filter/)
    expect(supabase.from).not.toHaveBeenCalled()
    expect(supabase.rpc).not.toHaveBeenCalled()
  })

  it('rejects an invalid dimensions bag before any DB work', async () => {
    const { supabase } = createQueuedMockSupabase()
    await expect(
      tagJournalLines.execute(
        { dimensions: { '0': 'X' }, reason: 'Retro-taggning', filters: { accounts: ['4010'] } },
        'company-1',
        'user-1',
        supabase as never,
      ),
    ).rejects.toThrow(/Invalid dimensions/)
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('throws a helpful error when no posted lines match', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { dimensions_enabled: false }, error: null }) // resolveDimensionBags passthrough
    enqueue({ data: [], error: null }) // entry match query, empty: no line query runs

    await expect(
      tagJournalLines.execute(
        { dimensions: { '6': 'P01' }, reason: 'Retro-taggning', filters: { accounts: ['4010'] } },
        'company-1',
        'user-1',
        supabase as never,
      ),
    ).rejects.toThrow(/Inga bokförda rader matchade filtret[\s\S]*gnubok_query_journal/)
  })

  it('rejects non-account filter values instead of silently widening the retag scope', async () => {
    // Hosts don't always enforce inputSchema. A mangled account filter on a
    // bulk WRITE path must fail fast, never fall through to "no account
    // filter" and retag more lines than asked.
    const { supabase } = createQueuedMockSupabase()
    await expect(
      tagJournalLines.execute(
        { dimensions: { '6': 'P01' }, reason: 'Retro-taggning', filters: { accounts: 'kontorsmaterial' } },
        'company-1',
        'user-1',
        supabase as never,
      ),
    ).rejects.toThrow(/accounts must be an account number/)
    await expect(
      tagJournalLines.execute(
        { dimensions: { '6': 'P01' }, reason: 'Retro-taggning', filters: { account_from: { x: 1 } } },
        'company-1',
        'user-1',
        supabase as never,
      ),
    ).rejects.toThrow(/filters\.account_from must be an account number/)
  })

  it('accepts a bare number for filters.accounts and applies it as a filter', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { dimensions_enabled: false }, error: null })
    enqueue({ data: [], error: null }) // entry match query runs, so normalization passed
    await expect(
      tagJournalLines.execute(
        { dimensions: { '6': 'P01' }, reason: 'Retro-taggning', filters: { accounts: 4010 } },
        'company-1',
        'user-1',
        supabase as never,
      ),
    ).rejects.toThrow(/Inga bokförda rader matchade filtret/)
  })

  it('throws asking to narrow the filter when more than 500 lines match', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { dimensions_enabled: false }, error: null })
    enqueueMatchedLines(enqueue, Array.from({ length: 501 }, (_, i) => makeLineRow(i)))

    await expect(
      tagJournalLines.execute(
        { dimensions: { '6': 'P01' }, reason: 'Retro-taggning', filters: { account_from: '4000', account_to: '4999' } },
        'company-1',
        'user-1',
        supabase as never,
      ),
    ).rejects.toThrow(/fler än 500 rader/)

    const insertCalls = (supabase.from as ReturnType<typeof vi.fn>).mock.calls
    expect(insertCalls.some((args) => args[0] === 'pending_operations')).toBe(false)
  })

  it('stops fetching line chunks as soon as the cap is exceeded (no full-ledger walk)', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { dimensions_enabled: false }, error: null })
    // 300 matching entries → 3 line chunks of up to 100 entry ids each. The
    // FIRST chunk alone already returns 501 lines (past RETAG_MAX_LINES), so
    // chunks 2-3 must never be fetched: the outcome is decided.
    enqueue({
      data: Array.from({ length: 300 }, (_, i) => ({
        id: `je-${i}`,
        entry_date: '2024-03-01',
        voucher_number: i,
        voucher_series: 'A',
        status: 'posted',
      })),
      error: null,
    })
    enqueue({
      data: Array.from({ length: 501 }, (_, i) => ({
        id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
        journal_entry_id: `je-${i % 300}`,
        account_number: '4010',
        debit_amount: 250,
        credit_amount: 0,
        sort_order: 1,
      })),
      error: null,
    })

    await expect(
      tagJournalLines.execute(
        { dimensions: { '6': 'P01' }, reason: 'Retro-taggning', filters: { only_untagged: true } },
        'company-1',
        'user-1',
        supabase as never,
      ),
    ).rejects.toThrow(/fler än 500 rader/)

    const fromCalls = (supabase.from as ReturnType<typeof vi.fn>).mock.calls
    // Exactly one journal_entry_lines query ran: the overflow short-circuits
    // before the second and third chunks.
    expect(fromCalls.filter((args) => args[0] === 'journal_entry_lines')).toHaveLength(1)
    expect(fromCalls.some((args) => args[0] === 'pending_operations')).toBe(false)
  })
})

// ── Staging ──────────────────────────────────────────────────────────────────

describe('gnubok_tag_journal_lines: staging', () => {
  it('stages a retag_line_dimensions op with matched line_ids + preview sample', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { dimensions_enabled: false }, error: null }) // passthrough (free-text era)
    enqueueMatchedLines(enqueue, [makeLineRow(1), makeLineRow(2)]) // line match query
    enqueue({ data: { id: 'op-retag-1' }, error: null }) // pending_operations insert

    const result = (await tagJournalLines.execute(
      {
        dimensions: { '6': 'P01' },
        reason: 'Retro-taggning av Bygg AB-projektet',
        filters: { accounts: ['4010'], date_from: '2024-01-01', date_to: '2024-12-31', text: 'Bygg AB' },
      },
      'company-1',
      'user-1',
      supabase as never,
      { type: 'api_key' },
    )) as {
      staged: boolean
      operation_id?: string
      risk_level: string
      preview: {
        matched_lines: number
        dimensions: Record<string, string>
        filter_summary: string
        sample: Array<{ account: string; date: string; debit: number; credit: number }>
      }
    }

    expect(result.staged).toBe(true)
    expect(result.operation_id).toBe('op-retag-1')
    expect(result.risk_level).toBe('medium')
    expect(result.preview.matched_lines).toBe(2)
    expect(result.preview.dimensions).toEqual({ '6': 'P01' })
    expect(result.preview.filter_summary).toMatch(/konto 4010/)
    expect(result.preview.filter_summary).toMatch(/datum 2024-01-01-2024-12-31/)
    expect(result.preview.filter_summary).toMatch(/text "Bygg AB"/)
    expect(result.preview.sample).toEqual([
      { account: '4010', date: '2024-03-01', debit: 250, credit: 0, dimensions_before: {}, dimensions_after: { '6': 'P01' } },
      { account: '4010', date: '2024-03-01', debit: 250, credit: 0, dimensions_before: {}, dimensions_after: { '6': 'P01' } },
    ])

    const insertCalls = (supabase.from as ReturnType<typeof vi.fn>).mock.calls
    expect(insertCalls.some((args) => args[0] === 'pending_operations')).toBe(true)
  })

  it('merges by default: keeps each line\'s other dimensions, stages mode merge and previews every resulting bag', async () => {
    // Regression: the tool replaced the whole bag, so tagging projekt on a
    // line that carried a kostnadsställe silently wiped the kostnadsställe,
    // while the dashboard workbench merges.
    const { supabase, enqueue, findCall } = createQueuedMockSupabase()
    enqueue({ data: { dimensions_enabled: false }, error: null })
    enqueueMatchedLines(enqueue, [
      makeLineRow(1, { dimensions: { '1': 'KS01' } }),
      makeLineRow(2, { dimensions: {} }),
      makeLineRow(3, { dimensions: { '6': 'P01' } }),
    ])
    enqueue({ data: { id: 'op-retag-merge' }, error: null }) // pending_operations insert

    const result = (await tagJournalLines.execute(
      { dimensions: { '6': 'P01' }, reason: 'Projektet saknas', filters: { accounts: ['4010'] } },
      'company-1',
      'user-1',
      supabase as never,
    )) as {
      staged: boolean
      preview: {
        mode: string
        resulting_dimensions: Record<string, number>
        unchanged_lines: number
        sample: Array<{ dimensions_before: Record<string, string>; dimensions_after: Record<string, string> }>
      }
    }

    expect(result.staged).toBe(true)
    expect(result.preview.mode).toBe('merge')
    expect(result.preview.resulting_dimensions).toEqual({ '1=KS01, 6=P01': 1, '6=P01': 2 })
    expect(result.preview.unchanged_lines).toBe(1)
    const line1 = result.preview.sample.find((s) => s.dimensions_before['1'] === 'KS01')!
    expect(line1.dimensions_after).toEqual({ '1': 'KS01', '6': 'P01' })

    const insert = findCall('pending_operations', 'insert')?.[0] as { title: string; params: Record<string, unknown> }
    expect(insert.params).toMatchObject({ mode: 'merge', dimensions: { '6': 'P01' } })
    expect(insert.title).toBe('Tagga om 3 verifikationsrader: 6=P01')
  })

  it('replace is explicit: stages mode replace and previews the bag as exactly the pairs', async () => {
    const { supabase, enqueue, findCall } = createQueuedMockSupabase()
    enqueue({ data: { dimensions_enabled: false }, error: null })
    enqueueMatchedLines(enqueue, [makeLineRow(1, { dimensions: { '1': 'KS01', '6': 'P99' } })])
    enqueue({ data: [], error: null }) // account_dimension_rules: a replace may remove a dimension, none is required
    enqueue({ data: { id: 'op-retag-replace' }, error: null }) // pending_operations insert

    const result = (await tagJournalLines.execute(
      { dimensions: { '6': 'P01' }, mode: 'replace', reason: 'Städa fantomkoder', filters: { accounts: ['4010'] } },
      'company-1',
      'user-1',
      supabase as never,
    )) as { preview: { mode: string; resulting_dimensions: Record<string, number>; will: string } }

    expect(result.preview.mode).toBe('replace')
    expect(result.preview.resulting_dimensions).toEqual({ '6=P01': 1 })
    expect(result.preview.will).toMatch(/^replace the dimensions bag/)
    const insert = findCall('pending_operations', 'insert')?.[0] as { title: string; params: Record<string, unknown> }
    expect(insert.params).toMatchObject({ mode: 'replace' })
    expect(insert.title).toBe('Ersätt dimensionerna på 1 verifikationsrader: 6=P01')
  })

  // crm#1313: the agent could not take a project tag off its bank lines:
  // {} and {"6":""} were both refused.
  it('an empty code removes that dimension: stages it, previews the line without it and keeps the others', async () => {
    const { supabase, enqueue, findCall } = createQueuedMockSupabase()
    // No name to resolve, so no registry read.
    enqueueMatchedLines(enqueue, [
      makeLineRow(1, { account_number: '1930', dimensions: { '1': 'KS01', '6': 'P01' } }),
      makeLineRow(2, { account_number: '1930', dimensions: { '6': 'P01' } }),
    ])
    enqueue({ data: [], error: null }) // account_dimension_rules: none required
    enqueue({ data: { id: 'op-retag-remove' }, error: null }) // pending_operations insert

    const result = (await tagJournalLines.execute(
      { dimensions: { '6': '' }, reason: 'Projekt hör inte till bankraden', filters: { accounts: ['1930'] } },
      'company-1',
      'user-1',
      supabase as never,
    )) as { staged: boolean; preview: { mode: string; resulting_dimensions: Record<string, number> } }

    expect(result.staged).toBe(true)
    expect(result.preview.mode).toBe('merge')
    expect(result.preview.resulting_dimensions).toEqual({ '1=KS01': 1, 'inga dimensioner': 1 })
    const insert = findCall('pending_operations', 'insert')?.[0] as { title: string; params: Record<string, unknown> }
    expect(insert.params).toMatchObject({ mode: 'merge', dimensions: { '6': '' } })
    expect(insert.title).toBe('Tagga om 2 verifikationsrader: 6 tas bort')
  })

  it('refuses before staging to take off a dimension the account requires', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueueMatchedLines(enqueue, [makeLineRow(1, { dimensions: { '6': 'P01' } })])
    enqueue({
      data: [{ account_number: '4010', rule_type: 'required', dimensions: { sie_dim_no: 6, name: 'Projekt' }, dimension_values: null }],
      error: null,
    })

    await expect(
      tagJournalLines.execute(
        { dimensions: { '6': '' }, reason: 'Rensa projekt', filters: { accounts: ['4010'] } },
        'company-1',
        'user-1',
        supabase as never,
      ),
    ).rejects.toThrow(/Konto 4010 kräver Projekt/)
    expect((supabase.from as ReturnType<typeof vi.fn>).mock.calls.some((c) => c[0] === 'pending_operations')).toBe(false)
  })

  it('still refuses a bag without any pair, and says how to remove one', async () => {
    const { supabase } = createQueuedMockSupabase()
    await expect(
      tagJournalLines.execute(
        { dimensions: {}, mode: 'replace', reason: 'Rensa allt', filters: { accounts: ['1930'] } },
        'company-1',
        'user-1',
        supabase as never,
      ),
    ).rejects.toThrow(/"" removes that dimension/)
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('rejects a mode that is neither merge nor replace before any DB work', async () => {
    const { supabase } = createQueuedMockSupabase()
    await expect(
      tagJournalLines.execute(
        { dimensions: { '6': 'P01' }, mode: 'append', reason: 'Retro-taggning', filters: { accounts: ['4010'] } },
        'company-1',
        'user-1',
        supabase as never,
      ),
    ).rejects.toThrow(/mode must be 'merge'/)
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('resolves dimension names to registry codes and echoes the resolution', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    // resolveDimensionBags (enabled): settings → ensure rpc → dimensions → values
    enqueue({ data: { dimensions_enabled: true }, error: null })
    enqueue({ data: null, error: null }) // ensure_company_dimensions rpc
    enqueue({
      data: [
        { id: 'dim-6', sie_dim_no: 6, name: 'Projekt', resets_annually: false, is_system: true, is_active: true, sort_order: 20 },
      ],
      error: null,
    })
    enqueue({
      data: [
        { id: 'v1', dimension_id: 'dim-6', code: 'P001', name: 'Villa Almgren takrenovering', is_active: true, start_date: null, end_date: null },
      ],
      error: null,
    })
    enqueueMatchedLines(enqueue, [makeLineRow(1)]) // line match query
    enqueue({ data: { id: 'op-retag-2' }, error: null }) // pending_operations insert

    const result = (await tagJournalLines.execute(
      {
        dimensions: { '6': 'villa almgren tak' },
        reason: 'Retro-taggning',
        filters: { accounts: ['4010'], only_untagged: true },
      },
      'company-1',
      'user-1',
      supabase as never,
    )) as {
      staged: boolean
      preview: {
        dimensions: Record<string, string>
        filter_summary: string
        dimension_resolutions?: Array<{ dimension: number; input: string; resolved_code: string }>
      }
    }

    expect(result.staged).toBe(true)
    // The staged bag carries the resolved registry CODE, never the raw name.
    expect(result.preview.dimensions).toEqual({ '6': 'P001' })
    expect(result.preview.filter_summary).toMatch(/endast otaggade rader/)
    expect(result.preview.dimension_resolutions).toHaveLength(1)
    expect(result.preview.dimension_resolutions![0]).toMatchObject({
      dimension: 6,
      input: 'villa almgren tak',
      resolved_code: 'P001',
    })
    expect((supabase.rpc as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe('ensure_company_dimensions')
  })

  it('rejects before staging when a name has no registry match (no auto-create)', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { dimensions_enabled: true }, error: null })
    enqueue({ data: null, error: null }) // ensure rpc
    enqueue({
      data: [
        { id: 'dim-6', sie_dim_no: 6, name: 'Projekt', resets_annually: false, is_system: true, is_active: true, sort_order: 20 },
      ],
      error: null,
    })
    enqueue({
      data: [
        { id: 'v1', dimension_id: 'dim-6', code: 'P001', name: 'Villa Almgren', is_active: true, start_date: null, end_date: null },
      ],
      error: null,
    })

    await expect(
      tagJournalLines.execute(
        { dimensions: { '6': 'Bryggeriet ombyggnad' }, reason: 'Retro-taggning', filters: { accounts: ['4010'] } },
        'company-1',
        'user-1',
        supabase as never,
      ),
    ).rejects.toThrow(/Okänt projekt[\s\S]*gnubok_create_dimension_value/)

    const insertCalls = (supabase.from as ReturnType<typeof vi.fn>).mock.calls
    expect(insertCalls.some((args) => args[0] === 'pending_operations')).toBe(false)
  })

  it('walks multiple entry pages: a full first page continues, and entries on later pages still match', async () => {
    // Regression target: the two-step fetch pages journal_entries with
    // .range() while filtering already-seen ids client-side (seenEntryIds).
    // This pins the interaction: a FULL first page (exactly ENTRY_PAGE_SIZE
    // rows) must not end the walk, an overlapping row on the next page (as a
    // shifted range can produce) must be dropped exactly once, and a genuinely
    // new entry on that page must survive the dedup and contribute its lines.
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { dimensions_enabled: false }, error: null })

    const entry = (i: number) => ({
      id: `je-${i}`,
      entry_date: '2024-03-01',
      voucher_number: i,
      voucher_series: 'A',
      status: 'posted',
    })
    const bareLine = (i: number, journalEntryId: string, account: string) => ({
      id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
      journal_entry_id: journalEntryId,
      account_number: account,
      debit_amount: 250,
      credit_amount: 0,
      sort_order: 1,
    })

    // Page 1: exactly ENTRY_PAGE_SIZE (1000) entries, so the loop must fetch
    // a second page. 1000 entries → 10 line chunks of 100 ids; only the first
    // chunk has a matching line.
    enqueue({ data: Array.from({ length: 1000 }, (_, i) => entry(i)), error: null })
    enqueue({ data: [bareLine(1, 'je-0', '4010')], error: null })
    for (let c = 1; c < 10; c++) enqueue({ data: [], error: null })

    // Page 2 overlaps page 1 (je-999 returned again) and carries one new
    // entry. The duplicate is skipped; the new entry gets its own line chunk.
    enqueue({ data: [entry(999), entry(1000)], error: null })
    enqueue({ data: [bareLine(2, 'je-1000', '5010')], error: null })

    enqueue(NO_LOCK_DATE) // company_settings: the lock check
    enqueue({ data: { id: 'op-paging-1' }, error: null }) // pending_operations insert

    const result = (await tagJournalLines.execute(
      { dimensions: { '6': 'P01' }, reason: 'Retro-taggning', filters: { only_untagged: true } },
      'company-1',
      'user-1',
      supabase as never,
    )) as {
      staged: boolean
      preview: { matched_lines: number; sample: Array<{ account: string }> }
    }

    expect(result.staged).toBe(true)
    // Both pages contributed: nothing on the far side of the page boundary
    // was silently dropped by the dedup.
    expect(result.preview.matched_lines).toBe(2)
    const sampleAccounts = result.preview.sample.map((s) => s.account)
    expect(sampleAccounts).toContain('4010') // line from page 1 (je-0)
    expect(sampleAccounts).toContain('5010') // line from page 2 (je-1000)

    const fromCalls = (supabase.from as ReturnType<typeof vi.fn>).mock.calls
    // Exactly two entry pages were read (the loop terminated on the short
    // second page) and 11 line chunks ran: 10 for page 1, ONE for page 2:
    // the overlapping je-999 was deduped, so only je-1000 needed lines.
    expect(fromCalls.filter((args) => args[0] === 'journal_entries')).toHaveLength(2)
    expect(fromCalls.filter((args) => args[0] === 'journal_entry_lines')).toHaveLength(11)
  })

  it('terminates when the match count is an exact multiple of the entry page size', async () => {
    // 1000 matches exactly: the raw first page is full, so the loop probes a
    // second page, finds it empty, and must stop instead of spinning (the
    // termination check reads the RAW page length, before dedup).
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { dimensions_enabled: false }, error: null })

    enqueue({
      data: Array.from({ length: 1000 }, (_, i) => ({
        id: `je-${i}`,
        entry_date: '2024-03-01',
        voucher_number: i,
        voucher_series: 'A',
        status: 'posted',
      })),
      error: null,
    })
    enqueue({
      data: [
        {
          id: '00000000-0000-4000-8000-000000000001',
          journal_entry_id: 'je-0',
          account_number: '4010',
          debit_amount: 250,
          credit_amount: 0,
          sort_order: 1,
        },
      ],
      error: null,
    })
    for (let c = 1; c < 10; c++) enqueue({ data: [], error: null })
    enqueue({ data: [], error: null }) // page 2: empty, ends the walk
    enqueue(NO_LOCK_DATE) // company_settings: the lock check
    enqueue({ data: { id: 'op-paging-2' }, error: null }) // pending_operations insert

    const result = (await tagJournalLines.execute(
      { dimensions: { '6': 'P01' }, reason: 'Retro-taggning', filters: { only_untagged: true } },
      'company-1',
      'user-1',
      supabase as never,
    )) as { staged: boolean; preview: { matched_lines: number } }

    expect(result.staged).toBe(true)
    expect(result.preview.matched_lines).toBe(1)
    const fromCalls = (supabase.from as ReturnType<typeof vi.fn>).mock.calls
    expect(fromCalls.filter((args) => args[0] === 'journal_entries')).toHaveLength(2)
  })

  it('dry_run previews the match without inserting a pending operation', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { dimensions_enabled: false }, error: null })
    enqueueMatchedLines(enqueue, [makeLineRow(1)]) // line match query

    const result = (await tagJournalLines.execute(
      {
        dimensions: { '6': 'P01' },
        reason: 'Retro-taggning',
        filters: { accounts: ['4010'] },
        dry_run: true,
      },
      'company-1',
      'user-1',
      supabase as never,
    )) as { staged: boolean; dry_run?: boolean; preview: { matched_lines: number } }

    expect(result.staged).toBe(false)
    expect(result.dry_run).toBe(true)
    expect(result.preview.matched_lines).toBe(1)
    const insertCalls = (supabase.from as ReturnType<typeof vi.fn>).mock.calls
    expect(insertCalls.some((args) => args[0] === 'pending_operations')).toBe(false)
  })
})

// ── Period locks (crm#1908) ──────────────────────────────────────────────────

describe('gnubok_tag_journal_lines: lines behind a period lock', () => {
  type LockPreview = {
    matched_lines: number
    taggable_lines: number
    blocked_lines: number
    blocked_by_reason?: Array<{ reason: string; lines: number; message: string; date_from?: string; date_to?: string }>
    resulting_dimensions: Record<string, number>
    unchanged_lines: number
    compliance_warning?: string
    will: string
    sample: Array<{ date: string; dimensions_after: Record<string, string>; blocked?: string }>
  }
  const args = { dimensions: { '6': 'P01' }, reason: 'Projektet saknades', filters: { text: 'kampanj' } }

  // The report: a filter matched lines on both sides of a year end. The
  // preview said every matched line would be tagged; the approval tagged the
  // open year only.
  const acrossYearEnd = () => [
    makeLineIn(1, 'period-2023', '2023-12-20'),
    makeLineIn(2, 'period-2023', '2023-11-03'),
    makeLineIn(3, 'period-2024', '2024-01-15'),
  ]

  it('counts the lines an approval can tag apart from the ones in a closed year, and says why', async () => {
    const { supabase, enqueue, findCall } = createQueuedMockSupabase()
    enqueue({ data: { dimensions_enabled: false }, error: null })
    enqueueMatchedLines(enqueue, acrossYearEnd(), { periods: [PERIOD_2023, PERIOD_2024] })
    enqueue({ data: { id: 'op-retag-locks' }, error: null }) // pending_operations insert

    const result = (await tagJournalLines.execute(args, 'company-1', 'user-1', supabase as never)) as {
      staged: boolean
      message: string
      preview: LockPreview
    }

    expect(result.staged).toBe(true)
    expect(result.preview).toMatchObject({ matched_lines: 3, taggable_lines: 1, blocked_lines: 2 })
    expect(result.preview.blocked_by_reason).toEqual([
      { reason: 'period_closed', lines: 2, message: PERIOD_CLOSED_SV, date_from: '2023-11-03', date_to: '2023-12-20' },
    ])
    // What the approval produces counts the line it can tag, not the match.
    expect(result.preview.resulting_dimensions).toEqual({ '6=P01': 1 })
    expect(result.preview.will).toMatch(/on the 1 matched POSTED lines that can be tagged/)
    expect(result.preview.will).toMatch(/the 2 lines in blocked_by_reason sit behind a period lock/)
    // A blocked sample line is marked and keeps the bag it has.
    const closedLine = result.preview.sample.find((line) => line.date === '2023-12-20')!
    expect(closedLine).toMatchObject({ blocked: 'period_closed', dimensions_after: {} })
    const openLine = result.preview.sample.find((line) => line.date === '2024-01-15')!
    expect(openLine).not.toHaveProperty('blocked')
    expect(openLine.dimensions_after).toEqual({ '6': 'P01' })

    // The agent reads it in the staging message, the approver on the row.
    const warning = `2 av 3 matchade rader kan inte taggas om och lämnas som de är: 2 rader (2023-11-03 till 2023-12-20): ${PERIOD_CLOSED_SV}`
    expect(result.message).toContain(`WARNING: ${warning}`)
    expect(result.preview.compliance_warning).toBe(warning)

    const insert = findCall('pending_operations', 'insert')?.[0] as {
      title: string
      params: { line_ids: string[] }
      preview_data: LockPreview
    }
    expect(insert.title).toBe('Tagga om 1 av 3 verifikationsrader: 6=P01')
    expect(insert.preview_data.compliance_warning).toBe(warning)
    // Every matched line is staged: the approval asks the lock check again.
    expect(insert.params.line_ids).toHaveLength(3)
  })

  it('a dry run answers the same counts and stages nothing', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { dimensions_enabled: false }, error: null })
    enqueueMatchedLines(enqueue, acrossYearEnd(), { periods: [PERIOD_2023, PERIOD_2024] })

    const result = (await tagJournalLines.execute({ ...args, dry_run: true }, 'company-1', 'user-1', supabase as never)) as {
      staged: boolean
      dry_run?: boolean
      message: string
      preview: LockPreview
    }

    expect(result.staged).toBe(false)
    expect(result.dry_run).toBe(true)
    expect(result.preview).toMatchObject({ matched_lines: 3, taggable_lines: 1, blocked_lines: 2 })
    expect(result.preview.blocked_by_reason).toMatchObject([{ reason: 'period_closed', lines: 2 }])
    expect(result.message).toMatch(/WARNING: 2 av 3 matchade rader kan inte taggas om/)
    expect((supabase.from as ReturnType<typeof vi.fn>).mock.calls.some((c) => c[0] === 'pending_operations')).toBe(false)
  })

  it('names each lock by its own reason: a locked period and the company lock date', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { dimensions_enabled: false }, error: null })
    enqueueMatchedLines(
      enqueue,
      [
        makeLineIn(1, 'period-locked', '2023-06-10'),
        makeLineIn(2, 'period-2024', '2024-01-15'),
        makeLineIn(3, 'period-2024', '2024-02-20'),
      ],
      {
        lockThrough: '2024-01-31',
        periods: [{ id: 'period-locked', is_closed: false, locked_at: '2023-08-01T00:00:00Z' }, PERIOD_2024],
      },
    )
    enqueue({ data: { id: 'op-retag-reasons' }, error: null }) // pending_operations insert

    const result = (await tagJournalLines.execute(args, 'company-1', 'user-1', supabase as never)) as { preview: LockPreview }

    expect(result.preview).toMatchObject({ matched_lines: 3, taggable_lines: 1, blocked_lines: 2 })
    // Newest first, as the preview orders the match. The period's own lock is
    // the reason given for a line that is also behind the lock date.
    expect(result.preview.blocked_by_reason).toEqual([
      {
        reason: 'company_lock_date',
        lines: 1,
        message: 'Bokföringen är låst t.o.m. 2024-01-31: använd rättelseverifikat (storno).',
        date_from: '2024-01-15',
        date_to: '2024-01-15',
      },
      {
        reason: 'period_locked',
        lines: 1,
        message: 'Perioden är låst: använd rättelseverifikat (storno) för att ändra dimensioner.',
        date_from: '2023-06-10',
        date_to: '2023-06-10',
      },
    ])
  })

  it('says nothing about locks when every matched line can be tagged', async () => {
    const { supabase, enqueue, findCall } = createQueuedMockSupabase()
    enqueue({ data: { dimensions_enabled: false }, error: null })
    enqueueMatchedLines(enqueue, [makeLineIn(1, 'period-2024', '2024-01-15'), makeLineIn(2, 'period-2024', '2024-02-20')], {
      periods: [PERIOD_2024],
    })
    enqueue({ data: { id: 'op-retag-open' }, error: null }) // pending_operations insert

    const result = (await tagJournalLines.execute(args, 'company-1', 'user-1', supabase as never)) as {
      message: string
      preview: LockPreview
    }

    expect(result.preview).toMatchObject({ matched_lines: 2, taggable_lines: 2, blocked_lines: 0 })
    expect(result.preview).not.toHaveProperty('blocked_by_reason')
    expect(result.preview).not.toHaveProperty('compliance_warning')
    expect(result.message).not.toMatch(/WARNING/)
    expect(result.preview.will).toMatch(/on every matched POSTED line/)
    const insert = findCall('pending_operations', 'insert')?.[0] as { title: string }
    expect(insert.title).toBe('Tagga om 2 verifikationsrader: 6=P01')
  })

  it('refuses to stage when no matched line can be tagged, with the reason', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { dimensions_enabled: false }, error: null })
    enqueueMatchedLines(enqueue, [makeLineIn(1, 'period-2023', '2023-12-20'), makeLineIn(2, 'period-2023', '2023-11-03')], {
      periods: [PERIOD_2023],
    })

    await expect(tagJournalLines.execute(args, 'company-1', 'user-1', supabase as never)).rejects.toThrow(
      /Ingen av de 2 matchade raderna kan taggas om: 2 rader \(2023-11-03 till 2023-12-20\): Perioden är stängd/,
    )
    expect((supabase.from as ReturnType<typeof vi.fn>).mock.calls.some((c) => c[0] === 'pending_operations')).toBe(false)
  })

  it('stages nothing when the period locks cannot be read', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { dimensions_enabled: false }, error: null })
    const rows = [makeLineIn(1, 'period-2024', '2024-01-15')]
    enqueue({ data: rows.map((r) => r.journal_entries), error: null })
    enqueue({ data: rows.map(({ journal_entries: parent, ...line }) => ({ ...line, journal_entry_id: parent.id })), error: null })
    enqueue({ data: null, error: { message: 'canceling statement due to statement timeout', code: '57014' } }) // company_settings

    // A lock state that could not be read is never shown as open.
    await expect(tagJournalLines.execute(args, 'company-1', 'user-1', supabase as never)).rejects.toMatchObject({ code: '57014' })
    expect((supabase.from as ReturnType<typeof vi.fn>).mock.calls.some((c) => c[0] === 'pending_operations')).toBe(false)
  })
})
