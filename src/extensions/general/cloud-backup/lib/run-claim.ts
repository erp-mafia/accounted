import type { SupabaseClient } from '@supabase/supabase-js'
import { createLogger } from '@/lib/logger'
import { isSelfHosted } from '@/lib/env/public-flags'
import { runClaimState } from './schedule'
import type { CloudSchedule } from '../types'

const log = createLogger('cloud-backup-run-claim')

/**
 * The run claim on a destination's schedule record: one backup run per
 * company and destination at a time.
 *
 * Two runs used to be able to work on the same destination: a cron invocation
 * delivered twice, or the hourly cron and a person pressing "Synka nu" (or
 * the first backup right after connecting, whose new schedule is due at
 * once). Both built and uploaded the same archives, a first Google Drive
 * upload has no file id to update so the folder got two files with the same
 * name, and both cron runs sent the failure mail.
 *
 * The claim is `sync_started_at` (with `sync_started_by`) inside the
 * schedule's JSON value. Every write of the record, the claim, its release
 * and the run's outcome, is a compare-and-set on the row's `updated_at`,
 * which every write moves (update_updated_at_column): it only lands while
 * the row is still the version the writer read, so what it writes is always
 * built on the record as it is, never on a copy read at the start of a run.
 * A check on the claim field alone was not enough: a second delivery that
 * read its rows before the first one finished a company found the claim
 * released, wrote its old copy back over the first one's result, ran the
 * company again and sent the failure mail a second time; and a schedule the
 * person edited after the cron's read was put back.
 */

export interface ScheduleKey {
  companyId: string
  /** `google_drive_schedule` / `dropbox_schedule`. */
  scheduleKey: string
}

/** A schedule record and the row version (`updated_at`) it was read at. */
export interface ScheduleRow {
  value: CloudSchedule
  version: string
}

const scheduleRows = (supabase: SupabaseClient, key: ScheduleKey) =>
  supabase
    .from('extension_data')
    .select('value, updated_at')
    .eq('company_id', key.companyId)
    .eq('extension_id', 'cloud-backup')
    .eq('key', key.scheduleKey)

/** The record as stored now, or null when the destination has none. Throws when it cannot be read. */
export async function readScheduleRow(
  supabase: SupabaseClient,
  key: ScheduleKey
): Promise<ScheduleRow | null> {
  const { data, error } = await scheduleRows(supabase, key).maybeSingle()
  if (error) throw new Error(`Failed to read backup schedule: ${error.message}`)
  const row = data as { value: CloudSchedule | null; updated_at: string } | null
  return row?.value ? { value: row.value, version: row.updated_at } : null
}

/** Columns of the record beside its value that a write may set: the member a settings save makes its owner. */
export interface ScheduleRowColumns {
  /** The failure mail goes to this member, and the backup runs as them. */
  user_id?: string
}

/**
 * Write the record only while it is still the version read. Returns the new
 * version, or null when someone else wrote first (nothing was written).
 */
export async function writeScheduleAtVersion(
  supabase: SupabaseClient,
  key: ScheduleKey,
  version: string,
  value: CloudSchedule,
  columns: ScheduleRowColumns = {}
): Promise<string | null> {
  const { data, error } = await supabase
    .from('extension_data')
    .update({ value, ...columns })
    .eq('company_id', key.companyId)
    .eq('extension_id', 'cloud-backup')
    .eq('key', key.scheduleKey)
    .eq('updated_at', version)
    .select('updated_at')
  if (error) throw new Error(`Failed to write backup schedule: ${error.message}`)
  const rows = (data ?? []) as { updated_at: string }[]
  return rows[0]?.updated_at ?? null
}

/** Tries before a patch gives up: each one lost to another writer of the same row. */
const PATCH_ATTEMPTS = 3

/**
 * Change fields of the record as it is now. `patch` gets the current value
 * and returns the one to write, or null to leave the record alone (the run's
 * claim is no longer its own). Starts from `known`, the version the caller
 * last read or wrote, and reads the record again whenever someone else wrote
 * in between, so a schedule the person edited while a backup ran keeps the
 * edit and gets the run's outcome on top.
 *
 * 'written'; 'left' (the patch declined the record as it is now); 'gone'
 * (the record was removed meanwhile: the destination was disconnected); or
 * 'lost' (every try lost to another writer).
 */
export async function patchScheduleRow(
  supabase: SupabaseClient,
  key: ScheduleKey,
  known: ScheduleRow,
  patch: (current: CloudSchedule) => CloudSchedule | null,
  columns: ScheduleRowColumns = {}
): Promise<'written' | 'left' | 'gone' | 'lost'> {
  let row: ScheduleRow = known
  for (let attempt = 0; attempt < PATCH_ATTEMPTS; attempt++) {
    const next = patch(row.value)
    if (!next) return 'left'
    if (await writeScheduleAtVersion(supabase, key, row.version, next, columns)) return 'written'
    const current = await readScheduleRow(supabase, key)
    if (!current) return 'gone'
    row = current
  }
  return 'lost'
}

/**
 * Run `sync` under the claim, for the runs a person starts ("Synka nu", the
 * first backup after connecting). `busy` when another run holds the
 * destination. A destination with no schedule record (none is written before
 * the first connect finishes) has nothing to claim on and just runs.
 *
 * The claim says a person took it (`sync_started_by: 'manual'`): these runs
 * have no file deadline and can be ended at the route's time limit, and a
 * claim left by one is not a nightly backup that died, so the cron takes it
 * over without counting a failed night (planScheduledRun). An abandoned
 * claim is taken over here too: the person is watching this run.
 */
export async function withManualRunClaim<T>(
  supabase: SupabaseClient,
  key: ScheduleKey,
  sync: () => Promise<T>
): Promise<{ busy: true } | { busy: false; result: T }> {
  const row = await readScheduleRow(supabase, key)
  if (!row) return { busy: false, result: await sync() }
  if (runClaimState(row.value, new Date(), isSelfHosted()) === 'held') return { busy: true }
  const startedAt = new Date().toISOString()
  const claimed: CloudSchedule = { ...row.value, sync_started_at: startedAt, sync_started_by: 'manual' }
  const version = await writeScheduleAtVersion(supabase, key, row.version, claimed)
  if (!version) return { busy: true }

  try {
    return { busy: false, result: await sync() }
  } finally {
    // A release that does not land leaves the destination looking busy until
    // the claim is old enough to be taken over: say so, it was not a backup
    // that died.
    try {
      const released = await patchScheduleRow(supabase, key, { value: claimed, version }, (current) =>
        current.sync_started_at === startedAt
          ? { ...current, sync_started_at: null, sync_started_by: null }
          : null
      )
      // Disconnected while the run held it: the record is gone, and the
      // claim with it.
      if (released === 'gone') log.warn('backup run claim not released: the schedule record was removed', key)
      if (released === 'lost') {
        log.error('backup run claim not released: the schedule record kept changing', undefined, key)
      }
    } catch (releaseError) {
      log.error('backup run claim not released', releaseError as Error, key)
    }
  }
}
