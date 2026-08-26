/**
 * First-fiscal-year defaults derived from TIC lookup data.
 *
 * Extracted from WelcomeOnboarding so both the wizard and the journey
 * onboarding can share them (dev_docs/onboarding_migration_plan.md, PR A).
 */

/**
 * Parse TIC v2's `startMonthDay` ("MM-DD": e.g. "07-01") into a month
 * number 1-12. Returns null on missing / malformed input so the caller
 * can fall through to the manual picker default.
 */
export function parseStartMonthDay(value: string | null | undefined): number | null {
  if (!value) return null
  const match = /^(\d{1,2})-\d{1,2}$/.exec(value)
  if (!match) return null
  const month = Number(match[1])
  if (!Number.isInteger(month) || month < 1 || month > 12) return null
  return month
}

/**
 * Derive the first-year defaults from TIC's `registrationDate`.
 * A company is treated as "first year" when registered less than 12 months
 * ago, or less than 18 months ago when the registry shows NO closed fiscal
 * period (`noClosedPeriod`): a company that has never filed an annual
 * report is still in its first räkenskapsår, and BFL 3 kap 3 § allows that
 * first year to run up to 18 months (no minimum). The 12-month floor alone
 * missed exactly the extended-first-year companies the signal exists for
 * (Arcim, registered 13 months before onboarding, first year to 31 Dec).
 *
 * `noClosedPeriod` comes from TIC's `fiscalYear` being null, which is
 * derived from `mostRecentFinancialSummary` (the latest filed report): a
 * strong but not perfect signal (a filed report can lag in the data).
 * Acceptable because every consumer only feeds a confirm-question
 * suggestion; never auto-set first_fiscal_year from this.
 * Returns both the toggle state and a seeded `first_year_start` (always the
 * 1st of the registration month, the format the date inputs expect).
 *
 * `now` exists for tests; production callers omit it.
 */
export function deriveFirstYearDefaults(
  registrationDate: number | null | undefined,
  now: number = Date.now(),
  opts?: { noClosedPeriod?: boolean },
): {
  isFirstFiscalYear: boolean
  firstYearStart: string | undefined
} {
  if (!registrationDate || !Number.isFinite(registrationDate)) {
    return { isFirstFiscalYear: false, firstYearStart: undefined }
  }
  const regDate = new Date(registrationDate)
  if (Number.isNaN(regDate.getTime())) {
    return { isFirstFiscalYear: false, firstYearStart: undefined }
  }
  const windowMonths = opts?.noClosedPeriod ? 18 : 12
  const monthsAgo = (now - regDate.getTime()) / (1000 * 60 * 60 * 24 * 30.44)
  if (monthsAgo >= windowMonths) return { isFirstFiscalYear: false, firstYearStart: undefined }
  const year = regDate.getUTCFullYear()
  const month = String(regDate.getUTCMonth() + 1).padStart(2, '0')
  return { isFirstFiscalYear: true, firstYearStart: `${year}-${month}-01` }
}
