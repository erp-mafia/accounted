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
  // Reviewed AND required is the human signature, and both halves are needed
  // here. Reviewed alone is also what a row carries when the company chart
  // settled it and a chart file then agreed with it, and what an onboarding
  // accept leaves behind: neither is a person's answer, so testing only that
  // flag let such a row keep the previous file's code after a chart that does
  // not mention the account at all.
  const fromPreviousChart = (mapping: AccountMapping) =>
    Boolean(mapping.providerVatCode)
    && !(mapping.vatTreatmentReviewed && mapping.requiresVatTreatmentReview)

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

  // Active only. Spiris ships the whole vendor catalogue and marks the rows the
  // company does not use inactive, so an inactive row's code is the vendor's
  // default for that BAS number and never something this company chose. Across
  // six real yearly exports about fifty accounts per year are inactive AND
  // coded, and not one of them is posted to anywhere in the matching SIE file:
  // keeping them buys no code the ledger needs and lets a catalogue default
  // land on a row, or come back on a later chart after the company had moved
  // the account on.
  const codesByAccount = new Map<string, string>()
  for (const account of accounts) {
    if (account.isActive && account.vatCode) codesByAccount.set(account.accountNumber, account.vatCode)
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
    // A code stating 0 % states no acquisition rate: the buyer self-assesses at
    // 25, 12 or 6, and zero is none of them. Read literally it is worse than a
    // bare code, because the row then buckets nowhere: fetchDynamicVatAccounts
    // builds rc-basis accounts for those three rates only, so the basis would
    // drop out of the FK004 reconciliation with nothing said. The label keeps
    // the rate it already derived.
    if (stated === 0 && treatment.startsWith('reverse_charge')) return mapping
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

/**
 * Accept the source system's answer without a review step.
 *
 * The mapping step leaves every code the chart translated as a SUGGESTION, so
 * the user confirms it before syncMappedAccounts writes it: a code they never
 * saw must not overwrite a treatment they set in Accounted on a later re-sync.
 *
 * Onboarding is the one place that premise does not hold. The company chart is
 * created in the same breath as the import, so there is nothing to overwrite,
 * and the act exists to be fast: its genomlysning offers four treatments on
 * class 3 alone, one account at a time, and never reaches the purchase side
 * where reverse charge and an import basis live. A file the user deliberately
 * picked, written by the system they are leaving, is a better answer than the
 * blank it would otherwise leave behind.
 *
 * Only rows this file actually translated are accepted. A row it could not
 * read keeps whatever the label suggested and stays unreviewed, so nothing is
 * marked settled on the strength of a guess.
 *
 * requiresVatTreatmentReview is cleared along with the accept, and that matters
 * more than it looks. Reviewed AND required is the signature applySourceVatCodes
 * reads as "a human answered this row", which it never overwrites. Leaving the
 * flag up would give every accepted row that signature, so picking the wrong
 * year's chart and then correcting it would change nothing at all: the second
 * file would report zero codes applied while the first one's treatments stayed.
 * Clearing it lands the row in the state enrichAccountMappingsWithVat produces
 * when the company chart answers, which a later chart may still correct.
 *
 * The premise is checked, not assumed: the second argument is a
 * NothingToOverwrite proof, which only nothingToOverwrite() can mint and only
 * when the company chart carries no VAT treatment at all. A caller outside a
 * first import (a re-import, a second pass through onboarding, any surface
 * where a human may already have set a treatment) cannot obtain one and so
 * cannot reach the auto-accept; it gets the reviewed mapping step instead.
 */
export function acceptSourceChartWithoutReview(
  mappings: AccountMapping[],
  proof: NothingToOverwrite,
): AccountMapping[] {
  // Runtime half of the type guard, for a caller that casts its way past it.
  if (proof !== NOTHING_TO_OVERWRITE) return mappings
  return mappings.map((mapping) =>
    mapping.providerVatCode && mapping.providerVatTreatment
      ? {
          ...mapping,
          vatTreatmentSuggested: false,
          vatTreatmentReviewed: true,
          requiresVatTreatmentReview: false,
        }
      : mapping,
  )
}

declare const nothingToOverwriteBrand: unique symbol

/**
 * Proof that a source chart may be accepted without review: the company chart
 * carries no default VAT treatment on any account, so no treatment a human set
 * in Accounted can be overwritten. Minted only by nothingToOverwrite().
 */
export type NothingToOverwrite = { readonly [nothingToOverwriteBrand]: true }

const NOTHING_TO_OVERWRITE = Object.freeze({}) as NothingToOverwrite

/**
 * The proof acceptSourceChartWithoutReview requires, or null when the company
 * chart already carries a VAT treatment (not a first import). Pass the whole
 * chart, inactive accounts included: a treatment on an inactive account is
 * still one the import could overwrite.
 */
export function nothingToOverwrite(
  companyAccounts: readonly Pick<BASAccount, 'default_vat_treatment'>[],
): NothingToOverwrite | null {
  return companyAccounts.some((account) => account.default_vat_treatment)
    ? null
    : NOTHING_TO_OVERWRITE
}
