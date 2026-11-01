/**
 * gnubok_lock_period: the staging pre-check must enforce the SAME predicate
 * as the commit path (lockPeriod in lib/core/bookkeeping/period-service.ts).
 *
 * The old inline check (journal_entry_id IS NULL AND is_business = true) was
 * dead: triage is what sets is_business, so it never matched an untriaged
 * row, and bulk-booked transactions keep journal_entry_id NULL while anchored
 * via transaction_voucher_links, so it blocked on already-booked rows. An
 * agent could stage a lock over thousands of untriaged transactions and
 * present an approval card claiming zero unbooked (BFL 5 kap 2 §).
 *
 * The corrected guard counts the rows of open_bank_rows (not ignored, not
 * private, anchored to no live verifikat, tests/pg/bank-row-open-read.pg.test.ts):
 *   - untriaged: is_business IS NULL
 *   - businessUnbooked: is_business = true
 * and fails CLOSED when the check itself cannot run.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { tools } from '../server'
import { getStructuredError } from '@/lib/errors/get-structured-error'

const lockPeriod = tools.find((t) => t.name === 'gnubok_lock_period')!

const PERIOD = {
  id: 'fp-1',
  name: 'FY 2026',
  period_start: '2026-01-01',
  period_end: '2026-12-31',
  is_closed: false,
  locked_at: null,
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('gnubok_lock_period staging guard', () => {
  // crm#1029: refuse at staging, not at approval, with the commit path's code.
  it('refuses to stage a lock of a year an SIE import still holds', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { ...PERIOD, import_hold: 'imp-1' } }) // fiscal_periods

    const err = await lockPeriod
      .execute({ fiscal_period_id: 'fp-1' }, 'company-1', 'user-1', supabase as never, { type: 'api_key' })
      .then(() => null, (e: Error) => e)

    expect(getStructuredError(err).code).toBe('PERIOD_HAS_UNFINISHED_SIE_IMPORT')
    expect(getStructuredError(err).remediation?.args).toEqual({ import_id: 'imp-1' })
    expect(err!.message).toContain('FY 2026 kan inte låsas')
    // Nothing else ran: no unbooked count, nothing staged.
    expect(supabase.from).toHaveBeenCalledTimes(1)
  })

  it('refuses to stage while untriaged transactions exist (the predicate the old check never matched)', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: PERIOD }) // fiscal_periods
    enqueue({ data: null, count: 3 }) // untriaged head-count
    enqueue({ data: null, count: 0 }) // business head-count

    await expect(
      lockPeriod.execute(
        { fiscal_period_id: 'fp-1' }, 'company-1', 'user-1', supabase as never, { type: 'api_key' },
      ),
    ).rejects.toThrow(/Kan inte låsa period: 3 banktransaktion\(er\) i perioden saknar bokföring \(3 ej hanterade\)/)

    const fromCalls = (supabase.from as ReturnType<typeof vi.fn>).mock.calls
    expect(fromCalls.some((args) => args[0] === 'pending_operations')).toBe(false)
  })

  it('keeps the load-bearing phrases for both error-code matchers', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: PERIOD })
    enqueue({ data: null, count: 1 })
    enqueue({ data: null, count: 0 })

    const err = await lockPeriod
      .execute({ fiscal_period_id: 'fp-1' }, 'company-1', 'user-1', supabase as never, { type: 'api_key' })
      .then(() => null, (e: Error) => e)

    expect(err).toBeInstanceOf(Error)
    // Route regex: "saknar bokföring"; inferCode regex:
    // /Kan inte låsa period:.*affärstransaktion/ (same phrases the
    // period-service message carries).
    expect(err!.message).toMatch(/saknar bokföring/)
    expect(err!.message).toMatch(/Kan inte låsa period:.*affärstransaktion/)
  })

  it('refuses to stage over business-triaged rows with no verifikat anchor anywhere', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: PERIOD })
    enqueue({ data: null, count: 0 }) // untriaged: none
    enqueue({ data: null, count: 1 }) // business head-count

    await expect(
      lockPeriod.execute(
        { fiscal_period_id: 'fp-1' }, 'company-1', 'user-1', supabase as never, { type: 'api_key' },
      ),
    ).rejects.toThrow(/1 markerade som affärshändelse men utan verifikat/)
  })

  it('stages the clean period: open_bank_rows holds nothing for it', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: PERIOD })
    enqueue({ data: null, count: 0 }) // untriaged: none
    enqueue({ data: null, count: 0 }) // business: none
    enqueue({ data: { id: 'op-lock-2' } }) // pending_operations insert

    const result = (await lockPeriod.execute(
      { fiscal_period_id: 'fp-1' }, 'company-1', 'user-1', supabase as never, { type: 'api_key' },
    )) as { staged: boolean; operation_id?: string; preview: Record<string, unknown> }

    expect(result.staged).toBe(true)
    expect(result.operation_id).toBe('op-lock-2')
    expect(result.preview.unbooked_business_transactions).toBe(0)
    expect(result.preview.untriaged_transactions).toBe(0)
  })

  it('fails CLOSED when the guard query errors: never stages, and the message steers to retry, not remediation', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: PERIOD })
    enqueue({ data: null, error: { message: 'connection reset' }, count: null }) // untriaged count fails

    const err = await lockPeriod
      .execute({ fiscal_period_id: 'fp-1' }, 'company-1', 'user-1', supabase as never, { type: 'api_key' })
      .then(() => null, (e: Error) => e)

    expect(err).toBeInstanceOf(Error)
    expect(err!.message).toMatch(/Kunde inte kontrollera obokförda banktransaktioner/)
    // Deliberately matches NEITHER remediation matcher: an unreachable DB
    // must not send an agent off booking transactions.
    expect(err!.message).not.toMatch(/saknar bokföring/)
    expect(err!.message).not.toMatch(/Kan inte låsa period/)

    const fromCalls = (supabase.from as ReturnType<typeof vi.fn>).mock.calls
    expect(fromCalls.some((args) => args[0] === 'pending_operations')).toBe(false)
  })
})
