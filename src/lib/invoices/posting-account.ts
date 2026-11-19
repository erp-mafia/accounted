import { isBasInterestIncomeAccount } from '@/lib/bookkeeping/result-account-ranges'

/**
 * Canonical shape for a per-line invoice posting-account override: a 4-digit
 * BAS class 1-3 account. Single source of truth shared by the server-side Zod
 * schemas (lib/api/schemas.ts) and the client-side form schemas
 * (ArticleForm, InvoiceEditor) so the two layers cannot drift apart.
 *
 * Classes 4-8 stay excluded for an article: an article never books to cost,
 * payroll, or financial accounts. Class 1-2 (balance-sheet) overrides exist
 * for deposits, customer advances, and genuine outlays; they are only
 * bookable on zero-VAT lines (enforced server-side in build-invoice-write.ts).
 * An invoice line additionally takes interest income: see
 * isInvoiceLinePostingAccount.
 */
export const INVOICE_POSTING_ACCOUNT_REGEX = /^[123]\d{3}$/

/**
 * What a customer invoice LINE (not an article) may post to: the class 1-3
 * accounts above plus the BAS interest-income groups
 * (isBasInterestIncomeAccount), so a loan invoice can carry the amortization
 * (1380/1385, class 1) and the interest (e.g. 8251) on its own rows (PH 246).
 * Shared by the invoice item Zod schema, the invoice builder and the editor.
 */
export function isInvoiceLinePostingAccount(account: string): boolean {
  return INVOICE_POSTING_ACCOUNT_REGEX.test(account) || isBasInterestIncomeAccount(account)
}

/** True when the account is a balance-sheet account (BAS class 1-2). */
export function isBalanceSheetAccount(account: string): boolean {
  return /^[12]/.test(account)
}

/**
 * True when a line on this account must carry 0 % VAT: a balance-sheet
 * account (deposit, advance, outlay, loan amortization) or an interest-income
 * account (granting credit is VAT exempt, ML 10 kap.; interest is financial
 * income, never a 3xxx sale). On a VAT-bearing line either would divert the
 * tax base away from a 3xxx account and understate ruta 05.
 */
export function isZeroVatOnlyPostingAccount(account: string): boolean {
  return isBalanceSheetAccount(account) || isBasInterestIncomeAccount(account)
}
