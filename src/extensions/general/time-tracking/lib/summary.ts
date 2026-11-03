import type { TimeEntry, TimeTrackingSettings } from '../types'

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

/** Hours per customer and calendar month, newest month first, then by customer name. */
export function summarizeByCustomerMonth(
  entries: SummaryEntry[],
  settings: Pick<TimeTrackingSettings, 'activity_codes' | 'default_hourly_rate'>,
): CustomerMonthSummary[] {
  const groups = new Map<string, CustomerMonthSummary & { amount_cents: number; rate_missing: boolean }>()

  for (const entry of entries) {
    const key = customerKey(entry)
    const month = entry.entry_date.slice(0, 7)
    const groupKey = `${key}|${month}`
    let group = groups.get(groupKey)
    if (!group) {
      group = {
        customer_key: key,
        customer_id: entry.customer_id,
        customer_code: entry.customer_code,
        customer_name: entry.customer_name,
        month,
        hours: 0,
        billable_hours: 0,
        uninvoiced_billable_hours: 0,
        uninvoiced_amount: null,
        amount_cents: 0,
        rate_missing: false,
      }
      groups.set(groupKey, group)
    }
    const hours = Number(entry.hours)
    group.hours += hours
    if (!entry.is_billable) continue
    group.billable_hours += hours
    if (entry.invoice_id) continue
    group.uninvoiced_billable_hours += hours
    const rate = resolveHourlyRate(entry.activity_code, settings)
    if (rate === null) group.rate_missing = true
    else group.amount_cents += Math.round(hours * rate * 100)
  }

  return [...groups.values()]
    .map(({ amount_cents, rate_missing, ...g }) => ({
      ...g,
      hours: round2(g.hours),
      billable_hours: round2(g.billable_hours),
      uninvoiced_billable_hours: round2(g.uninvoiced_billable_hours),
      uninvoiced_amount: rate_missing ? null : amount_cents / 100,
    }))
    .sort((a, b) =>
      b.month.localeCompare(a.month) ||
      (a.customer_name ?? a.customer_code ?? '').localeCompare(b.customer_name ?? b.customer_code ?? '', 'sv'),
    )
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
