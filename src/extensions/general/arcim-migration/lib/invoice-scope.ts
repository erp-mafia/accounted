/**
 * Which provider invoices a migration run pays the detail-fetch cost for.
 *
 * The provider list endpoints return the company's whole invoice register,
 * every year since the account was opened. The ledger for those years only
 * exists in Accounted for the fiscal years the SIE import brought over, so a
 * paid invoice outside them has no verifikat to link to and no balance to
 * carry: importing it adds rows the user never asked for and, on a large
 * register, the detail fetches behind it are what push /migrate past the
 * function's 300 s ceiling (#2469).
 *
 * Unpaid invoices are kept from any year: they are open receivables and
 * payables that the user has to follow up on, whichever year booked them.
 * So is a paid invoice settled on or after the scope's first day: it is
 * part of the 1510/2440 opening balance and its payment verifikat sits in
 * the imported ledger, and the kundreskontra as of the opening date has to
 * agree with that balance (BFNAR 2013:2 kap. 9). Only an invoice that was
 * both issued and settled before the imported years is declined.
 */

import type { SalesInvoiceDto, SupplierInvoiceDto } from '@/lib/providers/dto'

/** Inclusive ISO date bounds (YYYY-MM-DD) of the migrated fiscal years. */
export interface FiscalYearScope {
  start: string
  end: string
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}/

/**
 * True when the invoice should be imported under `scope`.
 *
 * No scope means no filter. An invoice whose issue date cannot be read as an
 * ISO date is kept: dropping it silently would hide a mapper defect behind a
 * plausible skip count. A payment date the provider did not supply says
 * nothing, so the issue date alone decides.
 */
export function invoiceWithinScope(
  dto: Pick<SalesInvoiceDto | SupplierInvoiceDto, 'issueDate' | 'paymentStatus'>,
  scope: FiscalYearScope | null | undefined,
): boolean {
  if (!scope) return true
  if (!dto.paymentStatus?.paid) return true
  const issued = isoDay(dto.issueDate)
  if (!issued) return true
  if (issued >= scope.start && issued <= scope.end) return true
  const settled = isoDay(dto.paymentStatus.lastPaymentDate)
  return settled !== null && settled >= scope.start
}

/**
 * The YYYY-MM-DD part of an ISO date or timestamp, or null when it is not a
 * real calendar day (2025-13-01, 2025-02-30): those must fall into the
 * "unreadable, keep" path, not into a lexical comparison that would
 * silently decline the invoice.
 */
function isoDay(value: string | undefined): string | null {
  const day = typeof value === 'string' ? value.slice(0, 10) : ''
  if (!ISO_DATE.test(day)) return null
  const parsed = new Date(`${day}T00:00:00Z`)
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === day ? day : null
}

/**
 * The scope covered by the company's completed SIE imports: earliest start
 * to latest end. Null when nothing has been imported or a row lacks bounds,
 * so the caller falls back to importing everything rather than guessing.
 */
export function fiscalYearScopeFromImports(
  rows: ReadonlyArray<{ fiscal_year_start: string | null; fiscal_year_end: string | null }> | null | undefined,
): FiscalYearScope | null {
  if (!rows || rows.length === 0) return null
  let start: string | null = null
  let end: string | null = null
  for (const row of rows) {
    if (!row.fiscal_year_start || !row.fiscal_year_end) return null
    if (start === null || row.fiscal_year_start < start) start = row.fiscal_year_start
    if (end === null || row.fiscal_year_end > end) end = row.fiscal_year_end
  }
  return start && end ? { start, end } : null
}
