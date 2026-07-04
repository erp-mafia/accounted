/**
 * Dimensions PR6: gnubok_tag_journal_lines (bulk retag staging) tests.
 *
 * Covers registration (scope map, strict schema, staged-operation output
 * contract via deriveToolMeta), the filter gates (no filters / 0 matches /
 * >500 matches), and the staging happy paths (free-text passthrough +
 * registry name resolution). Executor-side coverage
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
    enqueue({ data: [], error: null }) // line match query → empty

    await expect(
      tagJournalLines.execute(
        { dimensions: { '6': 'P01' }, reason: 'Retro-taggning', filters: { accounts: ['4010'] } },
        'company-1',
        'user-1',
        supabase as never,
      ),
    ).rejects.toThrow(/Inga bokförda rader matchade filtret[\s\S]*gnubok_query_journal/)
  })

  it('throws asking to narrow the filter when more than 500 lines match', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { dimensions_enabled: false }, error: null })
    enqueue({ data: Array.from({ length: 501 }, (_, i) => makeLineRow(i)), error: null })

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
})

// ── Staging ──────────────────────────────────────────────────────────────────

describe('gnubok_tag_journal_lines: staging', () => {
  it('stages a retag_line_dimensions op with matched line_ids + preview sample', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { dimensions_enabled: false }, error: null }) // passthrough (free-text era)
    enqueue({ data: [makeLineRow(1), makeLineRow(2)], error: null }) // line match query
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
      { account: '4010', date: '2024-03-01', debit: 250, credit: 0 },
      { account: '4010', date: '2024-03-01', debit: 250, credit: 0 },
    ])

    const insertCalls = (supabase.from as ReturnType<typeof vi.fn>).mock.calls
    expect(insertCalls.some((args) => args[0] === 'pending_operations')).toBe(true)
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
    enqueue({ data: [makeLineRow(1)], error: null }) // line match query
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

  it('dry_run previews the match without inserting a pending operation', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { dimensions_enabled: false }, error: null })
    enqueue({ data: [makeLineRow(1)], error: null }) // line match query

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
