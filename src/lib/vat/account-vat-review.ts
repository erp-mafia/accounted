import type { MomsBox } from './moms-box-mapping'
import { BOX_LABELS } from './moms-box-mapping'
import {
  isAccountVatTreatment,
  resolveVatTreatmentRuta,
  suggestVatTreatment,
  type AccountVatTreatment,
} from './account-vat-treatment'
import {
  resolveAccountVatBox,
  type VatAccountClassificationRow,
} from '@/lib/reports/vat-revenue-accounts'

/**
 * "Att granska" for an account's momskod, outside the import.
 *
 * The import's mapping step flags a row with requiresVatTreatmentReview and
 * clears it with vatTreatmentReviewed, but both live on the in-memory mapping
 * and are never written to chart_of_accounts. After the import, what is left
 * to check against is what the account itself says: its NAME, read by the
 * same suggestVatTreatment the import prefilled from, and the box its
 * amounts actually land in, resolved by the declaration's own precedence
 * (resolveAccountVatBox). An account is to be reviewed when the two point at
 * different rutor:
 *
 *   - no momskod of its own, and the BAS fallback sends its amounts somewhere
 *     other than the name says (a skipped or bulk-confirmed import row whose
 *     suggestion was never kept), or
 *   - a momskod that sends its amounts somewhere other than the name says.
 *
 * Comparing boxes rather than treatments keeps a correct BAS default quiet:
 * 3001 "Försäljning inom Sverige, 25 % moms" needs no code of its own to land
 * in ruta 05. Where the name says nothing (suggestVatTreatment is null) there
 * is nothing to contradict, so the account is never flagged. Classes 1-2 and
 * 7-8 carry no treatment.
 *
 * The one predicate behind the Kontoplan column and filter, its notice and
 * the Att göra row, so the three can never disagree on the count.
 */
export interface AccountVatReviewFinding {
  /** The treatment the account name suggests. */
  suggestedTreatment: AccountVatTreatment
  /** The ruta that treatment feeds on this account; null for OSS (outside the momsdeklaration). */
  suggestedBox: MomsBox | null
  /** The ruta the account's amounts land in today; null when none. */
  effectiveBox: MomsBox | null
  /** Whether the account carries a momskod of its own (else the BAS fallback applies). */
  hasOwnTreatment: boolean
}

function boxOf(treatment: AccountVatTreatment, accountClass: number, accountNumber: string): MomsBox | null {
  const mapping = resolveVatTreatmentRuta(treatment, accountClass, accountNumber)
  if (!mapping) return null
  const code = mapping.box.replace(/^ruta/, '')
  return code in BOX_LABELS ? (code as MomsBox) : null
}

export function accountVatReviewFinding(
  row: VatAccountClassificationRow,
): AccountVatReviewFinding | null {
  const accountClass = row.account_class ?? Number(row.account_number.charAt(0))
  if (accountClass < 3 || accountClass > 6) return null
  const suggestion = suggestVatTreatment(row.account_number, row.account_name)
  if (!suggestion) return null

  const suggestedBox = boxOf(suggestion.treatment, accountClass, row.account_number)
  const effectiveBox = resolveAccountVatBox({ ...row, account_class: accountClass })
  if (suggestedBox === effectiveBox) return null

  return {
    suggestedTreatment: suggestion.treatment,
    suggestedBox,
    effectiveBox,
    hasOwnTreatment: isAccountVatTreatment(row.default_vat_treatment),
  }
}

export function accountNeedsVatReview(row: VatAccountClassificationRow): boolean {
  return accountVatReviewFinding(row) !== null
}
