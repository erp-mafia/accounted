/**
 * Canonical shape for a per-line invoice posting-account override: a 4-digit
 * BAS class 1-3 account. Single source of truth shared by the server-side Zod
 * schemas (lib/api/schemas.ts) and the client-side form schemas
 * (ArticleForm, InvoiceEditor) so the two layers cannot drift apart.
 *
 * Classes 4-8 stay excluded: an invoice line never books to cost, payroll,
 * or financial accounts. Class 1-2 (balance-sheet) overrides exist for
 * deposits, customer advances, and genuine outlays; they are only bookable
 * on zero-VAT lines (enforced server-side in build-invoice-write.ts).
 */
export const INVOICE_POSTING_ACCOUNT_REGEX = /^[123]\d{3}$/

/** True when the account is a balance-sheet account (BAS class 1-2). */
export function isBalanceSheetAccount(account: string): boolean {
  return /^[12]/.test(account)
}
