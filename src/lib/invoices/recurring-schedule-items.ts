/**
 * One place that turns a validated schedule line (API, MCP, update helper)
 * into the recurring_invoice_schedule_items row. A text row stores its
 * description only: quantity/unit/price are zeroed so the DB CHECK
 * (product rows need a description and a positive quantity) and the spawn
 * (text rows never book) agree on what a text row is.
 */
import type { z } from 'zod'
import type { PostgrestError, SupabaseClient } from '@supabase/supabase-js'
import type { CreateRecurringScheduleObjectSchema, RecurringScheduleItemSchema } from '@/lib/api/schemas'

export type RecurringScheduleLineType = 'product' | 'text'

/** The request every door validates (RecurringScheduleItemSchema). */
export type RecurringScheduleItemInput = z.output<typeof RecurringScheduleItemSchema>

export interface RecurringScheduleItemRow {
  schedule_id: string
  sort_order: number
  line_type: RecurringScheduleLineType
  description: string
  quantity: number
  unit: string
  unit_price: number
  vat_rate: number | null
  dimensions: Record<string, string>
  article_id: string | null
}

export function toRecurringScheduleItemRow(
  scheduleId: string,
  item: RecurringScheduleItemInput,
  sortOrder: number,
): RecurringScheduleItemRow {
  if (item.line_type === 'text') {
    return {
      schedule_id: scheduleId,
      sort_order: sortOrder,
      line_type: 'text',
      description: item.description ?? '',
      quantity: 0,
      unit: '',
      unit_price: 0,
      vat_rate: null,
      dimensions: {},
      article_id: null,
    }
  }
  return {
    schedule_id: scheduleId,
    sort_order: sortOrder,
    line_type: 'product',
    description: item.description,
    quantity: item.quantity,
    unit: item.unit,
    unit_price: item.unit_price,
    vat_rate: item.vat_rate ?? null,
    dimensions: item.dimensions ?? {},
    article_id: item.article_id ?? null,
  }
}

/** A new schedule as every door validates it (CreateRecurringScheduleObjectSchema). */
export type RecurringScheduleCreateInput = z.output<typeof CreateRecurringScheduleObjectSchema>

/**
 * The recurring_invoice_schedules row a new schedule is inserted as, active,
 * first run on `nextRunDate`: one place for the dashboard's create route and
 * the machine doors (recurring-schedule-actions.ts).
 */
export function toRecurringScheduleRow(
  companyId: string,
  userId: string,
  input: RecurringScheduleCreateInput,
  nextRunDate: string,
): Record<string, unknown> {
  return {
    company_id: companyId,
    user_id: userId,
    customer_id: input.customer_id,
    name: input.name,
    day_of_month: input.day_of_month,
    interval_months: input.interval_months,
    send_hour: input.send_hour,
    payment_terms_days: input.payment_terms_days,
    currency: input.currency,
    your_reference: input.your_reference ?? null,
    our_reference: input.our_reference ?? null,
    notes: input.notes ?? null,
    period_start: input.period_start ?? null,
    auto_send: input.auto_send,
    default_dimensions: input.default_dimensions ?? {},
    next_run_date: nextRunDate,
    status: 'active',
  }
}

export function isTextLine(item: { line_type?: string | null }): boolean {
  return item.line_type === 'text'
}

/**
 * The article ids on product lines that are NOT this company's articles.
 * Tenancy check for every door that writes schedule lines: the FK on
 * article_id proves the article exists, not that it belongs to the company,
 * and the MCP commit runs on a service-role client without RLS (same rule as
 * buildInvoiceWriteData for invoice lines). Empty = every link is valid.
 */
export async function findForeignRecurringArticleIds(
  supabase: SupabaseClient,
  companyId: string,
  items: ReadonlyArray<{ line_type?: string | null; article_id?: string | null }>,
): Promise<{ invalidArticleIds: string[]; error: PostgrestError | null }> {
  const ids = Array.from(
    new Set(
      items
        .filter((item) => !isTextLine(item))
        .map((item) => item.article_id)
        .filter((id): id is string => !!id),
    ),
  )
  if (ids.length === 0) return { invalidArticleIds: [], error: null }
  const { data, error } = await supabase
    .from('articles')
    .select('id')
    .eq('company_id', companyId)
    .in('id', ids)
  if (error) return { invalidArticleIds: [], error }
  const found = new Set(((data ?? []) as Array<{ id: string }>).map((row) => row.id))
  return { invalidArticleIds: ids.filter((id) => !found.has(id)), error: null }
}

/** The refusal every door returns for a foreign or unknown article. */
export const RECURRING_ARTICLE_INVALID_MESSAGE =
  'Article not found in this company: pick one from the article register or drop article_id'

/**
 * Insert schedule lines. The code ships a few minutes before migration
 * 20261101003800 adds article_id: until then PostgREST refuses the unknown
 * column (PGRST204, 42703), and the lines are written again without it, so a
 * schedule save never fails over the link.
 */
export async function insertRecurringScheduleItems(
  supabase: SupabaseClient,
  rows: RecurringScheduleItemRow[],
): Promise<{ error: PostgrestError | null }> {
  const { error } = await supabase.from('recurring_invoice_schedule_items').insert(rows)
  if (error?.code !== 'PGRST204' && error?.code !== '42703') return { error }
  const withoutArticle = rows.map(({ article_id: _articleId, ...rest }) => rest)
  const retry = await supabase.from('recurring_invoice_schedule_items').insert(withoutArticle)
  return { error: retry.error }
}
