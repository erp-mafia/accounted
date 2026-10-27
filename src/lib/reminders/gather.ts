import type { SupabaseClient } from '@supabase/supabase-js'
import { mapWithConcurrency } from '@/lib/concurrency'
import { addDaysIso, todayIsoStockholm } from '@/lib/dates/iso'
import { getEmailService } from '@/lib/email/service'
import { hasCapability } from '@/lib/entitlements/has-capability'
import { CAPABILITY } from '@/lib/entitlements/keys'
import { REMINDERS_SENDING_ENABLED } from '@/lib/invoices/reminders-enabled'
import { createLogger, type Logger } from '@/lib/logger'
import { roundOre } from '@/lib/money'
import { expireStaleDailyBatches, resolveDailyBatchOwner } from '@/lib/pending-operations/daily-batch-staging'
import { getRiskLevel } from '@/lib/pending-operations/risk-tiers'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { chunk } from '@/lib/utils'
import { checkReminderBank } from './bank'
import {
  REMINDER_BATCH_EXCLUDED_REASONS,
  REMINDER_BATCH_ITEM_KIND,
  REMINDER_BATCH_TYPE,
  reminderBatchTitle,
  type ReminderBatchExcluded,
  type ReminderBatchExcludedReason,
  type ReminderBatchItem,
  type ReminderBatchParams,
} from './batch'
import type { ReminderChannel } from './channel'
import { createEmailReminderChannel } from './channels/email'
import { dispatchReminder } from './dispatch'
import { loadReminderContext } from './facts'
import { decideReminder, reminderSchedule, sendsAutomatically } from './policy'

/**
 * The daily reminder batch (accounted#104, phase 2): once a day, per company
 * that turned reminders on, the reminders the policy says are due today go
 * into ONE staged pending operation for an owner or administrator to review
 * in Att göra. This module only reads and stages; the commit
 * (batch-commit.ts) sends, through dispatch.ts, after a person approved.
 *
 * Every overdue invoice is decided with the same facts and policy the send
 * uses (facts.ts, policy.ts), then the bank is checked: a possible payment
 * keeps it out (listed, "match it first"); a bank not synced in 24 hours, or
 * none connected, puts it in marked, so the approver sends it knowingly.
 * Invoices on the ladder that are stopped for a reason a person should see
 * are listed as excluded; invoices that never join the ladder by themselves
 * (imported, issued before reminders were turned on) are not, so they are
 * not read either (list_reminder_candidate_invoices).
 */

const log = createLogger('reminders/gather')

/** Invoices decided at once while gathering (each reads its facts and may check the bank). */
const GATHER_CONCURRENCY = 4

/**
 * A reservation this old belongs to a send that is no longer running (the
 * process died mid-send, or the sent update failed): the daily run marks it
 * failed with an unknown outcome, so it stops reading as in flight and is
 * listed for a person (send_failed).
 */
export const RESERVATION_SWEEP_MINUTES = 15

/**
 * A failed send newer than this has not been in a batch yet: one day between
 * two runs, with room for the cron's start to drift. On a day with nothing
 * due it still stages a batch, once, so a person sees it.
 */
const UNSEEN_FAILURE_HOURS = 26

/** Ids per .in() filter: a longer list makes a URL PostgREST refuses. */
const IN_CHUNK = 200

const LISTED = new Set<string>(REMINDER_BATCH_EXCLUDED_REASONS)

export interface GatheredReminderBatch {
  batchDate: string
  items: ReminderBatchItem[]
  excluded: ReminderBatchExcluded[]
  /** The items automatic sending may send: issued and delivered from Accounted (sendsAutomatically). */
  automaticInvoiceIds: string[]
}

type Db = SupabaseClient

/** Today's reminders for one company: due items, and the stopped invoices a person should see. */
export async function gatherReminderBatch(db: Db, input: { companyId: string; now: Date }): Promise<GatheredReminderBatch> {
  const { companyId, now } = input
  const today = todayIsoStockholm(now)

  const { data: settings, error } = await db
    .from('company_settings')
    .select('reminder_days_level_1, reminder_days_level_2, reminder_days_level_3, reminders_enabled_at')
    .eq('company_id', companyId)
    .maybeSingle()
  if (error) throw new Error(`company_settings lookup failed: ${error.message}`)
  // No level is due before the first level's days after the due date.
  const firstDays = reminderSchedule(settings ?? {}).days[0]
  const dueOnOrBefore = addDaysIso(today, -firstDays)
  // Only invoices dated on or after the turn-on day (Europe/Stockholm, as the
  // policy compares) or already holding a reminder row: any other one the
  // policy neither reminds by itself nor lists, so its facts are not read.
  const enabledAt = (settings as { reminders_enabled_at?: string | null } | null)?.reminders_enabled_at ?? null
  const enabledOn = enabledAt ? todayIsoStockholm(new Date(enabledAt)) : null

  const candidates = await fetchAllRows<{ id: string }>((range) =>
    db
      .rpc('list_reminder_candidate_invoices', { p_company_id: companyId, p_due_on_or_before: dueOnOrBefore, p_enabled_on: enabledOn })
      .order('due_date', { ascending: true })
      .order('id', { ascending: true })
      .range(range.from, range.to),
  )

  const decided = await mapWithConcurrency(candidates, GATHER_CONCURRENCY, async ({ id }) => {
    const ctx = await loadReminderContext(db, companyId, id)
    if (ctx.companyInactive) return null
    const decision = decideReminder({
      today,
      schedule: reminderSchedule(ctx.company),
      enabledAt: ctx.company.reminders_enabled_at ?? null,
      invoice: ctx.facts,
      history: ctx.history,
    })
    const row = {
      invoice_id: ctx.invoice.id,
      invoice_number: ctx.invoice.invoice_number ?? null,
      customer_name: ctx.customer?.name ?? null,
      due_date: ctx.invoice.due_date,
    }
    const excluded = (reason: ReminderBatchExcludedReason): ReminderBatchExcluded => ({ ...row, reason })

    if (decision.kind === 'skip') return LISTED.has(decision.reason) ? excluded(decision.reason as ReminderBatchExcludedReason) : null

    const bank = await checkReminderBank(db, ctx, { companyId, today, now })
    if (bank.outcome === 'candidates') return excluded('possible_payment')
    const item: ReminderBatchItem = {
      ...row,
      kind: REMINDER_BATCH_ITEM_KIND,
      recipient: ctx.facts.recipient ?? '',
      level: decision.level,
      remaining_amount: roundOre(ctx.facts.remaining),
      currency: ctx.invoice.currency,
      bank: bank.outcome === 'pass' ? 'fresh' : bank.outcome,
    }
    return { item, automatic: sendsAutomatically(ctx.facts) }
  })

  const items: ReminderBatchItem[] = []
  const excludedRows: ReminderBatchExcluded[] = []
  const automaticInvoiceIds: string[] = []
  for (const entry of decided) {
    if (!entry) continue
    if ('item' in entry) {
      items.push(entry.item)
      if (entry.automatic) automaticInvoiceIds.push(entry.item.invoice_id)
    } else excludedRows.push(entry)
  }
  return { batchDate: today, items, excluded: excludedRows, automaticInvoiceIds }
}

export type StageReminderBatchOutcome =
  | { status: 'staged'; operationId: string; items: number; excluded: number; sent: number }
  | { status: 'empty'; excluded: number; sent: number }
  | { status: 'pending_exists'; operationId: string; sent: number }
  | { status: 'already_staged'; sent: number }
  | { status: 'no_owner'; sent: number }

/** Sends a company's reminders automatically (phase 4): who turned it on, and the channel. */
export interface AutomaticSend {
  actorUserId: string
  channel: ReminderChannel
  log: Logger
  /** REMINDERS_SENDING_ENABLED, passed down so tests can pin it. */
  sendingEnabled?: boolean
}

/**
 * Stage today's batch for one company, unless one is pending or today's was
 * already staged (the unique indexes of 20261027120100 hold the same rule
 * against two racing runs). A batch with nothing to send stages nothing,
 * unless a reminder failed since the last run without anyone knowing
 * whether it went out: then a batch that only lists is staged, so a person
 * sees it. Such a batch does not hold the next day's reminders back: a
 * batch with reminders replaces it while it waits.
 *
 * With automatic sending on (automatic.ts), the reminders whose bank check
 * passed, for invoices issued and delivered from Accounted, go out now
 * (mode automatic, through dispatch.ts like every send, one row per invoice
 * and level so a second run sends nothing). Every other one is staged for a
 * person.
 */
export async function stageReminderBatch(
  db: Db,
  input: { companyId: string; now: Date; automatic?: AutomaticSend | null },
): Promise<StageReminderBatchOutcome> {
  const { companyId, now } = input
  const existing = await existingBatches(db, companyId, now)
  const waiting = existing.undecided
  const blockingId = waiting && !waiting.listOnly ? waiting.id : null
  if (!input.automatic) {
    if (blockingId) return { status: 'pending_exists', operationId: blockingId, sent: 0 }
    if (existing.stagedToday) return { status: 'already_staged', sent: 0 }
  }

  const gathered = await gatherReminderBatch(db, { companyId, now })
  let items = gathered.items
  let sent = 0
  if (input.automatic) {
    const mayGo = new Set(gathered.automaticInvoiceIds)
    const automatic = await sendAutomatically(
      db,
      companyId,
      items.filter((item) => item.bank === 'fresh' && mayGo.has(item.invoice_id)),
      now,
      input.automatic,
    )
    sent = automatic.sent
    items = items.filter((item) => !automatic.handled.has(item.invoice_id))
    if (blockingId) return { status: 'pending_exists', operationId: blockingId, sent }
    if (existing.stagedToday) return { status: 'already_staged', sent }
  }

  let unseenFailures = 0
  if (items.length === 0) {
    if (waiting) return { status: 'pending_exists', operationId: waiting.id, sent }
    unseenFailures = await countUnseenFailures(db, companyId, gathered.excluded, now)
    if (unseenFailures === 0) return { status: 'empty', excluded: gathered.excluded.length, sent }
  } else if (waiting) {
    // It only lists: today's batch lists the same invoices again.
    await withdrawListOnlyBatch(db, waiting.id, now)
  }

  const owner = await resolveDailyBatchOwner(db, companyId, input.automatic?.actorUserId ?? null)
  if (!owner) return { status: 'no_owner', sent }

  const params: ReminderBatchParams = { batch_date: gathered.batchDate, items, excluded: gathered.excluded }
  const { data: inserted, error: insertError } = await db
    .from('pending_operations')
    .insert({
      company_id: companyId,
      user_id: owner,
      operation_type: REMINDER_BATCH_TYPE,
      status: 'pending',
      title: reminderBatchTitle(gathered.batchDate, items.length, unseenFailures),
      params,
      preview_data: {
        batch_date: gathered.batchDate,
        item_count: items.length,
        excluded_count: gathered.excluded.length,
        levels: [1, 2, 3].map((level) => items.filter((item) => item.level === level).length),
        unchecked_bank_count: items.filter((item) => item.bank !== 'fresh').length,
        sent_automatically: sent,
      },
      actor_type: 'cron',
      actor_label: 'Daglig påminnelseomgång',
      risk_level: getRiskLevel(REMINDER_BATCH_TYPE),
      agent_metadata: { source: 'reminder_batch' },
      created_at: now.toISOString(),
    })
    .select('id')
    .single()
  if (insertError) {
    // Another run staged it first (one pending batch per company, one per day).
    if ((insertError as { code?: string }).code === '23505') return { status: 'already_staged', sent }
    throw new Error(`reminder batch staging failed: ${insertError.message}`)
  }
  return { status: 'staged', operationId: (inserted as { id: string }).id, items: items.length, excluded: gathered.excluded.length, sent }
}

/**
 * The automatic sends of one company's day; a failure is recorded on its row
 * (an unknown outcome stops that invoice's ladder). handled: every item but
 * those dispatch left for a person (needs_person), which are staged.
 */
async function sendAutomatically(
  db: Db,
  companyId: string,
  items: readonly ReminderBatchItem[],
  now: Date,
  automatic: AutomaticSend,
): Promise<{ sent: number; handled: Set<string> }> {
  let sent = 0
  const handled = new Set<string>()
  for (const item of items) {
    try {
      const outcome = await dispatchReminder(
        { db, channel: automatic.channel, now: () => now, log: automatic.log, sendingEnabled: automatic.sendingEnabled },
        { companyId, invoiceId: item.invoice_id, level: item.level, actorUserId: automatic.actorUserId, mode: 'automatic' },
      )
      if (outcome.status === 'sent') sent += 1
      if (outcome.status !== 'skipped' || outcome.reason !== 'needs_person') handled.add(item.invoice_id)
    } catch (error) {
      handled.add(item.invoice_id)
      automatic.log.error('automatic reminder failed', error as Error, { companyId, invoiceId: item.invoice_id })
    }
  }
  return { sent, handled }
}

/**
 * The company's batch still waiting for a decision (pending, or being sent),
 * whether it only lists (nothing staged to send), and whether today's was
 * already staged, whatever became of it: one batch per day.
 */
async function existingBatches(
  db: Db,
  companyId: string,
  now: Date,
): Promise<{ undecided: { id: string; listOnly: boolean } | null; stagedToday: boolean }> {
  const [undecided, recent] = await Promise.all([
    db
      .from('pending_operations')
      .select('id, status, item_count:preview_data->item_count')
      .eq('company_id', companyId)
      .eq('operation_type', REMINDER_BATCH_TYPE)
      .in('status', ['pending', 'committing'])
      .limit(1),
    db
      .from('pending_operations')
      .select('params')
      .eq('company_id', companyId)
      .eq('operation_type', REMINDER_BATCH_TYPE)
      .gte('created_at', new Date(now.getTime() - 2 * 86_400_000).toISOString()),
  ])
  if (undecided.error) throw new Error(`reminder batch lookup failed: ${undecided.error.message}`)
  if (recent.error) throw new Error(`reminder batch lookup failed: ${recent.error.message}`)
  const batchDate = todayIsoStockholm(now)
  const row = (undecided.data ?? [])[0] as { id: string; status?: string; item_count?: unknown } | undefined
  return {
    undecided: row ? { id: row.id, listOnly: row.status === 'pending' && row.item_count === 0 } : null,
    stagedToday: ((recent.data ?? []) as Array<{ params: { batch_date?: unknown } | null }>).some((r) => r.params?.batch_date === batchDate),
  }
}

/**
 * How many of the invoices listed as send_failed failed since the last run
 * (failed_at), so no batch has shown them yet.
 */
async function countUnseenFailures(db: Db, companyId: string, excluded: readonly ReminderBatchExcluded[], now: Date): Promise<number> {
  const ids = excluded.filter((row) => row.reason === 'send_failed').map((row) => row.invoice_id)
  const since = new Date(now.getTime() - UNSEEN_FAILURE_HOURS * 3_600_000).toISOString()
  const unseen = new Set<string>()
  for (const part of chunk(ids, IN_CHUNK)) {
    const { data, error } = await db
      .from('invoice_reminders')
      .select('invoice_id')
      .eq('company_id', companyId)
      .eq('status', 'failed')
      .gte('failed_at', since)
      .in('invoice_id', part)
    if (error) throw new Error(`invoice_reminders lookup failed: ${error.message}`)
    for (const row of (data ?? []) as Array<{ invoice_id: string }>) unseen.add(row.invoice_id)
  }
  return unseen.size
}

/** A waiting batch that only lists goes when a batch with reminders is staged: nobody judged it. */
async function withdrawListOnlyBatch(db: Db, operationId: string, now: Date): Promise<void> {
  const { error } = await db
    .from('pending_operations')
    .update({
      status: 'rejected',
      resolved_at: now.toISOString(),
      rejection_category: 'superseded',
      result_data: { auto_rejected: true, reason: 'superseded' },
    })
    .eq('id', operationId)
    .eq('status', 'pending')
  if (error) throw new Error(`reminder batch withdrawal failed: ${error.message}`)
}

export interface ReminderBatchCronSummary {
  enabled: boolean
  companies: number
  staged: number
  empty: number
  pendingExists: number
  alreadyStaged: number
  noOwner: number
  /** Pending batches past their three days, or of a company that turned reminders off since. */
  withdrawn: number
  /** Reminders left reserved by a send that never finished, now failed with an unknown outcome. */
  swept: number
  /** Reminders sent without approval, for companies with automatic sending on. */
  sentAutomatically: number
  /** Companies with automatic sending on whose batch waits for approval today (see runReminderBatchCron). */
  automaticHeld: number
  failed: number
}

export interface ReminderBatchCronDeps {
  db: Db
  now?: () => Date
  /** The channel automatic sends go through; default email over the installation's EmailService. */
  channel?: ReminderChannel
  /** REMINDERS_SENDING_ENABLED; a parameter only so tests can pin both states. */
  sendingEnabled?: boolean
  log?: Logger
}

/** One company the daily run visits (list_reminder_batch_companies). */
interface BatchCompanyRow {
  company_id: string
  reminders_automatic_at: string | null
  reminders_automatic_by: string | null
  /** The person who turned automatic sending on is still an owner or administrator. */
  automatic_by_admin: boolean
}

/**
 * GET /api/reminders/batch/cron: stage the day's batch for every company
 * with reminders on, sending the sure ones at once for a company with
 * automatic sending on (automatic.ts). Off entirely while REMINDERS_SENDING_ENABLED is false:
 * no query runs. Archived, reset and sandbox companies are not visited
 * (list_reminder_batch_companies, the companyInactive rule of facts.ts);
 * companies whose invoices a collections provider pursues are skipped per
 * invoice by the same facts the send reads.
 *
 * First, reservations that outlived any send (RESERVATION_SWEEP_MINUTES)
 * are marked failed with an unknown outcome, so today's batches list them.
 * Automatic sending waits for approval, logged, when the person who turned
 * it on is no longer an owner or administrator, or the company has lost
 * email sending (the email_send capability approval is gated on too).
 */
export async function runReminderBatchCron(deps: ReminderBatchCronDeps): Promise<ReminderBatchCronSummary> {
  const summary: ReminderBatchCronSummary = {
    enabled: false,
    companies: 0,
    staged: 0,
    empty: 0,
    pendingExists: 0,
    alreadyStaged: 0,
    noOwner: 0,
    withdrawn: 0,
    swept: 0,
    sentAutomatically: 0,
    automaticHeld: 0,
    failed: 0,
  }
  if (!(deps.sendingEnabled ?? REMINDERS_SENDING_ENABLED)) return summary
  summary.enabled = true
  const { db } = deps
  const now = deps.now ? deps.now() : new Date()
  const cronLog = deps.log ?? log

  summary.swept = await sweepInterruptedReminders(db, now, cronLog)
  summary.withdrawn += await expireStaleDailyBatches(db, REMINDER_BATCH_TYPE, null, now)
  try {
    summary.withdrawn += await withdrawBatchesOfCompaniesTurnedOff(db, now)
  } catch (error) {
    // Tomorrow's run tries again; today's batches go out regardless.
    cronLog.error('reminder batches of companies that turned reminders off not withdrawn', error as Error)
  }

  const companies = await fetchAllRows<BatchCompanyRow>((range) =>
    db.rpc('list_reminder_batch_companies').order('company_id', { ascending: true }).range(range.from, range.to),
  )
  summary.companies = companies.length

  let channel = deps.channel ?? null
  for (const company of companies) {
    const companyId = company.company_id
    try {
      let automatic: AutomaticSend | null = null
      if (company.reminders_automatic_at && company.reminders_automatic_by) {
        if (!company.automatic_by_admin) {
          summary.automaticHeld += 1
          cronLog.warn('automatic reminders wait for approval: whoever turned them on is no longer an owner or administrator', {
            companyId,
            automaticBy: company.reminders_automatic_by,
          })
        } else if (!(await hasCapability(db, companyId, CAPABILITY.email_send))) {
          summary.automaticHeld += 1
          cronLog.warn('automatic reminders wait for approval: the company has no email_send capability', { companyId })
        } else {
          channel ??= createEmailReminderChannel(await getEmailService())
          automatic = { actorUserId: company.reminders_automatic_by, channel, log: cronLog, sendingEnabled: deps.sendingEnabled }
        }
      }
      const outcome = await stageReminderBatch(db, { companyId, now, automatic })
      summary.sentAutomatically += outcome.sent
      switch (outcome.status) {
        case 'staged':
          summary.staged += 1
          break
        case 'empty':
          summary.empty += 1
          break
        case 'pending_exists':
          summary.pendingExists += 1
          break
        case 'already_staged':
          summary.alreadyStaged += 1
          break
        case 'no_owner':
          summary.noOwner += 1
          cronLog.warn('reminder batch has no owner to stage under', { companyId })
          break
      }
    } catch (error) {
      summary.failed += 1
      cronLog.error('reminder batch failed for a company', error as Error, { companyId })
    }
  }
  return summary
}

/**
 * Reservations older than RESERVATION_SWEEP_MINUTES to failed with an
 * unknown outcome (sweep_interrupted_invoice_reminders). A failed sweep is
 * logged and the run goes on: such a row keeps stopping its invoice's
 * ladder (in_flight) until a later run sweeps it.
 */
async function sweepInterruptedReminders(db: Db, now: Date, cronLog: Logger): Promise<number> {
  const { data, error } = await db.rpc('sweep_interrupted_invoice_reminders', {
    p_reserved_before: new Date(now.getTime() - RESERVATION_SWEEP_MINUTES * 60_000).toISOString(),
  })
  if (error) {
    cronLog.error('interrupted reminders not swept', new Error(error.message))
    return 0
  }
  let swept = 0
  for (const row of (data ?? []) as Array<{ company_id: string; swept: number }>) {
    swept += row.swept
    cronLog.warn('reminder sends that never finished marked failed, outcome unknown', { companyId: row.company_id, swept: row.swept })
  }
  return swept
}

/** A pending batch of a company that has turned reminders off goes: it can no longer be approved. */
async function withdrawBatchesOfCompaniesTurnedOff(db: Db, now: Date): Promise<number> {
  const rows = await fetchAllRows<{ id: string; company_id: string }>((range) =>
    db
      .from('pending_operations')
      .select('id, company_id')
      .eq('operation_type', REMINDER_BATCH_TYPE)
      .eq('status', 'pending')
      .order('id', { ascending: true })
      .range(range.from, range.to),
  )
  if (rows.length === 0) return 0

  const stillOn = new Set<string>()
  for (const part of chunk([...new Set(rows.map((r) => r.company_id))], IN_CHUNK)) {
    const { data: on, error: settingsError } = await db
      .from('company_settings')
      .select('company_id')
      .in('company_id', part)
      .eq('send_invoice_reminders', true)
    if (settingsError) throw new Error(`company_settings lookup failed: ${settingsError.message}`)
    for (const r of (on ?? []) as Array<{ company_id: string }>) stillOn.add(r.company_id)
  }
  const off = rows.filter((r) => !stillOn.has(r.company_id)).map((r) => r.id)

  let withdrawn = 0
  for (const part of chunk(off, IN_CHUNK)) {
    const { data, error: updateError } = await db
      .from('pending_operations')
      .update({
        status: 'rejected',
        resolved_at: now.toISOString(),
        rejection_category: 'superseded',
        result_data: { auto_rejected: true, reason: 'reminders_off' },
      })
      .in('id', part)
      .eq('status', 'pending')
      .select('id')
    if (updateError) throw new Error(`reminder batch withdrawal failed: ${updateError.message}`)
    withdrawn += (data ?? []).length
  }
  return withdrawn
}
