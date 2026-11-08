/**
 * Unit tests for gnubok_year_end_readiness.
 *
 * Covers tool registration, scope mapping, and the blocker-kind classification
 * that turns the lib's coded blockers into structured agent-friendly entries.
 * Full integration with validateYearEndReadiness is covered by
 * lib/core/bookkeeping tests + the manual MCP smoke test.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { tools, YEAR_END_BLOCKER_KIND } from '../server'
import { TOOL_SCOPE_MAP } from '@/lib/auth/api-keys'

vi.mock('@/lib/core/bookkeeping/year-end-service', () => ({
  validateYearEndReadiness: vi.fn(),
  previewYearEndClosing: vi.fn(),
}))

vi.mock('@/lib/bokslut/dispositions-proposal-builder', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/bokslut/dispositions-proposal-builder')>()),
  bolagsskattOnLedger: vi.fn(),
}))

import {
  validateYearEndReadiness,
  previewYearEndClosing,
} from '@/lib/core/bookkeeping/year-end-service'
import { bolagsskattOnLedger } from '@/lib/bokslut/dispositions-proposal-builder'

describe('gnubok_year_end_readiness: registration', () => {
  it('is registered in the tools array', () => {
    const tool = tools.find((t) => t.name === 'gnubok_year_end_readiness')
    expect(tool).toBeDefined()
    expect(tool?.annotations.readOnlyHint).toBe(true)
    expect(tool?.annotations.destructiveHint).toBe(false)
    expect(tool?.annotations.idempotentHint).toBe(true)
  })

  it('requires fiscal_period_id', () => {
    const tool = tools.find((t) => t.name === 'gnubok_year_end_readiness')!
    const schema = tool.inputSchema as { required?: string[] }
    expect(schema.required).toContain('fiscal_period_id')
  })

  it('declares output schema with intent fields', () => {
    const tool = tools.find((t) => t.name === 'gnubok_year_end_readiness')!
    const schema = tool.outputSchema as { required?: string[] }
    expect(schema.required).toContain('ready')
    expect(schema.required).toContain('blockers')
    expect(schema.required).toContain('warnings')
    expect(schema.required).toContain('summary')
  })

  it('is mapped to reports:read scope', () => {
    expect(TOOL_SCOPE_MAP.gnubok_year_end_readiness).toBe('reports:read')
  })

  // The description is the only thing an agent reads before deciding what to
  // pre-check, and the 280-char budget does not fit all eleven kinds. It must
  // therefore name every kind the caller can DO something about ahead of time;
  // the four period-state kinds are summarized, since nothing can be
  // pre-checked about them.
  // period_locked joins them: its blocker message already says what to do
  // (unlock; run_year_end locks the period itself), and tools/list sits a
  // handful of tokens under its ceiling (payload-size.bench.test.ts), so the
  // description keeps summarizing it as period-state instead of naming it.
  const PERIOD_STATE_KINDS = new Set([
    'period_not_found',
    'period_not_ended',
    'period_already_closed',
    'period_locked',
    'closing_entry_exists',
    // Same reasoning as period_locked: the message says what releases the
    // year (finish or undo the SIE import), and tools/list has no room.
    'sie_import_unfinished',
    // A year's dates only a person can settle: nothing to pre-check.
    'next_period_not_calendar_year',
    'next_period_overlaps',
  ])

  it('maps the PERIOD_LOCKED readiness code to the period_locked kind', () => {
    expect(YEAR_END_BLOCKER_KIND.PERIOD_LOCKED).toBe('period_locked')
  })

  // Both directions of a prior result on the result account share one kind
  // (the description budget names every kind verbatim); the message says
  // which way to correct.
  it('maps an over-disposed prior result to the prior_result_left kind', () => {
    expect(YEAR_END_BLOCKER_KIND.PRIOR_RESULT_OVER_DISPOSED).toBe('prior_result_left')
    expect(YEAR_END_BLOCKER_KIND.PRIOR_RESULT_NOT_DISPOSED).toBe('prior_result_left')
  })

  it('names every actionable blocker kind the tool can emit', () => {
    const tool = tools.find((t) => t.name === 'gnubok_year_end_readiness')!
    const actionable = [...new Set(Object.values(YEAR_END_BLOCKER_KIND))].filter(
      (kind) => !PERIOD_STATE_KINDS.has(kind),
    )
    // Guards the summarizing itself: if a kind stops being period-state, or a
    // new one appears, it has to show up in the description.
    expect(actionable.length).toBe(9)
    for (const kind of actionable) {
      expect(tool.description, `blocker kind ${kind} missing from description`).toContain(kind)
    }
    expect(tool.description).toContain('period-state')
  })

  it('names unbooked transactions as the most common blocker', () => {
    // The omission that sent agents pre-checking the wrong things: this is the
    // blocker a real close trips on, and the description never mentioned it.
    const tool = tools.find((t) => t.name === 'gnubok_year_end_readiness')!
    expect(tool.description).toMatch(/unbooked_transactions \(most common\)/)
  })

  it('does not present open foreign-currency items as a blocker', () => {
    // validateYearEndReadiness pushes those onto `warnings`, never `blockers`:
    // executeYearEndClosing runs the revaluation itself, so escalating would
    // block a close that the very next step performs.
    const tool = tools.find((t) => t.name === 'gnubok_year_end_readiness')!
    expect(tool.description).toMatch(/FX = warning, never blocker/)
    expect(tool.description).not.toMatch(/[Bb]lockers[^.]*revaluation/)
  })
})

function makeMockSupabase(period: Record<string, unknown> | null) {
  return {
    from: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue({ data: period, error: null }),
          }),
        }),
      }),
    }),
  } as never
}

/**
 * The period read ends in .single(); the draft list (agent feedback seq
 * 978933) is awaited after .order().limit(). Records the draft query's
 * filters so a test can assert it lists only this period's drafts.
 */
function makeMockSupabaseWithDrafts(
  period: Record<string, unknown> | null,
  drafts: Array<Record<string, unknown>>,
) {
  const draftFilters: Array<[string, unknown]> = []
  let draftLimit: number | undefined
  const from = vi.fn((table: string) => {
    const chain: Record<string, unknown> = {}
    chain.select = vi.fn(() => chain)
    chain.eq = vi.fn((column: string, value: unknown) => {
      if (table === 'journal_entries') draftFilters.push([column, value])
      return chain
    })
    chain.order = vi.fn(() => chain)
    chain.limit = vi.fn((n: number) => {
      draftLimit = n
      return Promise.resolve({ data: drafts, error: null })
    })
    chain.single = vi.fn().mockResolvedValue({ data: period, error: null })
    return chain
  })
  return { supabase: { from } as never, draftFilters, draftLimit: () => draftLimit, from }
}

describe('gnubok_year_end_readiness: execute', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('classifies blocker codes into structured kinds', async () => {
    vi.mocked(validateYearEndReadiness).mockResolvedValue({
      ready: false,
      blockers: [
        { code: 'DRAFT_ENTRIES', message: '3 utkast måste bokföras eller raderas innan bokslut' },
        { code: 'UNEXPLAINED_VOUCHER_GAP', message: 'Oförklarat verifikationsnummerglapp i serie A: 5-7' },
        { code: 'TRIAL_BALANCE_UNBALANCED', message: 'Råbalansen balanserar inte: debet=100, kredit=200' },
        // Classification is by code, so an off-wording message (here the legacy
        // English one) must still land on sequence_mismatch.
        { code: 'SEQUENCE_COUNTER_BEHIND', message: 'Sequence counter integrity error in series A: counter=3 but max voucher=5' },
        { code: 'UNBOOKED_TRANSACTIONS', message: '3 transaktioner i perioden saknar bokföring: bokför dem eller markera dem som privata innan bokslut' },
        // The fail-closed variant shares the kind: an agent reacts to both by
        // going to look at the transactions and re-running readiness.
        { code: 'UNBOOKED_CHECK_FAILED', message: 'Kontrollen av obokförda transaktioner kunde inte genomföras: försök igen' },
      ],
      errors: [
        '3 utkast måste bokföras eller raderas innan bokslut',
        'Oförklarat verifikationsnummerglapp i serie A: 5-7',
        'Råbalansen balanserar inte: debet=100, kredit=200',
        'Sequence counter integrity error in series A: counter=3 but max voucher=5',
        '3 transaktioner i perioden saknar bokföring: bokför dem eller markera dem som privata innan bokslut',
        'Kontrollen av obokförda transaktioner kunde inte genomföras: försök igen',
      ],
      warnings: ['Inga bokförda verifikationer i perioden'],
      draftCount: 3,
      voucherGaps: [{ series: 'A', gap_start: 5, gap_end: 7 }],
      unexplainedGaps: [{ series: 'A', gap_start: 5, gap_end: 7 }],
      sequenceMismatches: [{ series: 'A', sequenceCounter: 3, actualMax: 5 }],
      trialBalanceBalanced: false,
    })

    const tool = tools.find((t) => t.name === 'gnubok_year_end_readiness')!
    const { supabase } = makeMockSupabaseWithDrafts(
      {
        id: 'period-1',
        name: '2026',
        period_start: '2026-01-01',
        period_end: '2026-12-31',
        is_closed: false,
        locked_at: null,
        closing_entry_id: null,
        continuity_verified: true,
      },
      [],
    )

    const result = (await tool.execute(
      { fiscal_period_id: 'period-1' },
      'company-1',
      'user-1',
      supabase,
    )) as { ready: boolean; blockers: { kind: string }[]; summary: string }

    expect(result.ready).toBe(false)
    const kinds = result.blockers.map((b) => b.kind)
    expect(kinds).toEqual([
      'draft_entries',
      'unexplained_voucher_gap',
      'trial_balance_unbalanced',
      'sequence_mismatch',
      'unbooked_transactions',
      'unbooked_transactions',
    ])
    expect(kinds).not.toContain('other')
    expect(result.summary).toMatch(/Inte klart/)
  })

  it('falls back to the wording heuristic for an unmapped blocker code', async () => {
    vi.mocked(validateYearEndReadiness).mockResolvedValue({
      ready: false,
      // A code the kind map does not know yet (a future blocker shipped
      // without a map entry): the message heuristic must still route it.
      blockers: [
        { code: 'SOME_FUTURE_CODE' as never, message: 'Råbalansen balanserar inte: debet=100, kredit=200' },
        { code: 'ANOTHER_FUTURE_CODE' as never, message: 'Något helt nytt gick fel' },
      ],
      errors: [
        'Råbalansen balanserar inte: debet=100, kredit=200',
        'Något helt nytt gick fel',
      ],
      warnings: [],
      draftCount: 0,
      voucherGaps: [],
      unexplainedGaps: [],
      sequenceMismatches: [],
      trialBalanceBalanced: false,
    })

    const tool = tools.find((t) => t.name === 'gnubok_year_end_readiness')!
    const supabase = makeMockSupabase({
      id: 'period-1', name: '2026',
      period_start: '2026-01-01', period_end: '2026-12-31',
      is_closed: false, locked_at: null, closing_entry_id: null, continuity_verified: true,
    })

    const result = (await tool.execute(
      { fiscal_period_id: 'period-1' },
      'company-1', 'user-1', supabase,
    )) as { blockers: { kind: string }[] }

    expect(result.blockers.map((b) => b.kind)).toEqual(['trial_balance_unbalanced', 'other'])
  })

  it('skips preview when not requested even if ready', async () => {
    vi.mocked(validateYearEndReadiness).mockResolvedValue({
      ready: true,
      blockers: [],
      errors: [],
      warnings: [],
      draftCount: 0,
      voucherGaps: [],
      unexplainedGaps: [],
      sequenceMismatches: [],
      trialBalanceBalanced: true,
    })

    const tool = tools.find((t) => t.name === 'gnubok_year_end_readiness')!
    const supabase = makeMockSupabase({
      id: 'period-1', name: '2026',
      period_start: '2026-01-01', period_end: '2026-12-31',
      is_closed: false, locked_at: null, closing_entry_id: null, continuity_verified: true,
    })

    const result = (await tool.execute(
      { fiscal_period_id: 'period-1' },
      'company-1', 'user-1', supabase,
    )) as { ready: boolean; preview: unknown; summary: string }

    expect(result.ready).toBe(true)
    expect(result.preview).toBeNull()
    expect(vi.mocked(previewYearEndClosing)).not.toHaveBeenCalled()
    expect(result.summary).toMatch(/Klart för bokslut/)
  })

  it('returns the preview when include_preview=true and ready', async () => {
    vi.mocked(validateYearEndReadiness).mockResolvedValue({
      ready: true,
      blockers: [],
      errors: [],
      warnings: [],
      draftCount: 0,
      voucherGaps: [],
      unexplainedGaps: [],
      sequenceMismatches: [],
      trialBalanceBalanced: true,
    })
    vi.mocked(previewYearEndClosing).mockResolvedValue({
      net_result: 12345,
      closing_account: '2099',
      lines: [],
    } as never)

    const tool = tools.find((t) => t.name === 'gnubok_year_end_readiness')!
    const supabase = makeMockSupabase({
      id: 'period-1', name: '2026',
      period_start: '2026-01-01', period_end: '2026-12-31',
      is_closed: false, locked_at: null, closing_entry_id: null, continuity_verified: true,
    })

    const result = (await tool.execute(
      { fiscal_period_id: 'period-1', include_preview: true },
      'company-1', 'user-1', supabase,
    )) as { preview: { net_result?: number } | null }

    expect(result.preview).not.toBeNull()
    expect(result.preview?.net_result).toBe(12345)
  })

  // Feedback seq 707985: the preview discloses the omföring the close books in
  // the next period, including when it will skip it (built by
  // previewYearEndClosing; the tool passes it through untouched).
  it('passes the disclosed omföring through in the preview', async () => {
    vi.mocked(validateYearEndReadiness).mockResolvedValue({
      ready: true,
      blockers: [],
      errors: [],
      warnings: [],
      draftCount: 0,
      voucherGaps: [],
      unexplainedGaps: [],
      sequenceMismatches: [],
      trialBalanceBalanced: true,
    })
    const resultAppropriation = {
      from_account: '2069',
      to_account: '2068',
      amount: 0,
      direction: 'profit',
      entry_date: '2025-01-01',
      skipped_reason: 'already_disposed',
      disposed_by: ['A1172'],
    }
    vi.mocked(previewYearEndClosing).mockResolvedValue({ netResult: 35059.47, resultAppropriation } as never)

    const tool = tools.find((t) => t.name === 'gnubok_year_end_readiness')!
    const supabase = makeMockSupabase({
      id: 'period-1', name: '2024',
      period_start: '2024-01-01', period_end: '2024-12-31',
      is_closed: false, locked_at: null, closing_entry_id: null, continuity_verified: true,
    })

    const result = (await tool.execute(
      { fiscal_period_id: 'period-1', include_preview: true },
      'company-1', 'user-1', supabase,
    )) as { preview: { resultAppropriation?: unknown } | null }

    expect(result.preview?.resultAppropriation).toEqual(resultAppropriation)
  })

  // Agent feedback seq 978933: readiness reported draft_count=1 and nothing an
  // agent could act on. It now lists the drafts by id, so each one can be
  // cancelled with gnubok_cancel_draft_entry or committed.
  it('lists the drafts behind DRAFT_ENTRIES by id, capped at 20, for this period only', async () => {
    vi.mocked(validateYearEndReadiness).mockResolvedValue({
      ready: false,
      blockers: [{ code: 'DRAFT_ENTRIES', message: '2 utkast måste bokföras eller raderas innan bokslut' }],
      errors: ['2 utkast måste bokföras eller raderas innan bokslut'],
      warnings: [],
      draftCount: 2,
      voucherGaps: [],
      unexplainedGaps: [],
      sequenceMismatches: [],
      trialBalanceBalanced: true,
    })
    const mock = makeMockSupabaseWithDrafts(
      {
        id: 'period-1', name: '2026',
        period_start: '2026-01-01', period_end: '2026-12-31',
        is_closed: false, locked_at: null, closing_entry_id: null, continuity_verified: true,
      },
      [
        { id: 'draft-1', voucher_series: 'A', entry_date: '2026-03-01', description: 'Hyra mars', source_type: 'manual', created_at: '2026-03-01T08:00:00Z' },
        { id: 'draft-2', voucher_series: 'A', entry_date: '2026-04-01', description: 'Hyra april', source_type: 'manual', created_at: '2026-04-01T08:00:00Z' },
      ],
    )

    const tool = tools.find((t) => t.name === 'gnubok_year_end_readiness')!
    const result = (await tool.execute(
      { fiscal_period_id: 'period-1' },
      'company-1', 'user-1', mock.supabase,
    )) as {
      draft_count: number
      drafts: Array<Record<string, unknown>>
      blockers: Array<{ kind: string; remediation?: { tool?: string } }>
    }

    expect(result.draft_count).toBe(2)
    expect(result.blockers[0]).toMatchObject({
      kind: 'draft_entries',
      remediation: { tool: 'gnubok_cancel_draft_entry' },
    })
    expect(result.drafts).toEqual([
      { journal_entry_id: 'draft-1', voucher_series: 'A', entry_date: '2026-03-01', description: 'Hyra mars', source_type: 'manual', created_at: '2026-03-01T08:00:00Z' },
      { journal_entry_id: 'draft-2', voucher_series: 'A', entry_date: '2026-04-01', description: 'Hyra april', source_type: 'manual', created_at: '2026-04-01T08:00:00Z' },
    ])
    expect(mock.draftFilters).toEqual(
      expect.arrayContaining([
        ['company_id', 'company-1'],
        ['fiscal_period_id', 'period-1'],
        ['status', 'draft'],
      ]),
    )
    expect(mock.draftLimit()).toBe(20)
  })

  it('skips the draft read and answers an empty list when there are no drafts', async () => {
    vi.mocked(validateYearEndReadiness).mockResolvedValue({
      ready: true,
      blockers: [],
      errors: [],
      warnings: [],
      draftCount: 0,
      voucherGaps: [],
      unexplainedGaps: [],
      sequenceMismatches: [],
      trialBalanceBalanced: true,
    })
    const mock = makeMockSupabaseWithDrafts(
      {
        id: 'period-1', name: '2026',
        period_start: '2026-01-01', period_end: '2026-12-31',
        is_closed: false, locked_at: null, closing_entry_id: null, continuity_verified: true,
      },
      [],
    )

    const tool = tools.find((t) => t.name === 'gnubok_year_end_readiness')!
    const result = (await tool.execute(
      { fiscal_period_id: 'period-1' },
      'company-1', 'user-1', mock.supabase,
    )) as { drafts: unknown[] }

    expect(result.drafts).toEqual([])
    expect(mock.from).not.toHaveBeenCalledWith('journal_entries')
  })
})

/**
 * crm#1726: the readiness preview said bolagsskattMissing for a profit year
 * whose tax, with its ej skattepliktiga intäkter and underskott, is 0 kr. The
 * web preview drops the flag on that real state (accounted#180); so does the
 * tool now.
 */
describe('gnubok_year_end_readiness: bolagsskattMissing is real state only', () => {
  const ready = () =>
    vi.mocked(validateYearEndReadiness).mockResolvedValue({
      ready: true,
      blockers: [],
      errors: [],
      warnings: [],
      draftCount: 0,
      voucherGaps: [],
      unexplainedGaps: [],
      sequenceMismatches: [],
      trialBalanceBalanced: true,
    })
  const run = async () => {
    const tool = tools.find((t) => t.name === 'gnubok_year_end_readiness')!
    const supabase = makeMockSupabase({
      id: 'period-1', name: '2025',
      period_start: '2025-01-01', period_end: '2025-12-31',
      is_closed: false, locked_at: null, closing_entry_id: null, continuity_verified: true,
    })
    return (await tool.execute(
      { fiscal_period_id: 'period-1', include_preview: true },
      'company-1', 'user-1', supabase,
    )) as { preview: { bolagsskattMissing?: boolean } | null }
  }

  beforeEach(() => {
    vi.mocked(bolagsskattOnLedger).mockReset()
    ready()
    vi.mocked(previewYearEndClosing).mockResolvedValue({ netResult: 50_000, bolagsskattMissing: true } as never)
  })

  it('drops the flag when the tax on the ledger is 0 kr', async () => {
    vi.mocked(bolagsskattOnLedger).mockResolvedValue(0)
    const result = await run()
    expect(result.preview?.bolagsskattMissing).toBe(false)
    expect(bolagsskattOnLedger).toHaveBeenCalledWith(expect.anything(), 'company-1', 'period-1')
  })

  it('keeps the flag when the ledger carries tax', async () => {
    vi.mocked(bolagsskattOnLedger).mockResolvedValue(10_300)
    expect((await run()).preview?.bolagsskattMissing).toBe(true)
  })

  it('keeps the flag when the tax check fails', async () => {
    vi.mocked(bolagsskattOnLedger).mockRejectedValue(new Error('trial balance unavailable'))
    expect((await run()).preview?.bolagsskattMissing).toBe(true)
  })

  it('does not compute the tax when the preview raises no tax line', async () => {
    vi.mocked(previewYearEndClosing).mockResolvedValue({ netResult: -100, bolagsskattMissing: false } as never)
    await run()
    expect(bolagsskattOnLedger).not.toHaveBeenCalled()
  })
})
