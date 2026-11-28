/**
 * Ticking a deadline off, or putting it back on the list, and the list an
 * agent picks the deadline from (crm#1848).
 *
 * One rule for every door: the dashboard (POST /api/deadlines/:id/complete)
 * and the operations deadlines.complete and deadlines.list
 * (lib/operations/deadlines.ts), which the MCP tools are generated from.
 *
 * The rule:
 *   - the deadline is the company's and not dismissed. A dismissed system
 *     deadline is hidden everywhere (lib/deadlines/open.ts), so it is not
 *     found here either;
 *   - the caller names the state it wants. Asking for the state the deadline
 *     already has changes nothing: completed_at keeps the moment it was first
 *     ticked off (or the filing date a recorded moms or AGI filing gave it);
 *   - only is_completed and completed_at move. The stored status column
 *     follows the filing flow and the nightly status job, not this tick, so
 *     no reader here hands it out next to is_completed: a deadline ticked off
 *     after its date keeps status 'overdue' in the row;
 *   - a machine door (`protectConfirmed`) never puts back a deadline whose
 *     filing Skatteverket confirmed through the connection (status
 *     'confirmed'), the rule vat-filings.unmark already holds. A person in
 *     the dashboard still may, as before.
 *
 * No verifikat, period or filing is touched: a deadline is a reminder.
 */
import { isUuid } from '@/lib/invariants/uuid'
import { daysBetweenIso, isPastDue, todayIsoStockholm } from '@/lib/dates/iso'
import type { OperationContext, OperationOutcome } from '@/lib/operations/types'
import type { Deadline } from '@/types'
import { filterOpenDeadlines } from './open'

type Ctx = Pick<OperationContext, 'supabase' | 'companyId'>
type Failure = { ok: false; code: string; details?: Record<string, unknown>; error?: unknown }

/** The row the dashboard reads back: the deadline with its customer's name. */
const DEADLINE_SELECT = '*, customer:customers(id, name)'

/** A deadline as an agent sees it: no stored status, see the file header. */
export interface DeadlineSummary {
  deadline_id: string
  title: string
  due_date: string
  due_time: string | null
  deadline_type: string
  tax_deadline_type: string | null
  tax_period: string | null
  priority: string
  source: string
  is_completed: boolean
  completed_at: string | null
  /** Open and past its due date (the due date itself is still on time). */
  overdue: boolean
  /** Swedish calendar days from today to the due date; negative once it has passed. */
  days_until_due: number
  notes: string | null
}

export function summarizeDeadline(row: Deadline, today: string = todayIsoStockholm()): DeadlineSummary {
  return {
    deadline_id: row.id,
    title: row.title,
    due_date: row.due_date,
    due_time: row.due_time ?? null,
    deadline_type: row.deadline_type,
    tax_deadline_type: row.tax_deadline_type ?? null,
    tax_period: row.tax_period ?? null,
    priority: row.priority,
    source: row.source,
    is_completed: Boolean(row.is_completed),
    completed_at: row.completed_at ?? null,
    overdue: !row.is_completed && isPastDue(row.due_date, today),
    days_until_due: daysBetweenIso(today, row.due_date),
    notes: row.notes ?? null,
  }
}

const failed = (error: unknown): Failure => ({ ok: false, code: 'UNKNOWN_ERROR', error })
const notFound = (deadlineId: string): Failure => ({
  ok: false,
  code: 'DEADLINE_NOT_FOUND',
  details: { deadline_id: deadlineId },
})

/**
 * The company's deadline by id while it is still on its list. A dismissed
 * system deadline is hidden everywhere (lib/deadlines/open.ts), so it is not
 * found; neither is a malformed id, which is answered without a read. Shared
 * with the removal (lib/deadlines/removal.ts).
 */
export async function findListedDeadline<Row>(
  ctx: Ctx,
  deadlineId: string,
  columns: string,
): Promise<{ ok: true; row: Row } | Failure> {
  if (!isUuid(deadlineId)) return notFound(deadlineId)
  const { data, error } = await ctx.supabase
    .from('deadlines')
    .select(columns)
    .eq('id', deadlineId)
    .eq('company_id', ctx.companyId)
    .is('dismissed_at', null)
    .maybeSingle()
  if (error) return failed(error)
  if (!data) return notFound(deadlineId)
  return { ok: true, row: data as unknown as Row }
}

/** Which deadline a dry run is about: the head of every preview here and in the removal. */
export function deadlinePreviewHead(
  row: Pick<Deadline, 'id' | 'title' | 'due_date' | 'tax_deadline_type' | 'tax_period'>,
): Record<string, unknown> {
  return {
    deadline_id: row.id,
    title: row.title,
    due_date: row.due_date,
    tax_deadline_type: row.tax_deadline_type ?? null,
    tax_period: row.tax_period ?? null,
  }
}

export interface DeadlineCompletion {
  deadline: Deadline
  /** False when the deadline already had the requested state and nothing was written. */
  changed: boolean
}

/**
 * Sets a deadline's completion. `isCompleted` undefined flips the current
 * state: the dashboard's body-less call, which no machine door offers (an
 * agent that retries a toggle would undo its own tick).
 */
export async function setDeadlineCompletion(
  ctx: Ctx,
  input: { deadlineId: string; isCompleted?: boolean },
  { dryRun, protectConfirmed = false }: { dryRun: boolean; protectConfirmed?: boolean },
): Promise<OperationOutcome<DeadlineCompletion>> {
  const { supabase, companyId } = ctx
  const found = await findListedDeadline<Deadline>(ctx, input.deadlineId, DEADLINE_SELECT)
  if (!found.ok) return found
  const existing = found.row

  const wasCompleted = Boolean(existing.is_completed)
  const target = input.isCompleted ?? !wasCompleted
  const changed = target !== wasCompleted
  if (protectConfirmed && changed && !target && existing.status === 'confirmed') {
    return { ok: false, code: 'DEADLINE_CONFIRMED_BY_SKATTEVERKET', details: { deadline_id: existing.id } }
  }

  if (dryRun) {
    return {
      ok: true,
      dryRun: true,
      preview: {
        ...deadlinePreviewHead(existing),
        current: { is_completed: wasCompleted, completed_at: existing.completed_at ?? null },
        is_completed: target,
        effect: !changed ? 'unchanged' : target ? 'mark_completed' : 'mark_not_completed',
      },
    }
  }
  if (!changed) return { ok: true, data: { deadline: existing, changed: false } }

  const { data: updated, error: updateError } = await supabase
    .from('deadlines')
    .update({ is_completed: target, completed_at: target ? new Date().toISOString() : null })
    .eq('id', existing.id)
    .eq('company_id', companyId)
    .select(DEADLINE_SELECT)
    .maybeSingle()
  if (updateError) return failed(updateError)
  // Deleted between the read and the write.
  if (!updated) return notFound(input.deadlineId)
  return { ok: true, data: { deadline: updated as Deadline, changed: true } }
}

export const DEADLINE_LIST_DEFAULT_LIMIT = 100
export const DEADLINE_LIST_MAX_LIMIT = 500

export interface ListDeadlinesInput {
  status: 'open' | 'completed' | 'all'
  due_from?: string
  due_to?: string
  limit: number
}

export interface DeadlineList {
  deadlines: DeadlineSummary[]
  has_more: boolean
}

/**
 * The company's deadlines by due date, earliest first. Dismissed deadlines
 * are never listed; `open` is the one open rule (lib/deadlines/open.ts).
 */
export async function listDeadlines(ctx: Ctx, input: ListDeadlinesInput): Promise<OperationOutcome<DeadlineList>> {
  const base = ctx.supabase.from('deadlines').select('*').eq('company_id', ctx.companyId)
  let query =
    input.status === 'open'
      ? filterOpenDeadlines(base)
      : input.status === 'completed'
        ? base.is('dismissed_at', null).eq('is_completed', true)
        : base.is('dismissed_at', null)
  if (input.due_from) query = query.gte('due_date', input.due_from)
  if (input.due_to) query = query.lte('due_date', input.due_to)

  // One row beyond the limit answers has_more without a count.
  const { data, error } = await query
    .order('due_date', { ascending: true })
    .order('id', { ascending: true })
    .limit(input.limit + 1)
  if (error) return failed(error)

  const rows = (data ?? []) as Deadline[]
  const today = todayIsoStockholm()
  return {
    ok: true,
    data: {
      deadlines: rows.slice(0, input.limit).map((row) => summarizeDeadline(row, today)),
      has_more: rows.length > input.limit,
    },
  }
}
