/**
 * What a machine door does to a company's recurring invoice schedules: list
 * them, create one, change one. One implementation behind the v1 endpoints,
 * the generated MCP tools and the approval of a staged proposal
 * (lib/operations/recurring-invoice-schedules.ts), so a proposal is checked
 * at staging by exactly the rules its approval runs:
 *
 *   - the customer is the company's, and has an email address while the
 *     schedule sends by itself (auto_send);
 *   - every linked article is the company's (findForeignRecurringArticleIds);
 *   - a start_date or next_run_date sits on the schedule's grid (day_of_month,
 *     clamped in shorter months); a next_run_date is after today in
 *     Stockholm, and a start_date is not in the past. At the approval of a
 *     proposal a date that went stale while it waited is no refusal: a
 *     start_date is kept (the cron rolls a missed date forward on the grid)
 *     and a next_run_date rolls forward on its own grid, so the phase the
 *     person approved survives a slow approval;
 *   - period placeholders in the texts in effect need a period_start in
 *     effect (periodPlaceholderProblem);
 *   - a reactivation or a new day_of_month moves next_run_date to the next
 *     strictly future run, never today, so no edit sends an invoice the same
 *     hour; any other edit leaves it alone.
 *
 * The dashboard routes (app/api/invoices/recurring) keep their own envelope
 * and enforce the same rules with the same helpers (recurring-run-date,
 * recurring-schedule-items, apply-recurring-schedule-update). A dry run reads
 * and checks; it writes nothing.
 */
import type { OperationContext, OperationOutcome } from '@/lib/operations/types'
import type { z } from 'zod'
import type { UpdateRecurringScheduleObjectSchema } from '@/lib/api/schemas'
import { dbError } from '@/lib/errors/db-error'
import { getErrorEntry } from '@/lib/errors/structured-errors'
import { roundOre } from '@/lib/money'
import { applyRecurringScheduleUpdate } from './apply-recurring-schedule-update'
import { periodPlaceholderProblem } from './recurring-placeholders'
import { runDateMatchesDayOfMonth } from './recurring-run-date'
import {
  computeInitialRunDate,
  computeNextRunDate,
  getStockholmDateHour,
  rollNextRunDateForward,
} from './recurring-schedule-service'
import {
  RECURRING_ARTICLE_INVALID_MESSAGE,
  findForeignRecurringArticleIds,
  insertRecurringScheduleItems,
  toRecurringScheduleItemRow,
  toRecurringScheduleRow,
  type RecurringScheduleCreateInput,
} from './recurring-schedule-items'

type Failure = Extract<OperationOutcome<never>, { ok: false }>

export type CreateRecurringScheduleInput = RecurringScheduleCreateInput
export type RecurringScheduleChanges = z.output<typeof UpdateRecurringScheduleObjectSchema>
export type UpdateRecurringScheduleInput = RecurringScheduleChanges & { schedule_id: string }

/** A database failure, its SQLSTATE kept (a statement timeout is still answered as retryable). */
function failed(error: unknown): Failure {
  return { ok: false, code: 'UNKNOWN_ERROR', error: error instanceof Error ? error : dbError(error) }
}

/** A rule a field breaks: the Swedish for the person, the English for the agent and the API client. */
function refused(field: string, messageSv: string, messageEn: string, extra: Record<string, unknown> = {}): Failure {
  return { ok: false, code: 'VALIDATION_ERROR', messageSv, messageEn, details: { field, message: messageEn, ...extra } }
}

const CUSTOMER_NOT_FOUND: Failure = { ok: false, code: 'CUSTOMER_NOT_FOUND', details: { field: 'customer_id' } }
const SCHEDULE_NOT_FOUND: Failure = { ok: false, code: 'RECURRING_SCHEDULE_NOT_FOUND', details: { field: 'schedule_id' } }

const NO_EMAIL = (field: string) =>
  refused(
    field,
    'Kunden saknar e-postadress: ett schema som skickar fakturorna själv behöver en. Lägg till en e-postadress på kunden, eller skapa fakturorna som utkast (auto_send false).',
    'The customer has no email address: auto_send requires one. Add an email to the customer first, or keep auto_send false.',
  )

const today = () => getStockholmDateHour(new Date()).date

async function foreignArticles(
  ctx: OperationContext,
  items: ReadonlyArray<{ line_type?: string | null; article_id?: string | null }>,
): Promise<Failure | null> {
  const { invalidArticleIds, error } = await findForeignRecurringArticleIds(ctx.supabase, ctx.companyId, items)
  if (error) return failed(error)
  if (invalidArticleIds.length === 0) return null
  return refused(
    'items',
    'Artikeln finns inte i företaget: välj en ur artikelregistret, eller ta bort article_id.',
    RECURRING_ARTICLE_INVALID_MESSAGE,
    { article_ids: invalidArticleIds },
  )
}

/** Price per run excl. VAT: the template lines, text rows aside (they carry no amounts). */
function totalExclVat(items: ReadonlyArray<{ line_type?: string | null; quantity: unknown; unit_price: unknown }>): number {
  return roundOre(
    items.filter((item) => item.line_type !== 'text').reduce((sum, item) => sum + Number(item.quantity) * Number(item.unit_price), 0),
  )
}

// ── List ─────────────────────────────────────────────────────────────────────

export interface ListRecurringSchedulesFilters {
  status?: 'active' | 'paused'
  limit?: number
  offset?: number
}

/** The schedule as a machine door lists it: qualified ids, its lines in their order. */
export interface RecurringScheduleListed {
  recurring_schedule_id: string
  name: string
  status: string
  customer_id: string
  customer_name: string | null
  day_of_month: number
  interval_months: number
  send_hour: number
  payment_terms_days: number
  currency: string
  auto_send: boolean
  next_run_date: string
  period_start: string | null
  last_run_at: string | null
  last_invoice_id: string | null
  last_run_warning: string | null
  generated_count: number
  monthly_total_excl_vat: number
  default_dimensions: Record<string, string>
  items: Array<{
    line_type: string
    description: string
    quantity: number
    unit: string
    unit_price: number
    vat_rate: number | null
    dimensions: Record<string, string>
    article_id: string | null
  }>
}

export interface RecurringSchedulePage {
  schedules: RecurringScheduleListed[]
  count: number
  total_count: number
  has_more: boolean
  next_offset?: number
}

type ScheduleRow = Record<string, unknown> & { items?: Array<Record<string, unknown>> | null }

/** A schedule's lines in their order, as every door shows them. */
function orderedItems(row: { items?: Array<Record<string, unknown>> | null }): RecurringScheduleListed['items'] {
  return (row.items ?? [])
    .slice()
    .sort((a, b) => Number(a.sort_order) - Number(b.sort_order))
    .map((it) => ({
      line_type: (it.line_type as string | undefined) ?? 'product',
      description: it.description as string,
      quantity: it.quantity as number,
      unit: it.unit as string,
      unit_price: it.unit_price as number,
      vat_rate: (it.vat_rate as number | null | undefined) ?? null,
      dimensions: (it.dimensions as Record<string, string> | null | undefined) ?? {},
      // '*' on the line join: article_id is absent until migration 20261101003800.
      article_id: (it.article_id as string | null | undefined) ?? null,
    }))
}

/**
 * One page of the company's schedules, newest first, `limit` at a time from
 * `offset`. One row past the page is read so has_more holds even when the
 * count is missing.
 */
export async function listRecurringSchedules(
  ctx: OperationContext,
  filters: ListRecurringSchedulesFilters,
): Promise<OperationOutcome<RecurringSchedulePage>> {
  const limit = filters.limit ?? 50
  const offset = filters.offset ?? 0
  let query = ctx.supabase
    .from('recurring_invoice_schedules')
    .select(
      'id, name, status, customer_id, day_of_month, interval_months, send_hour, payment_terms_days, currency, auto_send, default_dimensions, next_run_date, period_start, last_run_at, last_invoice_id, last_run_warning, generated_count, customer:customers(name), items:recurring_invoice_schedule_items(*)',
      { count: 'exact' },
    )
    .eq('company_id', ctx.companyId)
  if (filters.status) query = query.eq('status', filters.status)
  const { data, error, count } = await query
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .range(offset, offset + limit)
  if (error) return failed(error)

  const rows = (data ?? []) as ScheduleRow[]
  const schedules = rows.slice(0, limit).map((row): RecurringScheduleListed => {
    const items = orderedItems(row)
    return {
      recurring_schedule_id: row.id as string,
      name: row.name as string,
      status: row.status as string,
      customer_id: row.customer_id as string,
      customer_name: ((row.customer as { name?: string } | null)?.name as string | undefined) ?? null,
      day_of_month: row.day_of_month as number,
      interval_months: (row.interval_months as number | undefined) ?? 1,
      send_hour: row.send_hour as number,
      payment_terms_days: row.payment_terms_days as number,
      currency: row.currency as string,
      auto_send: row.auto_send as boolean,
      next_run_date: row.next_run_date as string,
      period_start: (row.period_start as string | null | undefined) ?? null,
      last_run_at: (row.last_run_at as string | null | undefined) ?? null,
      last_invoice_id: (row.last_invoice_id as string | null | undefined) ?? null,
      last_run_warning: (row.last_run_warning as string | null | undefined) ?? null,
      generated_count: (row.generated_count as number | undefined) ?? 0,
      monthly_total_excl_vat: totalExclVat(items),
      default_dimensions: (row.default_dimensions as Record<string, string> | null | undefined) ?? {},
      items,
    }
  })
  const hasMore = count == null ? rows.length > limit : offset + schedules.length < count
  return {
    ok: true,
    data: {
      schedules,
      count: schedules.length,
      total_count: count ?? offset + schedules.length + (hasMore ? 1 : 0),
      has_more: hasMore,
      ...(hasMore ? { next_offset: offset + schedules.length } : {}),
    },
  }
}

// ── Create ───────────────────────────────────────────────────────────────────

export interface RecurringScheduleCreated {
  recurring_schedule_id: string
  name: string
  customer_id: string
  day_of_month: number
  interval_months: number
  send_hour: number
  currency: string
  auto_send: boolean
  status: 'active'
  next_run_date: string
  item_count: number
}

/**
 * Create a schedule with its lines. The lines go in after the schedule row;
 * when they fail, the row is deleted again, since a schedule without lines
 * makes every cron run throw "schedule has no items" and skip its dates.
 */
export async function createRecurringSchedule(
  ctx: OperationContext,
  input: CreateRecurringScheduleInput,
  { dryRun }: { dryRun: boolean },
): Promise<OperationOutcome<RecurringScheduleCreated>> {
  const { supabase, companyId } = ctx
  const { data: customer, error: customerError } = await supabase
    .from('customers')
    .select('id, name, email')
    .eq('id', input.customer_id)
    .eq('company_id', companyId)
    .maybeSingle()
  if (customerError) return failed(customerError)
  if (!customer) return CUSTOMER_NOT_FOUND
  const articles = await foreignArticles(ctx, input.items)
  if (articles) return articles
  // An auto-sending schedule without an email would degrade every run to a draft and a warning.
  if (input.auto_send && !customer.email) return NO_EMAIL('auto_send')

  if (input.start_date !== undefined) {
    if (!runDateMatchesDayOfMonth(input.start_date, input.day_of_month)) {
      return refused(
        'start_date',
        `Startdatumet ${input.start_date} infaller inte på dag ${input.day_of_month} i månaden (som flyttas till månadens sista dag i kortare månader). Välj ett datum på den dagen, eller ändra day_of_month.`,
        `start_date ${input.start_date} does not fall on day_of_month ${input.day_of_month} (clamped to the last day in shorter months). Pick a date on that day or change day_of_month.`,
      )
    }
    // A proposal approved after its start_date passed keeps it: the cron
    // rolls a missed run forward on the grid, so the phase still holds.
    const todayStockholm = today()
    if (!ctx.pendingOperationId && input.start_date < todayStockholm) {
      return refused(
        'start_date',
        `Startdatumet ${input.start_date} har redan passerat (i dag är det ${todayStockholm}).`,
        `start_date ${input.start_date} is in the past (today in Europe/Stockholm is ${todayStockholm}).`,
      )
    }
  }

  const nextRunDate = computeInitialRunDate(new Date(), input.day_of_month, input.start_date)
  if (dryRun) {
    // auto_send stands in the preview: a schedule that sends by itself is
    // outbound customer email that never sees an approval again.
    return {
      ok: true,
      dryRun: true,
      preview: {
        name: input.name,
        customer_id: customer.id,
        customer_name: customer.name,
        day_of_month: input.day_of_month,
        interval_months: input.interval_months,
        send_hour: input.send_hour,
        payment_terms_days: input.payment_terms_days,
        currency: input.currency,
        auto_send: input.auto_send,
        projected_first_run_date: nextRunDate,
        monthly_total_excl_vat: totalExclVat(input.items),
        items: input.items,
        ...(input.default_dimensions && Object.keys(input.default_dimensions).length > 0
          ? { default_dimensions: input.default_dimensions }
          : {}),
      },
    }
  }

  const { data: schedule, error: insertError } = await supabase
    .from('recurring_invoice_schedules')
    .insert(toRecurringScheduleRow(companyId, ctx.userId, input, nextRunDate))
    .select()
    .single()
  if (insertError || !schedule) return failed(insertError ?? new Error('Failed to insert recurring schedule'))

  const scheduleId = (schedule as { id: string }).id
  const itemRows = input.items.map((item, idx) => toRecurringScheduleItemRow(scheduleId, item, idx))
  const { error: itemsError } = await insertRecurringScheduleItems(supabase, itemRows)
  if (itemsError) {
    const { error: rollbackError } = await supabase
      .from('recurring_invoice_schedules')
      .delete()
      .eq('id', scheduleId)
      .eq('company_id', companyId)
    if (rollbackError) {
      ctx.log.error('recurring schedule without lines left after a failed line insert', rollbackError, { scheduleId })
    }
    return failed(itemsError)
  }

  return {
    ok: true,
    created: true,
    data: {
      recurring_schedule_id: scheduleId,
      name: input.name,
      customer_id: input.customer_id,
      day_of_month: input.day_of_month,
      interval_months: input.interval_months,
      send_hour: input.send_hour,
      currency: input.currency,
      auto_send: input.auto_send,
      status: 'active',
      next_run_date: nextRunDate,
      item_count: itemRows.length,
    },
  }
}

// ── Update ───────────────────────────────────────────────────────────────────

export interface RecurringScheduleUpdated {
  recurring_schedule_id: string
  status: string
  updated_fields: string[]
  items_replaced: boolean
  item_count?: number
  next_run_date?: string
}

/** The fields a change may name, in the order the schedule shows them. */
const CHANGE_FIELDS = [
  'customer_id',
  'name',
  'day_of_month',
  'interval_months',
  'send_hour',
  'payment_terms_days',
  'currency',
  'your_reference',
  'our_reference',
  'notes',
  'period_start',
  'auto_send',
  'status',
  'next_run_date',
  'default_dimensions',
  'items',
] as const

/** The changes an update names: every field given, nothing else. */
export function scheduleChanges(input: UpdateRecurringScheduleInput): RecurringScheduleChanges {
  const changes: Record<string, unknown> = {}
  for (const field of CHANGE_FIELDS) {
    if (input[field] !== undefined) changes[field] = input[field]
  }
  return changes as RecurringScheduleChanges
}

interface CurrentSchedule {
  id: string
  name: string
  status: string
  customer_id: string
  day_of_month: number
  interval_months: number | null
  send_hour: number
  payment_terms_days: number
  currency: string
  your_reference: string | null
  our_reference: string | null
  notes: string | null
  period_start: string | null
  auto_send: boolean
  default_dimensions: Record<string, string> | null
  next_run_date: string
  customer: { name?: string | null; email?: string | null } | null
  items: Array<Record<string, unknown>> | null
}

/**
 * Change a schedule: the header fields, and the lines replaced as a whole
 * when `items` is given (apply-recurring-schedule-update.ts compensates both
 * writes on failure). The dry run previews the schedule as it stands, the
 * changes and the schedule as it would be.
 */
export async function updateRecurringSchedule(
  ctx: OperationContext,
  input: UpdateRecurringScheduleInput,
  { dryRun }: { dryRun: boolean },
): Promise<OperationOutcome<RecurringScheduleUpdated>> {
  const { supabase, companyId } = ctx
  const scheduleId = input.schedule_id
  const changes = scheduleChanges(input)
  const { items, ...fieldChanges } = changes

  const { data, error } = await supabase
    .from('recurring_invoice_schedules')
    .select(
      'id, name, status, customer_id, day_of_month, interval_months, send_hour, payment_terms_days, currency, your_reference, our_reference, notes, period_start, auto_send, default_dimensions, next_run_date, customer:customers(name, email), items:recurring_invoice_schedule_items(*)',
    )
    .eq('id', scheduleId)
    .eq('company_id', companyId)
    .maybeSingle()
  if (error) return failed(error)
  if (!data) return SCHEDULE_NOT_FOUND
  const current = data as unknown as CurrentSchedule

  if (items) {
    const articles = await foreignArticles(ctx, items)
    if (articles) return articles
  }

  // Period placeholders in the texts that will be in effect need a
  // period_start in effect: a change may touch the notes only.
  const periodProblem = periodPlaceholderProblem({
    notes: fieldChanges.notes !== undefined ? fieldChanges.notes : current.notes,
    itemDescriptions: (items ?? current.items ?? []).map((item) => item.description as string | null | undefined),
    periodStart: fieldChanges.period_start !== undefined ? fieldChanges.period_start : current.period_start,
  })
  if (periodProblem) {
    return refused(
      'period_start',
      periodProblem,
      'The texts use {periodstart}, {periodslut} or {nästa periodstart} but no period_start is in effect: set period_start, or drop the placeholders.',
    )
  }

  // A schedule that sends by itself needs the email of the customer it bills;
  // a new customer must be this company's whatever auto_send says.
  const effectiveAutoSend = fieldChanges.auto_send ?? current.auto_send
  if (fieldChanges.customer_id !== undefined) {
    const { data: target, error: targetError } = await supabase
      .from('customers')
      .select('id, email')
      .eq('id', fieldChanges.customer_id)
      .eq('company_id', companyId)
      .maybeSingle()
    if (targetError) return failed(targetError)
    if (!target) return CUSTOMER_NOT_FOUND
    if (effectiveAutoSend && !(target as { email?: string | null }).email) return NO_EMAIL('auto_send')
  } else if (fieldChanges.auto_send === true && !current.customer?.email) {
    return NO_EMAIL('auto_send')
  }

  const todayStockholm = today()
  const updateRow: Record<string, unknown> = {}
  for (const [field, value] of Object.entries(fieldChanges)) {
    if (value !== undefined) updateRow[field] = value
  }

  if (fieldChanges.status === 'active' || fieldChanges.day_of_month !== undefined || fieldChanges.next_run_date !== undefined) {
    const reactivating = fieldChanges.status === 'active'
    const dayChanged = fieldChanges.day_of_month !== undefined && fieldChanges.day_of_month !== current.day_of_month
    const effectiveDay = fieldChanges.day_of_month ?? current.day_of_month
    const effectiveInterval = fieldChanges.interval_months ?? current.interval_months ?? 1
    const stockholmToday = new Date(`${todayStockholm}T00:00:00Z`)

    // An explicit next_run_date re-phases the schedule and wins over the
    // recompute. Off the grid it is refused; one in the past or today is
    // refused too, except at the approval of a proposal that waited past it,
    // where it rolls forward on its own grid (strictly future).
    if (fieldChanges.next_run_date !== undefined) {
      const date = fieldChanges.next_run_date
      if (!runDateMatchesDayOfMonth(date, effectiveDay)) {
        return refused(
          'next_run_date',
          `Nästa körning ${date} infaller inte på dag ${effectiveDay} i månaden (som flyttas till månadens sista dag i kortare månader). Välj ett datum på den dagen, eller ändra day_of_month i samma ändring.`,
          `next_run_date ${date} does not fall on day_of_month ${effectiveDay} (clamped to the last day in shorter months). Pick a date on that day or change day_of_month in the same call.`,
        )
      }
      if (date <= todayStockholm) {
        if (!ctx.pendingOperationId) {
          return refused(
            'next_run_date',
            `Nästa körning måste ligga efter i dag (${todayStockholm}).`,
            `next_run_date must be after today in Europe/Stockholm (${todayStockholm}).`,
          )
        }
        updateRow.next_run_date = rollNextRunDateForward(date, stockholmToday, effectiveDay, effectiveInterval)
      }
    }

    const staleOnReactivate = reactivating && current.next_run_date <= todayStockholm
    if (fieldChanges.next_run_date === undefined && (staleOnReactivate || dayChanged)) {
      if (effectiveInterval === 1) {
        // Monthly keeps its today-anchored rule.
        const rolled = computeInitialRunDate(stockholmToday, effectiveDay)
        updateRow.next_run_date = rolled === todayStockholm ? computeNextRunDate(stockholmToday, effectiveDay) : rolled
      } else {
        // A schedule of several months rolls on its own month grid, so an edit
        // cannot move a quarterly schedule off its phase.
        updateRow.next_run_date = rollNextRunDateForward(current.next_run_date, stockholmToday, effectiveDay, effectiveInterval)
      }
    }

    // A conscious reactivation clears any lingering warning.
    if (reactivating) updateRow.last_run_warning = null
  }

  if (dryRun) {
    const currentItems = orderedItems(current)
    const currentPreview = {
      recurring_schedule_id: current.id,
      name: current.name,
      status: current.status,
      customer_id: current.customer_id,
      customer_name: current.customer?.name ?? null,
      day_of_month: current.day_of_month,
      interval_months: current.interval_months,
      send_hour: current.send_hour,
      payment_terms_days: current.payment_terms_days,
      currency: current.currency,
      your_reference: current.your_reference ?? null,
      our_reference: current.our_reference ?? null,
      notes: current.notes ?? null,
      auto_send: current.auto_send,
      default_dimensions: current.default_dimensions ?? {},
      next_run_date: current.next_run_date,
      items: currentItems,
    }
    return {
      ok: true,
      dryRun: true,
      preview: {
        current: currentPreview,
        changes,
        proposed: {
          ...currentPreview,
          ...fieldChanges,
          ...(updateRow.next_run_date !== undefined ? { next_run_date: updateRow.next_run_date } : {}),
          ...(items ? { items } : {}),
        },
      },
    }
  }

  const result = await applyRecurringScheduleUpdate(supabase, { scheduleId, companyId, fields: updateRow, items, log: ctx.log })
  if (!result.ok) {
    if (result.stage !== 'header' && (!result.itemsRestored || !result.headerRestored)) {
      // The compensation did not apply in full: say the schedule may be half
      // saved, in the registry's words, as the dashboard route does.
      ctx.log.error('recurring schedule update left a partial state', result.error, {
        scheduleId,
        stage: result.stage,
        itemsRestored: result.itemsRestored,
        headerRestored: result.headerRestored,
      })
      const partial = getErrorEntry('INVOICE_RECURRING_UPDATE_PARTIAL')
      return {
        ok: false,
        code: 'INVOICE_RECURRING_UPDATE_PARTIAL',
        messageSv: `${partial?.message_sv ?? 'Ändringen kunde inte slutföras.'} (${result.error.message})`,
        details: { stage: result.stage, items_restored: result.itemsRestored, header_restored: result.headerRestored },
      }
    }
    return failed(result.error)
  }

  return {
    ok: true,
    data: {
      recurring_schedule_id: scheduleId,
      status: fieldChanges.status ?? current.status,
      updated_fields: Object.keys(updateRow),
      items_replaced: Boolean(items),
      ...(items ? { item_count: items.length } : {}),
      ...(updateRow.next_run_date !== undefined ? { next_run_date: updateRow.next_run_date as string } : {}),
    },
  }
}
