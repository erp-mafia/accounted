/**
 * The record of a filed momsdeklaration, as the app knows it (issue #2746).
 *
 * There is no vat_declarations table. What exists is the period's moms
 * deadline (`deadlines`, tax_deadline_type moms_monthly / moms_quarterly):
 * the Skatteverket kvittens cron completes it when a signed declaration is
 * observed at Skatteverket (`completeTaxDeadline`, status 'confirmed'), the
 * generator preserves completed rows across regeneration, and the VAT view
 * already read a completed row as "the period is filed". Marking a period as
 * filed by hand therefore completes the same row (status 'submitted'), so
 * both filing paths leave one record that every reader agrees on.
 *
 * This module is the pure half: the period <-> tax_period key mapping, the
 * record shape, and the reference-in-notes convention. It is imported by the
 * client view, so it must stay free of server-only imports; the Supabase
 * reads and writes live in filing-record-store.ts.
 */

export type VatFilingPeriodType = 'monthly' | 'quarterly'

/** Deadline rows that represent a momsdeklaration for a calendar period. */
export const VAT_FILING_DEADLINE_TYPES = ['moms_monthly', 'moms_quarterly'] as const
export type VatFilingDeadlineType = (typeof VAT_FILING_DEADLINE_TYPES)[number]

export interface VatFilingRecord {
  /** The completed deadline row that carries the record. */
  deadline_id: string
  period_type: VatFilingPeriodType
  year: number
  /** 1-12 for monthly, 1-4 for quarterly. */
  period: number
  /** `deadlines.tax_period`: `YYYY-MM` or `YYYY-QN`. */
  tax_period: string
  /** Swedish calendar date the declaration was filed, `YYYY-MM-DD`. */
  filed_on: string
  /**
   * 'skatteverket' when the kvittens cron confirmed the filing at Skatteverket
   * (deadline status 'confirmed'); 'manual' for a filing recorded by a person
   * (the momsdeklaration page, the deadlines page, or the API).
   */
  source: 'skatteverket' | 'manual'
  /** Skatteverket's reference (kvittensnummer) as typed by the user, if any. */
  reference: string | null
}

/**
 * `deadlines.tax_period` for a VAT period, in the deadline generator's format
 * (lib/tax/deadline-config.ts): `YYYY-MM` monthly, `YYYY-QN` quarterly.
 */
export function vatFilingTaxPeriod(
  periodType: VatFilingPeriodType,
  year: number,
  period: number,
): string {
  return periodType === 'monthly'
    ? `${year}-${String(period).padStart(2, '0')}`
    : `${year}-Q${period}`
}

export function vatFilingDeadlineType(periodType: VatFilingPeriodType): VatFilingDeadlineType {
  return periodType === 'monthly' ? 'moms_monthly' : 'moms_quarterly'
}

/** Inverse of vatFilingTaxPeriod; null for any other tax_period label. */
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
  return null
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

/** Last calendar day of the period as `YYYY-MM-DD`. */
export function vatFilingPeriodEnd(
  periodType: VatFilingPeriodType,
  year: number,
  period: number,
): string {
  const endMonth = periodType === 'monthly' ? period : period * 3
  // Day 0 of the following month is the last day of endMonth.
  const end = new Date(year, endMonth, 0)
  const month = String(end.getMonth() + 1).padStart(2, '0')
  const day = String(end.getDate()).padStart(2, '0')
  return `${end.getFullYear()}-${month}-${day}`
}

export type VatFilingDateProblem =
  | 'VAT_FILING_PERIOD_NOT_ENDED'
  | 'VAT_FILING_DATE_BEFORE_PERIOD_END'
  | 'VAT_FILING_DATE_IN_FUTURE'

/**
 * Why a manual filing date cannot be recorded, or null when it can. Pure so
 * the v1 dry-run and the store validate identically: a declaration is filed
 * after its period ends and never in the future (`today` is the Swedish
 * calendar date, all strings `YYYY-MM-DD`).
 */
export function vatFilingDateProblem(
  input: { periodType: VatFilingPeriodType; year: number; period: number; filedOn: string },
  today: string,
): VatFilingDateProblem | null {
  const periodEnd = vatFilingPeriodEnd(input.periodType, input.year, input.period)
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
