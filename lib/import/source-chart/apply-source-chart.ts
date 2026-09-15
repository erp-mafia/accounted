import {
  applySourceVatCodes,
  enrichAccountMappingsWithVat,
  vatRateComesFromLabel,
} from '@/lib/import/account-vat-treatment'
import { makeNotice, type ImportNotice } from '@/lib/import/notices'
import type { AccountMapping } from '@/lib/import/types'
import type { BASAccount } from '@/types'
import { parseSourceChartCsv } from './parse-chart-csv'

/**
 * Apply a source system's chart export to a set of account mappings.
 *
 * The CSV counterpart of the provider-API path the arcim-migration extension
 * runs for Fortnox: same destination (applySourceVatCodes), different way of
 * getting the codes. It lives in core rather than in an extension because a
 * file the user hands over needs no OAuth, no provider client and no consent,
 * so the guided SIE import can offer it on its own.
 *
 * Enrichment, never a precondition. A file that cannot be read leaves the
 * mappings untouched and returns its complaint in `notices`; the mapping step
 * falls back to the label suggestion exactly as it does today.
 */

export interface SourceChartSummary {
  /**
   * What the header was recognised as, named back so a wrong detection is
   * visible rather than silent. Null when no format matched.
   */
  formatLabel: string | null
  /** Accounts the file described, whether or not this import uses them. */
  accountsInChart: number
  /** Of those, the ones the source system still offers for posting. */
  activeInChart: number
  /** Mappings now carrying a verbatim source code. */
  codesApplied: number
  /** Of those, the ones that resolved to a treatment. */
  treatmentsApplied: number
  /**
   * The accounts whose code was read but not translated: a real ruta this
   * project has no AccountVatTreatment for. Today that is 06 (momspliktiga
   * egna uttag) and 50 (beskattningsunderlag vid import); 37 and 38 were in
   * this group until triangulation_eu_goods existed. Each row keeps its code
   * for display and stays in the review list with its label suggestion.
   *
   * The accounts rather than a count, because a count sends the user hunting
   * through paginated pages for rows it will not name. Ascending, so the
   * order matches the table.
   */
  accountsWithoutTreatment: string[]
  /** Length of the above. Derived, so the number and the list cannot disagree. */
  codesWithoutTreatment: number
}

/**
 * The summary for a file that never got as far as being parsed, so a caller
 * that fails on the read itself can still report through the same shape.
 */
export function emptySourceChartSummary(): SourceChartSummary {
  return {
    formatLabel: null,
    accountsInChart: 0,
    activeInChart: 0,
    codesApplied: 0,
    treatmentsApplied: 0,
    accountsWithoutTreatment: [],
    codesWithoutTreatment: 0,
  }
}

export interface SourceChartResult {
  mappings: AccountMapping[]
  /**
   * Whether this file took effect. False when it could not be read at all, in
   * which case the mappings still carry whatever an earlier chart did and the
   * caller must keep describing THAT one: a summary reset to nothing would
   * have the line above the table invite a chart while the table still shows
   * the codes from one.
   */
  applied: boolean
  /**
   * Everything this file wants to say, in the shape ImportNotices renders:
   * one ochre sentence, the rest folded, the statistics behind the info
   * tooltip. The import already had that system; a second one beside it is
   * how a renamed account came to render in the same ochre as an unbalanced
   * ledger (see lib/import/notices.ts).
   */
  notices: ImportNotice[]
  summary: SourceChartSummary
}

/**
 * Undo what an earlier chart did, so a second file REPLACES the first instead
 * of layering onto it.
 *
 * Without this, picking a new file leaves every code the old one put on an
 * account the new one does not mention. That is not a corner case: it is the
 * documented recovery path. The help text warns that a chart from the wrong
 * räkenskapsår puts a wrong code on a right account, the button then offers
 * "Byt fil", and in a Spiris export the accounts a given year's chart omits
 * are exactly the ones that were inactive that year.
 *
 * Restoring means re-deriving the row from the account label, which is what
 * enrichAccountMappingsWithVat does once the provider facts are cleared: one
 * call for the whole set, so the function's internal chart lookup is built
 * once rather than per row.
 *
 * A reviewed row is left as it is, code and all. The flag means the user
 * answered it or the company's chart already had a treatment, and neither is
 * this file's to revert.
 */
function clearPreviousChart(
  mappings: AccountMapping[],
  existingAccounts: BASAccount[],
): AccountMapping[] {
  const fromPreviousChart = (mapping: AccountMapping) =>
    Boolean(mapping.providerVatCode) && !mapping.vatTreatmentReviewed

  const stale = mappings.filter(fromPreviousChart)
  if (stale.length === 0) return mappings

  const restored = new Map(
    enrichAccountMappingsWithVat(
      stale.map((mapping) => ({ ...mapping, providerVatCode: null, providerVatTreatment: null })),
      existingAccounts,
    ).map((mapping) => [mapping.sourceAccount, mapping]),
  )
  return mappings.map((mapping) =>
    fromPreviousChart(mapping) ? restored.get(mapping.sourceAccount) ?? mapping : mapping,
  )
}

/**
 * `content` is the file already decoded as text. Spiris writes UTF-8 with a
 * BOM, which the parser strips; a file in another encoding still yields usable
 * codes, since those are ASCII, but mojibake account names.
 *
 * `existingAccounts` is the company's own chart, needed only to restore a row
 * a previous file had touched: the same list enrichAccountMappingsWithVat was
 * given when the mappings were first built, so a restored row lands exactly
 * where it started.
 */
export function applySourceChartCsv(
  mappings: AccountMapping[],
  content: string,
  existingAccounts: BASAccount[] = [],
): SourceChartResult {
  const { accounts, format, notices } = parseSourceChartCsv(content)

  const codesByAccount = new Map<string, string>()
  for (const account of accounts) {
    if (account.vatCode) codesByAccount.set(account.accountNumber, account.vatCode)
  }

  const summaryBase = {
    formatLabel: format?.label ?? null,
    accountsInChart: accounts.length,
    activeInChart: accounts.filter((a) => a.isActive).length,
  }

  if (!format || codesByAccount.size === 0) {
    return {
      mappings,
      applied: false,
      notices: accounts.length > 0
        ? [...notices, makeNotice('source_chart_no_codes', 'action')]
        : notices,
      summary: {
        ...summaryBase,
        codesApplied: 0,
        treatmentsApplied: 0,
        accountsWithoutTreatment: [],
        codesWithoutTreatment: 0,
      },
    }
  }

  // Only now that the file is known to be usable: a chart that could not be
  // read must leave the previous one standing, which is what the early return
  // above promises.
  const base = clearPreviousChart(mappings, existingAccounts)

  // The detected format brings its own code vocabulary, so a second vendor is
  // an entry in SOURCE_CHART_FORMATS rather than a branch here.
  const translated = applySourceVatCodes(base, codesByAccount, format.translate)

  // Where applySourceVatCodes reads the rate off the account label, the chart
  // outranks it: a chart may state 20-12% on an account whose name carries no
  // percentage, and the label fallback then files 25 %.
  //
  // Only there. Everywhere else the treatment fixes its own rate, and
  // overriding that would replace a deliberate null with a sats the trade does
  // not have: a vmb account coded 07-25% would take 25 % although
  // vinstmarginalbeskattning has no single sats.
  const applied = translated.map((mapping, i) => {
    // Only rows THIS file named. A providerVatCode left behind by an earlier
    // file outlives that file on a row the user has since answered, and acting
    // on it let a second chart that does not even mention the account reset a
    // rate the user had deliberately changed.
    if (mapping === base[i]) return mapping
    const treatment = mapping.providerVatTreatment
    if (!mapping.providerVatCode || !treatment) return mapping
    if (!vatRateComesFromLabel(treatment, Number(mapping.sourceAccount.charAt(0)))) return mapping
    const stated = format.rateFromCode(mapping.providerVatCode)
    if (stated === null || stated === mapping.defaultVatRate) return mapping
    // Same ownership rule as the treatment above: a rate change on a row the
    // company chart had settled is news the user has to see, not something to
    // apply in silence. defaultVatRate is what buckets a reverse-charge row in
    // the rc-basis check, so a quiet change moves the FK004 reconciliation.
    return mapping.vatTreatmentReviewed
      ? {
          ...mapping,
          defaultVatRate: stated,
          vatTreatmentSuggested: true,
          vatTreatmentReviewed: false,
          requiresVatTreatmentReview: true,
        }
      : { ...mapping, defaultVatRate: stated }
  })

  // Counted over the rows THIS file changed, not over everything carrying a
  // code: a row the user confirmed from an earlier chart keeps that chart's
  // code, and counting it would have the line claim this file did work it did
  // not do. applySourceVatCodes returns every row it skips by reference, so
  // identity is the whole test.
  const touched = applied.filter((mapping, i) => mapping !== base[i])
  const codesApplied = touched.filter((m) => m.providerVatCode).length
  const treatmentsApplied = touched.filter((m) => m.providerVatTreatment).length
  const accountsWithoutTreatment = touched
    .filter((m) => m.providerVatCode && !m.providerVatTreatment)
    .map((m) => m.sourceAccount)
    .sort()

  // Deliberately NOT a notice. Notices are what went wrong with the FILE, and
  // ImportNotices folds everything but the first away, which is right for a
  // twenty-notice SIE import and wrong for this: the count is half of the
  // answer to "what did my file do", and the other half is the summary line
  // beside it. Two sentences of one thought, both on screen.
  return {
    mappings: applied,
    applied: true,
    notices,
    summary: {
      ...summaryBase,
      codesApplied,
      treatmentsApplied,
      accountsWithoutTreatment,
      codesWithoutTreatment: accountsWithoutTreatment.length,
    },
  }
}
