/**
 * Unit tests for gnubok_year_end_readiness.
 *
 * Covers tool registration, scope mapping, and the blocker-kind classification
 * heuristic that turns the lib's flat error strings into structured agent-
 * friendly entries. Full integration with validateYearEndReadiness is covered
 * by lib/core/bookkeeping tests + the manual MCP smoke test.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { tools } from '../server'
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

  it('classifies common error strings into structured kinds', async () => {
    vi.mocked(validateYearEndReadiness).mockResolvedValue({
      ready: false,
      errors: [
        '3 draft journal entries must be posted or deleted before closing',
        'Unexplained voucher gap in series A: 5-7',
        'Trial balance is not balanced: debit=100, credit=200',
        'Sequence counter integrity error in series A: counter=3 but max voucher=5',
      ],
      warnings: ['No posted journal entries in this period'],
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
    expect(kinds).toContain('draft_entries')
    expect(kinds).toContain('unexplained_voucher_gap')
    expect(kinds).toContain('sequence_mismatch')
    expect(kinds).toContain('trial_balance_unbalanced')
    expect(result.summary).toMatch(/Inte klart/)
  })

  it('skips preview when not requested even if ready', async () => {
    vi.mocked(validateYearEndReadiness).mockResolvedValue({
      ready: true,
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
