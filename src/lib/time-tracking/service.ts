/**
 * Time-entry reads shared by the time-tracking extension's session routes and
 * the time-entries operations (v1 REST + MCP), so the dashboard and the
 * machine doors answer from the same queries.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import type { OperationOutcome } from '@/lib/operations/types'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { summarizeTimeByMonth } from './summary'
import type { TimeSummaryGroupBy, TimeSummaryRow } from './summary'
import { DEFAULT_SETTINGS, TIME_TRACKING_EXTENSION_ID } from './types'
import type { ActivityCode, Consultant, TimeEntry, TimeTrackingSettings } from './types'

export interface TimeTrackingContext {
  supabase: SupabaseClient
  companyId: string
  /** Only error() is used, so an extension's logger fits as well as the core one. */
  log: { error(message: string, ...args: unknown[]): void }
}

export interface TimeEntryFilters {
  from?: string
  to?: string
  customer_id?: string
  customer_code?: string
  consultant?: string
  project_code?: string
  /** Only billable rows not yet on an invoice. */
  uninvoiced?: boolean
}

export const TIME_ENTRY_LIST_LIMIT_MAX = 500
const TIME_ENTRY_LIST_LIMIT_DEFAULT = 100

/** A time_entries row selected with its linked customer, `customers(name)`. */
export type TimeEntryRow = TimeEntry & { customers: { name: string } | null }

/** The display name: the linked Accounted customer wins over the imported snapshot. */
export function withCustomerName({ customers, ...entry }: TimeEntryRow): TimeEntry {
  return { ...entry, hours: Number(entry.hours), customer_name: customers?.name ?? entry.customer_name }
}

/** The company's time-tracking settings (extension_data), defaults filled in. */
export async function loadTimeTrackingSettings(ctx: TimeTrackingContext): Promise<TimeTrackingSettings> {
  const { data, error } = await ctx.supabase
    .from('extension_data')
    .select('value')
    .eq('company_id', ctx.companyId)
    .eq('extension_id', TIME_TRACKING_EXTENSION_ID)
    .eq('key', 'settings')
    .maybeSingle()
  if (error) throw error
  return { ...DEFAULT_SETTINGS, ...((data?.value as Partial<TimeTrackingSettings> | null) ?? {}) }
}

// The query builder is narrowed structurally so each filter stays a one-liner.
interface FilterableQuery<Q> {
  gte(column: string, value: string): Q
  lte(column: string, value: string): Q
  eq(column: string, value: string | boolean): Q
  is(column: string, value: null): Q
}

function applyFilters<Q extends FilterableQuery<Q>>(query: Q, f: TimeEntryFilters): Q {
  let q = query
  if (f.from) q = q.gte('entry_date', f.from)
  if (f.to) q = q.lte('entry_date', f.to)
  if (f.customer_id) q = q.eq('customer_id', f.customer_id)
  if (f.customer_code) q = q.eq('customer_code', f.customer_code.toUpperCase())
  if (f.consultant) q = q.eq('consultant', f.consultant.toUpperCase())
  if (f.project_code) q = q.eq('project_code', f.project_code)
  if (f.uninvoiced) q = q.is('invoice_id', null).eq('invoiced_externally', false).eq('is_billable', true)
  return q
}

export interface TimeEntryPage {
  entries: TimeEntry[]
  total: number
  has_more: boolean
  next_offset: number | null
}

/** One page of entries, newest first. */
export async function listTimeEntries(
  ctx: TimeTrackingContext,
  filters: TimeEntryFilters & { limit?: number; offset?: number },
): Promise<OperationOutcome<TimeEntryPage>> {
  const limit = Math.min(filters.limit ?? TIME_ENTRY_LIST_LIMIT_DEFAULT, TIME_ENTRY_LIST_LIMIT_MAX)
  const offset = filters.offset ?? 0
  const query = ctx.supabase
    .from('time_entries')
    .select('id, company_id, user_id, entry_date, consultant, customer_id, customer_code, customer_name, project_code, activity_code, hours, comment, is_billable, invoice_id, invoiced_externally, source, import_key, created_at, updated_at, customers(name)', { count: 'exact' })
    .eq('company_id', ctx.companyId)
  const { data, error, count } = await applyFilters(query, filters)
    .order('entry_date', { ascending: false })
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1)
  if (error) {
    ctx.log.error('time_entries list failed', error)
    return { ok: false, code: 'UNKNOWN_ERROR', error }
  }
  const total = count ?? 0
  const hasMore = offset + limit < total
  return {
    ok: true,
    data: {
      entries: ((data ?? []) as unknown as TimeEntryRow[]).map(withCustomerName),
      total,
      has_more: hasMore,
      next_offset: hasMore ? offset + limit : null,
    },
  }
}

/** Every entry matching the filters, oldest first, past PostgREST's 1000-row cap. */
export async function fetchAllTimeEntries(ctx: TimeTrackingContext, filters: TimeEntryFilters): Promise<TimeEntry[]> {
  const rows = await fetchAllRows<TimeEntryRow>(({ from, to }) => {
    const query = ctx.supabase
      .from('time_entries')
      .select('id, company_id, user_id, entry_date, consultant, customer_id, customer_code, customer_name, project_code, activity_code, hours, comment, is_billable, invoice_id, invoiced_externally, source, import_key, created_at, updated_at, customers(name)')
      .eq('company_id', ctx.companyId)
    return applyFilters(query, filters)
      .order('entry_date', { ascending: true })
      .order('id', { ascending: true })
      .range(from, to) as unknown as PromiseLike<{ data: TimeEntryRow[] | null; error: { message: string } | null }>
  })
  return rows.map(withCustomerName)
}

export interface TimeSummary {
  group_by: TimeSummaryGroupBy
  rows: TimeSummaryRow[]
  totals: {
    hours: number
    billable_hours: number
    uninvoiced_billable_hours: number
    /** Null when some uninvoiced billable hours have no known rate. */
    uninvoiced_amount: number | null
  }
}

const round2 = (x: number) => Math.round(x * 100) / 100

/** Hours and uninvoiced amounts per customer, project or consultant and month. */
export async function summarizeTimeEntries(
  ctx: TimeTrackingContext,
  filters: TimeEntryFilters & { group_by: TimeSummaryGroupBy },
): Promise<OperationOutcome<TimeSummary>> {
  try {
    const [entries, settings] = await Promise.all([fetchAllTimeEntries(ctx, filters), loadTimeTrackingSettings(ctx)])
    const rows = summarizeTimeByMonth(entries, settings, filters.group_by)
    const amountKnown = rows.every((r) => r.uninvoiced_amount !== null)
    return {
      ok: true,
      data: {
        group_by: filters.group_by,
        rows,
        totals: {
          hours: round2(rows.reduce((s, r) => s + r.hours, 0)),
          billable_hours: round2(rows.reduce((s, r) => s + r.billable_hours, 0)),
          uninvoiced_billable_hours: round2(rows.reduce((s, r) => s + r.uninvoiced_billable_hours, 0)),
          uninvoiced_amount: amountKnown ? round2(rows.reduce((s, r) => s + (r.uninvoiced_amount ?? 0), 0)) : null,
        },
      },
    }
  } catch (error) {
    ctx.log.error('time_entries summary failed', error)
    return { ok: false, code: 'UNKNOWN_ERROR', error }
  }
}

export interface TimeCodes {
  consultants: Consultant[]
  activity_codes: ActivityCode[]
  default_hourly_rate: number | null
  /** Customer codes from imported reports and the Accounted customer each is linked to. */
  customer_codes: Array<{ code: string; customer_id: string; customer_name: string | null }>
  /** Active values of SIE dimension 6 (Projekt). */
  projects: Array<{ code: string; name: string }>
}

/** Everything a time entry can reference, so an agent can resolve names to codes. */
export async function listTimeCodes(ctx: TimeTrackingContext): Promise<OperationOutcome<TimeCodes>> {
  try {
    const settings = await loadTimeTrackingSettings(ctx)
    const customerIds = [...new Set(settings.customer_links.map((l) => l.customer_id))]
    const [customers, projects] = await Promise.all([
      customerIds.length === 0
        ? Promise.resolve([] as Array<{ id: string; name: string }>)
        : fetchAllRows<{ id: string; name: string }>(({ from, to }) =>
            ctx.supabase
              .from('customers')
              .select('id, name')
              .eq('company_id', ctx.companyId)
              .in('id', customerIds)
              .order('id', { ascending: true })
              .range(from, to) as unknown as PromiseLike<{ data: Array<{ id: string; name: string }> | null; error: { message: string } | null }>,
          ),
      fetchAllRows<{ code: string; name: string }>(({ from, to }) =>
        ctx.supabase
          .from('dimension_values')
          .select('code, name, dimensions!inner(sie_dim_no)')
          .eq('company_id', ctx.companyId)
          .eq('is_active', true)
          .eq('dimensions.sie_dim_no', 6)
          .order('code', { ascending: true })
          .range(from, to) as unknown as PromiseLike<{ data: Array<{ code: string; name: string }> | null; error: { message: string } | null }>,
      ),
    ])
    const names = new Map(customers.map((c) => [c.id, c.name]))
    return {
      ok: true,
      data: {
        consultants: settings.consultants,
        activity_codes: settings.activity_codes,
        default_hourly_rate: settings.default_hourly_rate,
        customer_codes: settings.customer_links
          // A link whose customer was deleted (or belongs elsewhere) is not offered.
          .filter((l) => names.has(l.customer_id))
          .map((l) => ({ code: l.code, customer_id: l.customer_id, customer_name: names.get(l.customer_id) ?? null })),
        projects: projects.map(({ code, name }) => ({ code, name })),
      },
    }
  } catch (error) {
    ctx.log.error('time codes list failed', error)
    return { ok: false, code: 'UNKNOWN_ERROR', error }
  }
}
