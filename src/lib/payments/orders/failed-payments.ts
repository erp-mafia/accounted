/**
 * Bank payments the bank did not carry out: rejected (it refused the
 * payment, often days after the signing) or failed (it refused the
 * instruction, or the payment failed there). Both are final; nothing at the
 * bank pays them any more.
 *
 * Open Payments has no payment webhooks. A final status arrives by polling:
 * while a person watches the signing (the signing poll, the follow-up after
 * BankID) or later in the status sync, when nobody is looking. Two surfaces
 * tell the company, so a missed supplier payment is not first found when the
 * supplier chases it (accounted#143):
 *
 * - the Att göra row "Betalningen till {mottagare} gick inte igenom", derived
 *   here on every read (listInvoicesAfterFailedPayment), nothing written;
 * - the mail to the people behind the payment (outcome-notify.ts), once.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { PaymentFailedDue } from '@/lib/worklist/types'
import { PAYABLE_SUPPLIER_INVOICE_STATUSES } from '../batch-eligibility'
import type { PaymentOrderStatus } from './status'

export const FAILED_PAYMENT_ORDER_STATUSES = ['rejected', 'failed'] as const satisfies readonly PaymentOrderStatus[]

/**
 * How many failed orders one read considers, newest first. Ids travel in the
 * GET query string of the reads after it (150 is the worklist's ceiling for
 * an .in() filter); a company with more than this many failed payments of
 * unpaid invoices has a problem the first rows already show.
 */
const SCAN_CAP = 100

interface FailedOrderRow {
  id: string
  supplier_invoice_id: string
  status: (typeof FAILED_PAYMENT_ORDER_STATUSES)[number]
  amount: number | string
  currency: string
  payee_name: string
  provider_error_code: string | null
  provider_status_at: string | null
  created_at: string
}

/**
 * Supplier invoices whose newest bank payment the bank rejected or that
 * failed, and that still need paying (lib/worklist payment_failed), most
 * pressing due date first.
 *
 * An invoice counts while its newest payment order (by created_at) ended
 * rejected or failed and the invoice is still payable
 * (PAYABLE_SUPPLIER_INVOICE_STATUSES, the betalfil's own rule). It leaves when a
 * person makes a new payment of it (any newer order, a cancelled one too: a
 * person acted), or when the invoice is paid, credited or settled any other
 * way. Supplier invoices only: a skattekonto payment that did not go through
 * is back in "Betala in till Skatteverket" already (a rejected order covers no
 * charge, skattekonto-underway.ts), and a salary payment is made again from
 * its run; their people get the mail.
 *
 * Throws on a failed read; the worklist soft-fails it.
 */
export async function listInvoicesAfterFailedPayment(supabase: SupabaseClient, companyId: string): Promise<PaymentFailedDue[]> {
  const { data: failedData, error: failedError } = await supabase
    .from('payment_orders')
    .select('id, supplier_invoice_id, status, amount, currency, payee_name, provider_error_code, provider_status_at, created_at')
    .eq('company_id', companyId)
    .eq('purpose', 'supplier_invoice')
    .in('status', [...FAILED_PAYMENT_ORDER_STATUSES])
    .not('supplier_invoice_id', 'is', null)
    .order('created_at', { ascending: false })
    .limit(SCAN_CAP)
  if (failedError) throw failedError
  // The newest failed order of each invoice; older ones are history.
  const latestFailed = new Map<string, FailedOrderRow>()
  for (const row of (failedData ?? []) as FailedOrderRow[]) {
    if (!latestFailed.has(row.supplier_invoice_id)) latestFailed.set(row.supplier_invoice_id, row)
  }
  if (latestFailed.size === 0) return []
  const invoiceIds = [...latestFailed.keys()]

  const [orders, invoices] = await Promise.all([
    supabase.from('payment_orders').select('id, supplier_invoice_id, created_at').eq('company_id', companyId).in('supplier_invoice_id', invoiceIds),
    supabase
      .from('supplier_invoices')
      .select('id, status, supplier_invoice_number, arrival_number, due_date')
      .eq('company_id', companyId)
      .in('id', invoiceIds),
  ])
  if (orders.error) throw orders.error
  if (invoices.error) throw invoices.error

  const newestCreated = new Map<string, number>()
  for (const row of (orders.data ?? []) as Array<{ supplier_invoice_id: string; created_at: string }>) {
    const at = Date.parse(row.created_at)
    if (at > (newestCreated.get(row.supplier_invoice_id) ?? -Infinity)) newestCreated.set(row.supplier_invoice_id, at)
  }
  const payable: ReadonlySet<string> = new Set(PAYABLE_SUPPLIER_INVOICE_STATUSES)
  const due: PaymentFailedDue[] = []
  for (const invoice of (invoices.data ?? []) as Array<{
    id: string
    status: string
    supplier_invoice_number: string | null
    arrival_number: number | null
    due_date: string | null
  }>) {
    const failed = latestFailed.get(invoice.id)
    if (!failed || !payable.has(invoice.status)) continue
    // A newer order of the invoice is a new attempt, whatever became of it.
    if ((newestCreated.get(invoice.id) ?? -Infinity) > Date.parse(failed.created_at)) continue
    due.push({
      payment_order_id: failed.id,
      supplier_invoice_id: invoice.id,
      payee_name: failed.payee_name,
      supplier_invoice_number: invoice.supplier_invoice_number,
      arrival_number: invoice.arrival_number,
      due_date: invoice.due_date,
      amount: Number(failed.amount),
      currency: failed.currency,
      status: failed.status,
      reason_code: failed.provider_error_code,
      ended_at: failed.provider_status_at,
    })
  }
  return due.sort((a, b) => (a.due_date ?? '9999').localeCompare(b.due_date ?? '9999') || a.payment_order_id.localeCompare(b.payment_order_id))
}
