import { roundOre } from '@/lib/money'
import { formatCurrency } from '@/lib/utils'

// formatKronor lives in lib/utils beside formatCurrency, so the kundförlust
// texts (invoicing) share it without importing collections.
export { formatKronor } from '@/lib/utils'

/**
 * An amount read off one invoice (what is unpaid, the claim) in the invoice's
 * own currency: a USD invoice owes dollars, and formatKronor would print the
 * same figure as kronor. Same shape as formatKronor (whole amounts without
 * decimals, otherwise both decimals), and identical to it for SEK or no
 * currency. Pure and client-safe.
 */
export function formatInvoiceAmount(amount: number, currency: string | null | undefined): string {
  return formatCurrency(roundOre(amount), currency)
}
