/**
 * How each priced kind is counted: from the log the feature already keeps,
 * never from a second ledger of usage. Each source names its table, the
 * moment that counts (the column whose month the unit falls in) and the
 * filters that make a row a billable unit:
 *
 *   bank_payment  payment_orders that reached the provider, by submitted_at
 *                 (the same count as the bank payments cap, lib/payments/usage.ts)
 *   peppol_send   Peppol deliveries handed to the access point, by submitted_at
 *   kivra_send    invoices and payslips Kivra accepted, by created_at
 *   billo_send    the same for Billo
 *   signing       completed signing requests, by completed_at; an annual
 *                 report's signing is part of the plan and not counted
 *
 * A failed or refused send is never counted: its row carries another status.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { usagePeriodBounds } from '@/lib/payments/usage'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import type { UsageKind } from './kinds'

export interface UsageSource {
  table: string
  /** The timestamp column whose Stockholm month the unit belongs to. */
  at: string
  eq?: Readonly<Record<string, string>>
  notNull?: readonly string[]
  isNull?: readonly string[]
}

export const USAGE_SOURCES: Readonly<Record<UsageKind, readonly UsageSource[]>> = Object.freeze({
  bank_payment: [{ table: 'payment_orders', at: 'submitted_at', notNull: ['provider_payment_id'] }],
  peppol_send: [{ table: 'peppol_deliveries', at: 'submitted_at' }],
  kivra_send: [
    { table: 'digital_mailbox_dispatches', at: 'created_at', eq: { provider: 'kivra', status: 'sent' } },
    { table: 'salary_payslip_deliveries', at: 'created_at', eq: { provider: 'kivra', status: 'sent' } },
  ],
  billo_send: [
    { table: 'digital_mailbox_dispatches', at: 'created_at', eq: { provider: 'billo', status: 'sent' } },
    { table: 'salary_payslip_deliveries', at: 'created_at', eq: { provider: 'billo', status: 'sent' } },
  ],
  signing: [{ table: 'signing_requests', at: 'completed_at', eq: { status: 'completed' }, isNull: ['annual_report_version_id'] }],
})

/**
 * The structural subset of a PostgREST filter builder the sources need. The
 * builder is cast to it once per read: matching the generic builder type
 * against a filter helper sends the compiler into infinite instantiation.
 */
interface UsageQuery<Row> extends PromiseLike<{ data: Row[] | null; count?: number | null; error: { message: string } | null }> {
  eq(column: string, value: string): UsageQuery<Row>
  not(column: string, operator: string, value: null): UsageQuery<Row>
  is(column: string, value: null): UsageQuery<Row>
  gte(column: string, value: string): UsageQuery<Row>
  lt(column: string, value: string): UsageQuery<Row>
  order(column: string): UsageQuery<Row>
  range(from: number, to: number): UsageQuery<Row>
}

function applySource<Row>(query: UsageQuery<Row>, source: UsageSource, period: string): UsageQuery<Row> {
  const { start, end } = usagePeriodBounds(period)
  let q = query.gte(source.at, start).lt(source.at, end)
  for (const [column, value] of Object.entries(source.eq ?? {})) q = q.eq(column, value)
  for (const column of source.notNull ?? []) q = q.not(column, 'is', null)
  for (const column of source.isNull ?? []) q = q.is(column, null)
  return q
}

/** One company's units of a kind in a month. Throws on a failed read. */
export async function countCompanyUsage(
  supabase: SupabaseClient,
  companyId: string,
  kind: UsageKind,
  period: string,
): Promise<number> {
  let total = 0
  for (const source of USAGE_SOURCES[kind]) {
    const query = supabase.from(source.table).select('id', { count: 'exact', head: true }) as unknown as UsageQuery<never>
    const { count, error } = await applySource(query.eq('company_id', companyId), source, period)
    if (error) throw new Error(`usage count ${kind} (${source.table}) failed: ${error.message}`)
    total += count ?? 0
  }
  return total
}

/** Every company's units of a kind in a month, for the monthly statements. Companies with none are absent. */
export async function countUsageByCompany(service: SupabaseClient, kind: UsageKind, period: string): Promise<Map<string, number>> {
  const counts = new Map<string, number>()
  for (const source of USAGE_SOURCES[kind]) {
    const rows = await fetchAllRows<{ id: string; company_id: string }>(({ from, to }) => {
      const query = service.from(source.table).select('id, company_id') as unknown as UsageQuery<{ id: string; company_id: string }>
      return applySource(query, source, period).order('id').range(from, to)
    })
    for (const row of rows) counts.set(row.company_id, (counts.get(row.company_id) ?? 0) + 1)
  }
  return counts
}
