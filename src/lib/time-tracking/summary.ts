import type { TimeEntry, TimeTrackingSettings } from './types'

type SummaryEntry = Pick<
  TimeEntry,
  'entry_date' | 'customer_id' | 'customer_code' | 'customer_name' | 'activity_code' | 'hours' | 'is_billable' | 'invoice_id'
>

export interface CustomerMonthSummary {
  /** customer_id when linked, otherwise `code:<customer_code>`. */
  customer_key: string
  customer_id: string | null
  customer_code: string | null
  customer_name: string | null
  month: string
  hours: number
  billable_hours: number
  uninvoiced_billable_hours: number
  /** Uninvoiced billable hours times the resolved rate; null when no rate is known for some hours. */
  uninvoiced_amount: number | null
}

const round2 = (x: number) => Math.round(x * 100) / 100

export function customerKey(entry: Pick<TimeEntry, 'customer_id' | 'customer_code'>): string {
  return entry.customer_id ?? `code:${entry.customer_code ?? ''}`
}

/** Rate for one row: its activity code's rate, then the company default. */
export function resolveHourlyRate(
  activityCode: string | null,
  settings: Pick<TimeTrackingSettings, 'activity_codes' | 'default_hourly_rate'>,
): number | null {
  const code = activityCode ? settings.activity_codes.find((a) => a.code === activityCode) : undefined
  return code?.hourly_rate ?? settings.default_hourly_rate ?? null
}

interface Totals {
  hours: number
  billable_hours: number
  uninvoiced_billable_hours: number
  uninvoiced_amount: number | null
}

/**
 * Totals per (group, calendar month). Only uninvoiced billable hours are
 * priced; the amount is null when some of those hours have no known rate.
 * Each group keeps the first entry seen, for its labels.
 */
function totalsByGroupMonth<E extends SummaryEntry>(
  entries: E[],
  settings: Pick<TimeTrackingSettings, 'activity_codes' | 'default_hourly_rate'>,
  keyOf: (entry: E) => string,
): Array<Totals & { key: string; month: string; first: E }> {
  const groups = new Map<string, { key: string; month: string; first: E; hours: number; billable: number; uninvoiced: number; cents: number; rateMissing: boolean }>()

  for (const entry of entries) {
    const key = keyOf(entry)
    const month = entry.entry_date.slice(0, 7)
    const groupKey = `${key}|${month}`
    let group = groups.get(groupKey)
    if (!group) {
      group = { key, month, first: entry, hours: 0, billable: 0, uninvoiced: 0, cents: 0, rateMissing: false }
      groups.set(groupKey, group)
    }
    const hours = Number(entry.hours)
    group.hours += hours
    if (!entry.is_billable) continue
    group.billable += hours
    if (entry.invoice_id) continue
    group.uninvoiced += hours
    const rate = resolveHourlyRate(entry.activity_code, settings)
    if (rate === null) group.rateMissing = true
    else group.cents += Math.round(hours * rate * 100)
  }

  return [...groups.values()].map((g) => ({
    key: g.key,
    month: g.month,
    first: g.first,
    hours: round2(g.hours),
    billable_hours: round2(g.billable),
    uninvoiced_billable_hours: round2(g.uninvoiced),
    uninvoiced_amount: g.rateMissing ? null : g.cents / 100,
  }))
}

/** Hours per customer and calendar month, newest month first, then by customer name. */
export function summarizeByCustomerMonth(
  entries: SummaryEntry[],
  settings: Pick<TimeTrackingSettings, 'activity_codes' | 'default_hourly_rate'>,
): CustomerMonthSummary[] {
  return totalsByGroupMonth(entries, settings, customerKey)
    .map(({ key, first, ...totals }) => ({
      customer_key: key,
      customer_id: first.customer_id,
      customer_code: first.customer_code,
      customer_name: first.customer_name,
      ...totals,
    }))
    .sort((a, b) =>
      b.month.localeCompare(a.month) ||
      (a.customer_name ?? a.customer_code ?? '').localeCompare(b.customer_name ?? b.customer_code ?? '', 'sv'),
    )
}

export type TimeSummaryGroupBy = 'customer' | 'project' | 'consultant'

export interface TimeSummaryRow extends Totals {
  /** customer: customer_id or `code:<customer_code>`; project: the project code or ''; consultant: the initials. */
  key: string
  /** Customer name, project code or consultant initials; null for hours without a project. */
  label: string | null
  month: string
}

type GroupableEntry = SummaryEntry & Pick<TimeEntry, 'project_code' | 'consultant'>

const GROUPINGS: Record<TimeSummaryGroupBy, { keyOf: (e: GroupableEntry) => string; labelOf: (e: GroupableEntry) => string | null }> = {
  customer: { keyOf: customerKey, labelOf: (e) => e.customer_name ?? e.customer_code },
  project: { keyOf: (e) => e.project_code ?? '', labelOf: (e) => e.project_code },
  consultant: { keyOf: (e) => e.consultant, labelOf: (e) => e.consultant },
}

/** Hours per customer, project or consultant and calendar month, newest month first, then by label. */
export function summarizeTimeByMonth(
  entries: GroupableEntry[],
  settings: Pick<TimeTrackingSettings, 'activity_codes' | 'default_hourly_rate'>,
  groupBy: TimeSummaryGroupBy,
): TimeSummaryRow[] {
  const { keyOf, labelOf } = GROUPINGS[groupBy]
  return totalsByGroupMonth(entries, settings, keyOf)
    .map(({ first, ...totals }) => ({ ...totals, label: labelOf(first) }))
    .sort((a, b) => b.month.localeCompare(a.month) || (a.label ?? '').localeCompare(b.label ?? '', 'sv'))
}

function csvCell(value: string | number | null): string {
  if (value === null) return ''
  const text = typeof value === 'number' ? String(value).replace('.', ',') : value
  // Guard against spreadsheet formula injection from free-text comments.
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text
  return /[";\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe
}

/**
 * Fakturaunderlag as semicolon CSV (Swedish Excel default), one row per time
 * entry with the resolved rate and amount, so it can be checked line by line
 * against the invoice.
 */
export function buildInvoiceBasisCsv(
  entries: Array<SummaryEntry & Pick<TimeEntry, 'consultant' | 'project_code' | 'comment'>>,
  settings: Pick<TimeTrackingSettings, 'activity_codes' | 'default_hourly_rate'>,
): string {
  const header = ['Datum', 'Kund', 'Kundnamn', 'Projekt', 'Medarbetare', 'A-kod', 'Timmar', 'Timpris', 'Belopp', 'Kommentar']
  const lines = [header.join(';')]
  for (const e of entries) {
    const rate = resolveHourlyRate(e.activity_code, settings)
    const hours = Number(e.hours)
    const amount = rate === null ? null : Math.round(hours * rate * 100) / 100
    lines.push([
      e.entry_date,
      e.customer_code ?? '',
      e.customer_name ?? '',
      e.project_code,
      e.consultant,
      e.activity_code,
      hours,
      rate,
      amount,
      e.comment,
    ].map(csvCell).join(';'))
  }
  // BOM so Excel opens the UTF-8 file with å, ä, ö intact.
  return '﻿' + lines.join('\r\n') + '\r\n'
}
