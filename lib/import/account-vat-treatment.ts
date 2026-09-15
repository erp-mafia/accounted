import type { BASAccount } from '@/types'
import {
  defaultRateForVatTreatment,
  suggestVatTreatment,
  vatRateFromLabel,
  type AccountVatTreatment,
} from '@/lib/vat/account-vat-treatment'
import type { AccountMapping } from './types'

/**
 * Treatments whose box does not fix the sats, independently of account class.
 *
 * Momspliktiga uttag and an import basis both exist at 25, 12 and 6 %: ruta 06
 * and ruta 50 are one box each, and the rate rides on the account label or a
 * source chart code. Ruta 05 solved the same problem the other way, with three
 * treatments, which is why standard_25/reduced_12/reduced_6 are not here.
 */
const RATE_NOT_FIXED_BY_BOX: ReadonlySet<AccountVatTreatment> = new Set([
  'own_use',
  'import_goods',
])

/**
 * Whether the suggested rate is read off the account label rather than fixed by
 * the treatment.
 *
 * True for a reverse charge on a purchase account, where the acquisition rate
 * is a real number the treatment does not determine, and for the treatments
 * above, where the box covers three rates. Everywhere else
 * defaultRateForVatTreatment is authoritative, including where it deliberately
 * answers null: vmb has no single sats and oss carries a destination country's
 * rate that never drives ruta 05 arithmetic. Exported so a caller holding a
 * better source than the label knows exactly where it is allowed to win.
 */
export function vatRateComesFromLabel(
  treatment: AccountVatTreatment,
  accountClass: number,
): boolean {
  if (RATE_NOT_FIXED_BY_BOX.has(treatment)) return true
  return accountClass >= 4 && treatment.startsWith('reverse_charge')
}

/**
 * The momssats to suggest next to a provider-translated treatment. A
 * reverse-charge code names the ruta the basis feeds, never the acquisition
 * rate, and the label is the only place the 12%/6% purchase accounts say so
 * (Fortnox 4516 "Inköp varor EU 12%" and 4515 share IVEU). Every other
 * treatment fixes its own rate.
 */
function providerSuggestedRate(
  treatment: AccountVatTreatment,
  accountClass: number,
  sourceName: string,
): number | null {
  if (vatRateComesFromLabel(treatment, accountClass)) {
    return vatRateFromLabel(sourceName) ?? defaultRateForVatTreatment(treatment, accountClass)
  }
  return defaultRateForVatTreatment(treatment, accountClass)
}

/**
 * Attach the momskod the source system has on each account to its identity
 * mapping. SIE4 carries no VAT code, so this runs server-side after the
 * provider's chart was fetched next to the SIE export (Fortnox /accounts);
 * `codesByAccount` is source account number to the provider's verbatim code
 * and `translate` turns a code into a treatment for that account, or null
 * when the code has no equivalent there.
 *
 * Both are stored as facts about the source account (providerVatCode,
 * providerVatTreatment); the row's suggestion is derived from them by
 * enrichAccountMappingsWithVat, which every consumer runs. The translated
 * code is a SUGGESTION, not a reviewed value: it still needs the row's
 * confirm (or "Bekräfta alla föreslagna"), because a reviewed row is written
 * onto an existing chart account by syncMappedAccounts and the mapping step
 * is skipped when nothing needs review. A code the user never saw must not
 * overwrite a treatment they cleared in Accounted on a later re-sync.
 *
 * Only class 3-6 identity mappings are touched, the same rows the label
 * suggestion covers: a remapped account gets the target's treatment, and
 * classes 1-2 and 7-8 carry no treatment.
 *
 * Two kinds of already-answered row, and they are not the same:
 *
 *   The USER answered it in this step. Never touched. applyVatTreatmentReview
 *   leaves requiresVatTreatmentReview as it found it, so reviewed AND required
 *   is the signature of a human answer.
 *
 *   The COMPANY CHART answered it, which enrichAccountMappingsWithVat records
 *   by clearing requiresVatTreatmentReview. Here the file is the newer
 *   statement about the same account and may update it, because a source
 *   system does move a code between fiscal years: Spiris swapped the names AND
 *   the codes of 3541 and 3542 between 2022 and 2023, so last year's treatment
 *   on this year's account would file EU sales as export. Such a row is left
 *   as it is while the file agrees, and re-opened for review only when it does
 *   not, so a multi-year migration does not re-confirm dozens of unchanged
 *   rows every year.
 *
 * Every row it does not touch is returned BY REFERENCE, which is what lets a
 * caller tell what this file changed from what an earlier one did.
 */
export function applySourceVatCodes(
  mappings: AccountMapping[],
  codesByAccount: ReadonlyMap<string, string>,
  translate: (code: string, accountNumber: string) => AccountVatTreatment | null,
): AccountMapping[] {
  return mappings.map((mapping) => {
    if (!mapping.targetAccount || mapping.sourceAccount !== mapping.targetAccount) return mapping
    const accountClass = Number(mapping.sourceAccount.charAt(0))
    if (accountClass < 3 || accountClass > 6) return mapping
    if (mapping.vatTreatmentReviewed && mapping.requiresVatTreatmentReview) return mapping

    const code = codesByAccount.get(mapping.sourceAccount)?.trim()
    if (!code) return mapping

    const treatment = translate(code, mapping.sourceAccount)
    const withFacts = { ...mapping, providerVatCode: code, providerVatTreatment: treatment }
    if (!treatment) return withFacts
    // The file agrees with the treatment the account already carries: record
    // that it spoke, and leave the row settled rather than asking again.
    if (mapping.vatTreatmentReviewed && mapping.defaultVatTreatment === treatment) return withFacts

    return {
      ...withFacts,
      defaultVatTreatment: treatment,
      defaultVatRate: providerSuggestedRate(treatment, accountClass, mapping.sourceName),
      vatTreatmentSuggested: true,
      vatTreatmentReviewed: false,
      requiresVatTreatmentReview: true,
    }
  })
}

/**
 * Add reviewable VAT suggestions to identity mappings. SIE itself has no VAT
 * treatment record, so a suggestion comes from the source system's momskod
 * when the provider reported one (applySourceVatCodes), else from the
 * account label; either way it is not reviewed until the user confirms the
 * row or continues from the mapping step. A treatment the company already
 * set on the account in its chart outranks both and needs no review.
 */
export function enrichAccountMappingsWithVat(
  mappings: AccountMapping[],
  existingAccounts: BASAccount[],
): AccountMapping[] {
  const existingByNumber = new Map(
    existingAccounts.map((account) => [account.account_number, account]),
  )

  return mappings.map((mapping) => {
    if (!mapping.targetAccount || mapping.sourceAccount !== mapping.targetAccount) {
      return {
        ...mapping,
        defaultVatTreatment: null,
        defaultVatRate: null,
        vatTreatmentSuggested: false,
        vatTreatmentReviewed: true,
        requiresVatTreatmentReview: false,
      }
    }
    const accountClass = Number(mapping.sourceAccount.charAt(0))
    if (accountClass < 3 || accountClass > 6) return mapping

    const existing = existingByNumber.get(mapping.targetAccount)
    if (existing?.default_vat_treatment) {
      return {
        ...mapping,
        defaultVatTreatment: existing.default_vat_treatment,
        defaultVatRate: existing.default_vat_rate,
        vatTreatmentReviewed: true,
        vatTreatmentSuggested: false,
        requiresVatTreatmentReview: false,
      }
    }

    if (mapping.providerVatTreatment) {
      return {
        ...mapping,
        defaultVatTreatment: mapping.providerVatTreatment,
        defaultVatRate:
          existing?.default_vat_rate ??
          providerSuggestedRate(mapping.providerVatTreatment, accountClass, mapping.sourceName),
        vatTreatmentSuggested: true,
        vatTreatmentReviewed: false,
        requiresVatTreatmentReview: true,
      }
    }

    const suggestion = suggestVatTreatment(mapping.sourceAccount, mapping.sourceName)
    return {
      ...mapping,
      defaultVatTreatment: suggestion?.treatment ?? null,
      defaultVatRate: existing?.default_vat_rate ?? suggestion?.rate ?? null,
      vatTreatmentSuggested: Boolean(suggestion),
      vatTreatmentReviewed: false,
      requiresVatTreatmentReview: accountClass === 3 || accountClass === 4 || Boolean(suggestion),
    }
  })
}

/**
 * The user's own answer for one row.
 *
 * Sets requiresVatTreatmentReview as well as clearing the suggestion, so the
 * pair applySourceVatCodes reads as "a human answered this" is established
 * here rather than inherited from whatever the row happened to carry. It used
 * to be inherited, which held only because every row reaching a review had the
 * flag up already; a row settled by a source chart does not, and its answer
 * was then overwritable by the next chart. The counter and the filter both ask
 * for required AND NOT reviewed, so a row answered here still leaves the list.
 */
export function applyVatTreatmentReview(
  mappings: AccountMapping[],
  sourceAccount: string,
  treatment: AccountVatTreatment | null,
  rate: number | null,
): AccountMapping[] {
  return mappings.map((mapping) =>
    mapping.sourceAccount === sourceAccount
      ? {
          ...mapping,
          defaultVatTreatment: treatment,
          defaultVatRate: rate,
          vatTreatmentSuggested: false,
          vatTreatmentReviewed: true,
          requiresVatTreatmentReview: true,
        }
      : mapping
  )
}

export function enrichChangedAccountMappingWithVat(
  mappings: AccountMapping[],
  sourceAccount: string,
  existingAccounts: BASAccount[],
): AccountMapping[] {
  return mappings.map((mapping) =>
    mapping.sourceAccount === sourceAccount
      ? enrichAccountMappingsWithVat([mapping], existingAccounts)[0]
      : mapping
  )
}

/**
 * Accept the suggested VAT treatment for every mapping still awaiting review,
 * in one action. Exactly the per-row "Bekräfta" semantics batched: each row
 * keeps its current suggested default (or null when there is none) and is
 * marked reviewed. Added because a Fortnox chart routinely puts 70+ class 3/4
 * accounts behind the review gate, and clicking them one by one across
 * paginated pages was an observed migration dead end (2026-08-18).
 */
export function applyVatTreatmentReviewAll(mappings: AccountMapping[]): AccountMapping[] {
  return mappings.map((mapping) =>
    mapping.requiresVatTreatmentReview && !mapping.vatTreatmentReviewed
      ? {
          ...mapping,
          vatTreatmentSuggested: false,
          vatTreatmentReviewed: true,
        }
      : mapping
  )
}
