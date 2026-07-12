import type { SupabaseClient } from '@supabase/supabase-js'
import {
  createInvoicePaymentJournalEntry,
  createInvoiceCashEntry,
} from '@/lib/bookkeeping/invoice-entries'
import { createJournalEntry, findFiscalPeriod } from '@/lib/bookkeeping/engine'
import { resolveInvoicePaymentSourceType } from '@/lib/bookkeeping/propose-payment-lines'
import { isBookkeepingError } from '@/lib/bookkeeping/errors'
import { cancelOrphanedPaymentEntry } from '@/lib/bookkeeping/cancel-orphaned-entry'
import { planInvoicePayment } from '@/lib/invoices/apply-invoice-payment'
import { eventBus } from '@/lib/events'
import type { CreateJournalEntryInput, Customer, EntityType, Invoice } from '@/types'

/**
 * The core "apply a payment to an invoice" operation, extracted from the
 * mark-paid route so the Stripe payment sync (and any future automated payment
 * channel) shares the exact same booking, status transition, orphan handling
 * and event emission as the manual flow:
 *
 *   1. planInvoicePayment: ledger math + overpayment guard
 *   2. journal entry: custom lines | cash entry (kontantmetoden, unbooked) |
 *      payment entry (clears 1510), fail-closed for real invoices
 *   3. CAS-guarded invoice status update; a lost race or failed update cancels
 *      the just-posted voucher so GL and sub-ledger never diverge
 *   4. invoice.paid event (best-effort)
 *
 * `settlementAccountNumber` routes the debit side: default 1930 (bank), 1686
 * for PSP-balance settlements (Stripe) where the money reaches the bank only
 * with the later payout.
 *
 * The function performs the write path only. Caller-owned concerns stay in
 * the callers: fetching the invoice, payable-status guards, request parsing,
 * the duplicate-payment guard (a UX advisory: the Stripe sync skips it
 * because the payment event IS the authoritative payment), and mapping the
 * result to a transport-specific response.
 */

export interface SettleCustomLine {
  account_number: string
  debit_amount: number
  credit_amount: number
  line_description?: string
}

/**
 * Invoice shape at the settlement boundary. Callers typically join only the
 * customer's name (`customer:customers(name)`), so the relation is modelled
 * as exactly that: reading any other Customer field here would be undefined
 * at runtime. A fully joined Customer still satisfies this structurally.
 */
export type InvoiceWithCustomerName = Omit<Invoice, 'customer'> & {
  customer?: Pick<Customer, 'name'> | null
}

export interface SettleInvoicePaymentParams {
  invoice: InvoiceWithCustomerName
  /** Payment amount in the INVOICE currency (caller converts if needed). */
  paymentAmountInInvoiceCurrency: number
  /** Booking date (YYYY-MM-DD). */
  paymentDate: string
  accountingMethod: string
  entityType: EntityType
  /** FX difference in SEK (manual flow only). */
  exchangeRateDifference?: number
  /** Caller-supplied booking lines (manual dialog only); must balance. */
  customLines?: SettleCustomLine[]
  /** Debit-side account; default '1930'. Stripe settlements pass '1686'. */
  settlementAccountNumber?: string
}

export type SettleInvoicePaymentResult =
  | {
      ok: true
      newStatus: 'paid' | 'partially_paid'
      newPaidAmount: number
      newRemaining: number
      journalEntryId: string | null
      paidAt: string | null
    }
  | { ok: false; code: 'MATCH_AMOUNT_EXCEEDS_REMAINING'; details: Record<string, unknown> }
  | { ok: false; code: 'INVOICE_PAID_LINES_UNBALANCED'; details: Record<string, unknown> }
  | { ok: false; code: 'INVOICE_PAID_NO_FISCAL_PERIOD'; details: Record<string, unknown> }
  | { ok: false; code: 'INVOICE_PAID_BOOK_FAILED'; details: Record<string, unknown> }
  | { ok: false; code: 'INVOICE_PAID_RACE' }
  | { ok: false; code: 'BOOKKEEPING_ERROR'; error: unknown }
  | { ok: false; code: 'UPDATE_FAILED'; error: unknown }

export async function settleInvoicePayment(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  params: SettleInvoicePaymentParams,
): Promise<SettleInvoicePaymentResult> {
  const {
    invoice,
    paymentAmountInInvoiceCurrency,
    paymentDate,
    accountingMethod,
    entityType,
    exchangeRateDifference,
    customLines,
    settlementAccountNumber,
  } = params

  const now = new Date().toISOString()

  // Drive the JE shape from the invoice's actual booking state, not from
  // the current accounting_method setting. If the invoice was booked at
  // send (Dr 1510 / Cr 30xx + VAT), the payment MUST clear 1510:
  // otherwise the receivable orphans and 30xx + VAT double-count. Only
  // when there is no prior JE (pure kontantmetoden) do we recognise
  // revenue + VAT here.
  const invoiceAlreadyBooked = !!(invoice as { journal_entry_id?: string | null })
    .journal_entry_id
  const useCashEntry = !invoiceAlreadyBooked && accountingMethod === 'cash'

  // Ledger math + overpayment guard. Runs BEFORE any journal entry is
  // created so a doomed overpayment never burns a voucher number.
  const payment = planInvoicePayment(invoice, paymentAmountInInvoiceCurrency)
  if (!payment.ok) {
    return {
      ok: false,
      code: 'MATCH_AMOUNT_EXCEEDS_REMAINING',
      details: payment.details as Record<string, unknown>,
    }
  }
  const { newPaidAmount, newRemaining, newStatus } = payment.plan

  const isRealInvoice = !invoice.document_type || invoice.document_type === 'invoice'
  let journalEntryId: string | null = null

  if (isRealInvoice) {
    try {
      if (customLines) {
        const totalDebit = customLines.reduce((s, l) => s + l.debit_amount, 0)
        const totalCredit = customLines.reduce((s, l) => s + l.credit_amount, 0)
        if (Math.round((totalDebit - totalCredit) * 100) !== 0 || totalDebit <= 0) {
          return {
            ok: false,
            code: 'INVOICE_PAID_LINES_UNBALANCED',
            details: { totalDebit, totalCredit },
          }
        }

        const fiscalPeriodId = await findFiscalPeriod(supabase, companyId, paymentDate)
        if (!fiscalPeriodId) {
          return {
            ok: false,
            code: 'INVOICE_PAID_NO_FISCAL_PERIOD',
            details: { paymentDate },
          }
        }
        const sourceType = resolveInvoicePaymentSourceType({
          invoiceAlreadyBooked,
          // Settings store a raw string; anything but 'cash' books as accrual,
          // matching the useCashEntry check above.
          accountingMethod: accountingMethod === 'cash' ? 'cash' : 'accrual',
        })
        const input: CreateJournalEntryInput = {
          fiscal_period_id: fiscalPeriodId,
          entry_date: paymentDate,
          description: invoice.customer?.name
            ? `Inbetalning kundfaktura ${invoice.invoice_number}, ${invoice.customer.name}`
            : `Inbetalning kundfaktura ${invoice.invoice_number}`,
          source_type: sourceType,
          source_id: invoice.id,
          lines: customLines,
        }
        const journalEntry = await createJournalEntry(supabase, companyId, userId, input)
        journalEntryId = journalEntry?.id ?? null
      } else if (useCashEntry) {
        // The entry helpers never read invoice.customer (the display name is
        // passed explicitly), so the partial customer relation is safe here.
        const journalEntry = await createInvoiceCashEntry(
          supabase,
          companyId,
          userId,
          invoice as Invoice,
          paymentDate,
          entityType,
          invoice.customer?.name ?? undefined,
          settlementAccountNumber,
        )
        journalEntryId = journalEntry?.id ?? null
      } else {
        const journalEntry = await createInvoicePaymentJournalEntry(
          supabase,
          companyId,
          userId,
          invoice as Invoice,
          paymentDate,
          exchangeRateDifference,
          invoice.customer?.name ?? undefined,
          undefined,
          settlementAccountNumber,
        )
        journalEntryId = journalEntry?.id ?? null
      }
    } catch (err) {
      if (isBookkeepingError(err)) {
        return { ok: false, code: 'BOOKKEEPING_ERROR', error: err }
      }
      return {
        ok: false,
        code: 'INVOICE_PAID_BOOK_FAILED',
        details: { reason: err instanceof Error ? err.message : 'unknown' },
      }
    }

    // Fail closed: a real invoice must produce a payment voucher. If a helper
    // returned null without throwing (e.g. a closed/locked fiscal period),
    // refuse to mark the invoice paid: flipping status with no journal entry
    // orphans the receivable and diverges the GL from the sub-ledger.
    if (!journalEntryId) {
      return {
        ok: false,
        code: 'INVOICE_PAID_BOOK_FAILED',
        details: { reason: 'no_journal_entry_created' },
      }
    }
  }

  // CAS guard: only update if status is still in a payable state.
  const { data: updateResult, error: updateError } = await supabase
    .from('invoices')
    .update({
      status: newStatus,
      paid_amount: newPaidAmount,
      remaining_amount: newRemaining,
      ...(newStatus === 'paid' ? { paid_at: now } : {}),
    })
    .eq('id', invoice.id)
    .eq('company_id', companyId)
    .in('status', ['sent', 'overdue', 'partially_paid'])
    .select('id')

  if (updateError) {
    // The payment voucher already posted but the invoice row did not flip to
    // paid; cancel the orphan so the GL doesn't diverge from the sub-ledger.
    if (journalEntryId) {
      await cancelOrphanedPaymentEntry(
        supabase,
        companyId,
        userId,
        journalEntryId,
        'Automatiskt makulerad: fakturauppdatering misslyckades efter bokförd betalning',
      )
    }
    return { ok: false, code: 'UPDATE_FAILED', error: updateError }
  }

  if (!updateResult || updateResult.length === 0) {
    // Status changed between read and write (concurrent settle): cancel the
    // orphaned payment voucher; the trigger documents the voucher gap.
    if (journalEntryId) {
      await cancelOrphanedPaymentEntry(
        supabase,
        companyId,
        userId,
        journalEntryId,
        'Automatiskt makulerad: dubblettbokning förhindrad av samtidighetsskydd',
      )
    }
    return { ok: false, code: 'INVOICE_PAID_RACE' }
  }

  // Notify subscribers: invoice.paid fans out to registered webhooks and the
  // Stripe extension's link-deactivation handler. Best-effort: the payment is
  // already committed, so an emit failure must not fail the operation.
  try {
    await eventBus.emit({
      type: 'invoice.paid',
      payload: {
        invoice: {
          ...invoice,
          status: newStatus,
          paid_amount: newPaidAmount,
          remaining_amount: newRemaining,
          paid_at: newStatus === 'paid' ? now : invoice.paid_at,
        } as Invoice,
        companyId,
        userId,
        paymentAmount: paymentAmountInInvoiceCurrency,
        paymentDate,
      },
    })
  } catch {
    // Swallowed by design; the DB state is the source of truth.
  }

  return {
    ok: true,
    newStatus,
    newPaidAmount,
    newRemaining,
    journalEntryId,
    paidAt: newStatus === 'paid' ? now : null,
  }
}
