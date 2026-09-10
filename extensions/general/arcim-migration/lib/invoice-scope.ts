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
 * plausible skip count.
 */
export function invoiceWithinScope(
  dto: Pick<SalesInvoiceDto | SupplierInvoiceDto, 'issueDate' | 'paymentStatus'>,
  scope: FiscalYearScope | null | undefined,
): boolean {
  if (!scope) return true
  if (!dto.paymentStatus?.paid) return true
  const issued = typeof dto.issueDate === 'string' ? dto.issueDate.slice(0, 10) : ''
  if (!ISO_DATE.test(issued)) return true
  return issued >= scope.start && issued <= scope.end
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
