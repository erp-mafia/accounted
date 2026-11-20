/**
 * Expected-side arithmetic for the payroll scenario catalogue.
 *
 * Every function here restates one cited formula in a few lines of local
 * arithmetic. Nothing imports the salary engine: an expected figure computed
 * by the helper under test would only prove the helper agrees with itself.
 * Two shared inputs are allowed because they are data and the money
 * primitive, not engine logic: roundOre (CLAUDE.md hard rule 6) and
 * Skatteverket's published 2026 monthly tax tables (SKV 434, bundled in
 * tax-tables-fallback.ts).
 *
 * Rounding convention, stated once: a per-unit rate (dagslön, timlön, a
 * kalenderdagslön, a semestertillägg per day) is rounded to öre before it is
 * multiplied, as a payslip prints an à-pris; a total is rounded to öre;
 * skatteavdrag is in whole kronor (SFF 22 kap. 1 §). Where an agreement
 * prescribes none of this the scenario says so.
 */
import { roundOre } from '@/lib/money'
import { FALLBACK_TAX_TABLES_2026 } from '../../tax-tables-fallback'

/** 2026 statutory figures, each from the swedish-payroll skill (catalogue.ts SRC). */
export const Y2026 = {
  /** social-charges.md:5-16 */
  avgifterStandard: 0.3142,
  /** social-charges.md:23 (ålderspensionsavgift only) */
  avgifterReduced: 0.1021,
  /** social-charges.md:25 */
  avgifterYouth: 0.2081,
  youthCap: 25000,
  /** social-charges.md:45 */
  prisbasbelopp: 59200,
  /** sick-pay.md:12-15 */
  sjuklonRate: 0.8,
  karensFactor: 0.2,
  /** sick-pay.md:19 */
  maxKarensPer12Months: 10,
  /** vacation-pay.md:11, Semesterlagen 16 b § */
  procentregeln: 0.12,
  /** Semesterlagen 16 a § andra stycket */
  sammaloneTillagg: 0.0043,
  /** benefits.md:52 */
  kostformanLunch: 124,
} as const

/** The engine's documented day divisor (work-schedule.ts LEGACY_DAILY_DIVISOR). */
export const DAY_DIVISOR = 21

// ---------------------------------------------------------------------------
// Calendar
// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000
const ms = (iso: string) => Date.parse(`${iso}T00:00:00Z`)
const iso = (t: number) => new Date(t).toISOString().slice(0, 10)

/** ISO weekday, 1 = Monday ... 7 = Sunday. */
export function weekday(date: string): number {
  const d = new Date(ms(date)).getUTCDay()
  return d === 0 ? 7 : d
}

export function addDays(date: string, n: number): string {
  return iso(ms(date) + n * DAY_MS)
}

/** Every date from `from` to `to`, both included. */
export function datesBetween(from: string, to: string): string[] {
  const out: string[] = []
  for (let t = ms(from); t <= ms(to); t += DAY_MS) out.push(iso(t))
  return out
}

/** Monday to Friday dates in [from, to]. Public holidays are not excluded (the documented convention). */
export function weekdaysBetween(from: string, to: string): string[] {
  return datesBetween(from, to).filter((d) => weekday(d) <= 5)
}

export function calendarDays(from: string, to: string): number {
  return datesBetween(from, to).length
}

// ---------------------------------------------------------------------------
// Pay rates
// ---------------------------------------------------------------------------

/** Dagslön: månadslön / 21, rounded to öre. */
export function dagslon(monthly: number, divisor = DAY_DIVISOR): number {
  return roundOre(monthly / divisor)
}

/** Kalenderdagslön: månadslön × 12 / 365, rounded to öre. */
export function kalenderdagslon(monthly: number): number {
  return roundOre((monthly * 12) / 365)
}

/** Timlön from a monthly salary: månadslön × 12 / (52 × veckoarbetstid), rounded to öre. */
export function timlonAnnual(monthly: number, hoursPerWeek: number): number {
  return roundOre((monthly * 12) / (52 * hoursPerWeek))
}

/** Karensavdrag: 20 % of an average week's sjuklön, the week's sjuklön being 80 % of månadslön × 12 / 52. */
export function karensavdragMonthly(monthly: number): number {
  return roundOre(Y2026.karensFactor * Y2026.sjuklonRate * ((monthly * 12) / 52))
}

/** Karensavdrag for hourly pay: 20 % of 80 % of timlön × weekly hours. */
export function karensavdragHourly(hourly: number, hoursPerWeek: number): number {
  return roundOre(Y2026.karensFactor * Y2026.sjuklonRate * hourly * hoursPerWeek)
}

// ---------------------------------------------------------------------------
// Avgifter
// ---------------------------------------------------------------------------

export type AvgiftTier = 'standard' | 'reduced' | 'exempt' | 'youth'

/**
 * The 2026 tier from the birth year alone (social-charges.md:20-25): born
 * 1937 or earlier exempt, born 1938-1958 reduced, born 2003-2007 youth from
 * a payment in April 2026, else standard.
 */
export function avgiftTier2026(birthYear: number, paymentDate: string): AvgiftTier {
  if (birthYear <= 1937) return 'exempt'
  if (birthYear <= 1958) return 'reduced'
  const month = Number(paymentDate.slice(5, 7))
  if (birthYear >= 2003 && birthYear <= 2007 && month >= 4) return 'youth'
  return 'standard'
}

export function avgiftRate(tier: AvgiftTier): number {
  switch (tier) {
    case 'exempt':
      return 0
    case 'reduced':
      return Y2026.avgifterReduced
    case 'youth':
      return Y2026.avgifterYouth
    default:
      return Y2026.avgifterStandard
  }
}

/** Avgifter on a month's underlag; the youth rate applies up to the cap, the standard rate above. */
export function avgifter(basis: number, tier: AvgiftTier): number {
  if (tier === 'youth' && basis > Y2026.youthCap) {
    return roundOre(roundOre(Y2026.youthCap * Y2026.avgifterYouth) + roundOre((basis - Y2026.youthCap) * Y2026.avgifterStandard))
  }
  return roundOre(basis * avgiftRate(tier))
}

// ---------------------------------------------------------------------------
// Tax
// ---------------------------------------------------------------------------

/**
 * Skatteavdrag from Skatteverket's 2026 monthly table: the row whose income
 * bracket holds the income in whole kronor, the employee's column. Above
 * 80 000 kr the row is a percentage of the whole income, öre dropped.
 */
export function tableTax(table: number, column: number, income: number): number {
  const rows = FALLBACK_TAX_TABLES_2026[table]
  if (!rows) throw new Error(`no 2026 tax table ${table}`)
  const kronor = Math.round(income)
  if (kronor <= 0) return 0
  for (const row of rows) {
    const from = row[0]
    const to = row[1] === 0 ? Number.POSITIVE_INFINITY : row[1]
    if (kronor < from || kronor > to) continue
    const value = row[column + 1]
    return row[8] === 1 ? Math.floor((kronor * value) / 100) : value
  }
  throw new Error(`no bracket for ${kronor} in table ${table}`)
}

/** Engångsskatt: the one-off amount × the verified percentage, öre dropped (or to the nearest krona). */
export function oneOffTax(amount: number, percent: number, rounding: 'truncate' | 'nearest' = 'truncate'): number {
  const exact = (Math.round(amount * 100) * Math.round(percent * 100)) / 1_000_000
  return rounding === 'nearest' ? Math.round(exact) : Math.trunc(exact)
}

// ---------------------------------------------------------------------------
// Premium windows (agreement scenarios)
// ---------------------------------------------------------------------------

/** Minutes since midnight for 'HH:MM'. */
export function minutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number)
  return h * 60 + m
}

/**
 * Hours of a shift [start, end) on `date` that fall inside a window
 * [winStart, winEnd) on the same calendar date (24:00 is written '24:00').
 * A shift that ends at or before it starts runs past midnight; only the
 * part on `date` is counted here, the caller passes the next date for the rest.
 */
export function overlapHours(shiftStart: string, shiftEnd: string, winStart: string, winEnd: string): number {
  const s = minutes(shiftStart)
  const e = minutes(shiftEnd) <= s ? 24 * 60 : minutes(shiftEnd)
  const ws = minutes(winStart)
  const we = minutes(winEnd)
  const overlap = Math.max(0, Math.min(e, we) - Math.max(s, ws))
  return overlap / 60
}

/** Round worked time up to whole half hours ("varje påbörjad halvtimme betalas som full halvtimme"). */
export function ceilHalfHours(hours: number): number {
  return Math.ceil(hours * 2 - 1e-9) / 2
}
