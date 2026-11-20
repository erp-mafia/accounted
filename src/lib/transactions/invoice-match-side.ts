/**
 * Which open-invoice intercept a categorization falls under, if any: a plain
 * 244x payment of a supplier invoice from a bank or cash account (money
 * out), or a plain 151x receipt of a customer payment on a 19xx account
 * (money in). findInvoiceMatchSuggestion searches exactly for these, unless
 * the caller confirmed there is no match; the categorize core records the
 * check only where it applies. Pure.
 */
export function invoiceMatchSide(input: {
  transaction: { amount: number }
  debitAccount: string
  creditAccount: string
  isBusiness: boolean
}): 'supplier' | 'customer' | null {
  const { transaction, debitAccount, creditAccount, isBusiness } = input
  if (!isBusiness) return null
  if (transaction.amount < 0 && /^244\d$/.test(debitAccount) && /^1\d{3}$/.test(creditAccount)) return 'supplier'
  if (transaction.amount > 0 && /^19\d{2}$/.test(debitAccount) && /^151\d$/.test(creditAccount)) return 'customer'
  return null
}
