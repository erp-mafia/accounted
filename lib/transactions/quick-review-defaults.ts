import {
  getDefaultAccountForCategory,
  getDefaultVatTreatmentForCategory,
} from '@/lib/bookkeeping/category-mapping'
import type { TransactionCategory, VatTreatment } from '@/types'

/**
 * The template shape the transaction review dialog actually reads.
 *
 * Deliberately NOT `BookingTemplate`: the review dialog is opened from three
 * sources, and only one of them has a full catalog template behind it.
 *
 *  - a static catalog template (`BookingTemplate`, structurally assignable),
 *  - a user library template converted to the same shape,
 *  - a learned counterparty template ("Tidigare motparter"), which has no
 *    catalog entry at all: it carries a name and a debit/credit pair and
 *    nothing else.
 *
 * The counterparty case used to be forced into `BookingTemplate` with an
 * `as BookingTemplate` cast on a two-field object literal. The cast made
 * every missing field look present to the compiler, so `template.debit_account`
 * read `undefined` at runtime, flowed into the dialog's `defaultAccount` prop
 * (typed `string`), and crashed the page on `accountOverride.startsWith('2')`.
 * Typing the optional fields as optional is what makes that class of bug a
 * compile error instead of an error boundary.
 */
export interface ReviewTemplate {
  id: string
  name_sv: string
  debit_account?: string
  credit_account?: string
  vat_treatment?: VatTreatment | null
  vat_rate?: number
  special_rules_sv?: string
  deductibility_note_sv?: string
  requires_vat_registration_data?: boolean
  reverse_charge_supplier_type?: 'eu_business' | 'non_eu_business' | 'swedish_business'
}

export interface QuickReviewDefaults {
  account: string
  vat: VatTreatment | 'none'
}

/**
 * Resolve the account + VAT the review dialog starts on.
 *
 * A template without a `templateId` (library or counterparty template) is not
 * validated server-side against the static catalog, so its own debit account
 * and VAT treatment seed the form. Anything the template leaves unset falls
 * back to the transaction category's defaults, and finally to an empty
 * account / no VAT: the caller feeds a required `string` prop, and an
 * `undefined` there is what took the page down.
 */
export function resolveQuickReviewDefaults(
  template: ReviewTemplate | null | undefined,
  templateId: string | undefined,
  category: TransactionCategory | null | undefined,
): QuickReviewDefaults {
  const useTemplateDefaults = !templateId && !!template

  const account =
    (useTemplateDefaults ? template.debit_account : undefined) ||
    (category ? getDefaultAccountForCategory(category) : '') ||
    ''

  const vat: VatTreatment | 'none' = useTemplateDefaults
    ? (template.vat_treatment ?? 'none')
    : (category ? (getDefaultVatTreatmentForCategory(category) ?? 'none') : 'none')

  return { account, vat }
}
