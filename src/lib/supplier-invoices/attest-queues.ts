/**
 * The two queues the attest policy puts a company's supplier invoices in, as
 * the one who pays sees them: waiting for attest (the client has not said
 * yes) and ready to pay (attested, still owed, not already at the bank). One
 * definition for every surface that counts them: the Att göra row "Betala N
 * attesterade fakturor" (lib/worklist attested_to_pay) and the byrå client
 * list's two columns (lib/clients/fetch-client-overview.ts), so the byrå and
 * the client company can never disagree on a number.
 *
 * Only invoices the policy governs are in a queue (invoiceNeedsAttest: the
 * policy is on, the company keeps faktureringsmetoden, not a credit note, at
 * or above the threshold). A company without a policy has no queues at all:
 * there an approval is one click by whoever pays, nobody else waits on it.
 *
 * Waiting is what can still be attested (canApproveSupplierInvoice, the
 * attest service's own rule: not attested, registered or overdue). Ready is
 * an attested invoice the payment file would still pay
 * (PAYABLE_SUPPLIER_INVOICE_STATUSES, a part-paid one included) with money
 * left on it, minus what is no longer the payer's to do: a supplier that
 * debits the invoice itself (auto_debit, crm#1463) and an invoice with an
 * open bank payment (isOpenPaymentOrder, the Att betala tab's rule,
 * crm#1243). A payment file keeps the invoice ready: a generated file may
 * never have reached the bank.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { chunk } from '@/lib/utils'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { PAYABLE_SUPPLIER_INVOICE_STATUSES } from '@/lib/payments/batch-eligibility'
import { isOpenPaymentOrder, OPEN_PAYMENT_ORDER_CANDIDATE_STATUSES } from '@/lib/payments/orders/status'
import { invoiceNeedsAttest, type AttestInvoiceFacts, type AttestPolicy } from './attest-policy'
import { toPolicy, type PolicyRow } from './attest-policy-read'
import { canApproveSupplierInvoice, companyAttestsSupplierInvoices, isOverduePayable } from './lifecycle'

export type AttestQueueKind = 'waiting' | 'ready'

/** One queue: how many, the nearest due date, and how many of them have fallen due. */
export interface AttestQueue {
  count: number
  /** The earliest due date in the queue (ISO yyyy-MM-dd); null when empty. */
  next_due: string | null
  /** How many have passed their due date (isOverduePayable). */
  overdue: number
}

export interface AttestQueues {
  waiting: AttestQueue
  ready: AttestQueue
}

/** The invoice facts the queues read. */
export type AttestQueueInvoice = AttestInvoiceFacts & {
  id: string
  company_id: string
  status: string
  approved_at: string | null
  due_date: string
  remaining_amount: number
  auto_debit?: boolean | null
}

/** "Nothing left to pay", as lifecycle.ts and the payment paths read it. */
const FULLY_PAID_EPSILON = 0.005

const PAYABLE: ReadonlySet<string> = new Set(PAYABLE_SUPPLIER_INVOICE_STATUSES)

/**
 * The queue an invoice sits in, or null. `leftOut` = an open bank payment
 * covers it (isOpenPaymentOrder), or the caller leaves it to another row.
 */
export function attestQueueOf(
  policy: AttestPolicy,
  accountingMethod: string | null | undefined,
  invoice: AttestQueueInvoice,
  leftOut: boolean,
): AttestQueueKind | null {
  if (!invoiceNeedsAttest(policy, accountingMethod, invoice)) return null
  if (invoice.remaining_amount <= FULLY_PAID_EPSILON) return null
  if (!invoice.approved_at) return canApproveSupplierInvoice(invoice) ? 'waiting' : null
  if (!PAYABLE.has(invoice.status)) return null
  if (invoice.auto_debit || leftOut) return null
  return 'ready'
}

export const EMPTY_ATTEST_QUEUE: AttestQueue = Object.freeze({ count: 0, next_due: null, overdue: 0 })

function addToQueue(queue: AttestQueue, invoice: AttestQueueInvoice, today: string): AttestQueue {
  return {
    count: queue.count + 1,
    next_due: queue.next_due === null || invoice.due_date < queue.next_due ? invoice.due_date : queue.next_due,
    overdue: queue.overdue + (isOverduePayable(invoice, today) ? 1 : 0),
  }
}

/** Max ids per PostgREST .in() filter (mirrors lib/worklist IN_CLAUSE_CHUNK). */
const IN_CLAUSE_CHUNK = 150

interface OrderRow {
  id: string
  supplier_invoice_id: string
  status: string
  supplier_invoice_payment_id: string | null
}

export interface LoadAttestQueuesOptions {
  /**
   * Invoice ids another row already shows, left out of ready: the Att göra
   * list passes what its payment_failed row lists ("Betalningen gick inte
   * igenom"), so one payment is one row there. Read only when some attested
   * invoice could be ready. The byrå client list passes nothing: there a
   * failed payment is simply still to pay.
   */
  leaveOut?: () => Promise<ReadonlySet<string>>
}

/**
 * The .in() lists of one payment order read: its company ids and invoice ids
 * together stay at IN_CLAUSE_CHUNK, the ceiling that keeps the request line
 * under the gateway's 8 KB (about 200 ids already got a 414 in prod,
 * lib/suggestion-log/receipts.ts). One company's invoices may span reads.
 */
export function paymentOrderReadChunks(
  invoiceIdsByCompany: ReadonlyMap<string, readonly string[]>,
  cap: number = IN_CLAUSE_CHUNK,
): Array<{ companyIds: string[]; invoiceIds: string[] }> {
  const reads: Array<{ companyIds: string[]; invoiceIds: string[] }> = []
  let current = { companyIds: [] as string[], invoiceIds: [] as string[] }
  const used = () => current.companyIds.length + current.invoiceIds.length
  for (const [companyId, ids] of invoiceIdsByCompany) {
    let rest = [...ids]
    while (rest.length > 0) {
      // Room for this company's id and at least one invoice id, else a new read.
      if (cap - used() < 2) {
        reads.push(current)
        current = { companyIds: [], invoiceIds: [] }
      }
      const take = rest.slice(0, cap - used() - 1)
      current.companyIds.push(companyId)
      current.invoiceIds.push(...take)
      rest = rest.slice(take.length)
    }
  }
  if (used() > 0) reads.push(current)
  return reads
}

/**
 * The attest queues of each of `companyIds` whose attest policy is on and
 * that keep faktureringsmetoden; a company missing from the map has no
 * attest step (no policy, policy off, or kontantmetoden). Grouped reads
 * across all the companies: the policies, the accounting methods, the
 * invoices still owed, and the bank payments of the attested ones. The
 * caller owns authorization: every id is read as-is. Throws on a failed
 * read; each surface decides how it degrades.
 */
export async function loadAttestQueues(
  supabase: SupabaseClient,
  companyIds: readonly string[],
  today: string,
  options: LoadAttestQueuesOptions = {},
): Promise<Map<string, AttestQueues>> {
  const result = new Map<string, AttestQueues>()
  const ids = [...new Set(companyIds)]
  if (ids.length === 0) return result

  const policies = new Map<string, AttestPolicy>()
  for (const part of chunk(ids, IN_CLAUSE_CHUNK)) {
    const { data, error } = await supabase
      .from('company_attest_policies')
      .select('company_id, enabled, threshold_amount, mode, attesters, preparer_may_attest, two_step_from_sek, updated_by, updated_at')
      .in('company_id', part)
      .eq('enabled', true)
    if (error) throw error
    for (const row of (data ?? []) as PolicyRow[]) policies.set(row.company_id, toPolicy(row))
  }
  if (policies.size === 0) return result

  const methods = new Map<string, string | null>()
  for (const part of chunk([...policies.keys()], IN_CLAUSE_CHUNK)) {
    const { data, error } = await supabase.from('company_settings').select('company_id, accounting_method').in('company_id', part)
    if (error) throw error
    for (const row of (data ?? []) as Array<{ company_id: string; accounting_method: string | null }>) {
      methods.set(row.company_id, row.accounting_method)
    }
  }
  // Kontantmetoden has no attest step: no queues, as if there were no policy.
  const governed = [...policies.keys()].filter((id) => companyAttestsSupplierInvoices(methods.get(id) ?? null))
  if (governed.length === 0) return result

  const invoices: AttestQueueInvoice[] = []
  for (const part of chunk(governed, IN_CLAUSE_CHUNK)) {
    const rows = await fetchAllRows<AttestQueueInvoice>(({ from, to }) =>
      supabase
        .from('supplier_invoices')
        .select('id, company_id, user_id, status, approved_at, due_date, remaining_amount, auto_debit, is_credit_note, currency, total, total_sek, exchange_rate')
        .in('company_id', part)
        .in('status', [...PAYABLE_SUPPLIER_INVOICE_STATUSES])
        .eq('is_credit_note', false)
        .order('id', { ascending: true })
        .range(from, to),
    )
    invoices.push(...rows.map((r) => ({ ...r, total: Number(r.total), remaining_amount: Number(r.remaining_amount) })))
  }

  // The attested ones may already be at the bank: their open payment
  // orders, read across the companies in as few reads as the URL allows,
  // each paged (fetchAllRows: PostgREST caps a read at 1000 rows).
  const attestedByCompany = new Map<string, string[]>()
  for (const invoice of invoices) {
    if (invoice.approved_at) attestedByCompany.set(invoice.company_id, [...(attestedByCompany.get(invoice.company_id) ?? []), invoice.id])
  }
  const inBankPayment = new Set<string>()
  for (const read of paymentOrderReadChunks(attestedByCompany)) {
    const orders = await fetchAllRows<OrderRow>(({ from, to }) =>
      supabase
        .from('payment_orders')
        .select('id, supplier_invoice_id, status, supplier_invoice_payment_id')
        .in('company_id', read.companyIds)
        .in('supplier_invoice_id', read.invoiceIds)
        .in('status', [...OPEN_PAYMENT_ORDER_CANDIDATE_STATUSES])
        .order('id', { ascending: true })
        .range(from, to),
    )
    for (const order of orders) {
      if (isOpenPaymentOrder(order)) inBankPayment.add(order.supplier_invoice_id)
    }
  }
  const shownElsewhere = attestedByCompany.size > 0 && options.leaveOut ? await options.leaveOut() : new Set<string>()
  const leftOut = (invoiceId: string) => inBankPayment.has(invoiceId) || shownElsewhere.has(invoiceId)

  for (const companyId of governed) result.set(companyId, { waiting: EMPTY_ATTEST_QUEUE, ready: EMPTY_ATTEST_QUEUE })
  for (const invoice of invoices) {
    const queues = result.get(invoice.company_id)
    const policy = policies.get(invoice.company_id)
    if (!queues || !policy) continue
    const kind = attestQueueOf(policy, methods.get(invoice.company_id) ?? null, invoice, leftOut(invoice.id))
    if (kind) result.set(invoice.company_id, { ...queues, [kind]: addToQueue(queues[kind], invoice, today) })
  }
  return result
}
