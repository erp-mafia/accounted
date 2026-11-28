import { isCreditNoteDocument } from '@/lib/bookkeeping/credit-note-state'
import { itemHasAccrual } from '@/lib/bookkeeping/accruals/account-suggestions'
import { isCashLedger } from '@/lib/bookkeeping/bank-leg'
import { futurePaymentDateRefusal } from '@/lib/invoices/payment-date'
import { DEFAULT_PAYMENT_ACCOUNT } from '@/lib/webshop-orders/booking-lines'
import type { InvoiceDocumentType } from '@/types'

/**
 * The kontantfaktura (crm#1281): a faktura that is paid at the moment it is
 * issued (Swish, card, Klarna, cash at the counter), so the document is also
 * the customer's receipt. The sale and the payment are one affärshändelse,
 * booked as one verifikat on the fakturadatum: the payment account debit
 * against revenue (30xx) and output VAT (26xx), with no kundfordran in
 * between, in either accounting method.
 *
 * The issue step books nothing of its own for it; the payment that settles
 * it at issue books the cash entry (settleInvoicePayment with
 * recognizeSaleAtPayment), exactly the shape a kontantmetoden invoice gets
 * when it is paid. One shape, one series, one reversal hook.
 */

/**
 * The accounts a kontantfaktura can be paid to (crm#2324):
 *
 * - a cash ledger (19xx: kassa, bank, the Swish account), where the money is
 *   at once;
 * - 1686 Fordringar för kontokort och kuponger (BAS 2026), the claim on a
 *   card acquirer or payment provider from the sale until its payout: card
 *   and Klarna money is not in the bank at the sale, and the customer is
 *   discharged, so it is neither 19xx nor 1510;
 * - an account one of the company's webshop stores books a payment method to
 *   (`providerAccounts`, loadPaidAtIssueProviderAccounts), such as an own
 *   1517 for Klarna: the account the store's Bokför already debits for the
 *   same sale.
 *
 * Any other account is refused at every door. The provider accounts are the
 * company's, so a door that has not read them allows 19xx and 1686 only.
 */
export function isPaidAtIssueAccount(
  accountNumber: string | null | undefined,
  providerAccounts: readonly string[] = [],
): boolean {
  if (!accountNumber) return false
  return isCashLedger(accountNumber) || accountNumber === DEFAULT_PAYMENT_ACCOUNT || providerAccounts.includes(accountNumber)
}

/**
 * Why this document cannot be issued as already paid, or null when it can.
 * The one rule every door applies (the dashboard and v1 mark-sent, the MCP
 * tool at staging, issueAndBookInvoice at commit), so they cannot drift.
 *
 * - custom_lines: user-edited issuance lines are the registration verifikat
 *   a kontantfaktura never has.
 * - not_invoice: an offert, proforma or följesedel asks for no payment.
 * - credit_note: a kreditfaktura settles against its original.
 * - self_billed: a mottagen självfaktura is registered from the buyer's
 *   document, never issued by us.
 * - periodisering: a periodiserad line books to 29xx and is dissolved by a
 *   schedule the registration verifikat creates; the cash entry books
 *   revenue directly, so the periodisering would be lost. Such an invoice is
 *   sent as usual and its payment registered afterwards.
 * - dated_ahead: the payment is dated the invoice date, and a payment is never
 *   dated ahead of today (lib/invoices/payment-date.ts). Asked here so it is
 *   refused before a number is taken, not by the settlement after it.
 */
export type PaidAtIssueBlockReason =
  | 'custom_lines'
  | 'not_invoice'
  | 'credit_note'
  | 'self_billed'
  | 'periodisering'
  | 'dated_ahead'

export function paidAtIssueBlockReason(
  invoice: {
    document_type?: InvoiceDocumentType | string | null
    credited_invoice_id?: string | null
    total?: number | null
    is_self_billed?: boolean | null
    invoice_date?: string | null
    items?: ReadonlyArray<{
      accrual_period_start?: string | null
      accrual_period_end?: string | null
    }> | null
  },
  request: { customLines?: ReadonlyArray<unknown> | null } = {},
): PaidAtIssueBlockReason | null {
  if (request.customLines) return 'custom_lines'
  if (invoice.document_type && invoice.document_type !== 'invoice') return 'not_invoice'
  if (isCreditNoteDocument(invoice)) return 'credit_note'
  if (invoice.is_self_billed) return 'self_billed'
  if ((invoice.items ?? []).some((item) => itemHasAccrual(item))) return 'periodisering'
  if (invoice.invoice_date && futurePaymentDateRefusal(invoice.invoice_date)) return 'dated_ahead'
  return null
}
