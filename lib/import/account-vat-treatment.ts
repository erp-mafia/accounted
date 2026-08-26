import type { BASAccount } from '@/types'
import {
  suggestVatTreatment,
  type AccountVatTreatment,
} from '@/lib/vat/account-vat-treatment'
import type { AccountMapping } from './types'

/**
 * Add reviewable VAT suggestions to identity mappings. SIE itself has no VAT
 * treatment record, so suggestions come only from the account label and are
 * never considered reviewed until the user continues from the mapping step.
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
