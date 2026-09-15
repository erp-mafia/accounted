import type { BASReferenceAccount } from '@/lib/bookkeeping/bas-reference'
import { getBASReference } from '@/lib/bookkeeping/bas-reference'

/**
 * Accounts that are not in the BAS 2026 reference but are seeded by
 * seed_chart_of_accounts() for one legal form, so booking templates for that
 * form may reference them and account-backfill can restore them. Keep this
 * list tiny: every entry is a deviation from the standard chart that a
 * reviewer has to justify.
 *
 * 3901 Medlemsavgifter (ekonomisk förening): a sub-account under BAS group 39
 * Övriga rörelseintäkter. Membership fees are tax-exempt for the association
 * (Skatteverket, "Deklarera för en ekonomisk förening") and must be isolated
 * from other operating income so the INK2S 4.5c adjustment can be detected
 * from the ledger (lib/bokslut/tax-provision/tax-adjustment-service.ts).
 */
export const FORM_SEEDED_ACCOUNTS: Readonly<Record<string, BASReferenceAccount>> = {
  '3901': {
    account_number: '3901',
    account_name: 'Medlemsavgifter',
    account_class: 3,
    account_group: '39',
    account_type: 'revenue',
    normal_balance: 'credit',
    description:
      'Medlemsavgifter i en ekonomisk förening: övriga rörelseintäkter, skattefria för föreningen (INK2S 4.5c) och utanför moms.',
    sru_code: '7413',
    k2_excluded: false,
  },
}

export function getFormSeededAccount(accountNumber: string): BASReferenceAccount | undefined {
  return FORM_SEEDED_ACCOUNTS[accountNumber]
}

/** BAS 2026 first, then the form-seeded deviations. */
export function getSeedableAccountReference(accountNumber: string): BASReferenceAccount | undefined {
  return getBASReference(accountNumber) ?? getFormSeededAccount(accountNumber)
}
