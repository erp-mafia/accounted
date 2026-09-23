import { getAccountName } from '@/lib/bookkeeping/client-account-names'
import { ruleCategoryAccount, type RuleRow } from '@/lib/rules/model'

/** "google cloud emea" -> "Google Cloud Emea": the stored name is normalised lower-case. */
export function counterpartyTitle(name: string): string {
  return name
    .split(' ')
    .filter(Boolean)
    .map((w) => (w.length <= 3 && w === w.toLowerCase() ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1)))
    .join(' ')
}

/** "IT-tjänster 6540" for the account the rule categorises to. */
export function accountLabel(account: string): string {
  const name = getAccountName(account)
  return name && name !== account ? `${name} ${account}` : account
}

/** The row's one-line name: counterparty -> category. */
export function ruleTitle(row: Pick<RuleRow, 'counterparty_name' | 'debit_account' | 'credit_account'>): string {
  return `${counterpartyTitle(row.counterparty_name)} → ${accountLabel(ruleCategoryAccount(row))}`
}

const VAT_KEYS: Record<string, string> = {
  standard_25: 'vat_standard_25',
  reduced_12: 'vat_reduced_12',
  reduced_6: 'vat_reduced_6',
  exempt: 'vat_exempt',
  no_vat: 'vat_exempt',
  none: 'vat_exempt',
  reverse_charge: 'vat_reverse_charge',
  reverse_charge_eu: 'vat_reverse_charge',
  reverse_charge_non_eu: 'vat_reverse_charge',
}

/** i18n key in the `rules` namespace for a VAT treatment, or null for an unknown value. */
export function vatLabelKey(treatment: string): string | null {
  return VAT_KEYS[treatment] ?? null
}
