/**
 * K2 framework gate for the asset register.
 *
 * BFNAR 2016:10 punkt 10.4: egenupparbetade immateriella tillgangar far inte
 * aktiveras under K2; only acquired intangibles may be recognized. The BAS
 * chart marks the affected accounts (1010-1019, Utvecklingsutgifter and
 * balanserade utgifter) as "Ej K2" via the k2_excluded flag, so instead of
 * hardcoding number ranges the gate asks the BAS reference: any account whose
 * k2_excluded flag is set requires the K3 framework. The asset API routes
 * reject writes that would land an asset (or its accumulated-depreciation
 * counterpart) on such an account when the company's accounting_framework is
 * not 'k3'.
 */
import { getBASReference, type BASReferenceAccount } from '@/lib/bookkeeping/bas-reference'

/**
 * Return the first account in the list that the BAS reference flags as
 * k2_excluded ("Ej K2"), or null when every account is allowed under K2.
 * Unknown account numbers are treated as allowed: the Zod range checks and
 * chart validation own that concern.
 */
export function findK2ExcludedAccount(
  accountNumbers: Array<string | undefined>,
): BASReferenceAccount | null {
  for (const accountNumber of accountNumbers) {
    if (!accountNumber) continue
    const reference = getBASReference(accountNumber)
    if (reference?.k2_excluded) return reference
  }
  return null
}

/** Swedish user-facing message for the K2_EXCLUDED_ACCOUNT rejection. */
export function k2ExcludedAccountMessage(account: BASReferenceAccount): string {
  return (
    `Konto ${account.account_number} (${account.account_name}) kräver K3: ` +
    'egenupparbetade immateriella tillgångar får inte aktiveras enligt K2 (BFNAR 2016:10 punkt 10.4). ' +
    'Byt regelverk under Inställningar → Bokföring om företaget tillämpar K3.'
  )
}
