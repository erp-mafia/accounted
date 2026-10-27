import type { DispatchSkipReason } from './dispatch'
import type { ReminderOverview } from './overview'
import { REMINDER_LEVELS, type ReminderLevel } from './policy'

/**
 * The pure parts of turning reminders on (accounted#104, phase 3): what the
 * invoice list offers, the ladder's days as a person types them, the body of
 * the settings save, and the sentence for each outcome of a picked send.
 * Client-safe: the server modules above are imported for their types only.
 */

/**
 * The id the invoice list's offer is dismissed under (notice_dismissals, per
 * user and company). It carries no "category:" prefix, so lib/notices never
 * reaps it as a recovered health notice.
 */
export const TURN_ON_OFFER_NOTICE_ID = 'reminders_turn_on_offer'

/** POST /api/reminders/send takes at most this many invoices per call. */
export const PICKED_SEND_MAX = 50

/** Days after the due date, as the ladder allows them (the company_settings check). */
export const REMINDER_DAYS_MIN = 1
export const REMINDER_DAYS_MAX = 365

export type TurnOnEntry = 'offer' | 'status' | null

/**
 * What the invoice list shows for reminders: the offer to turn them on (off,
 * no collections provider, something overdue), the quiet status control
 * (on), or nothing. Reminders that are on keep their control even beside a
 * collections connection, so they can still be turned off.
 */
export function turnOnEntry(
  overview: Pick<ReminderOverview, 'available' | 'enabled' | 'collectionsConnected' | 'overdueCount'> | null,
): TurnOnEntry {
  if (!overview?.available) return null
  if (overview.enabled) return 'status'
  if (overview.collectionsConnected) return null
  return overview.overdueCount > 0 ? 'offer' : null
}

export type ReminderDaysInput = readonly [string, string, string]
export type ReminderDays = [number, number, number]
export type ReminderDaysError = 'whole_number' | 'range' | 'ascending'
export type ReminderDaysCheck =
  | { ok: true; days: ReminderDays }
  | { ok: false; error: ReminderDaysError; level: ReminderLevel }

const WHOLE_NUMBER = /^\d+$/

/**
 * The three day fields as typed: each a whole number from 1 to 365, each
 * later than the one before. A refusal names the first field at fault.
 */
export function checkReminderDays(input: ReminderDaysInput): ReminderDaysCheck {
  const days: number[] = []
  for (const level of REMINDER_LEVELS) {
    const text = input[level - 1].trim()
    if (!WHOLE_NUMBER.test(text)) return { ok: false, error: 'whole_number', level }
    const value = Number(text)
    if (value < REMINDER_DAYS_MIN || value > REMINDER_DAYS_MAX) return { ok: false, error: 'range', level }
    const previous = days.at(-1)
    if (previous !== undefined && value <= previous) return { ok: false, error: 'ascending', level }
    days.push(value)
  }
  return { ok: true, days: days as ReminderDays }
}

/** The schedule's days as the fields show them. */
export function reminderDaysInput(days: readonly number[]): [string, string, string] {
  return [String(days[0]), String(days[1]), String(days[2])]
}

/** Whether the typed days differ from the saved ones (an unreadable field counts as a change). */
export function reminderDaysChanged(input: ReminderDaysInput, saved: readonly number[]): boolean {
  const check = checkReminderDays(input)
  return !check.ok || check.days.some((day, index) => day !== saved[index])
}

/** The PUT /api/settings body: the toggle when it moves, the days when given. */
export function reminderSettingsBody(change: { on?: boolean; days?: ReminderDays }): Record<string, boolean | number> {
  const body: Record<string, boolean | number> = {}
  if (change.on !== undefined) body.send_invoice_reminders = change.on
  if (change.days) {
    body.reminder_days_level_1 = change.days[0]
    body.reminder_days_level_2 = change.days[1]
    body.reminder_days_level_3 = change.days[2]
  }
  return body
}

/** The ids of a pick in calls the send route takes. */
export function sendBatches(ids: readonly string[]): string[][] {
  const unique = [...new Set(ids)]
  const batches: string[][] = []
  for (let start = 0; start < unique.length; start += PICKED_SEND_MAX) {
    batches.push(unique.slice(start, start + PICKED_SEND_MAX))
  }
  return batches
}

/** A skip the send route answers: the dispatch path's reasons, and an invoice it could not find. */
export type PickedSkipReason = DispatchSkipReason | 'not_found'

/**
 * Every reason the send route may answer, each with a sentence
 * (reminders_setup.skip_<reason>). A Record so that a reason added to the
 * dispatch path fails the type check until it has a sentence.
 */
const SKIP_REASONS: Record<PickedSkipReason, true> = {
  not_invoice: true,
  credited: true,
  not_sent: true,
  paid: true,
  not_overdue: true,
  collections: true,
  customer_excluded: true,
  autogiro: true,
  no_email: true,
  response: true,
  in_flight: true,
  send_failed: true,
  undelivered: true,
  earlier_reminders: true,
  imported: true,
  not_delivered: true,
  before_enabled: true,
  not_due: true,
  complete: true,
  sending_off: true,
  company_inactive: true,
  reminders_off: true,
  changed: true,
  possible_payment: true,
  bank_not_fresh: true,
  already_sent: true,
  not_found: true,
}

export const PICKED_SKIP_REASONS = Object.keys(SKIP_REASONS) as PickedSkipReason[]

export function isPickedSkipReason(reason: string | null | undefined): reason is PickedSkipReason {
  return typeof reason === 'string' && Object.hasOwn(SKIP_REASONS, reason)
}

/** One invoice's answer from POST /api/reminders/send. */
export interface PickedSendResult {
  invoice_id: string
  status: 'sent' | 'skipped' | 'failed'
  level?: ReminderLevel
  reason?: string
  code?: string
}

/** The message key (reminders_setup) for one invoice's outcome. */
export function resultSentenceKey(result: Pick<PickedSendResult, 'status' | 'reason'>): string {
  if (result.status === 'sent') return 'result_sent'
  if (result.status === 'failed') return 'result_failed'
  return isPickedSkipReason(result.reason) ? `skip_${result.reason}` : 'skip_other'
}

export interface PickedSendSummary {
  sent: number
  skipped: number
  failed: number
  /** Skipped only because the bank was not synced in 24 hours: sendable again once a person attests. */
  bankRetryIds: string[]
}

export function summariseSendResults(results: readonly PickedSendResult[]): PickedSendSummary {
  const summary: PickedSendSummary = { sent: 0, skipped: 0, failed: 0, bankRetryIds: [] }
  for (const result of results) {
    if (result.status === 'sent') summary.sent += 1
    else if (result.status === 'failed') summary.failed += 1
    else {
      summary.skipped += 1
      if (result.reason === 'bank_not_fresh') summary.bankRetryIds.push(result.invoice_id)
    }
  }
  return summary
}

/** A later answer for an invoice replaces its earlier one (the attested retry); order stays the first call's. */
export function mergeSendResults(
  earlier: readonly PickedSendResult[],
  later: readonly PickedSendResult[],
): PickedSendResult[] {
  const latest = new Map(later.map((result) => [result.invoice_id, result]))
  const merged = earlier.map((result) => latest.get(result.invoice_id) ?? result)
  const known = new Set(earlier.map((result) => result.invoice_id))
  return [...merged, ...later.filter((result) => !known.has(result.invoice_id))]
}
