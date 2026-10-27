import type { SupabaseClient } from '@supabase/supabase-js'
import { mapWithConcurrency } from '@/lib/concurrency'
import { addDaysIso, todayIsoStockholm } from '@/lib/dates/iso'
import { getEmailService } from '@/lib/email/service'
import { REMINDERS_SENDING_ENABLED } from '@/lib/invoices/reminders-enabled'
import { createLogger, type Logger } from '@/lib/logger'
import { roundOre } from '@/lib/money'
import { expireStaleDailyBatches, resolveDailyBatchOwner } from '@/lib/pending-operations/daily-batch-staging'
import { getRiskLevel } from '@/lib/pending-operations/risk-tiers'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
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
import { decideReminder, reminderSchedule } from './policy'

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
 * (imported, issued before reminders were turned on) are not.
 */

const log = createLogger('reminders/gather')

/** Invoices decided at once while gathering (each reads its facts and may check the bank). */
const GATHER_CONCURRENCY = 4

const LISTED = new Set<string>(REMINDER_BATCH_EXCLUDED_REASONS)

export interface GatheredReminderBatch {
  batchDate: string
  items: ReminderBatchItem[]
  excluded: ReminderBatchExcluded[]
}

type Db = SupabaseClient

/** Today's reminders for one company: due items, and the stopped invoices a person should see. */
export async function gatherReminderBatch(db: Db, input: { companyId: string; now: Date }): Promise<GatheredReminderBatch> {
  const { companyId, now } = input
  const today = todayIsoStockholm(now)

  const { data: settings, error } = await db
    .from('company_settings')
    .select('reminder_days_level_1, reminder_days_level_2, reminder_days_level_3')
    .eq('company_id', companyId)
    .maybeSingle()
  if (error) throw new Error(`company_settings lookup failed: ${error.message}`)
  // No level is due before the first level's days after the due date.
  const firstDays = reminderSchedule(settings ?? {}).days[0]
  const dueOnOrBefore = addDaysIso(today, -firstDays)

  const candidates = await fetchAllRows<{ id: string }>((range) =>
    db
      .from('invoices')
      .select('id')
      .eq('company_id', companyId)
      .in('status', ['sent', 'overdue', 'partially_paid'])
      .lte('due_date', dueOnOrBefore)
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
    return item
  })

  const items: ReminderBatchItem[] = []
  const excludedRows: ReminderBatchExcluded[] = []
  for (const entry of decided) {
    if (!entry) continue
    if ('kind' in entry) items.push(entry)
    else excludedRows.push(entry)
  }
  return { batchDate: today, items, excluded: excludedRows }
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
 * against two racing runs). A batch with nothing to send stages nothing.
 *
 * With automatic sending on (automatic.ts), the reminders whose bank check
 * passed go out now (mode automatic, through dispatch.ts like every send,
 * one row per invoice and level so a second run sends nothing), and only
 * the uncertain ones are staged for a person.
 */
export async function stageReminderBatch(
  db: Db,
  input: { companyId: string; now: Date; automatic?: AutomaticSend | null },
): Promise<StageReminderBatchOutcome> {
  const { companyId, now } = input
  const existing = await existingBatches(db, companyId, now)
  const undecidedId = existing.undecidedId
  if (!input.automatic) {
    if (undecidedId) return { status: 'pending_exists', operationId: undecidedId, sent: 0 }
    if (existing.stagedToday) return { status: 'already_staged', sent: 0 }
  }

  const gathered = await gatherReminderBatch(db, { companyId, now })
  let items = gathered.items
  let sent = 0
  if (input.automatic) {
    sent = await sendAutomatically(db, companyId, items.filter((item) => item.bank === 'fresh'), now, input.automatic)
    items = items.filter((item) => item.bank !== 'fresh')
    if (undecidedId) return { status: 'pending_exists', operationId: undecidedId, sent }
    if (existing.stagedToday) return { status: 'already_staged', sent }
  }
  if (items.length === 0) return { status: 'empty', excluded: gathered.excluded.length, sent }

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
      title: reminderBatchTitle(gathered.batchDate, items.length),
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

/** The automatic sends of one company's day; a failure is recorded on its row and stops that invoice's ladder. */
async function sendAutomatically(
  db: Db,
  companyId: string,
  items: readonly ReminderBatchItem[],
  now: Date,
  automatic: AutomaticSend,
): Promise<number> {
  let sent = 0
  for (const item of items) {
    try {
      const outcome = await dispatchReminder(
        { db, channel: automatic.channel, now: () => now, log: automatic.log, sendingEnabled: automatic.sendingEnabled },
        { companyId, invoiceId: item.invoice_id, level: item.level, actorUserId: automatic.actorUserId, mode: 'automatic' },
      )
      if (outcome.status === 'sent') sent += 1
    } catch (error) {
      automatic.log.error('automatic reminder failed', error as Error, { companyId, invoiceId: item.invoice_id })
    }
  }
  return sent
}

/**
 * The company's batch still waiting for a decision (pending, or being sent),
 * and whether today's was already staged, whatever became of it: one batch
 * per day.
 */
async function existingBatches(db: Db, companyId: string, now: Date): Promise<{ undecidedId: string | null; stagedToday: boolean }> {
  const [undecided, recent] = await Promise.all([
    db
      .from('pending_operations')
      .select('id')
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
  return {
    undecidedId: ((undecided.data ?? [])[0] as { id: string } | undefined)?.id ?? null,
    stagedToday: ((recent.data ?? []) as Array<{ params: { batch_date?: unknown } | null }>).some((r) => r.params?.batch_date === batchDate),
  }
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
  /** Reminders sent without approval, for companies with automatic sending on. */
  sentAutomatically: number
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

/**
 * GET /api/reminders/batch/cron: stage the day's batch for every company
 * with reminders on, sending the sure ones at once for a company with
 * automatic sending on (automatic.ts). Off entirely while REMINDERS_SENDING_ENABLED is false:
 * no query runs. Archived, reset and sandbox companies, and companies whose
 * invoices a collections provider pursues, are skipped per invoice by the
 * same facts the send reads.
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
    sentAutomatically: 0,
    failed: 0,
  }
  if (!(deps.sendingEnabled ?? REMINDERS_SENDING_ENABLED)) return summary
  summary.enabled = true
  const { db } = deps
  const now = deps.now ? deps.now() : new Date()
  const cronLog = deps.log ?? log

  summary.withdrawn += await expireStaleDailyBatches(db, REMINDER_BATCH_TYPE, null, now)
  summary.withdrawn += await withdrawBatchesOfCompaniesTurnedOff(db, now)

  const companies = await fetchAllRows<{ company_id: string; reminders_automatic_at: string | null; reminders_automatic_by: string | null }>((range) =>
    db
      .from('company_settings')
      .select('company_id, reminders_automatic_at, reminders_automatic_by')
      .eq('send_invoice_reminders', true)
      .order('company_id', { ascending: true })
      .range(range.from, range.to),
  )
  summary.companies = companies.length

  let channel = deps.channel ?? null
  for (const { company_id: companyId, reminders_automatic_at: automaticAt, reminders_automatic_by: automaticBy } of companies) {
    try {
      let automatic: AutomaticSend | null = null
      if (automaticAt && automaticBy) {
        channel ??= createEmailReminderChannel(await getEmailService())
        automatic = { actorUserId: automaticBy, channel, log: cronLog, sendingEnabled: deps.sendingEnabled }
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

/** A pending batch of a company that has turned reminders off goes: it can no longer be approved. */
async function withdrawBatchesOfCompaniesTurnedOff(db: Db, now: Date): Promise<number> {
  const { data: pending, error } = await db
    .from('pending_operations')
    .select('id, company_id')
    .eq('operation_type', REMINDER_BATCH_TYPE)
    .eq('status', 'pending')
  if (error) throw new Error(`reminder batch lookup failed: ${error.message}`)
  const rows = (pending ?? []) as Array<{ id: string; company_id: string }>
  if (rows.length === 0) return 0

  const { data: on, error: settingsError } = await db
    .from('company_settings')
    .select('company_id')
    .in('company_id', [...new Set(rows.map((r) => r.company_id))])
    .eq('send_invoice_reminders', true)
  if (settingsError) throw new Error(`company_settings lookup failed: ${settingsError.message}`)
  const stillOn = new Set(((on ?? []) as Array<{ company_id: string }>).map((r) => r.company_id))
  const off = rows.filter((r) => !stillOn.has(r.company_id)).map((r) => r.id)
  if (off.length === 0) return 0

  const { data: withdrawn, error: updateError } = await db
    .from('pending_operations')
    .update({
      status: 'rejected',
      resolved_at: now.toISOString(),
      rejection_category: 'superseded',
      result_data: { auto_rejected: true, reason: 'reminders_off' },
    })
    .in('id', off)
    .eq('status', 'pending')
    .select('id')
  if (updateError) throw new Error(`reminder batch withdrawal failed: ${updateError.message}`)
  return (withdrawn ?? []).length
}
