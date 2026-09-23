/**
 * Unit tests for gnubok_book_skattekonto_row / gnubok_book_skattekonto_rows:
 * registration/scope/risk wiring, input validation, tenant-scoped not-found,
 * the stage-time bookability gates (already booked / ignored / unsettled /
 * no rule), and the staged-approval contract: staging must never book; the
 * booking runs only when the approved op's commit executor dispatches into
 * the skatteverket extension (covered in
 * lib/pending-operations/__tests__/skattekonto-book-executor.test.ts).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { TOOL_SCOPE_MAP } from '@/lib/auth/api-keys'
import { OPERATION_RISK_TIERS } from '@/lib/pending-operations/risk-tiers'

// Stage-time preview enrichment is mocked so the tests control the rule
// outcome; the booking functions are mocked too so any call to them from the
// staging path (which must never happen) is caught.
const mockAttach = vi.fn()
const mockBokforSingle = vi.fn()
const mockBokforBatch = vi.fn()
vi.mock('@/extensions/general/skatteverket/lib/skattekonto-booking', () => ({
  attachBookingSuggestions: (...a: unknown[]) => mockAttach(...a),
  bokforSkattekontoTransaction: (...a: unknown[]) => mockBokforSingle(...a),
  bokforSkattekontoTransactionsBatch: (...a: unknown[]) => mockBokforBatch(...a),
}))

import { tools } from '../server'

const single = tools.find((t) => t.name === 'gnubok_book_skattekonto_row')!
const batch = tools.find((t) => t.name === 'gnubok_book_skattekonto_rows')!

const noopSupabase = { from: vi.fn() } as never

const ROW = {
  id: 'skv-tx-1',
  transaktionsdatum: '2026-03-12',
  transaktionstext: 'Debiterad preliminärskatt',
  belopp_skatteverket: -5000,
  status: 'booked',
  is_ignored: false,
  journal_entry_id: null,
}

const SUGGESTION = {
  account: '2518',
  account_name: 'Betald F-skatt',
  label: 'Debiterad preliminärskatt',
}

/** Default: pass rows through with a matched suggestion, like the real matcher. */
function attachWithSuggestion(): void {
  mockAttach.mockImplementation(async (_supabase, _companyId, rows: (typeof ROW)[]) =>
    rows.map((r) => ({ ...r, booking_suggestion: SUGGESTION })),
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  attachWithSuggestion()
})

describe('book skattekonto tools: registration', () => {
  it('both tools are registered, search-only, staged-schema, strict-input', () => {
    for (const t of [single, batch]) {
      expect(t).toBeDefined()
      expect(t.catalogVisibility).toBe('search')
      expect((t.inputSchema as { additionalProperties?: boolean }).additionalProperties).toBe(false)
      const out = t.outputSchema as { properties?: Record<string, unknown>; required?: string[] }
      expect(out?.properties?.staged).toBeDefined()
      expect(out?.required).toContain('staged')
      expect(t.description).toMatch(/stag(e|es|ing)/i)
      expect(t.annotations.readOnlyHint).toBe(false)
    }
  })

  it('is mapped to transactions:write scope (API keys without it get 403)', () => {
    expect(TOOL_SCOPE_MAP.gnubok_book_skattekonto_row).toBe('transactions:write')
    expect(TOOL_SCOPE_MAP.gnubok_book_skattekonto_rows).toBe('transactions:write')
  })

  it('both op types are tiered medium (bounded rule-driven booking)', () => {
    expect(OPERATION_RISK_TIERS.book_skattekonto_row).toBe('medium')
    expect(OPERATION_RISK_TIERS.book_skattekonto_rows).toBe('medium')
  })
})

describe('gnubok_book_skattekonto_row: validation gates', () => {
  it('rejects a missing skattekonto_transaction_id before any DB call', async () => {
    await expect(
      single.execute({}, 'company-1', 'user-1', noopSupabase),
    ).rejects.toThrow(/skattekonto_transaction_id/)
  })

  it('rejects when the row does not exist in this company (wrong tenant)', async () => {
    const { supabase, findCalls } = createQueuedMockSupabase()
    // Queue empty: the row fetch resolves { data: null }.
    await expect(
      single.execute(
        { skattekonto_transaction_id: 'skv-tx-other-company' },
        'company-1', 'user-1', supabase as never,
      ),
    ).rejects.toThrow(/hittades inte/)
    // The lookup is company-scoped: defense in depth alongside RLS.
    expect(findCalls('skattekonto_transactions', 'eq')).toContainEqual(['company_id', 'company-1'])
  })

  it('rejects an already-booked row at stage time', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { ...ROW, journal_entry_id: 'je-9' } })
    await expect(
      single.execute({ skattekonto_transaction_id: ROW.id }, 'company-1', 'user-1', supabase as never),
    ).rejects.toThrow(/redan bokförd/)
  })

  it('rejects an ignored row at stage time', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { ...ROW, is_ignored: true } })
    await expect(
      single.execute({ skattekonto_transaction_id: ROW.id }, 'company-1', 'user-1', supabase as never),
    ).rejects.toThrow(/ignorerad/)
  })

  it('rejects an unsettled (kommande) row at stage time', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { ...ROW, status: 'upcoming' } })
    await expect(
      single.execute({ skattekonto_transaction_id: ROW.id }, 'company-1', 'user-1', supabase as never),
    ).rejects.toThrow(/inte genomförd/)
  })

  it('rejects a row with no matching counter-account rule', async () => {
    mockAttach.mockImplementation(async (_s, _c, rows: (typeof ROW)[]) =>
      rows.map((r) => ({ ...r, booking_suggestion: null })),
    )
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { ...ROW } })
    await expect(
      single.execute({ skattekonto_transaction_id: ROW.id }, 'company-1', 'user-1', supabase as never),
    ).rejects.toThrow(/motkontoregel/)
  })
})

describe('gnubok_book_skattekonto_row: staging behaviour', () => {
  it('dry_run previews the booking without staging or booking anything', async () => {
    const { supabase, enqueue, findCall } = createQueuedMockSupabase()
    enqueue({ data: { ...ROW } })
    const result = (await single.execute(
      { skattekonto_transaction_id: ROW.id, dry_run: true },
      'company-1', 'user-1', supabase as never,
    )) as { staged: boolean; dry_run?: boolean; preview: Record<string, unknown> }

    expect(result.dry_run).toBe(true)
    expect(result.staged).toBe(false)
    expect(result.preview).toMatchObject({
      skattekonto_transaction_id: ROW.id,
      transaction_date: '2026-03-12',
      amount: -5000,
      skattekonto_account: '1630',
      suggested_counter_account: '2518',
      rule_label: 'Debiterad preliminärskatt',
    })
    expect(findCall('pending_operations', 'insert')).toBeUndefined()
    expect(mockBokforSingle).not.toHaveBeenCalled()
    expect(mockBokforBatch).not.toHaveBeenCalled()
  })

  it('stages a pending op that requires approval; booking never runs at stage time', async () => {
    const { supabase, enqueue, findCall, calls } = createQueuedMockSupabase()
    enqueue({ data: { ...ROW } })          // row fetch
    enqueue({ data: null })                // period check: company_settings
    enqueue({ data: null })                // period check: fiscal_periods
    enqueue({ data: { id: 'op-1' } })      // pending_operations insert

    const result = (await single.execute(
      { skattekonto_transaction_id: ROW.id },
      'company-1', 'user-1', supabase as never, { type: 'api_key' },
    )) as {
      staged: boolean
      operation_id?: string
      risk_level: string
      approve?: { tool: string; args: Record<string, unknown> }
    }

    expect(result.staged).toBe(true)
    expect(result.operation_id).toBe('op-1')
    expect(result.risk_level).toBe('medium')
    // The explicit approval contract: the booking happens only through the
    // approve tool, never as a side-effect of staging.
    expect(result.approve).toEqual({
      tool: 'gnubok_approve_pending_operation',
      args: { operation_id: 'op-1', company_id: 'company-1' },
    })
    const inserted = findCall('pending_operations', 'insert')?.[0] as Record<string, unknown>
    expect(inserted).toMatchObject({
      operation_type: 'book_skattekonto_row',
      params: { transaction_id: ROW.id },
      risk_level: 'medium',
    })
    // No journal write of any kind at stage time.
    expect(calls.some((c) => c.table === 'journal_entries')).toBe(false)
    expect(mockBokforSingle).not.toHaveBeenCalled()
    expect(mockBokforBatch).not.toHaveBeenCalled()
  })
})

describe('gnubok_book_skattekonto_rows: batch staging', () => {
  it('rejects an empty id list before any DB call', async () => {
    await expect(
      batch.execute({ skattekonto_transaction_ids: [] }, 'company-1', 'user-1', noopSupabase),
    ).rejects.toThrow(/skattekonto_transaction_ids/)
  })

  it('rejects more than 200 ids before any DB call', async () => {
    const ids = Array.from({ length: 201 }, (_, i) => `skv-tx-${i}`)
    await expect(
      batch.execute({ skattekonto_transaction_ids: ids }, 'company-1', 'user-1', noopSupabase),
    ).rejects.toThrow(/1-200/)
  })

  it('stages only bookable rows; blocked and foreign rows land in skipped with reasons', async () => {
    const rows = [
      { ...ROW, id: 'skv-ok' },
      { ...ROW, id: 'skv-booked', journal_entry_id: 'je-1' },
      { ...ROW, id: 'skv-upcoming', status: 'upcoming' },
    ]
    const { supabase, enqueue, findCall } = createQueuedMockSupabase()
    enqueue({ data: rows })                // batch row fetch (skv-foreign not returned)
    enqueue({ data: null })                // period check: company_settings
    enqueue({ data: null })                // period check: fiscal_periods
    enqueue({ data: { id: 'op-2' } })      // pending_operations insert

    const result = (await batch.execute(
      { skattekonto_transaction_ids: ['skv-ok', 'skv-booked', 'skv-upcoming', 'skv-foreign'] },
      'company-1', 'user-1', supabase as never,
    )) as { staged: boolean; preview: Record<string, unknown> }

    expect(result.staged).toBe(true)
    const inserted = findCall('pending_operations', 'insert')?.[0] as {
      operation_type: string
      params: { ids: string[] }
    }
    expect(inserted.operation_type).toBe('book_skattekonto_rows')
    expect(inserted.params.ids).toEqual(['skv-ok'])
    expect(result.preview.row_count).toBe(1)
    expect(result.preview.skipped).toEqual([
      { skattekonto_transaction_id: 'skv-foreign', reason: 'TRANSACTION_NOT_FOUND' },
      { skattekonto_transaction_id: 'skv-booked', reason: 'ALREADY_BOOKED' },
      { skattekonto_transaction_id: 'skv-upcoming', reason: 'NOT_SETTLED' },
    ])
    expect(mockBokforBatch).not.toHaveBeenCalled()
  })

  it('refuses to stage when no row is bookable, naming the reasons', async () => {
    const rows = [{ ...ROW, id: 'skv-booked', journal_entry_id: 'je-1' }]
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: rows })
    await expect(
      batch.execute(
        { skattekonto_transaction_ids: ['skv-booked'] },
        'company-1', 'user-1', supabase as never,
      ),
    ).rejects.toThrow(/ALREADY_BOOKED/)
  })
})
