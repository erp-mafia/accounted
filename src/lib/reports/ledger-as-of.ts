import { stockholmYearMonth } from '@/lib/dates/iso'
/**
 * The balance date of the AR and AP ledgers (kundreskontra and
 * leverantörsreskontra), checked once for every door: v1 /reports/ar-ledger
 * and /reports/supplier-ledger and the MCP tools gnubok_get_ar_ledger and
 * gnubok_get_supplier_ledger.
 *
 * The ledgers age every open invoice against this date, so a date that does
 * not exist is no harmless default: "2025-02-30" gave an empty ledger and a
 * string that is no date at all put every invoice in the 90+ bucket. v1 held
 * the check in each route and MCP had none; now both read this one.
 */

export type LedgerAsOfDate =
  | { ok: true; asOfDate: string | undefined }
  | { ok: false; message: string; messageSv: string }

/**
 * `value` absent, null or empty means today (the generators' default). A
 * present value must be YYYY-MM-DD, a real calendar date, in the year range
 * 2000 to next year: outside it is a typo or a probe that makes the generator
 * walk an arbitrarily long invoice history, and the one-year tolerance lets a
 * year-end report for the year that just turned over through on 1 January.
 */
export function parseLedgerAsOfDate(value: unknown, now: Date = new Date()): LedgerAsOfDate {
  if (value === undefined || value === null || value === '') return { ok: true, asOfDate: undefined }
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return { ok: false, message: 'Expected YYYY-MM-DD.', messageSv: 'Ange datumet som ÅÅÅÅ-MM-DD.' }
  }
  // The regex accepts 2026-13-45; the Date round trip does not.
  const probe = new Date(`${value}T00:00:00Z`)
  if (Number.isNaN(probe.getTime()) || probe.toISOString().slice(0, 10) !== value) {
    return { ok: false, message: 'Not a valid calendar date.', messageSv: 'Datumet finns inte i kalendern.' }
  }
  const year = probe.getUTCFullYear()
  const maxYear = stockholmYearMonth(now).year + 1
  if (year < 2000 || year > maxYear) {
    return {
      ok: false,
      message: `Year out of supported range. Accepted: 2000 to ${maxYear}.`,
      messageSv: `Året måste ligga mellan 2000 och ${maxYear}.`,
    }
  }
  return { ok: true, asOfDate: value }
}
