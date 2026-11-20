import type { CloudSchedule } from '../types'
import { todayIsoStockholm } from '@/lib/dates/iso'

const STOCKHOLM_TZ = 'Europe/Stockholm'

function isValidHour(hour: unknown): hour is number {
  return (
    typeof hour === 'number' && Number.isInteger(hour) && hour >= 0 && hour <= 23
  )
}

function stockholmHourOf(date: Date): number {
  return Number(
    new Intl.DateTimeFormat('sv-SE', {
      timeZone: STOCKHOLM_TZ,
      hour: '2-digit',
      hourCycle: 'h23',
    }).format(date)
  )
}

/**
 * Absolute timestamp of today's HH:00 in Europe/Stockholm. Tries the two
 * offsets Sweden uses (CEST +02:00, CET +01:00) and keeps the one that lands
 * on the requested wall-clock hour, so DST transitions resolve correctly
 * without a timezone library.
 */
export function stockholmSlotForDay(now: Date, hour: number): Date {
  const dateStr = todayIsoStockholm(now)
  const hh = String(hour).padStart(2, '0')
  for (const offset of ['+02:00', '+01:00']) {
    const candidate = new Date(`${dateStr}T${hh}:00:00${offset}`)
    if (stockholmHourOf(candidate) === hour) return candidate
  }
  return new Date(`${dateStr}T${hh}:00:00+01:00`)
}

/** UTC hour that corresponds to a Stockholm wall-clock hour today. */
export function stockholmHourToUtcHour(hour: number, now: Date = new Date()): number {
  return stockholmSlotForDay(now, hour).getUTCHours()
}

/**
 * Today's scheduled slot as an absolute timestamp, or null when the schedule
 * carries no valid hour. `hour_local` (Europe/Stockholm wall-clock, stable
 * across DST) wins over the legacy `hour_utc`.
 */
function scheduleSlotForDay(schedule: CloudSchedule, now: Date): Date | null {
  if (isValidHour(schedule.hour_local)) {
    return stockholmSlotForDay(now, schedule.hour_local)
  }
  if (isValidHour(schedule.hour_utc)) {
    const slot = new Date(now)
    slot.setUTCHours(schedule.hour_utc, 0, 0, 0)
    return slot
  }
  return null
}

/**
 * A schedule is due when its daily slot for today has passed and no auto-sync
 * attempt has run since that slot. Hour equality is deliberately NOT
 * required: if the popular 03:00 batch overruns the cron's time budget, the
 * leftover companies stay due and get picked up by the next hourly run
 * instead of silently losing the whole day.
 */
export function isScheduleDue(
  schedule: CloudSchedule | null | undefined,
  now: Date
): boolean {
  if (!schedule?.enabled) return false
  const slot = scheduleSlotForDay(schedule, now)
  if (!slot) return false
  if (now.getTime() < slot.getTime()) return false

  if (!schedule.last_auto_sync_at) return true
  const lastAttempt = new Date(schedule.last_auto_sync_at).getTime()
  return Number.isFinite(lastAttempt) ? lastAttempt < slot.getTime() : true
}

const parseMs = (iso: string | null | undefined): number => {
  const ms = iso ? Date.parse(iso) : NaN
  return Number.isFinite(ms) ? ms : 0
}

/**
 * When the cron last gave this schedule a turn: its last finished attempt, or
 * the last time it ran out of time on it. 0 when it never had one. The cron
 * takes the oldest first, so a company that needs several runs (a first
 * backup of many years) goes to the back after each and cannot use the whole
 * time budget every hour while the companies behind it wait.
 */
export function lastTurnMs(schedule: CloudSchedule): number {
  return Math.max(parseMs(schedule.last_auto_sync_at), parseMs(schedule.deferred_at))
}

/**
 * How old a claim must be before the run that took it is taken to be gone.
 *
 * Hosted, a function is ended at its time limit: the cron's is well under
 * the platform ceiling of 800 s, and a run a person started lives in the
 * extension route, which has the whole 800 s, so its claim gets that plus a
 * margin. Self-hosted there is no limit at all: a large backup simply runs
 * for as long as it takes, and a claim only goes stale when the process
 * died, so it is given hours before another run may start beside it.
 */
export function claimAbandonedAfterMs(by: CloudSchedule['sync_started_by'], selfHosted: boolean): number {
  if (selfHosted) return 6 * 60 * 60_000
  return by === 'manual' ? 20 * 60_000 : 15 * 60_000
}

/** What the cron writes as the error of a backup whose run was ended mid-way; the card shows it. */
export const INTERRUPTED_BACKUP_ERROR = 'Säkerhetskopieringen avbröts innan den blev klar.'

/**
 * 'held': a run started a while ago and may still be working on this
 * destination. 'abandoned': a claim nobody released for longer than its run
 * can have lived (claimAbandonedAfterMs), so that run was ended in the
 * middle of this company.
 */
export function runClaimState(
  schedule: Pick<CloudSchedule, 'sync_started_at' | 'sync_started_by'>,
  now: Date,
  selfHosted: boolean
): 'free' | 'held' | 'abandoned' {
  if (!schedule.sync_started_at) return 'free'
  const startedAt = Date.parse(schedule.sync_started_at)
  if (!Number.isFinite(startedAt)) return 'free'
  const age = now.getTime() - startedAt
  return age < claimAbandonedAfterMs(schedule.sync_started_by, selfHosted) ? 'held' : 'abandoned'
}

/** A killed run of this night's backup has already been counted as a failure. */
function interruptedSinceSlot(schedule: CloudSchedule, now: Date): boolean {
  const slot = scheduleSlotForDay(schedule, now)
  const interruptedAt = parseMs(schedule.interrupted_at)
  return slot !== null && interruptedAt > 0 && interruptedAt >= slot.getTime()
}

/**
 * The failure count after one more failed attempt. A night whose run was
 * killed is already counted (planScheduledRun), so the retry failing too does
 * not count the same night twice: the alert mail says "nights in a row".
 */
export function failuresAfterFailedAttempt(schedule: CloudSchedule, now: Date): number {
  const counted = schedule.consecutive_failures ?? 0
  return interruptedSinceSlot(schedule, now) ? Math.max(counted, 1) : counted + 1
}

export type ScheduledRunPlan =
  /** Another run holds the destination: leave it alone. */
  | { action: 'busy' }
  /**
   * Take the claim (`claimed` is the schedule to write) and run the backup.
   * `interrupted`: the cron's own claim was abandoned, so the nightly run
   * before this one was killed; `claimed` counts that as this night's
   * failure. `tookOver: 'manual'`: the abandoned claim was a person's run,
   * which is no failed night; it is only taken over.
   */
  | { action: 'run'; claimed: CloudSchedule; interrupted: boolean; tookOver?: 'manual' }
  /**
   * The retry after a killed run was killed too. `failed` records the night
   * as a failed attempt, so the schedule is not due again before tomorrow.
   */
  | { action: 'give_up'; failed: CloudSchedule }

/**
 * What the cron does with a due schedule, given its run claim.
 *
 * A cron claim still set when the next hourly run comes is a run that was
 * killed in the middle of this company (3 runs in 30 days ended at the 300 s
 * limit, 2026-11). That used to leave no trace: no failure count, no mail,
 * and the card kept its last "lyckades". It is now counted as that night's
 * failure and tried once more, first in the queue where it gets the whole
 * run; if that run is killed as well the night is recorded as failed, so a
 * backup that dies every time reaches the three-nights mail instead of being
 * retried every hour ahead of everyone else.
 *
 * A claim a person's run left ("Synka nu" or the first backup after
 * connecting, ended at the route's limit on a large company) says nothing
 * about the nightly backup: the cron takes it over and counts nothing.
 */
export function planScheduledRun(schedule: CloudSchedule, now: Date, selfHosted: boolean): ScheduledRunPlan {
  const at = now.toISOString()
  const state = runClaimState(schedule, now, selfHosted)
  if (state === 'held') return { action: 'busy' }
  // The claim is the company's turn: it is no longer waiting for one.
  const claim = { sync_started_at: at, sync_started_by: 'cron' as const, left_over_runs: 0 }
  if (state === 'free') return { action: 'run', interrupted: false, claimed: { ...schedule, ...claim } }
  if (schedule.sync_started_by === 'manual') {
    return { action: 'run', interrupted: false, tookOver: 'manual', claimed: { ...schedule, ...claim } }
  }
  if (interruptedSinceSlot(schedule, now)) {
    return {
      action: 'give_up',
      failed: {
        ...schedule,
        sync_started_at: null,
        sync_started_by: null,
        left_over_runs: 0,
        last_auto_sync_at: at,
        last_auto_sync_status: 'error',
        last_auto_sync_error: INTERRUPTED_BACKUP_ERROR,
      },
    }
  }
  return {
    action: 'run',
    interrupted: true,
    claimed: {
      ...schedule,
      ...claim,
      interrupted_at: at,
      consecutive_failures: (schedule.consecutive_failures ?? 0) + 1,
    },
  }
}

/** Due runs in a row without a turn before it is an error: one spill into the next hour is normal. */
const LEFT_OVER_RUNS_BEFORE_ERROR = 3
/** The cron runs hourly (vercel.json): this many due runs without a turn is a day. */
const LEFT_OVER_RUNS_PER_DAY = 24

/**
 * Whether a schedule's count of due runs that never reached it is one to
 * report: the third in a row (the cron is not keeping up), and each full day
 * after that. Counted on the record (`left_over_runs`, set back to 0 by the
 * claim) and reported only on these exact counts, so it is said once and not
 * on every run. Comparing clock times instead missed or doubled the report
 * whenever two runs were not exactly an hour apart, and never reached three
 * hours for an evening slot, which stops being due at midnight.
 */
export function leftOverRunsToReport(runs: number): 'three_runs' | 'a_day' | null {
  if (runs === LEFT_OVER_RUNS_BEFORE_ERROR) return 'three_runs'
  return runs > 0 && runs % LEFT_OVER_RUNS_PER_DAY === 0 ? 'a_day' : null
}

/** A daily backup two days old has missed a night and the retries after it. */
export const STALE_BACKUP_MS = 48 * 60 * 60_000

/**
 * Automatic backup is on but nothing has been saved for two days. The card
 * says so: it otherwise keeps showing the last attempt as "lyckades" for as
 * long as no attempt gets far enough to record another outcome.
 * `lastSavedAt` is the last-sync record's `at`, which every finished upload
 * and every completed sync moves; before the first one, the connection's age
 * decides. Never before automatic backup has been on for two days.
 */
export function backupIsStale(params: {
  schedule: Pick<CloudSchedule, 'enabled' | 'enabled_at'> | null
  lastSavedAt: string | null | undefined
  connectedAt: string | null | undefined
  now: Date
}): boolean {
  if (!params.schedule?.enabled) return false
  // Switched on today with an old manual backup is not a backup that stopped:
  // the two days count from when automatic backup was last switched on.
  const since = Math.max(parseMs(params.lastSavedAt) || parseMs(params.connectedAt), parseMs(params.schedule.enabled_at))
  return since > 0 && params.now.getTime() - since > STALE_BACKUP_MS
}
