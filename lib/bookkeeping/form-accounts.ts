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
 *
 * Bostadsrättsförening (20260915170000): BAS 2026 has no accounts for the
 * årsavgift and hyra split a BRF needs for the ÅRL 6 kap. 3 a § nyckeltal
 * (3011-3014 hyror, 3020-3021 årsavgifter, 3031-3033 fees per BRL 7 kap.
 * 14 §), nor for the building components of K3 17.4 with 38.10 (1113-1117,
 * free numbers between BAS 1112 and 1118). The seed also relabels the BAS
 * account 2087 (Bunden överkursfond) to Upplåtelseavgifter for the form,
 * because ÅRL 3 kap. 10 b § counts upplåtelseavgifter as insatser and BAS has
 * no account of its own; that deviation is a label, so it is documented here
 * but not listed (getBASReference('2087') stays the BAS row, and a backfill
 * of 2087 for a BRF should be reviewed by hand).
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
  ...brfComponentAccounts(),
  ...brfRevenueAccounts(),
}

function brfComponentAccounts(): Record<string, BASReferenceAccount> {
  const components: Array<[string, string]> = [
    ['1113', 'Byggnader, komponent stomme och grund'],
    ['1114', 'Byggnader, komponent fasad och fönster'],
    ['1115', 'Byggnader, komponent tak'],
    ['1116', 'Byggnader, komponent stammar och VVS'],
    ['1117', 'Byggnader, komponent installationer'],
  ]
  return Object.fromEntries(
    components.map(([account_number, account_name]) => [
      account_number,
      {
        account_number,
        account_name,
        account_class: 1,
        account_group: '11',
        account_type: 'asset',
        normal_balance: 'debit',
        description: `${account_name}: komponentavskrivning av byggnaden i en bostadsrättsförening (K3 17.4 och 38.10); ackumulerade avskrivningar på 1119.`,
        sru_code: '7214',
        k2_excluded: false,
      } satisfies BASReferenceAccount,
    ]),
  )
}

function brfRevenueAccounts(): Record<string, BASReferenceAccount> {
  const revenue: Array<[string, string, string]> = [
    ['3011', 'Hyresintäkter bostäder', 'Hyror för bostäder upplåtna med hyresrätt (momsfri upplåtelse, ML 10 kap.).'],
    ['3012', 'Hyresintäkter lokaler', 'Hyror för lokaler; momsfria utan frivillig beskattning (ML 12 kap.).'],
    ['3013', 'Hyresintäkter garage', 'Hyror för garage; momspliktiga när upplåtelsen inte är underordnad en bostadsupplåtelse.'],
    ['3014', 'Hyresintäkter parkeringsplatser', 'Parkeringsavgifter; momspliktiga när upplåtelsen inte är underordnad en bostadsupplåtelse.'],
    ['3020', 'Årsavgifter bostäder', 'Årsavgifter för bostadslägenheter (BRL 7 kap. 14 §), momsfria; grund för nyckeltalet årsavgift per kvm (ÅRL 6 kap. 3 a §).'],
    ['3021', 'Årsavgifter lokaler', 'Årsavgifter för lokaler upplåtna med bostadsrätt.'],
    ['3031', 'Överlåtelseavgifter', 'Överlåtelseavgift enligt stadgarna (BRL 7 kap. 14 §), momsfri.'],
    ['3032', 'Pantsättningsavgifter', 'Pantsättningsavgift enligt stadgarna (BRL 7 kap. 14 §), momsfri.'],
    ['3033', 'Andrahandsupplåtelseavgifter', 'Avgift för andrahandsupplåtelse enligt stadgarna (BRL 7 kap. 14 §, högst tio procent av prisbasbeloppet per år), momsfri.'],
  ]
  return Object.fromEntries(
    revenue.map(([account_number, account_name, description]) => [
      account_number,
      {
        account_number,
        account_name,
        account_class: 3,
        account_group: '30',
        account_type: 'revenue',
        normal_balance: 'credit',
        description,
        sru_code: '7410',
        k2_excluded: false,
      } satisfies BASReferenceAccount,
    ]),
  )
}

export function getFormSeededAccount(accountNumber: string): BASReferenceAccount | undefined {
  return FORM_SEEDED_ACCOUNTS[accountNumber]
}

/** BAS 2026 first, then the form-seeded deviations. */
export function getSeedableAccountReference(accountNumber: string): BASReferenceAccount | undefined {
  return getBASReference(accountNumber) ?? getFormSeededAccount(accountNumber)
}
