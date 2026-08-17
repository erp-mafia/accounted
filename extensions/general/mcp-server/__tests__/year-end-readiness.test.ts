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

import {
  validateYearEndReadiness,
  previewYearEndClosing,
} from '@/lib/core/bookkeeping/year-end-service'

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
  const PERIOD_STATE_KINDS = new Set([
    'period_not_found',
    'period_not_ended',
    'period_already_closed',
    'closing_entry_exists',
  ])

  it('names every actionable blocker kind the tool can emit', () => {
    const tool = tools.find((t) => t.name === 'gnubok_year_end_readiness')!
    const actionable = [...new Set(Object.values(YEAR_END_BLOCKER_KIND))].filter(
      (kind) => !PERIOD_STATE_KINDS.has(kind),
    )
    // Guards the summarizing itself: if a kind stops being period-state, or a
    // new one appears, it has to show up in the description.
    expect(actionable.length).toBe(8)
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
    const supabase = makeMockSupabase({
      id: 'period-1',
      name: '2026',
      period_start: '2026-01-01',
      period_end: '2026-12-31',
      is_closed: false,
      locked_at: null,
      closing_entry_id: null,
      continuity_verified: true,
    })

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
})
