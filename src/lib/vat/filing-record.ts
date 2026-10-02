/**
 * The record of a filed momsdeklaration, as the app knows it (issues #2746,
 * #2786).
 *
 * There is no vat_declarations table. What exists is the period's moms
 * deadline (`deadlines`, tax_deadline_type moms_monthly / moms_quarterly /
 * moms_yearly): the Skatteverket kvittens cron completes it when a signed
 * declaration is observed at Skatteverket (status 'confirmed'), the
 * generator preserves completed rows across regeneration, and the VAT view
 * already read a completed row as "the period is filed". Marking a period as
 * filed by hand therefore completes the same row (status 'submitted'), so
 * both filing paths leave one record that every reader agrees on.
 *
 * This module is the pure half: the period <-> tax_period key mapping, the
 * record shape, and the reference-in-notes convention. It is imported by the
 * client view, so it must stay free of server-only imports; the Supabase
 * reads and writes live in filing-record-store.ts.
 *
 * A period is `{ period_type, year, period }` for every cadence. Monthly and
 * quarterly periods are calendar periods by law (SFL 26 kap). A yearly
 * (helårsmoms) period is the räkenskapsår, keyed like every yearly VAT
 * period in the app: `year` is the calendar year the räkenskapsår ENDS in and
 * `period` is always 1. Where the räkenskapsår ends is a company fact, not
 * part of the key, so the functions that place a period in time (its
 * tax_period label and its dates) also take the company's fiscal-year end
 * month (vatFilingFiscalYearEndMonth). Monthly and quarterly ignore it.
 */
import { FISCAL_YEAR_RE } from '@/lib/invariants'
import { fiscalYearEndMonthFor, getFiscalYearLabel } from '@/lib/tax/deadline-config'
import type { EntityType } from '@/types'

export type VatFilingPeriodType = 'monthly' | 'quarterly' | 'yearly'

/** Deadline rows that represent a momsdeklaration, one type per cadence. */
export const VAT_FILING_DEADLINE_TYPES = ['moms_monthly', 'moms_quarterly', 'moms_yearly'] as const
export type VatFilingDeadlineType = (typeof VAT_FILING_DEADLINE_TYPES)[number]

export interface VatFilingRecord {
  /** The completed deadline row that carries the record. */
  deadline_id: string
  period_type: VatFilingPeriodType
  /** Calendar year of the period; for yearly, the year the räkenskapsår ends. */
  year: number
  /** 1-12 for monthly, 1-4 for quarterly, 1 for yearly. */
  period: number
  /** `deadlines.tax_period`: `YYYY-MM`, `YYYY-QN`, or `YYYY` / `YYYY-1/YYYY` yearly. */
  tax_period: string
  /** First day of the declared period, `YYYY-MM-DD`. */
  period_start: string
  /** Last day of the declared period, `YYYY-MM-DD`. */
  period_end: string
  /** Swedish calendar date the declaration was filed, `YYYY-MM-DD`. */
  filed_on: string
  /**
   * 'skatteverket' when the kvittens cron confirmed the filing at Skatteverket
   * (deadline status 'confirmed'); 'manual' for a filing recorded by a person
   * (the momsdeklaration page, the deadlines page, the API or MCP).
   */
  source: 'skatteverket' | 'manual'
  /** Skatteverket's reference (kvittensnummer) as typed by the user, if any. */
  reference: string | null
}

/**
 * The month (1-12) the company's räkenskapsår ends, which places its yearly
 * VAT periods. Derived by the deadline generator's own rule
 * (fiscalYearEndMonthFor), so the filing record and the deadline row can
 * never disagree on a label. Falls back to December when the start month is
 * not configured: the column's default is January, a calendar year.
 */
export function vatFilingFiscalYearEndMonth(
  settings:
    | { entity_type?: EntityType | string | null; fiscal_year_start_month?: number | null }
    | null
    | undefined,
): number {
  return fiscalYearEndMonthFor(settings ?? {}) ?? 12
}

/**
 * `deadlines.tax_period` for a VAT period, in the deadline generator's format
 * (lib/tax/deadline-config.ts): `YYYY-MM` monthly, `YYYY-QN` quarterly, and
 * the räkenskapsår label yearly (`YYYY`, or `YYYY-1/YYYY` for a broken year).
 */
export function vatFilingTaxPeriod(
  periodType: VatFilingPeriodType,
  year: number,
  period: number,
  fiscalYearEndMonth: number,
): string {
  if (periodType === 'monthly') return `${year}-${String(period).padStart(2, '0')}`
  if (periodType === 'quarterly') return `${year}-Q${period}`
  return getFiscalYearLabel(fiscalYearEndMonth, year)
}

export function vatFilingDeadlineType(periodType: VatFilingPeriodType): VatFilingDeadlineType {
  if (periodType === 'monthly') return 'moms_monthly'
  if (periodType === 'quarterly') return 'moms_quarterly'
  return 'moms_yearly'
}

/**
 * Inverse of vatFilingTaxPeriod; null for any other tax_period label. The
 * formats of the three cadences never overlap, so the label alone names the
 * period. A yearly label names the year the räkenskapsår ends in.
 */
export function vatFilingPeriodFromTaxPeriod(
  taxPeriod: string | null | undefined,
): { period_type: VatFilingPeriodType; year: number; period: number } | null {
  if (!taxPeriod) return null
  const quarterly = /^(\d{4})-Q([1-4])$/.exec(taxPeriod)
  if (quarterly) {
    return { period_type: 'quarterly', year: Number(quarterly[1]), period: Number(quarterly[2]) }
  }
  const monthly = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(taxPeriod)
  if (monthly) {
    return { period_type: 'monthly', year: Number(monthly[1]), period: Number(monthly[2]) }
  }
  const calendarYear = /^(\d{4})$/.exec(taxPeriod)
  if (calendarYear) return { period_type: 'yearly', year: Number(calendarYear[1]), period: 1 }
  const brokenYear = /^(\d{4})\/(\d{4})$/.exec(taxPeriod)
  if (brokenYear && Number(brokenYear[2]) === Number(brokenYear[1]) + 1) {
    return { period_type: 'yearly', year: Number(brokenYear[2]), period: 1 }
  }
  return null
}

/**
 * The fiscal-year end month a stored yearly label was written under. A
 * `YYYY` label is a calendar räkenskapsår whatever the company says today;
 * a `YYYY-1/YYYY` label takes today's end month, the only source there is
 * (the label does not carry it).
 */
export function vatFilingLabelFiscalYearEndMonth(
  taxPeriod: string,
  fiscalYearEndMonth: number,
): number {
  return FISCAL_YEAR_RE.test(taxPeriod) ? 12 : fiscalYearEndMonth
}

/** Map key for a period: `${periodType}:${year}:${period}`. */
export function vatFilingKey(periodType: VatFilingPeriodType, year: number, period: number): string {
  return `${periodType}:${year}:${period}`
}

/** Index a filings list by period key for O(1) lookups in the picker and seed. */
export function indexVatFilings(records: VatFilingRecord[]): Map<string, VatFilingRecord> {
  const byPeriod = new Map<string, VatFilingRecord>()
  for (const record of records) {
    const key = vatFilingKey(record.period_type, record.year, record.period)
    // Newest filing wins when a period somehow carries two completed rows.
    const existing = byPeriod.get(key)
    if (!existing || existing.filed_on < record.filed_on) byPeriod.set(key, record)
  }
  return byPeriod
}

function isoDate(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

/**
 * First and last calendar day of the period as `YYYY-MM-DD`. A yearly period
 * spans the twelve months ending in `fiscalYearEndMonth` of `year`. A first
 * or changed räkenskapsår may be longer or shorter (BFL 3 kap 3 §); its
 * figures come from the fiscal period itself, while the filing record only
 * needs the period's place in the year.
 */
export function vatFilingPeriodRange(
  periodType: VatFilingPeriodType,
  year: number,
  period: number,
  fiscalYearEndMonth: number,
): { start: string; end: string } {
  const endMonth =
    periodType === 'monthly' ? period : periodType === 'quarterly' ? period * 3 : fiscalYearEndMonth
  const months = periodType === 'monthly' ? 1 : periodType === 'quarterly' ? 3 : 12
  // Month arithmetic through Date rolls the year over: day 1 of the month
  // after the span's start, and day 0 of the month after its end.
  return {
    start: isoDate(new Date(year, endMonth - months, 1)),
    end: isoDate(new Date(year, endMonth, 0)),
  }
}

/** Last calendar day of the period as `YYYY-MM-DD`. */
export function vatFilingPeriodEnd(
  periodType: VatFilingPeriodType,
  year: number,
  period: number,
  fiscalYearEndMonth: number,
): string {
  return vatFilingPeriodRange(periodType, year, period, fiscalYearEndMonth).end
}

export type VatFilingDateProblem =
  | 'VAT_FILING_PERIOD_NOT_ENDED'
  | 'VAT_FILING_DATE_BEFORE_PERIOD_END'
  | 'VAT_FILING_DATE_IN_FUTURE'

/**
 * Why a manual filing date cannot be recorded, or null when it can. Pure so
 * the dry run, the store and the dialog validate identically: a declaration
 * is filed after its period ends and never in the future (`today` is the
 * Swedish calendar date, all strings `YYYY-MM-DD`).
 */
export function vatFilingDateProblem(
  input: { periodType: VatFilingPeriodType; year: number; period: number; filedOn: string },
  today: string,
  fiscalYearEndMonth: number,
): VatFilingDateProblem | null {
  const periodEnd = vatFilingPeriodEnd(input.periodType, input.year, input.period, fiscalYearEndMonth)
  if (periodEnd >= today) return 'VAT_FILING_PERIOD_NOT_ENDED'
  if (input.filedOn <= periodEnd) return 'VAT_FILING_DATE_BEFORE_PERIOD_END'
  if (input.filedOn > today) return 'VAT_FILING_DATE_IN_FUTURE'
  return null
}

/**
 * The reference rides in the deadline's free-text `notes` on its own line,
 * behind a fixed prefix, so it survives on the deadlines page as readable
 * text and can still be read back verbatim here. Only lines we wrote are
 * ever parsed or removed; the user's own notes are left alone.
 */
export const VAT_FILING_REFERENCE_PREFIX = 'Skatteverkets referens: '

export function parseVatFilingReference(notes: string | null | undefined): string | null {
  if (!notes) return null
  for (const line of notes.split('\n')) {
    if (line.startsWith(VAT_FILING_REFERENCE_PREFIX)) {
      const value = line.slice(VAT_FILING_REFERENCE_PREFIX.length).trim()
      return value.length > 0 ? value : null
    }
  }
  return null
}

/**
 * Rewrite the reference line inside `notes`. `undefined` keeps whatever line
 * is there, `null` (or an empty string) removes it, a string replaces it.
 */
export function withVatFilingReference(
  notes: string | null | undefined,
  reference: string | null | undefined,
): string | null {
  if (reference === undefined) return notes ?? null
  const kept = (notes ?? '')
    .split('\n')
    .filter((line) => !line.startsWith(VAT_FILING_REFERENCE_PREFIX))
  const trimmed = reference?.trim() ?? ''
  if (trimmed.length > 0) kept.push(`${VAT_FILING_REFERENCE_PREFIX}${trimmed}`)
  const merged = kept.join('\n').trim()
  return merged.length > 0 ? merged : null
}
