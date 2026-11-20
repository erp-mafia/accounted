/**
 * gnubok_run_year_end: the staged preview names the closing account the
 * year-end service will actually post to (resultClosingAccounts(form)), so
 * the approval card never promises 2099 to a form that closes elsewhere.
 * The description stays account-agnostic for the same reason.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import type { ResultAppropriationPreview } from '@/types'

// The omföring disclosure comes from previewYearEndClosing (covered in
// lib/core/bookkeeping tests); here only what the approval card makes of it.
vi.mock('@/lib/core/bookkeeping/year-end-service', () => ({
  validateYearEndReadiness: vi.fn(),
  previewYearEndClosing: vi.fn(),
}))

import { tools } from '../server'
import { getStructuredError } from '@/lib/errors/get-structured-error'
import { getErrorEntry } from '@/lib/errors/structured-errors'
import { previewYearEndClosing } from '@/lib/core/bookkeeping/year-end-service'

const runYearEnd = tools.find((t) => t.name === 'gnubok_run_year_end')!

const PERIOD = {
  id: 'fp-1',
  name: 'Räkenskapsår 2026',
  period_start: '2026-01-01',
  period_end: '2026-12-31',
  is_closed: false,
  locked_at: null,
}

type Staged = { staged: boolean; preview: Record<string, unknown> }

async function stageFor(entityType: string): Promise<Staged> {
  const { supabase, enqueue } = createQueuedMockSupabase()
  enqueue({ data: PERIOD }) // fiscal_periods
  enqueue({ data: { bookkeeping_locked_through: null } }) // company_settings (the lock on the year's last day)
  enqueue({ data: PERIOD }) // fiscal_periods (the period covering it)
  enqueue({ data: { entity_type: entityType } }) // companies (resolveCompanyEntityType)
  enqueue({ data: { id: 'op-1' } }) // pending_operations insert
  return (await runYearEnd.execute(
    { fiscal_period_id: 'fp-1' },
    'company-1',
    'user-1',
    supabase as never,
    { type: 'api_key' },
  )) as Staged
}

function omforing(overrides: Partial<ResultAppropriationPreview> = {}): ResultAppropriationPreview {
  return {
    from_account: '2099',
    to_account: '2098',
    amount: 150000,
    direction: 'profit',
    entry_date: '2027-01-01',
    skipped_reason: null,
    disposed_by: [],
    ...overrides,
  }
}

function previewWith(resultAppropriation: ResultAppropriationPreview | null) {
  vi.mocked(previewYearEndClosing).mockResolvedValue({ resultAppropriation } as never)
}

beforeEach(() => {
  vi.clearAllMocks()
  previewWith(null)
})

describe('gnubok_run_year_end: form-aware preview', () => {
  it('keeps the description free of a specific account', () => {
    expect(runYearEnd.description).not.toContain('2099')
    expect(runYearEnd.description).toMatch(/result account/)
  })

  it('names 2069 Årets resultat for an ideell förening', async () => {
    const result = await stageFor('ideell_forening')
    expect(result.staged).toBe(true)
    expect(result.preview.closing_account).toBe('2069')
    expect(result.preview.closing_account_name).toBe('Årets resultat')
    expect(String(result.preview.will)).toMatch(/into 2069 Årets resultat/)
    expect(String(result.preview.will)).not.toContain('2099')
  })

  it('still names 2099 for an aktiebolag', async () => {
    const result = await stageFor('aktiebolag')
    expect(result.preview.closing_account).toBe('2099')
    expect(String(result.preview.will)).toMatch(/into 2099/)
  })

  it('refuses to stage when the company form is unknown instead of defaulting it', async () => {
    await expect(stageFor('handelsbolag')).rejects.toThrow(/Unknown company entity_type/)
  })
})

// The closing entry is dated the year's last day: a company lock date on or
// after it (where the automatic lock puts it) refused the close at approval.
describe('gnubok_run_year_end: the company lock date over the year\'s last day', () => {
  async function stageWithLockDate(lockedThrough: string) {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: PERIOD }) // fiscal_periods
    enqueue({ data: { bookkeeping_locked_through: lockedThrough } }) // company_settings
    enqueue({ data: PERIOD }) // fiscal_periods (the period covering the date)
    enqueue({ data: { entity_type: 'aktiebolag' } }) // companies
    enqueue({ data: { id: 'op-1' } }) // pending_operations insert
    const staging = runYearEnd.execute({ fiscal_period_id: 'fp-1' }, 'company-1', 'user-1', supabase as never, { type: 'api_key' })
    return { staging, staged: () => findCalls('pending_operations', 'insert') }
  }

  it('refuses to stage, naming the lock date and the tool that moves it', async () => {
    const { staging, staged } = await stageWithLockDate('2026-12-31')

    const refusal = await staging.then(
      () => null,
      (err: unknown) => err,
    )
    expect(refusal).toMatchObject({ code: 'YEAR_END_COMPANY_LOCK_DATE' })
    expect((refusal as Error).message).toMatch(/company lock date \(2026-12-31\).*gnubok_update_bookkeeping_lock.*auto_lock_period_days/)
    // What the agent and the user read: the English text as thrown, the
    // registry's Swedish sentence beside it, and the tool that moves the date.
    const structured = getStructuredError(refusal)
    expect(structured.code).toBe('YEAR_END_COMPANY_LOCK_DATE')
    expect(structured.message_sv).toBe(getErrorEntry('YEAR_END_COMPANY_LOCK_DATE')!.message_sv)
    expect(structured.message_en).toBe((refusal as Error).message)
    expect(structured.remediation?.tool).toBe('gnubok_update_bookkeeping_lock')
    expect(staged()).toHaveLength(0)
  })

  it('stages when the lock date is the day before', async () => {
    const { staging, staged } = await stageWithLockDate('2026-12-30')

    expect(((await staging) as Staged).staged).toBe(true)
    expect(staged()).toHaveLength(1)
  })
})

// Feedback seq 707985: approving run_year_end also booked an omföring in the
// next period that the card never mentioned. The card now discloses it.
describe('gnubok_run_year_end: discloses the omföring into the next period', () => {
  it('names the omföring, its accounts, amount and date for an aktiebolag', async () => {
    previewWith(omforing())

    const result = await stageFor('aktiebolag')

    expect(result.preview.result_appropriation).toEqual(omforing())
    expect(String(result.preview.will)).toMatch(
      /then book the omföring 2099 → 2098 of about 150000 on 2027-01-01/,
    )
    expect(previewYearEndClosing).toHaveBeenCalledWith(expect.anything(), 'company-1', 'user-1', 'fp-1')
  })

  it('names 2069 -> 2068 for an ideell förening, never 2099', async () => {
    previewWith(omforing({ from_account: '2069', to_account: '2068', amount: 35059.47 }))

    const result = await stageFor('ideell_forening')

    expect(result.preview.result_appropriation).toMatchObject({ from_account: '2069', to_account: '2068' })
    expect(String(result.preview.will)).toMatch(/omföring 2069 → 2068 of about 35059.47/)
    expect(String(result.preview.will)).not.toContain('2099')
  })

  it('says no omföring will be booked when the next period already disposes the result', async () => {
    previewWith(
      omforing({
        from_account: '2069',
        to_account: '2068',
        amount: 0,
        skipped_reason: 'already_disposed',
        disposed_by: ['A1172'],
      }),
    )

    const result = await stageFor('ideell_forening')

    expect(result.preview.result_appropriation).toMatchObject({
      skipped_reason: 'already_disposed',
      disposed_by: ['A1172'],
    })
    expect(String(result.preview.will)).toMatch(/no omföring 2069 → 2068: already disposed by A1172/)
    expect(String(result.preview.will)).not.toMatch(/then book the omföring/)
  })

  it('adds nothing, and skips the preview, for a form without an omföring (enskild firma)', async () => {
    const result = await stageFor('enskild_firma')

    expect(result.preview.result_appropriation).toBeNull()
    expect(String(result.preview.will)).not.toMatch(/omföring/)
    expect(previewYearEndClosing).not.toHaveBeenCalled()
  })
})
