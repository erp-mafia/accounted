import type { SupabaseClient } from '@supabase/supabase-js'
import { runBankCheck, type BankCheckResult } from '@/lib/collections/bank-check'
import type { ReminderContext } from './facts'

/**
 * The collections bank check for a reminder: has the account the customer
 * pays to synced within 24 hours, and does it show an unbooked payment that
 * could be this invoice's (OCR, invoice number, customer and amount)? The
 * daily batch asks it when gathering and the send asks it again.
 */
export function checkReminderBank(
  db: SupabaseClient,
  ctx: Pick<ReminderContext, 'invoice' | 'customer' | 'facts'>,
  input: { companyId: string; today: string; now: Date },
): Promise<BankCheckResult> {
  return runBankCheck(db, {
    companyId: input.companyId,
    invoice: {
      id: ctx.invoice.id,
      invoice_number: ctx.invoice.invoice_number,
      invoice_date: ctx.invoice.invoice_date,
      currency: ctx.invoice.currency,
      payment_cash_account_id: ctx.invoice.payment_cash_account_id ?? null,
    },
    customerName: ctx.customer?.name ?? null,
    remaining: ctx.facts.remaining,
    dismissedTransactionIds: [],
    today: input.today,
    now: input.now,
  })
}
