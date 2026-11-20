import type { BASAccount } from '@/types'
import { RC_BASIS_BOXES, isReverseChargeBasisAccount } from '@/lib/bookkeeping/vat-entries'
import {
  defaultRateForVatTreatment,
  resolveVatTreatmentRuta,
  suggestVatTreatment,
  vatRateFromLabel,
  type AccountVatTreatment,
} from '@/lib/vat/account-vat-treatment'
import { rcBasisPairFinding, type RcBasisPairFinding } from './rc-basis-pairs'
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
 * Whether a debit on `account` reports a reverse-charge basis in ruta 20-24
 * under `treatment`, its momskod: the momskod decides where there is one, and
 * an account without one reports only as a BAS basis account. The
 * declaration's own rule (fetchDynamicVatAccounts, costAccountRcBasisRate).
 */
function reportsRcBasis(account: string, treatment: AccountVatTreatment | null | undefined): boolean {
  if (!treatment) return isReverseChargeBasisAccount(account)
  const box = resolveVatTreatmentRuta(treatment, Number(account.charAt(0)), account)?.box
  return box !== undefined && RC_BASIS_BOXES.has(box)
}

/**
 * Whether `treatment` on a cost account counts twice the basis the file's
 * vouchers already report on a pair beside it (`finding`): a reverse-charge
 * purchase momskod reports each of those purchases in ruta 20-24 again
 * (crm#1096). The mapping step warns on it, whoever set the momskod.
 */
export function countsRcBasisTwice(
  account: string,
  treatment: AccountVatTreatment | null | undefined,
  finding: RcBasisPairFinding | null | undefined,
): boolean {
  return Boolean(finding && treatment) && reportsRcBasis(account, treatment)
}

/**
 * Each row's RcBasisPairFinding within `mappings`, every leg judged by the
 * momskod it lands with: a leg the file maps onto itself by its row's
 * (`treatmentOf`), any other by the account it lands on (`chartTreatmentOf`,
 * the company's kontoplan where the caller has it).
 */
function findingsIn(
  mappings: readonly AccountMapping[],
  treatmentOf: (mapping: AccountMapping) => AccountVatTreatment | null | undefined,
  chartTreatmentOf: (account: string) => AccountVatTreatment | null | undefined = () => null,
): (mapping: AccountMapping) => RcBasisPairFinding | null {
  const bySource = new Map(mappings.map((mapping) => [mapping.sourceAccount, mapping]))
  const legReports = (leg: string) => {
    const row = bySource.get(leg)
    if (row?.targetAccount === leg) return reportsRcBasis(leg, treatmentOf(row))
    const account = row?.targetAccount || leg
    return reportsRcBasis(account, chartTreatmentOf(account))
  }
  return (mapping) => rcBasisPairFinding(mapping.rcBasisPair, legReports)
}

/**
 * Each row's RcBasisPairFinding as the rows stand, keyed by source account:
 * every leg judged by the momskod its row carries now. What the mapping step
 * shows.
 */
export function rcBasisPairFindings(mappings: readonly AccountMapping[]): Map<string, RcBasisPairFinding> {
  const findingOf = findingsIn(mappings, (mapping) => mapping.defaultVatTreatment)
  const findings = new Map<string, RcBasisPairFinding>()
  for (const mapping of mappings) {
    const finding = findingOf(mapping)
    if (finding) findings.set(mapping.sourceAccount, finding)
  }
  return findings
}

/**
 * A reverse-charge momskod the file rules out as a suggestion: it would count
 * the basis twice and the file ends on the pair, so the periods still to be
 * declared report through the pair. Where the file ends on the account's own
 * basis instead, the momskod stays the suggestion and the row only carries
 * the warning.
 */
function ruledOutByRcBasisPair(
  mapping: AccountMapping,
  treatment: AccountVatTreatment | null | undefined,
  finding: RcBasisPairFinding | null,
): boolean {
  return Boolean(finding?.latest) && countsRcBasisTwice(mapping.sourceAccount, treatment, finding)
}

/**
 * The reverse-charge momskod the prefill set aside on a row that now carries
 * none, or null: the source system's code where it named one, else the label's
 * suggestion, the one enrichAccountMappingsWithVat would otherwise make. What
 * the mapping step explains in place of the source-code line.
 */
export function rcMomskodSetAside(
  mapping: AccountMapping,
  finding: RcBasisPairFinding | null | undefined,
): AccountVatTreatment | null {
  if (!finding?.latest || mapping.defaultVatTreatment) return null
  const candidate = mapping.providerVatTreatment
    || suggestVatTreatment(mapping.sourceAccount, mapping.sourceName)?.treatment
  return candidate && ruledOutByRcBasisPair(mapping, candidate, finding) ? candidate : null
}

/**
 * The row where a reverse-charge momskod was ruled out: no momskod suggested,
 * still for the user to confirm, so it stays in the review list where the
 * mapping step says why. `rate` is the booking rate the row already had.
 */
function withoutRcMomskod(mapping: AccountMapping, rate: number | null): AccountMapping {
  return {
    ...mapping,
    defaultVatTreatment: null,
    defaultVatRate: rate,
    vatTreatmentSuggested: false,
    vatTreatmentReviewed: false,
    requiresVatTreatmentReview: true,
  }
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
  // The code each row this file speaks for, translated: also what a leg of a
  // pair beside another row is judged by, before the rule below.
  const codedByAccount = new Map(mappings.map((mapping) => {
    if (!mapping.targetAccount || mapping.sourceAccount !== mapping.targetAccount) return [mapping.sourceAccount, null]
    const accountClass = Number(mapping.sourceAccount.charAt(0))
    if (accountClass < 3 || accountClass > 6) return [mapping.sourceAccount, null]
    if (mapping.vatTreatmentReviewed && mapping.requiresVatTreatmentReview) return [mapping.sourceAccount, null]
    const code = codesByAccount.get(mapping.sourceAccount)?.trim()
    return [mapping.sourceAccount, code ? { code, treatment: translate(code, mapping.sourceAccount) } : null]
  }))
  const findingOf = findingsIn(
    mappings,
    (mapping) => codedByAccount.get(mapping.sourceAccount)?.treatment || mapping.defaultVatTreatment,
  )

  return mappings.map((mapping) => {
    const coded = codedByAccount.get(mapping.sourceAccount)
    if (!coded) return mapping
    const { code, treatment } = coded
    const accountClass = Number(mapping.sourceAccount.charAt(0))
    const withFacts = { ...mapping, providerVatCode: code, providerVatTreatment: treatment }
    if (!treatment) return withFacts
    // The file agrees with the treatment the account already carries: record
    // that it spoke, and leave the row settled rather than asking again.
    if (mapping.vatTreatmentReviewed && mapping.defaultVatTreatment === treatment) return withFacts
    // A reverse-charge code on a cost account does not say where the source
    // reported the basis; the vouchers do, and a pair beside the account that
    // reports ruta 20-24 means the code would count it twice (crm#1096). The
    // code then says nothing usable: a row the company chart settled keeps
    // the chart's answer, any other is left without a momskod to confirm.
    if (ruledOutByRcBasisPair(mapping, treatment, findingOf(mapping))) {
      return mapping.vatTreatmentReviewed ? withFacts : withoutRcMomskod(withFacts, mapping.defaultVatRate ?? null)
    }

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
 *
 * On an account the file ends up booking beside a separate basis pair that
 * reports ruta 20-24 (ruledOutByRcBasisPair), a reverse-charge momskod is not
 * suggested from the source code or the label. One the chart already has
 * stays, with the mapping step's warning: Accounted's own bookings on such an
 * account report their basis through that momskod alone, and the file may be
 * an older year.
 *
 * `context` is the whole mapping set when `mappings` is part of it: the legs
 * of a pair beside a row are judged by their own rows.
 */
export function enrichAccountMappingsWithVat(
  mappings: AccountMapping[],
  existingAccounts: BASAccount[],
  context: readonly AccountMapping[] = mappings,
): AccountMapping[] {
  const existingByNumber = new Map(
    existingAccounts.map((account) => [account.account_number, account]),
  )
  // A leg is judged by the user's answer where its row has one, else by the
  // momskod the row is about to get here, before the rule.
  const findingOf = findingsIn(
    context,
    (mapping) => mapping.vatTreatmentReviewed && mapping.requiresVatTreatmentReview
      ? mapping.defaultVatTreatment
      : existingByNumber.get(mapping.targetAccount)?.default_vat_treatment
        || mapping.providerVatTreatment
        || suggestVatTreatment(mapping.sourceAccount, mapping.sourceName)?.treatment,
    (account) => existingByNumber.get(account)?.default_vat_treatment,
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

    const finding = findingOf(mapping)
    if (ruledOutByRcBasisPair(mapping, mapping.providerVatTreatment, finding)) {
      return withoutRcMomskod(mapping, existing?.default_vat_rate ?? null)
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
    if (ruledOutByRcBasisPair(mapping, suggestion?.treatment, finding)) {
      return withoutRcMomskod(mapping, existing?.default_vat_rate ?? null)
    }
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
 * to be inherited, which held only while every row reaching a review had the
 * flag up already; a row the company chart settled does not, and its answer
 * was then overwritable by the next chart file. The counter and the filter
 * both ask for required AND NOT reviewed, so a row answered here still leaves
 * the review list.
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
      ? enrichAccountMappingsWithVat([mapping], existingAccounts, mappings)[0]
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
