import { beforeEach, describe, expect, it, vi } from 'vitest'

// #3440 interim block, staging door and agent-facing guidance. The suspension
// module is NOT mocked: these tests pin the switch as shipped. The fix PR
// deletes this file with lib/core/bookkeeping/kontantmetod-cutoff-suspension.ts.

vi.mock('@/lib/core/bookkeeping/kontantmetod-cutoff', async () => {
  const actual = await vi.importActual<
    typeof import('@/lib/core/bookkeeping/kontantmetod-cutoff')
  >('@/lib/core/bookkeeping/kontantmetod-cutoff')
  return { ...actual, assessKontantmetodCutoff: vi.fn() }
})

vi.mock('@/lib/core/bookkeeping/year-end-service', async () => {
  const actual = await vi.importActual<
    typeof import('@/lib/core/bookkeeping/year-end-service')
  >('@/lib/core/bookkeeping/year-end-service')
  return { ...actual, validateYearEndReadiness: vi.fn() }
})

import { tools } from '../server'
import { toToolError } from '../tool-result'
import { assessKontantmetodCutoff } from '@/lib/core/bookkeeping/kontantmetod-cutoff'
import { validateYearEndReadiness } from '@/lib/core/bookkeeping/year-end-service'
import { getErrorEntry } from '@/lib/errors/structured-errors'
import { yearEndCloseSkill } from '@/lib/agent-skills/workflows/year-end-close'

const cutoffTool = tools.find((candidate) => candidate.name === 'gnubok_post_kontantmetod_cutoff')!
const readinessTool = tools.find((candidate) => candidate.name === 'gnubok_year_end_readiness')!

function makeRecordingSupabase(rows: Record<string, unknown> = {}) {
  const inserts: unknown[] = []
  const from = vi.fn((table: string) => {
    const chain: Record<string, unknown> = {}
    for (const name of ['select', 'eq', 'in', 'order', 'limit']) chain[name] = () => chain
    chain.insert = (value: unknown) => {
      inserts.push(value)
      return chain
    }
    chain.maybeSingle = async () => ({ data: rows[table] ?? null, error: null })
    chain.single = async () => ({ data: rows[table] ?? null, error: null })
    return chain
  })
  return { auth: {}, from, inserts }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('kontantmetoden cut-off suspension (#3440): staging door', () => {
  it('refuses to stage before any read, with the structured code', async () => {
    const supabase = makeRecordingSupabase()
    let thrown: unknown
    try {
      await cutoffTool.execute(
        { fiscal_period_id: 'fp-1' }, 'company-1', 'user-1', supabase as never, { type: 'api_key' },
      )
    } catch (err) {
      thrown = err
    }

    expect(thrown).toBeInstanceOf(Error)
    expect((thrown as { code?: string }).code).toBe('KONTANTMETOD_CUTOFF_SUSPENDED')
    expect(supabase.from).not.toHaveBeenCalled()
    expect(supabase.inserts).toHaveLength(0)
    expect(assessKontantmetodCutoff).not.toHaveBeenCalled()
  })

  it('answers an envelope an agent can act on: not retryable, no manual workaround', async () => {
    const err = await cutoffTool
      .execute({ fiscal_period_id: 'fp-1' }, 'company-1', 'user-1', makeRecordingSupabase() as never)
      .catch((e: unknown) => e)
    const { error } = toToolError(err, { toolName: cutoffTool.name })

    expect(error.code).toBe('KONTANTMETOD_CUTOFF_SUSPENDED')
    expect(error.retryable).toBe(false)
    expect(error.message_en).toMatch(/temporarily suspended/)
    expect(error.message_en).toMatch(/#3440/)
    expect(error.message_en).toMatch(/Do not book .* by hand/)
    expect(error.message_sv).toBe(getErrorEntry('KONTANTMETOD_CUTOFF_SUSPENDED')?.message_sv)
    expect(error.remediation?.description).toMatch(/do not work around it/)
    expect(error.remediation?.description).toMatch(/waits/)
  })

  it('says so in its description, within the description budget', () => {
    expect(cutoffTool.description).toMatch(/^TEMPORARILY SUSPENDED \(#3440\)/)
    expect(cutoffTool.description).toContain('KONTANTMETOD_CUTOFF_SUSPENDED')
    expect(cutoffTool.description.length).toBeLessThanOrEqual(280)
  })
})

describe('kontantmetoden cut-off suspension (#3440): registry entry', () => {
  it('is a permanent 409 refusal in both languages', () => {
    const entry = getErrorEntry('KONTANTMETOD_CUTOFF_SUSPENDED')
    expect(entry).toMatchObject({ httpStatus: 409, retryable: false })
    expect(entry?.message_sv).toMatch(/tillfälligt avstängd/)
    expect(entry?.message_sv).toMatch(/Bokför inte .* manuellt/)
    expect(entry?.message_en).toMatch(/temporarily suspended/)
  })
})

describe('kontantmetoden cut-off suspension (#3440): agent guidance', () => {
  it('gnubok_year_end_readiness attaches the suspension code and remediation to the cut-off blocker only', async () => {
    vi.mocked(validateYearEndReadiness).mockResolvedValue({
      ready: false,
      blockers: [
        { code: 'KONTANTMETOD_CUTOFF_REQUIRED', message: 'cut-off' },
        { code: 'DRAFT_ENTRIES', message: 'drafts' },
      ],
      errors: ['cut-off', 'drafts'],
      warnings: [],
      draftCount: 1,
      voucherGaps: [],
      unexplainedGaps: [],
      sequenceMismatches: [],
      trialBalanceBalanced: true,
    } as never)
    const supabase = makeRecordingSupabase({
      fiscal_periods: {
        id: 'fp-1', name: '2026', period_start: '2026-01-01', period_end: '2026-12-31',
        is_closed: false, locked_at: null, closing_entry_id: null, continuity_verified: true,
      },
    })

    const result = (await readinessTool.execute(
      { fiscal_period_id: 'fp-1' }, 'company-1', 'user-1', supabase as never,
    )) as { blockers: Array<Record<string, unknown>> }

    const [cutoff, drafts] = result.blockers
    expect(cutoff).toMatchObject({
      kind: 'kontantmetod_cutoff_required',
      error_code: 'KONTANTMETOD_CUTOFF_SUSPENDED',
      remediation: getErrorEntry('KONTANTMETOD_CUTOFF_SUSPENDED')?.remediation,
    })
    expect(drafts).not.toHaveProperty('error_code')
    expect(drafts).not.toHaveProperty('remediation')
  })

  it('the year-end-close skill no longer tells an agent to stage the cut-off', () => {
    expect(yearEndCloseSkill.body).toContain('KONTANTMETOD_CUTOFF_SUSPENDED')
    expect(yearEndCloseSkill.body).toMatch(/Temporarily suspended \(#3440\)/)
    expect(yearEndCloseSkill.body).not.toContain('stage it through `gnubok_stage_tool({ tool: "gnubok_post_kontantmetod_cutoff"')
    expect(yearEndCloseSkill.body).not.toContain('| Step 3 below. |')
  })
})
