/**
 * "Härleds automatiskt" for an article row: the article type (tjänst/vara)
 * picks the company's own service/goods sales account for the line's VAT
 * rate when the company keeps one (crm#1661).
 *
 * BAS 2026 itself has no service/goods split for domestic sales: 3001, 3002
 * and 3003 are "Försäljning inom Sverige" per VAT rate, and those stay the
 * default. Many charts carry the common sub-accounts 3041-3043 (tjänster)
 * and 3051-3053 (varor) on top, typically from an earlier system. Those are
 * company accounts, not BAS reference accounts, so a line only books one
 * when all of these hold:
 *
 *  - the line is an ordinary domestic sale at 25, 12 or 6 %. Reverse
 *    charge, export and 0 % lines keep their statutory account, and momsfri
 *    keeps 3004/3100 (the declaration cannot read a VAT rate off a 30x4
 *    account, and an enskild firma's momsfri sales go to 3100 for NE R2);
 *  - the article still derives its account (no explicit revenue_account);
 *  - the account is active in the company's chart, so nothing is ever
 *    posted to an account the company does not have;
 *  - the momsdeklaration would count the account at exactly the line's
 *    rate (resolveEffectiveVatRate: a configured momskod or momssats, or a
 *    name that states the rate). An account the declaration cannot classify
 *    would otherwise drop the sale from ruta 05 and raise
 *    REVENUE_ACCOUNT_WITHOUT_RUTA;
 *  - the company itself books that kind of sale there: its ledger credits
 *    the account in the räkenskapsår of the invoice date or the one before
 *    (imported SIE and migration verifikat included, they are its own
 *    history). Having the account in the chart is not enough: most imported
 *    charts carry 3041-3053 unused, and switching those companies away from
 *    3001-3003 would change their resultaträkning without anyone choosing it.
 *
 * Otherwise the line keeps revenue_account null and books today's
 * VAT-derived account (getRevenueAccount).
 */
import type { ArticleType, VatTreatment } from '@/types'
import { resolveEffectiveVatRate, type VatAccountClassificationRow } from '@/lib/reports/vat-revenue-accounts'
import { ARTICLE_TYPE_SALES_ACCOUNTS } from '@/lib/bookkeeping/bas-data/article-type-sales-accounts'
import { scheduledFiscalYear } from '@/lib/bookkeeping/suggest-fiscal-period'
import { addMonthsIso } from '@/lib/dates/iso'

type DomesticTaxedTreatment = 'standard_25' | 'reduced_12' | 'reduced_6'

export const ARTICLE_TYPE_REVENUE_ACCOUNTS: Record<
  DomesticTaxedTreatment,
  { rate: number; tjanst: string; vara: string }
> = ARTICLE_TYPE_SALES_ACCOUNTS

/** Every account the article type can derive, for the one chart lookup. */
export const ARTICLE_TYPE_REVENUE_ACCOUNT_NUMBERS: readonly string[] = Object.values(
  ARTICLE_TYPE_REVENUE_ACCOUNTS,
).flatMap((entry) => [entry.tjanst, entry.vara])

const ACCOUNT_RATE = new Map<string, number>(
  Object.values(ARTICLE_TYPE_REVENUE_ACCOUNTS).flatMap((entry) => [
    [entry.tjanst, entry.rate] as const,
    [entry.vara, entry.rate] as const,
  ]),
)

/**
 * The accounts among `rows` (the company's ACTIVE chart rows for
 * ARTICLE_TYPE_REVENUE_ACCOUNT_NUMBERS) that the momsdeklaration counts at
 * the rate the table above assigns them.
 */
export function usableArticleTypeAccounts(rows: readonly VatAccountClassificationRow[]): Set<string> {
  const usable = new Set<string>()
  for (const row of rows) {
    const expected = ACCOUNT_RATE.get(row.account_number)
    if (expected === undefined) continue
    const rate = resolveEffectiveVatRate(row)
    if (rate !== null && Math.abs(rate - expected) < 1e-9) usable.add(row.account_number)
  }
  return usable
}

function domesticTaxedTreatment(treatment: VatTreatment): DomesticTaxedTreatment | null {
  return treatment === 'standard_25' || treatment === 'reduced_12' || treatment === 'reduced_6'
    ? treatment
    : null
}

/**
 * The span of the company's own ledger that says whether it books a kind of
 * sale on a tjänst/vara account: the räkenskapsår holding the invoice date
 * and the one before it, on the company's fiscal_year_start_month (January
 * when unknown). Null for a date that is not YYYY-MM-DD, so nothing derives.
 */
export function articleTypeHistoryWindow(
  invoiceDate: string,
  fiscalYearStartMonth: number | null | undefined,
): { from: string; to: string } | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(invoiceDate)) return null
  const month =
    typeof fiscalYearStartMonth === 'number' &&
    Number.isInteger(fiscalYearStartMonth) &&
    fiscalYearStartMonth >= 1 &&
    fiscalYearStartMonth <= 12
      ? fiscalYearStartMonth
      : 1
  const current = scheduledFiscalYear(invoiceDate, month)
  return { from: addMonthsIso(current.start, -12), to: current.end }
}

/**
 * The accounts the company has booked sales on: those among `rows` (its
 * ledger_account_days for the window, posted and reversed verifikat) with a
 * credit. A credit is a sale even when a storno or a resultatavslut later
 * debits the account back to zero.
 */
export function accountsWithBookedSales(
  rows: readonly { account_number: string; credit: number | string | null }[],
): Set<string> {
  const booked = new Set<string>()
  for (const row of rows) {
    if ((Number(row.credit) || 0) > 0) booked.add(row.account_number)
  }
  return booked
}

/**
 * A requested account that is itself an article-type account for ANOTHER
 * rate was frozen by deriveArticleTypeRevenueAccount before the line's VAT
 * rate changed, so it is re-derived instead of kept.
 */
function frozenForAnotherRate(requested: string, domestic: DomesticTaxedTreatment | null): boolean {
  const requestedRate = ACCOUNT_RATE.get(requested)
  return requestedRate !== undefined && (!domestic || requestedRate !== ARTICLE_TYPE_REVENUE_ACCOUNTS[domestic].rate)
}

interface ArticleTypeLine {
  requested: string | null
  treatment: VatTreatment
  article: { type: ArticleType | null; derives: boolean } | null
}

/**
 * The tjänst/vara account a line would take if the company may use it, or
 * null when the line keeps what it was sent or has no such account. The
 * write path collects these to read the company's chart and history once
 * per invoice, for exactly the accounts its lines ask for.
 */
export function articleTypeCandidateAccount(line: ArticleTypeLine): string | null {
  const { requested, treatment, article } = line
  if (!article || !article.derives || !article.type) return null
  const domestic = domesticTaxedTreatment(treatment)
  if (requested !== null && !frozenForAnotherRate(requested, domestic)) return null
  return domestic ? ARTICLE_TYPE_REVENUE_ACCOUNTS[domestic][article.type] : null
}

/**
 * The revenue_account a line stores. `requested` is what the caller sent
 * (an explicit line or article account, or null for "derive"); `usable` is
 * the company's tjänst/vara accounts that pass every condition above.
 *
 * A requested type account for another rate on a line whose article still
 * derives is re-derived for the current rate, so a 25 % tjänst row edited to
 * 12 % moves from 3041 to 3042 (or back to null) instead of keeping a 25 %
 * account. Any other requested account is kept as is.
 */
export function deriveArticleTypeRevenueAccount(input: ArticleTypeLine & { usable: ReadonlySet<string> }): string | null {
  const { requested, treatment, article, usable } = input
  if (!article || !article.derives || !article.type) return requested
  const domestic = domesticTaxedTreatment(treatment)
  if (requested !== null && !frozenForAnotherRate(requested, domestic)) return requested
  const target = articleTypeCandidateAccount({ requested, treatment, article })
  return target && usable.has(target) ? target : null
}
