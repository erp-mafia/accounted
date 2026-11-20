import type { AccountingFramework, Company } from '@/types'

/**
 * The accounting framework the company reports under now, as client code
 * reads it: the one place the BAS catalog reads it. Today the framework is
 * stored per company (companies.accounting_framework); once it is stored per
 * räkenskapsår (src/lib/company/accounting-framework.ts) this returns the
 * open year's. Null without a company.
 */
export function currentAccountingFramework(
  company: Pick<Company, 'accounting_framework'> | null | undefined,
): AccountingFramework | null {
  const framework = company?.accounting_framework
  return framework === 'k2' || framework === 'k3' ? framework : null
}

/**
 * Whether the BAS catalog hides the accounts BAS 2026 marks # ("not for K2",
 * `k2_excluded`) by default.
 *
 * Most of them carry treatments K2 does not allow, among them capitalised
 * own development (1010-1019, Fond för utvecklingsutgifter 2089), deferred
 * tax (1370, 2240, 8940) and fair value (Fond för verkligt värde 2096,
 * 8290-8295, 8320-8325, 8450-8455). Neither do the årsbokslut frameworks the
 * product closes enskild firma and ideell förening under: BFNAR 2017:3 (as
 * amended by BFNAR 2026:1) 19.2 bars egenupparbetade immateriella tillgångar
 * and uppskjuten skatt from the ingångsbalansräkning and 19.4 revalues
 * fair-valued instruments, and förenklat årsbokslut (K1) is simpler still.
 * Those forms store 'k2' in the framework column, so the rule is: hidden by
 * default unless the company reports under K3.
 *
 * Unknown (no company in context) keeps everything visible, as before: the
 * toggle stays the user's.
 */
export function hideNotForK2AccountsByDefault(framework: AccountingFramework | null): boolean {
  return framework !== null && framework !== 'k3'
}
