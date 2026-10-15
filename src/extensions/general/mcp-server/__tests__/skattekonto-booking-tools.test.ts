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

// The company's skattekonto account (lib/skatteverket/skattekonto-account.ts):
// 1630 here, what every company resolved to before the setting existed.
vi.mock('@/lib/skatteverket/skattekonto-account', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/skatteverket/skattekonto-account')>()),
  resolveSkattekontoAccount: vi.fn(async () => '1630'),
}))

// Stage-time preview enrichment is mocked so the tests control the rule
// outcome; the booking functions are mocked too so any call to them from the
// staging path (which must never happen) is caught.
const mockAttach = vi.fn()
const mockBokforSingle = vi.fn()
const mockBokforBatch = vi.fn()
// The ledger-twin search is mocked so the tests control whether the ledger
// already carries the event; the message builder stays real.
const mockTwins = vi.fn()
// The ledger holding (rows a summarised verifikat already holds, crm#1043,
// and rows the ledger plan assigns to one verifikat, PH 171) is mocked the
// same way: the cover and the plan are given, the check (ledgerHoldOf) and
// the message and info builders stay real.
const mockCover = vi.fn()
const mockPlanned = vi.fn()
// The direct-booking search (a bank verifikat without any 1630 line already
// books the event, PH 171) is mocked the same way: the holders are given,
// the counter line and the message stay real.
const mockDirect = vi.fn()
vi.mock('@/extensions/general/skatteverket/lib/skattekonto-direct', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/extensions/general/skatteverket/lib/skattekonto-direct')>()),
  findDirectLedgerHolders: (...a: unknown[]) => mockDirect(...a),
}))
vi.mock('@/extensions/general/skatteverket/lib/skattekonto-booking', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/extensions/general/skatteverket/lib/skattekonto-booking')>()
  return {
    ledgerTwinMessage: actual.ledgerTwinMessage,
    ledgerCoverMessage: actual.ledgerCoverMessage,
    toLedgerCoverInfo: actual.toLedgerCoverInfo,
    ledgerHoldOf: actual.ledgerHoldOf,
    normaliseDuplicateReason: actual.normaliseDuplicateReason,
    DUPLICATE_REASON_MAX_LENGTH: actual.DUPLICATE_REASON_MAX_LENGTH,
    // Real: the staged verifikat must be the executor's own lines.
    buildSkattekontoEntry: actual.buildSkattekontoEntry,
    counterLineOf: actual.counterLineOf,
    ledgerDirectMessage: actual.ledgerDirectMessage,
    attachBookingSuggestions: (...a: unknown[]) => mockAttach(...a),
    findSkattekontoLedgerTwins: (...a: unknown[]) => mockTwins(...a),
    findSkattekontoLedgerHolding: async (...a: unknown[]) => {
      const cover = (await mockCover(...a)) as { event_ids: string[] } | null
      return { account: '1630', cover, covered: new Set(cover?.event_ids ?? []), planned: mockPlanned() }
    },
    bokforSkattekontoTransaction: (...a: unknown[]) => mockBokforSingle(...a),
    bokforSkattekontoTransactionsBatch: (...a: unknown[]) => mockBokforBatch(...a),
  }
})

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

const TWIN = {
  journal_entry_id: 'je-imported-185',
  voucher_series: 'A',
  voucher_number: 185,
  entry_date: '2026-03-12',
  description: 'Preliminärskatt (import)',
  status: 'posted',
}

/** Default: the ledger holds no twin for any row. */
function noTwins(): void {
  mockTwins.mockImplementation(async (_supabase, _companyId, rows: Array<{ id: string }>) =>
    new Map(rows.map((r) => [r.id, []])),
  )
}

/** The ledger already carries the event of these rows. */
function twinsFor(...ids: string[]): void {
  mockTwins.mockImplementation(async (_supabase, _companyId, rows: Array<{ id: string }>) =>
    new Map(rows.map((r) => [r.id, ids.includes(r.id) ? [TWIN] : []])),
  )
}

/** A summarised year-end verifikat that already holds the given open rows (crm#1043). */
function coverFor(...ids: string[]) {
  return {
    account_number: '1630',
    through_date: '2026-12-31',
    kind: 'ledger_agrees' as const,
    event_ids: ids,
    event_count: ids.length,
    event_total: -5000 * ids.length,
    entries: [
      {
        journal_entry_id: 'je-year-end',
        voucher_number: 1,
        voucher_series: 'B',
        entry_date: '2026-12-31',
        description: 'Skattekonto 2026',
        status: 'posted' as const,
        open_amount: 37887.25,
      },
    ],
    entry_total: 37887.25,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  attachWithSuggestion()
  noTwins()
  // Default: no unlinked verifikat on 1630 covers any row, none is planned.
  mockCover.mockResolvedValue(null)
  mockPlanned.mockReturnValue(new Map())
  // Default: no bank verifikat books any row without the skattekonto.
  mockDirect.mockImplementation(async (_supabase, _companyId, probes: Array<{ id: string }>) =>
    new Map(probes.map((p) => [p.id, []])),
  )
})

const REASON = 'Räntan debiterades två gånger'

/** The ledger plan: these rows held by one monthly verifikat (B7, 28 February). */
function plannedFor(...ids: string[]) {
  const hold = {
    entry: {
      journal_entry_id: 'je-february',
      voucher_number: 7,
      voucher_series: 'B',
      entry_date: '2027-02-28',
      description: 'Skattekonto februari',
      status: 'posted' as const,
      open_amount: -10000,
    },
    event_ids: ids,
    total: -10000,
    from_date: '2027-02-28',
    to_date: '2027-03-12',
  }
  mockPlanned.mockReturnValue(new Map(ids.map((id) => [id, hold])))
}

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
    // The verifikat the approval posts, as the executor builds it (crm#1104):
    // a charge on the skattekonto debits the counter account, credits 1630.
    expect(result.preview.journal_entry).toEqual({
      entry_date: '2026-03-12',
      description: 'Skattekonto: Debiterad preliminärskatt',
      lines: [
        { account_number: '2518', debit_amount: 5000, credit_amount: 0, line_description: 'Debiterad preliminärskatt' },
        { account_number: '1630', debit_amount: 0, credit_amount: 5000, line_description: 'Debiterad preliminärskatt' },
      ],
      total_debit: 5000,
      total_credit: 5000,
      balanced: true,
      note: expect.any(String),
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
    // One verifikat per bookable row, none for a skipped one (crm#1104).
    const entries = result.preview.journal_entries as Array<{ description: string; lines: Array<{ account_number: string }> }>
    expect(entries).toHaveLength(1)
    expect(entries[0].description).toBe('Skattekonto: Debiterad preliminärskatt')
    expect(entries[0].lines.map((l) => l.account_number)).toEqual(['2518', '1630'])
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

describe('book skattekonto tools: ledger twin guard', () => {
  it('row: refuses to stage when a verifikat already carries the event, naming it and the link tool', async () => {
    twinsFor(ROW.id)
    const { supabase, enqueue, findCall } = createQueuedMockSupabase()
    enqueue({ data: { ...ROW } })

    const err = (await single
      .execute({ skattekonto_transaction_id: ROW.id }, 'company-1', 'user-1', supabase as never)
      .catch((e: unknown) => e)) as Error & { code?: string; remediation?: { tool?: string } }

    expect(err.code).toBe('SKATTEKONTO_BOOK_LEDGER_TWIN_EXISTS')
    expect(err.message).toContain('verifikat A185 (2026-03-12)')
    expect(err.remediation?.tool).toBe('gnubok_reconcile_match')
    expect(findCall('pending_operations', 'insert')).toBeUndefined()
    expect(mockBokforSingle).not.toHaveBeenCalled()
  })

  it('row: a combined twin links the row together with its companions, not alone', async () => {
    const companion = { id: 'row-agavg', transaktionsdatum: '2026-03-12', transaktionstext: 'Arbetsgivaravgift', belopp_skatteverket: -4000 }
    mockTwins.mockImplementation(async (_supabase, _companyId, rows: Array<{ id: string }>) =>
      new Map(rows.map((r) => [r.id, [{ ...TWIN, combined_with: [companion] }]])),
    )
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { ...ROW } })

    const err = (await single
      .execute({ skattekonto_transaction_id: ROW.id }, 'company-1', 'user-1', supabase as never)
      .catch((e: unknown) => e)) as Error & {
      code?: string
      remediation?: { tool?: string; description?: string; args?: { pairs?: Array<{ external_ids: string[]; journal_entry_ids: string[] }> } }
    }

    expect(err.code).toBe('SKATTEKONTO_BOOK_LEDGER_TWIN_EXISTS')
    expect(err.message).toContain('tillsammans med en annan rad på skattekontot')
    expect(err.remediation?.args?.pairs).toEqual([
      { external_ids: [ROW.id, 'row-agavg'], journal_entry_ids: ['je-imported-185'] },
    ])
    expect(err.remediation?.description).toContain('together with the 1 other open row(s)')
  })

  it('row: allow_duplicate stages the override with the twin in the preview and a reviewer warning', async () => {
    twinsFor(ROW.id)
    const { supabase, enqueue, findCall } = createQueuedMockSupabase()
    enqueue({ data: { ...ROW } })          // row fetch
    enqueue({ data: null })                // period check: company_settings
    enqueue({ data: null })                // period check: fiscal_periods
    enqueue({ data: { id: 'op-3' } })      // pending_operations insert

    const result = (await single.execute(
      { skattekonto_transaction_id: ROW.id, allow_duplicate: true, duplicate_reason: REASON },
      'company-1', 'user-1', supabase as never,
    )) as { staged: boolean; preview: Record<string, unknown> }

    expect(result.staged).toBe(true)
    const inserted = findCall('pending_operations', 'insert')?.[0] as { params: Record<string, unknown> }
    expect(inserted.params).toEqual({ transaction_id: ROW.id, allow_duplicate: true, duplicate_reason: REASON })
    expect(result.preview.ledger_twins).toEqual([TWIN])
    expect(String(result.preview.compliance_warning)).toContain('DUPLICATE_OVERRIDE')
    expect(mockBokforSingle).not.toHaveBeenCalled()
  })

  it('row: allow_duplicate without a twin stores no override, so the commit keeps the guard on', async () => {
    const { supabase, enqueue, findCall } = createQueuedMockSupabase()
    enqueue({ data: { ...ROW } })          // row fetch
    enqueue({ data: null })                // period check: company_settings
    enqueue({ data: null })                // period check: fiscal_periods
    enqueue({ data: { id: 'op-5' } })      // pending_operations insert

    const result = (await single.execute(
      { skattekonto_transaction_id: ROW.id, allow_duplicate: true, duplicate_reason: REASON },
      'company-1', 'user-1', supabase as never,
    )) as { staged: boolean; preview: Record<string, unknown> }

    expect(result.staged).toBe(true)
    const inserted = findCall('pending_operations', 'insert')?.[0] as { params: Record<string, unknown> }
    expect(inserted.params).toEqual({ transaction_id: ROW.id })
    expect(result.preview.compliance_warning).toBeUndefined()
  })

  it('rows: a twin row is skipped with LEDGER_TWIN_EXISTS and its twins; an allowed one is staged with the override', async () => {
    twinsFor('skv-twin', 'skv-allowed')
    const rows = [
      { ...ROW, id: 'skv-ok' },
      { ...ROW, id: 'skv-twin' },
      { ...ROW, id: 'skv-allowed' },
    ]
    const { supabase, enqueue, findCall } = createQueuedMockSupabase()
    enqueue({ data: rows })                // batch row fetch
    enqueue({ data: null })                // period check: company_settings
    enqueue({ data: null })                // period check: fiscal_periods
    enqueue({ data: { id: 'op-4' } })      // pending_operations insert

    const result = (await batch.execute(
      {
        skattekonto_transaction_ids: ['skv-ok', 'skv-twin', 'skv-allowed'],
        allow_duplicate_ids: ['skv-allowed'],
        duplicate_reason: REASON,
      },
      'company-1', 'user-1', supabase as never,
    )) as { staged: boolean; preview: Record<string, unknown> }

    expect(result.staged).toBe(true)
    const inserted = findCall('pending_operations', 'insert')?.[0] as { params: Record<string, unknown> }
    expect(inserted.params).toEqual({ ids: ['skv-ok', 'skv-allowed'], allow_duplicate_ids: ['skv-allowed'], duplicate_reason: REASON })
    expect(result.preview.skipped).toEqual([
      { skattekonto_transaction_id: 'skv-twin', reason: 'LEDGER_TWIN_EXISTS', ledger_twins: [TWIN] },
    ])
    expect(String(result.preview.compliance_warning)).toContain('DUPLICATE_OVERRIDE')
    // One search for all open rows.
    expect(mockTwins).toHaveBeenCalledTimes(1)
    expect(mockBokforBatch).not.toHaveBeenCalled()
  })

  it('rows: refuses with the coded twin refusal when every row is already in the ledger', async () => {
    twinsFor('skv-a', 'skv-b')
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: [{ ...ROW, id: 'skv-a' }, { ...ROW, id: 'skv-b' }] })

    const err = (await batch
      .execute({ skattekonto_transaction_ids: ['skv-a', 'skv-b'] }, 'company-1', 'user-1', supabase as never)
      .catch((e: unknown) => e)) as Error & { code?: string }

    expect(err.code).toBe('SKATTEKONTO_BOOK_LEDGER_TWIN_EXISTS')
    expect(err.message).toContain('Alla 2 rader finns redan i bokföringen')
  })
})

describe('book skattekonto tools: ledger cover guard (a summarised verifikat already holds the rows)', () => {
  type Refusal = Error & {
    code?: string
    remediation?: {
      tool?: string
      description?: string
      args?: { account_key?: string; pairs?: Array<{ external_ids: string[]; journal_entry_ids: string[]; allow_remainder?: boolean }> }
    }
  }

  it('row: refuses to stage a covered row, and hands back the link to make with allow_remainder', async () => {
    mockCover.mockResolvedValue(coverFor(ROW.id, 'skv-other'))
    const { supabase, enqueue, findCall } = createQueuedMockSupabase()
    enqueue({ data: { ...ROW } })

    const err = (await single
      .execute({ skattekonto_transaction_id: ROW.id }, 'company-1', 'user-1', supabase as never)
      .catch((e: unknown) => e)) as Refusal

    expect(err.code).toBe('SKATTEKONTO_BOOK_LEDGER_COVER_EXISTS')
    expect(err.message).toContain('Händelsen ser redan ut att vara bokförd')
    expect(err.message).toContain('B1 (2026-12-31)')
    expect(err.remediation?.tool).toBe('gnubok_reconcile_match')
    expect(err.remediation?.args).toEqual({
      account_key: 'skattekonto',
      pairs: [{ external_ids: [ROW.id], journal_entry_ids: ['je-year-end'], allow_remainder: true }],
    })
    expect(err.remediation?.description).toContain('allow_remainder: true')
    expect(findCall('pending_operations', 'insert')).toBeUndefined()
    expect(mockBokforSingle).not.toHaveBeenCalled()
  })

  it('row: a row the cover does not name stages as before', async () => {
    mockCover.mockResolvedValue(coverFor('skv-other'))
    const { supabase, enqueue, findCall } = createQueuedMockSupabase()
    enqueue({ data: { ...ROW } })          // row fetch
    enqueue({ data: null })                // period check: company_settings
    enqueue({ data: null })                // period check: fiscal_periods
    enqueue({ data: { id: 'op-c1' } })     // pending_operations insert

    const result = (await single.execute(
      { skattekonto_transaction_id: ROW.id },
      'company-1', 'user-1', supabase as never,
    )) as { staged: boolean; preview: Record<string, unknown> }

    expect(result.staged).toBe(true)
    const inserted = findCall('pending_operations', 'insert')?.[0] as { params: Record<string, unknown> }
    expect(inserted.params).toEqual({ transaction_id: ROW.id })
    expect(result.preview.ledger_cover).toBeUndefined()
    expect(result.preview.compliance_warning).toBeUndefined()
  })

  it('row: allow_duplicate stages the override for a covered row, with the cover in the preview and a reviewer warning', async () => {
    mockCover.mockResolvedValue(coverFor(ROW.id))
    const { supabase, enqueue, findCall } = createQueuedMockSupabase()
    enqueue({ data: { ...ROW } })
    enqueue({ data: null })
    enqueue({ data: null })
    enqueue({ data: { id: 'op-c2' } })

    const result = (await single.execute(
      { skattekonto_transaction_id: ROW.id, allow_duplicate: true, duplicate_reason: REASON },
      'company-1', 'user-1', supabase as never,
    )) as { staged: boolean; preview: Record<string, unknown> }

    expect(result.staged).toBe(true)
    const inserted = findCall('pending_operations', 'insert')?.[0] as { params: Record<string, unknown> }
    expect(inserted.params).toEqual({ transaction_id: ROW.id, allow_duplicate: true, duplicate_reason: REASON })
    expect(result.preview.ledger_cover).toMatchObject({ through_date: '2026-12-31', entry_count: 1 })
    expect(String(result.preview.compliance_warning)).toContain('DUPLICATE_OVERRIDE')
    expect(mockBokforSingle).not.toHaveBeenCalled()
  })

  it('rows: covered rows are skipped with LEDGER_COVER_EXISTS, the others staged, the cover stated once, one bridge read', async () => {
    mockCover.mockResolvedValue(coverFor('skv-covered-1', 'skv-covered-2', 'skv-allowed'))
    const rows = [
      { ...ROW, id: 'skv-fresh' },
      { ...ROW, id: 'skv-covered-1' },
      { ...ROW, id: 'skv-covered-2' },
      { ...ROW, id: 'skv-allowed' },
    ]
    const { supabase, enqueue, findCall } = createQueuedMockSupabase()
    enqueue({ data: rows })                // batch row fetch
    enqueue({ data: null })                // period check: company_settings
    enqueue({ data: null })                // period check: fiscal_periods
    enqueue({ data: { id: 'op-c3' } })     // pending_operations insert

    const result = (await batch.execute(
      {
        skattekonto_transaction_ids: rows.map((r) => r.id),
        allow_duplicate_ids: ['skv-allowed'],
        duplicate_reason: REASON,
      },
      'company-1', 'user-1', supabase as never,
    )) as { staged: boolean; preview: Record<string, unknown> }

    expect(result.staged).toBe(true)
    const inserted = findCall('pending_operations', 'insert')?.[0] as { params: Record<string, unknown> }
    expect(inserted.params).toEqual({ ids: ['skv-fresh', 'skv-allowed'], allow_duplicate_ids: ['skv-allowed'], duplicate_reason: REASON })
    expect(result.preview.skipped).toEqual([
      { skattekonto_transaction_id: 'skv-covered-1', reason: 'LEDGER_COVER_EXISTS' },
      { skattekonto_transaction_id: 'skv-covered-2', reason: 'LEDGER_COVER_EXISTS' },
    ])
    expect(result.preview.ledger_cover).toMatchObject({ through_date: '2026-12-31', event_count: 3 })
    expect(String(result.preview.compliance_warning)).toContain('DUPLICATE_OVERRIDE')
    expect(mockCover).toHaveBeenCalledTimes(1)
    expect(mockBokforBatch).not.toHaveBeenCalled()
  })

  it('rows: when every row is covered nothing is staged, and the refusal carries the rows and the verifikat to link', async () => {
    mockCover.mockResolvedValue(coverFor('skv-a', 'skv-b'))
    const { supabase, enqueue, findCall } = createQueuedMockSupabase()
    enqueue({ data: [{ ...ROW, id: 'skv-a' }, { ...ROW, id: 'skv-b' }] })

    const err = (await batch
      .execute({ skattekonto_transaction_ids: ['skv-a', 'skv-b'] }, 'company-1', 'user-1', supabase as never)
      .catch((e: unknown) => e)) as Refusal

    expect(err.code).toBe('SKATTEKONTO_BOOK_LEDGER_COVER_EXISTS')
    expect(err.message).toContain('Alla 2 rader ser redan ut att vara bokförda')
    expect(err.remediation?.args?.pairs).toEqual([
      { external_ids: ['skv-a', 'skv-b'], journal_entry_ids: ['je-year-end'], allow_remainder: true },
    ])
    expect(findCall('pending_operations', 'insert')).toBeUndefined()
  })
})

describe('book skattekonto tools: ledger plan guard (one monthly verifikat holds the rows, PH 171)', () => {
  type Refusal = Error & {
    code?: string
    remediation?: {
      tool?: string
      args?: { account_key?: string; pairs?: Array<{ external_ids: string[]; journal_entry_ids: string[]; allow_remainder?: boolean }> }
    }
  }

  it('row: refuses a planned row that no cover names, with the exact link (no remainder) to make', async () => {
    mockCover.mockResolvedValue(coverFor('skv-december'))
    plannedFor(ROW.id, 'skv-ranta-march')
    const { supabase, enqueue, findCall } = createQueuedMockSupabase()
    enqueue({ data: { ...ROW } })

    const err = (await single
      .execute({ skattekonto_transaction_id: ROW.id }, 'company-1', 'user-1', supabase as never)
      .catch((e: unknown) => e)) as Refusal

    expect(err.code).toBe('SKATTEKONTO_BOOK_LEDGER_COVER_EXISTS')
    expect(err.message).toContain('verifikat B7 (2027-02-28) på konto 1630')
    expect(err.remediation?.args).toEqual({
      account_key: 'skattekonto',
      pairs: [{ external_ids: [ROW.id, 'skv-ranta-march'], journal_entry_ids: ['je-february'] }],
    })
    expect(findCall('pending_operations', 'insert')).toBeUndefined()
  })

  it('rows: a planned row is skipped with its own verifikat on the skipped entry; the rest is staged', async () => {
    plannedFor('skv-planned')
    const { supabase, enqueue, findCall } = createQueuedMockSupabase()
    enqueue({ data: [{ ...ROW, id: 'skv-fresh' }, { ...ROW, id: 'skv-planned' }] })
    enqueue({ data: null })                // period check: company_settings
    enqueue({ data: null })                // period check: fiscal_periods
    enqueue({ data: { id: 'op-p1' } })     // pending_operations insert

    const result = (await batch.execute(
      { skattekonto_transaction_ids: ['skv-fresh', 'skv-planned'] },
      'company-1', 'user-1', supabase as never,
    )) as { staged: boolean; preview: Record<string, unknown> }

    const inserted = findCall('pending_operations', 'insert')?.[0] as { params: Record<string, unknown> }
    expect(inserted.params).toEqual({ ids: ['skv-fresh'] })
    expect(result.preview.skipped).toEqual([
      expect.objectContaining({
        skattekonto_transaction_id: 'skv-planned',
        reason: 'LEDGER_COVER_EXISTS',
        ledger_cover: expect.objectContaining({ kind: 'planned_link', event_ids: ['skv-planned'] }),
      }),
    ])
    // No aggregate cover to state for the batch.
    expect(result.preview.ledger_cover).toBeUndefined()
  })

  it('rows: when every row is planned, the refusal is the first row\'s exact link', async () => {
    plannedFor('skv-a', 'skv-b')
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: [{ ...ROW, id: 'skv-a' }, { ...ROW, id: 'skv-b' }] })

    const err = (await batch
      .execute({ skattekonto_transaction_ids: ['skv-a', 'skv-b'] }, 'company-1', 'user-1', supabase as never)
      .catch((e: unknown) => e)) as Refusal

    expect(err.code).toBe('SKATTEKONTO_BOOK_LEDGER_COVER_EXISTS')
    expect(err.remediation?.args?.pairs).toEqual([{ external_ids: ['skv-a', 'skv-b'], journal_entry_ids: ['je-february'] }])
  })

  it('row: the override for a planned row stages with the reason and a reviewer warning naming the verifikat', async () => {
    plannedFor(ROW.id, 'skv-ranta-march')
    const { supabase, enqueue, findCall } = createQueuedMockSupabase()
    enqueue({ data: { ...ROW } })
    enqueue({ data: null })
    enqueue({ data: null })
    enqueue({ data: { id: 'op-p2' } })

    const result = (await single.execute(
      { skattekonto_transaction_id: ROW.id, allow_duplicate: true, duplicate_reason: REASON },
      'company-1', 'user-1', supabase as never,
    )) as { staged: boolean; preview: Record<string, unknown> }

    const inserted = findCall('pending_operations', 'insert')?.[0] as { params: Record<string, unknown> }
    expect(inserted.params).toEqual({ transaction_id: ROW.id, allow_duplicate: true, duplicate_reason: REASON })
    expect(String(result.preview.compliance_warning)).toContain('B7 on 1630 already holds this row exactly')
  })
})

describe('book skattekonto tools: the override needs a reason', () => {
  it('row: allow_duplicate without duplicate_reason is a bad argument, nothing staged', async () => {
    twinsFor(ROW.id)
    const { supabase, enqueue, findCall } = createQueuedMockSupabase()
    enqueue({ data: { ...ROW } })
    enqueue({ data: { ...ROW } })

    for (const extra of [{}, { duplicate_reason: '  ' }]) {
      await expect(
        single.execute({ skattekonto_transaction_id: ROW.id, allow_duplicate: true, ...extra }, 'company-1', 'user-1', supabase as never),
      ).rejects.toThrow(/duplicate_reason/)
    }
    expect(findCall('pending_operations', 'insert')).toBeUndefined()
  })

  it('rows: allow_duplicate_ids without duplicate_reason is a bad argument, nothing staged', async () => {
    const { supabase, enqueue, findCall } = createQueuedMockSupabase()
    enqueue({ data: [{ ...ROW, id: 'skv-a' }] })

    await expect(
      batch.execute({ skattekonto_transaction_ids: ['skv-a'], allow_duplicate_ids: ['skv-a'] }, 'company-1', 'user-1', supabase as never),
    ).rejects.toThrow(/duplicate_reason/)
    expect(findCall('pending_operations', 'insert')).toBeUndefined()
  })
})

describe('book skattekonto tools: direct-booking guard (a bank verifikat already books the row without 1630, PH 171)', () => {
  type Refusal = Error & {
    code?: string
    remediation?: { tool?: string; description?: string; args?: Record<string, unknown> }
  }
  const HOLDER = {
    journal_entry_id: 'je-a14',
    voucher_series: 'A',
    voucher_number: 14,
    entry_date: '2026-03-31',
    description: 'Avstämning skattekonto',
    status: 'posted',
  }

  /** A bank verifikat already books these rows without 1630. */
  function directFor(...ids: string[]): void {
    mockDirect.mockImplementation(async (_supabase, _companyId, probes: Array<{ id: string }>) =>
      new Map(probes.map((p) => [p.id, ids.includes(p.id) ? [HOLDER] : []])),
    )
  }

  it('row: refuses to stage, names the verifikat, and hands back the ignore to make', async () => {
    directFor(ROW.id)
    const { supabase, enqueue, findCall } = createQueuedMockSupabase()
    enqueue({ data: { ...ROW } })

    const err = (await single
      .execute({ skattekonto_transaction_id: ROW.id }, 'company-1', 'user-1', supabase as never)
      .catch((e: unknown) => e)) as Refusal

    expect(err.code).toBe('SKATTEKONTO_BOOK_LEDGER_DIRECT_EXISTS')
    expect(err.message).toContain('Händelsen finns redan i bokföringen utan skattekontot: verifikat A14 (2026-03-31)')
    expect(err.message).toContain('konto 2518 direkt mot banken')
    expect(err.remediation?.tool).toBe('gnubok_ignore_transaction')
    expect(err.remediation?.args).toEqual({ transaction_id: ROW.id })
    // Searched on the counter line the preview would show: D 2518 5000.
    expect(mockDirect.mock.calls[0][2]).toEqual([
      { id: ROW.id, transaktionsdatum: ROW.transaktionsdatum, counter: { account: '2518', net: 5000 } },
    ])
    expect(findCall('pending_operations', 'insert')).toBeUndefined()
    expect(mockBokforSingle).not.toHaveBeenCalled()
  })

  it('row: allow_duplicate with a reason stages the override, the verifikat in the preview and a reviewer warning', async () => {
    directFor(ROW.id)
    const { supabase, enqueue, findCall } = createQueuedMockSupabase()
    enqueue({ data: { ...ROW } })
    enqueue({ data: null })                // period check: company_settings
    enqueue({ data: null })                // period check: fiscal_periods
    enqueue({ data: { id: 'op-d1' } })     // pending_operations insert

    const result = (await single.execute(
      { skattekonto_transaction_id: ROW.id, allow_duplicate: true, duplicate_reason: REASON },
      'company-1', 'user-1', supabase as never,
    )) as { staged: boolean; preview: Record<string, unknown> }

    expect(result.staged).toBe(true)
    const inserted = findCall('pending_operations', 'insert')?.[0] as { params: Record<string, unknown> }
    expect(inserted.params).toEqual({ transaction_id: ROW.id, allow_duplicate: true, duplicate_reason: REASON })
    expect(result.preview.ledger_direct).toEqual([HOLDER])
    expect(String(result.preview.compliance_warning)).toContain('already book this event from the bank without 1630')
  })

  it('row: a twin answers first, the direct search never runs', async () => {
    twinsFor(ROW.id)
    directFor(ROW.id)
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { ...ROW } })

    const err = (await single
      .execute({ skattekonto_transaction_id: ROW.id }, 'company-1', 'user-1', supabase as never)
      .catch((e: unknown) => e)) as Refusal
    expect(err.code).toBe('SKATTEKONTO_BOOK_LEDGER_TWIN_EXISTS')
    expect(mockDirect).not.toHaveBeenCalled()
  })

  it('rows: held rows are skipped with LEDGER_DIRECT_EXISTS and their verifikat, one search, an allowed one staged with the override', async () => {
    directFor('skv-held', 'skv-allowed')
    const rows = [
      { ...ROW, id: 'skv-fresh' },
      { ...ROW, id: 'skv-held' },
      { ...ROW, id: 'skv-allowed' },
      { ...ROW, id: 'skv-ignored', is_ignored: true },
    ]
    const { supabase, enqueue, findCall } = createQueuedMockSupabase()
    enqueue({ data: rows })                // batch row fetch
    enqueue({ data: null })                // period check: company_settings
    enqueue({ data: null })                // period check: fiscal_periods
    enqueue({ data: { id: 'op-d2' } })     // pending_operations insert

    const result = (await batch.execute(
      {
        skattekonto_transaction_ids: rows.map((r) => r.id),
        allow_duplicate_ids: ['skv-allowed'],
        duplicate_reason: REASON,
      },
      'company-1', 'user-1', supabase as never,
    )) as { staged: boolean; preview: Record<string, unknown> }

    expect(mockDirect).toHaveBeenCalledTimes(1)
    // Only the open, settled rows with a rule are searched.
    expect((mockDirect.mock.calls[0][2] as Array<{ id: string }>).map((p) => p.id)).toEqual([
      'skv-fresh',
      'skv-held',
      'skv-allowed',
    ])
    const inserted = findCall('pending_operations', 'insert')?.[0] as { params: Record<string, unknown> }
    expect(inserted.params).toEqual({ ids: ['skv-fresh', 'skv-allowed'], allow_duplicate_ids: ['skv-allowed'], duplicate_reason: REASON })
    expect(result.preview.skipped).toEqual([
      { skattekonto_transaction_id: 'skv-held', reason: 'LEDGER_DIRECT_EXISTS', ledger_direct: [HOLDER] },
      { skattekonto_transaction_id: 'skv-ignored', reason: 'ROW_IGNORED' },
    ])
    expect(String(result.preview.compliance_warning)).toContain('already book this event from the bank')
  })

  it('rows: when every row is held nothing is staged, and the refusal names the first row\'s verifikat', async () => {
    directFor('skv-a', 'skv-b')
    const { supabase, enqueue, findCall } = createQueuedMockSupabase()
    enqueue({ data: [{ ...ROW, id: 'skv-a' }, { ...ROW, id: 'skv-b' }] })

    const err = (await batch
      .execute({ skattekonto_transaction_ids: ['skv-a', 'skv-b'] }, 'company-1', 'user-1', supabase as never)
      .catch((e: unknown) => e)) as Refusal

    expect(err.code).toBe('SKATTEKONTO_BOOK_LEDGER_DIRECT_EXISTS')
    expect(err.message).toContain('Alla 2 rader finns redan i bokföringen. Första raden: Händelsen finns redan i bokföringen utan skattekontot')
    expect(err.remediation?.args).toEqual({ transaction_id: 'skv-a' })
    expect(findCall('pending_operations', 'insert')).toBeUndefined()
  })
})
