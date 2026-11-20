/**
 * The verifikat rows a staged match of one bank row to one customer invoice
 * will post, for the staging preview (crm#1813): the agent and the approver
 * saw only the two totals, so a kursvinst or kursförlust on a foreign invoice
 * first showed after approval. match_batch_allocate's preview already carried
 * its rows (expected_lines, lib/invoices/batch-allocation-preview.ts); this is
 * the same field for the single match.
 *
 * Read only. The rows come from the builders bookCustomerBankMatch books with
 * (lib/invoices/book-customer-bank-match.ts), fed the same arguments in the
 * same order: the invoice's booking state picks the shape (an invoice with a
 * verifikat, or any invoice under faktureringsmetoden, clears 1510; a
 * never-booked invoice paid in full under kontantmetoden books revenue and
 * moms), the bank leg is the row's own settlement account, and a foreign
 * invoice clears what the ledger carries. When that function changes its
 * routing, this one changes with it.
 *
 * A preview never refuses: anything the booking would refuse (a missing
 * booking rate, an unreadable accounting method) answers null here and the
 * staging goes on exactly as before, with the refusal where it always was.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { cashPartialBlockReason } from '@/lib/bookkeeping/booking-mode'
import { buildInvoiceCashLines } from '@/lib/bookkeeping/invoice-entries'
import { invoiceCashBankSek } from '@/lib/bookkeeping/invoice-lines'
import { buildInvoiceMatchClearingLines, invoiceMatchClearingInvoiceOf } from '@/lib/bookkeeping/invoice-payment-lines'
import { carriedSekOf } from '@/lib/bookkeeping/ledger-carried-sek'
import { lineBalance } from '@/lib/bookkeeping/line-balance'
import { resolveSettlementAccount } from '@/lib/bookkeeping/settlement-account'
import { checkAccountingMethod } from '@/lib/company/accounting-method'
import { resolveCompanyEntityType } from '@/lib/company/entity-type'
import type { MatchPaymentPlanResult } from '@/lib/invoices/match-payment-plan'
import type { SaleFirstPlan } from '@/lib/invoices/sale-first'
import type { Logger } from '@/lib/logger'
import type { CreateJournalEntryLineInput, Invoice } from '@/types'

export interface CustomerMatchExpectedLine {
  account_number: string
  description: string
  debit: number
  credit: number
}

export interface CustomerMatchExpectedLines {
  expected_lines: CustomerMatchExpectedLine[]
  /** Debits equal credits to the öre. */
  expected_lines_balanced: boolean
}

export interface CustomerMatchPreviewTransaction {
  amount: number
  amount_sek?: number | null
  currency: string | null
  exchange_rate?: number | null
  cash_account_id?: string | null
}

export async function customerMatchExpectedLines(
  ctx: { supabase: SupabaseClient; companyId: string; log: Logger },
  transaction: CustomerMatchPreviewTransaction,
  invoice: Invoice & { customer?: { name?: string | null } | null },
  matchPlan: Extract<MatchPaymentPlanResult, { ok: true }>,
  salePlan: Extract<SaleFirstPlan, { ok: true }>,
): Promise<CustomerMatchExpectedLines | null> {
  const { supabase, companyId, log } = ctx
  // A bank row without a currency cannot be previewed: staging goes on as before.
  const txCurrency = transaction.currency
  if (!txCurrency) return null
  try {
    const settingsRead = await supabase
      .from('company_settings')
      .select('accounting_method, entity_type')
      .eq('company_id', companyId)
      .single()
    const method = checkAccountingMethod(settingsRead)
    if (!method.ok) return null
    const { accountingMethod } = method

    const { fx } = matchPlan
    const { isFullyPaid } = matchPlan.plan
    const overpaymentAccount = matchPlan.overpayment?.account
    const feeAccount = matchPlan.fee?.account
    const invoiceAlreadyBooked = !!invoice.journal_entry_id
    // The booking refuses this shape; there are no rows to show.
    if (
      cashPartialBlockReason({
        invoiceAlreadyBooked,
        accountingMethod,
        priorPaidAmount: invoice.paid_amount,
        paysRemainingInFull: isFullyPaid,
      })
    ) {
      return null
    }
    const useCashEntry = !invoiceAlreadyBooked && accountingMethod === 'cash' && isFullyPaid
    const paymentAccount = await resolveSettlementAccount(supabase, companyId, transaction.cash_account_id ?? null, log)

    let lines: CreateJournalEntryLineInput[]
    if (useCashEntry) {
      const entityType = await resolveCompanyEntityType(
        supabase,
        companyId,
        (settingsRead.data as { entity_type?: unknown } | null)?.entity_type,
      )
      lines = buildInvoiceCashLines(
        invoice,
        entityType,
        invoice.customer?.name ?? undefined,
        paymentAccount,
        invoiceCashBankSek(transaction),
        overpaymentAccount,
        { deferDeductionShare: accountingMethod === 'cash', feeAccount },
      ).lines
    } else {
      const carriedSek = salePlan.required
        ? salePlan.receivableSek
        : await carriedSekOf(supabase, companyId, 'customer', invoice)
      lines = buildInvoiceMatchClearingLines(
        {
          amount: transaction.amount,
          amount_sek: transaction.amount_sek ?? null,
          currency: txCurrency,
          exchange_rate: transaction.exchange_rate ?? null,
        },
        invoiceMatchClearingInvoiceOf(invoice, carriedSek),
        fx.required ? fx.paidInInvoiceCurrency : undefined,
        paymentAccount,
        overpaymentAccount,
        feeAccount,
      ).lines
    }

    return {
      expected_lines: lines.map((line) => ({
        account_number: line.account_number,
        description: line.line_description ?? '',
        debit: line.debit_amount,
        credit: line.credit_amount,
      })),
      expected_lines_balanced: lineBalance(lines).balanced,
    }
  } catch (err) {
    log.warn('customer match preview: the expected lines could not be built (staging continues without them)', {
      error: err instanceof Error ? err.message : String(err),
    })
    return null
  }
}
