import type { PoolClient } from 'pg'
import { describe, expect, it } from 'vitest'
import { getClient, getPool } from './setup'
import { seedCompany } from './fixtures'

/**
 * The recurring invoice cron records the invoice on its schedule and, when
 * that write answers an error, holds the schedule before removing the draft
 * (src/app/api/invoices/recurring/cron/route.ts, holdRecurringScheduleRun in
 * src/lib/invoices/recurring-schedule-claim.ts).
 *
 * An error answer does not prove the record failed: the UPDATE can still be
 * on its way. Without the hold, the draft was removed while that UPDATE was
 * queued; the UPDATE committed after (run date, period and count moved on),
 * the delete then cleared last_invoice_id, and the period was never billed.
 *
 * Pinned here with the statements as the route sends them, on two real
 * connections, in both orders: the record (gated on the claim, last_run_at =
 * claimTs) and the hold (the claim moved on to a hold token with the warning
 * a person reads, only while last_run_at = claimTs and the run date and
 * period are the ones read). Whichever commits first wins and the other
 * matches no row, so the draft is removed only when the record can no longer
 * land. The hold, not the claim, is what the run gives back after the
 * removal: until then the schedule stays held, whatever happens to the run.
 */

const CLAIM_TS = '2026-07-06T06:30:00.000Z'
const HOLD_TS = '2026-07-06T06:30:00.001Z'
const PRIOR_RUN = '2026-06-06T06:30:00.000Z'
const HELD_WARNING =
  'Körningen 2026-07-06 avbröts: connection reset. Kontrollera om en faktura skapades för perioden. ' +
  'Om ingen skapades: använd "Skapa faktura nu". ' +
  'Om en skapades: se till att schemats periodstart (om den är ifylld) ligger efter fakturans period, ' +
  'och pausa och aktivera sedan schemat. ' +
  'Har schemat inte flyttats till nästa körning väntar det tills du har gjort något av detta.'

async function seedClaimedSchedule(): Promise<{ scheduleId: string; companyId: string }> {
  const { companyId, userId } = await seedCompany()
  const { rows: customers } = await getPool().query<{ id: string }>(
    `INSERT INTO public.customers (company_id, user_id, name, customer_type)
     VALUES ($1, $2, 'Kund AB', 'swedish_business') RETURNING id`,
    [companyId, userId],
  )
  const { rows } = await getPool().query<{ id: string }>(
    `INSERT INTO public.recurring_invoice_schedules
       (company_id, user_id, customer_id, name, day_of_month, next_run_date, period_start, last_run_at, generated_count)
     VALUES ($1, $2, $3, 'Retainer', 6, '2026-07-06', '2026-07-01', $4, 4)
     RETURNING id`,
    [companyId, userId, customers[0]!.id, CLAIM_TS],
  )
  return { scheduleId: rows[0]!.id, companyId }
}

/** The record as the route writes it: the next run and period, gated on this run's claim. */
function record(runner: { query: PoolClient['query'] }, scheduleId: string, companyId: string) {
  return runner.query(
    `UPDATE public.recurring_invoice_schedules
        SET next_run_date = '2026-08-06', period_start = '2026-08-01', generated_count = 5,
            last_run_at = $3
      WHERE id = $1 AND company_id = $2 AND last_run_at = $3
      RETURNING id`,
    [scheduleId, companyId, CLAIM_TS],
  )
}

/** The hold: the claim moved on to the hold token, only while this run holds it and the schedule has not moved on. */
function hold(runner: { query: PoolClient['query'] }, scheduleId: string, companyId: string) {
  return runner.query(
    `UPDATE public.recurring_invoice_schedules
        SET last_run_at = $3, last_run_warning = $5
      WHERE id = $1 AND company_id = $2 AND last_run_at = $4
        AND next_run_date = '2026-07-06' AND period_start = '2026-07-01'
      RETURNING id`,
    [scheduleId, companyId, HOLD_TS, CLAIM_TS, HELD_WARNING],
  )
}

/** The release after the draft is confirmed gone: the run back, only from the hold. */
function release(runner: { query: PoolClient['query'] }, scheduleId: string, companyId: string) {
  return runner.query(
    `UPDATE public.recurring_invoice_schedules
        SET last_run_at = $3, last_run_warning = 'Körningen 2026-07-06 misslyckades: connection reset. Nytt försök görs automatiskt varje timme idag.'
      WHERE id = $1 AND company_id = $2 AND last_run_at = $4
      RETURNING id`,
    [scheduleId, companyId, PRIOR_RUN, HOLD_TS],
  )
}

async function scheduleState(scheduleId: string) {
  const { rows } = await getPool().query<{
    next_run_date: string
    period_start: string
    generated_count: number
    last_run_at: Date
    last_run_warning: string | null
  }>(
    `SELECT next_run_date::text AS next_run_date, period_start::text AS period_start, generated_count, last_run_at,
            last_run_warning
       FROM public.recurring_invoice_schedules WHERE id = $1`,
    [scheduleId],
  )
  return rows[0]!
}

async function waitUntilBlockedOnLock(pid: number, maxAttempts = 150, intervalMs = 20): Promise<void> {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const { rows } = await getPool().query<{ wait_event_type: string | null }>(
      `SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1`,
      [pid],
    )
    if (rows[0]?.wait_event_type === 'Lock') return
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
  throw new Error(`Backend ${pid} never blocked on a lock after ${maxAttempts * intervalMs}ms`)
}

async function backendPid(client: PoolClient): Promise<number> {
  const { rows } = await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
  return rows[0]!.pid
}

describe('the recurring record and its hold on one schedule', () => {
  it('the record commits first (it was only slow): the hold matches nothing, so the draft is kept', async () => {
    const { scheduleId, companyId } = await seedClaimedSchedule()
    const recorder = await getClient()
    const holder = await getClient()
    try {
      await recorder.query('BEGIN')
      expect((await record(recorder, scheduleId, companyId)).rowCount).toBe(1)

      const pid = await backendPid(holder)
      const pending = hold(holder, scheduleId, companyId)
      await waitUntilBlockedOnLock(pid)
      await recorder.query('COMMIT')

      expect((await pending).rowCount).toBe(0)
    } finally {
      await recorder.query('ROLLBACK').catch(() => {})
      recorder.release()
      holder.release()
    }
    // Recorded, and the claim still this run's: no retry today, no period billed twice.
    expect(await scheduleState(scheduleId)).toMatchObject({
      next_run_date: '2026-08-06',
      period_start: '2026-08-01',
      generated_count: 5,
      last_run_at: new Date(CLAIM_TS),
    })
  })

  it('the hold commits first: the queued record matches nothing, the schedule stays held until the release', async () => {
    const { scheduleId, companyId } = await seedClaimedSchedule()
    const holder = await getClient()
    const recorder = await getClient()
    try {
      await holder.query('BEGIN')
      expect((await hold(holder, scheduleId, companyId)).rowCount).toBe(1)

      const pid = await backendPid(recorder)
      const pending = record(recorder, scheduleId, companyId)
      await waitUntilBlockedOnLock(pid)
      await holder.query('COMMIT')

      expect((await pending).rowCount).toBe(0)
    } finally {
      await holder.query('ROLLBACK').catch(() => {})
      holder.release()
      recorder.release()
    }
    // Held, with the warning a person reads, should the run stop here (before
    // or after the draft is removed): no run claims it until a release.
    expect(await scheduleState(scheduleId)).toMatchObject({
      next_run_date: '2026-07-06',
      period_start: '2026-07-01',
      generated_count: 4,
      last_run_at: new Date(HOLD_TS),
      last_run_warning: HELD_WARNING,
    })

    // The draft confirmed gone, the run is given back from the hold; the
    // record, still gated on the claim, can never land after that either.
    const after = await getClient()
    try {
      expect((await release(after, scheduleId, companyId)).rowCount).toBe(1)
      expect((await record(after, scheduleId, companyId)).rowCount).toBe(0)
    } finally {
      after.release()
    }
    expect(await scheduleState(scheduleId)).toMatchObject({
      next_run_date: '2026-07-06',
      period_start: '2026-07-01',
      generated_count: 4,
      last_run_at: new Date(PRIOR_RUN),
    })
  })
})
