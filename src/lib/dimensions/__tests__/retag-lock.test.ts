/**
 * The lock check a retag asks before the write (lib/dimensions/retag-lock.ts):
 * why a posted line's dimension tags cannot change, read from the same period
 * verdict every other door reads (periodLockVerdict). The preview and the
 * commit both call retagBlockOf, so what this pins is what both answer.
 *
 * The RPC that enforces the same rule at the write is covered by
 * tests/pg/dimension-retag.pg.test.ts.
 */
import { describe, expect, it } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { periodLockVerdict } from '@/lib/core/bookkeeping/period-status'
import { fetchRetagLockFacts, retagBlockOf, type RetagLockFacts } from '../retag-lock'
import { describeRetagFailureGroup, groupRetagFailures, partialRetagWarning } from '../retag-service'

const OPEN = { id: 'period-open', is_closed: false, locked_at: null }
const LOCKED = { id: 'period-locked', is_closed: false, locked_at: '2026-02-01T00:00:00Z' }
const CLOSED = { id: 'period-closed', is_closed: true, locked_at: '2026-02-01T00:00:00Z' }

function facts(lockThrough: string | null = null): RetagLockFacts {
  return { lockThrough, periods: new Map([OPEN, LOCKED, CLOSED].map((period) => [period.id, period])) }
}

describe('retagBlockOf', () => {
  it('lets a line in an open period after the lock date through', () => {
    expect(retagBlockOf(facts('2026-01-31'), { entry_date: '2026-02-01', fiscal_period_id: 'period-open' })).toBeNull()
    expect(retagBlockOf(facts(), { entry_date: '2026-02-01', fiscal_period_id: 'period-open' })).toBeNull()
  })

  it('refuses a line in a closed period, with the sentence the RPC raises', () => {
    expect(retagBlockOf(facts(), { entry_date: '2025-12-20', fiscal_period_id: 'period-closed' })).toEqual({
      reason: 'period_closed',
      message: 'Perioden är stängd: använd rättelseverifikat (storno) för att ändra dimensioner.',
    })
  })

  it('refuses a line in a locked period', () => {
    expect(retagBlockOf(facts(), { entry_date: '2026-01-10', fiscal_period_id: 'period-locked' })).toEqual({
      reason: 'period_locked',
      message: 'Perioden är låst: använd rättelseverifikat (storno) för att ändra dimensioner.',
    })
  })

  it('refuses a line on or before the company lock date, the day itself included', () => {
    const lock = facts('2026-01-31')
    expect(retagBlockOf(lock, { entry_date: '2026-01-31', fiscal_period_id: 'period-open' })).toEqual({
      reason: 'company_lock_date',
      message: 'Bokföringen är låst t.o.m. 2026-01-31: använd rättelseverifikat (storno).',
    })
    expect(retagBlockOf(lock, { entry_date: '2026-01-30', fiscal_period_id: 'period-open' })?.reason).toBe('company_lock_date')
  })

  it("gives the period's own state before the lock date: a closed period stays closed wherever the date moves", () => {
    const lock = facts('2026-12-31')
    expect(retagBlockOf(lock, { entry_date: '2025-12-20', fiscal_period_id: 'period-closed' })?.reason).toBe('period_closed')
    expect(retagBlockOf(lock, { entry_date: '2026-01-10', fiscal_period_id: 'period-locked' })?.reason).toBe('period_locked')
  })

  it('judges a verifikat whose period is unknown on the lock date alone, as the RPC does', () => {
    expect(retagBlockOf(facts(), { entry_date: '2026-03-01', fiscal_period_id: 'period-gone' })).toBeNull()
    expect(retagBlockOf(facts(), { entry_date: '2026-03-01', fiscal_period_id: null })).toBeNull()
    expect(retagBlockOf(facts('2026-03-31'), { entry_date: '2026-03-01', fiscal_period_id: null })?.reason).toBe(
      'company_lock_date',
    )
  })

  it('agrees with the period verdict the other doors read, for every state', () => {
    for (const period of [OPEN, LOCKED, CLOSED]) {
      for (const lockThrough of [null, '2026-01-31']) {
        for (const date of ['2026-01-15', '2026-03-01']) {
          const verdict = periodLockVerdict(date, lockThrough, period).status.status
          const block = retagBlockOf(facts(lockThrough), { entry_date: date, fiscal_period_id: period.id })
          expect(block === null, `${period.id} ${lockThrough} ${date}`).toBe(verdict === 'open')
        }
      }
    }
  })
})

describe('fetchRetagLockFacts', () => {
  it('reads the company lock date and the named periods once each', async () => {
    const { supabase, enqueue, findCall } = createQueuedMockSupabase()
    enqueue({ data: { bookkeeping_locked_through: '2026-01-31' } })
    enqueue({ data: [OPEN, CLOSED] })

    const read = await fetchRetagLockFacts(supabase as never, 'company-1', [
      'period-open',
      'period-closed',
      'period-open',
      null,
      undefined,
    ])

    expect(read.lockThrough).toBe('2026-01-31')
    expect([...read.periods.keys()]).toEqual(['period-open', 'period-closed'])
    // Company-scoped, and each period asked for once.
    expect(findCall('fiscal_periods', 'eq')).toEqual(['company_id', 'company-1'])
    expect(findCall('fiscal_periods', 'in')).toEqual(['id', ['period-open', 'period-closed']])
  })

  it('reads no period when no verifikat names one', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null })

    const read = await fetchRetagLockFacts(supabase as never, 'company-1', [null])

    expect(read).toEqual({ lockThrough: null, periods: new Map() })
    expect(supabase.from).toHaveBeenCalledTimes(1)
  })

  it('throws when the lock date cannot be read: an unread lock is never open', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ error: { message: 'connection reset', code: '08006' } })

    await expect(fetchRetagLockFacts(supabase as never, 'company-1', ['period-open'])).rejects.toMatchObject({
      code: '08006',
    })
  })

  it('throws when the periods cannot be read', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { bookkeeping_locked_through: null } })
    enqueue({ error: { message: 'canceling statement due to statement timeout', code: '57014' } })

    await expect(fetchRetagLockFacts(supabase as never, 'company-1', ['period-open'])).rejects.toMatchObject({
      code: '57014',
    })
  })
})

describe('what a door says about the lines left untagged', () => {
  const closed = 'Perioden är stängd: använd rättelseverifikat (storno) för att ändra dimensioner.'
  const failed = [
    { line_id: 'l1', error: closed, reason: 'period_closed' as const, entry_date: '2025-12-20' },
    { line_id: 'l2', error: closed, reason: 'period_closed' as const, entry_date: '2025-11-03' },
    { line_id: 'l3', error: 'Verifikationsraden hittades inte.', reason: 'line_not_found' as const },
  ]

  it('counts the failures per reason, with the first and last date where known', () => {
    expect(groupRetagFailures(failed)).toEqual([
      { reason: 'period_closed', lines: 2, message: closed, date_from: '2025-11-03', date_to: '2025-12-20' },
      { reason: 'line_not_found', lines: 1, message: 'Verifikationsraden hittades inte.' },
    ])
  })

  it('keeps two refusals of one reason apart when their sentences differ', () => {
    const groups = groupRetagFailures([
      { line_id: 'l1', error: 'Värdet "P9" finns inte som aktivt värde för dimension 6.', reason: 'refused' },
      { line_id: 'l2', error: 'Endast rader på bokförda verifikat kan taggas om.', reason: 'refused' },
    ])
    expect(groups.map((group) => group.lines)).toEqual([1, 1])
  })

  it('writes a group as one sentence for a person', () => {
    const [group, missing] = groupRetagFailures(failed)
    expect(describeRetagFailureGroup(group)).toBe(`2 rader (2025-11-03 till 2025-12-20): ${closed}`)
    expect(describeRetagFailureGroup(missing)).toBe('1 rad: Verifikationsraden hittades inte.')
    expect(describeRetagFailureGroup({ ...group, lines: 1, date_from: '2025-12-20' })).toBe(`1 rad (2025-12-20): ${closed}`)
  })

  it('warns in so many words when lines were left, and not at all when none were', () => {
    const failed_by_reason = groupRetagFailures(failed)
    expect(partialRetagWarning({ outcome: 'partial', retagged: 12, unchanged: 1, failed, failed_by_reason })).toBe(
      'PARTIAL: 3 of 16 lines were NOT tagged (2 period_closed, 2025-11-03 to 2025-12-20; 1 line_not_found). ' +
        '12 were tagged and 1 already carried the tags. ' +
        'failed_by_reason gives the reason per group: tell the user which lines were left and why.',
    )
    expect(
      partialRetagWarning({ outcome: 'complete', retagged: 12, unchanged: 1, failed: [], failed_by_reason: [] }),
    ).toBeNull()
  })
})
