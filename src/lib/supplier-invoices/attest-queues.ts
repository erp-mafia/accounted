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
 * crm#1243), and one a person ticked "Inlagd i banken" that has not fallen
 * due (bankEnteredHolds, the same tab's rule, crm#1824). A payment file keeps
 * the invoice ready: a generated file may never have reached the bank.
 *
 * A company without queues still has invoices to pay: loadToPayQueue counts
 * them with the same ready rule (isToPayWithoutAttest), so the Att göra
 * Betala row is one definition whether the company attests or not (crm#1631).
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { chunk } from '@/lib/utils'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { PAYABLE_SUPPLIER_INVOICE_STATUSES } from '@/lib/payments/batch-eligibility'
import { isOpenPaymentOrder, OPEN_PAYMENT_ORDER_CANDIDATE_STATUSES } from '@/lib/payments/orders/status'
import { invoiceNeedsAttest, type AttestInvoiceFacts, type AttestPolicy } from './attest-policy'
import { toPolicy, type PolicyRow } from './attest-policy-read'
import { canApproveSupplierInvoice, companyAttestsSupplierInvoices, isOverduePayable } from './lifecycle'
import { bankEnteredHolds } from './stages'

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
  /** The "Inlagd i banken" tick; it keeps the invoice out of ready until it falls due (bankEnteredHolds). */
  bank_entered_at?: string | null
}

/** "Nothing left to pay", as lifecycle.ts and the payment paths read it. */
const FULLY_PAID_EPSILON = 0.005

const PAYABLE: ReadonlySet<string> = new Set(PAYABLE_SUPPLIER_INVOICE_STATUSES)

/**
 * Ready to pay once nothing waits on attest: the payment file would still pay
 * it, money is left on it, the supplier does not debit it itself, and
 * `leftOut` is false (no open bank payment covers it, isOpenPaymentOrder, and
 * no other row shows it). The one tail of every to-pay count here.
 */
function isReadyToPay(invoice: AttestQueueInvoice, leftOut: boolean): boolean {
  if (invoice.remaining_amount <= FULLY_PAID_EPSILON) return false
  if (!PAYABLE.has(invoice.status)) return false
  return !invoice.auto_debit && !leftOut
}

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
  return isReadyToPay(invoice, leftOut) ? 'ready' : null
}

/**
 * True when an invoice of a company the attest policy does not govern (no
 * policy, the policy off, or kontantmetoden) waits to be paid: the ready
 * rule above, over every invoice whose approval is done or not part of the
 * method. Kontantmetoden has no approval step, so a registered invoice is
 * ready as it stands; faktureringsmetoden approves with one click
 * (approved_at), and an invoice not approved yet is the approval row's
 * (lib/worklist supplier_invoice_approval), not this one's (crm#1631).
 */
export function isToPayWithoutAttest(
  accountingMethod: string | null | undefined,
  invoice: AttestQueueInvoice,
  leftOut: boolean,
): boolean {
  if (invoice.is_credit_note) return false
  if (companyAttestsSupplierInvoices(accountingMethod) && !invoice.approved_at) return false
  return isReadyToPay(invoice, leftOut)
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

  const invoices = await readOwedInvoices(supabase, governed)

  // The attested ones may already be at the bank.
  const attestedByCompany = new Map<string, string[]>()
  for (const invoice of invoices) {
    if (invoice.approved_at) attestedByCompany.set(invoice.company_id, [...(attestedByCompany.get(invoice.company_id) ?? []), invoice.id])
  }
  const inBankPayment = await readInBankPayment(supabase, attestedByCompany)
  const shownElsewhere = attestedByCompany.size > 0 && options.leaveOut ? await options.leaveOut() : new Set<string>()
  const leftOut = (invoice: AttestQueueInvoice) =>
    inBankPayment.has(invoice.id) || shownElsewhere.has(invoice.id) || bankEnteredHolds(invoice, today)

  for (const companyId of governed) result.set(companyId, { waiting: EMPTY_ATTEST_QUEUE, ready: EMPTY_ATTEST_QUEUE })
  for (const invoice of invoices) {
    const queues = result.get(invoice.company_id)
    const policy = policies.get(invoice.company_id)
    if (!queues || !policy) continue
    const kind = attestQueueOf(policy, methods.get(invoice.company_id) ?? null, invoice, leftOut(invoice))
    if (kind) result.set(invoice.company_id, { ...queues, [kind]: addToQueue(queues[kind], invoice, today) })
  }
  return result
}

/** The invoices still owed at `companyIds` that a payment could pay: payable status, not a credit note. */
async function readOwedInvoices(supabase: SupabaseClient, companyIds: readonly string[]): Promise<AttestQueueInvoice[]> {
  const invoices: AttestQueueInvoice[] = []
  for (const part of chunk([...companyIds], IN_CLAUSE_CHUNK)) {
    const rows = await fetchAllRows<AttestQueueInvoice>(({ from, to }) =>
      supabase
        .from('supplier_invoices')
        .select('id, company_id, user_id, status, approved_at, due_date, remaining_amount, auto_debit, bank_entered_at, is_credit_note, currency, total, total_sek, exchange_rate')
        .in('company_id', part)
        .in('status', [...PAYABLE_SUPPLIER_INVOICE_STATUSES])
        .eq('is_credit_note', false)
        .order('id', { ascending: true })
        .range(from, to),
    )
    invoices.push(...rows.map((r) => ({ ...r, total: Number(r.total), remaining_amount: Number(r.remaining_amount) })))
  }
  return invoices
}

/**
 * Which of the invoices have an open bank payment: their open payment
 * orders, read across the companies in as few reads as the URL allows, each
 * paged (fetchAllRows: PostgREST caps a read at 1000 rows).
 */
async function readInBankPayment(
  supabase: SupabaseClient,
  invoiceIdsByCompany: ReadonlyMap<string, readonly string[]>,
): Promise<Set<string>> {
  const inBankPayment = new Set<string>()
  for (const read of paymentOrderReadChunks(invoiceIdsByCompany)) {
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
  return inBankPayment
}

/** What one company's payer has to pay, and whether the attest policy put it there. */
export interface ToPayQueue {
  /** True when the attest policy governs the company: the queue is its attested invoices. */
  attested: boolean
  queue: AttestQueue
}

/**
 * The supplier invoices one company has to pay, as the Att göra Betala row
 * counts them. Where the attest policy governs the company it is the ready
 * queue above (attested: true, "Betala N attesterade fakturor"). Everywhere
 * else, kontantmetoden included, it is every invoice isToPayWithoutAttest
 * admits (attested: false, "Betala N leverantörsfakturor"): before this, a
 * company without an attest queue had no row for an unpaid invoice, even
 * past its due date (crm#1631). Throws on a failed read, like
 * loadAttestQueues.
 */
export async function loadToPayQueue(
  supabase: SupabaseClient,
  companyId: string,
  today: string,
  options: LoadAttestQueuesOptions = {},
): Promise<ToPayQueue> {
  const governed = (await loadAttestQueues(supabase, [companyId], today, options)).get(companyId)
  if (governed) return { attested: true, queue: governed.ready }

  const { data: settings, error } = await supabase
    .from('company_settings')
    .select('accounting_method')
    .eq('company_id', companyId)
    .maybeSingle()
  if (error) throw error
  const accountingMethod = (settings as { accounting_method?: string | null } | null)?.accounting_method ?? null

  // Approval done or not part of the method, before the bank and the other rows are asked.
  const candidates = (await readOwedInvoices(supabase, [companyId])).filter(
    (invoice) => invoice.company_id === companyId && isToPayWithoutAttest(accountingMethod, invoice, false),
  )
  if (candidates.length === 0) return { attested: false, queue: EMPTY_ATTEST_QUEUE }
  const inBankPayment = await readInBankPayment(supabase, new Map([[companyId, candidates.map((c) => c.id)]]))
  const shownElsewhere = options.leaveOut ? await options.leaveOut() : new Set<string>()

  let queue = EMPTY_ATTEST_QUEUE
  for (const invoice of candidates) {
    const leftOut = inBankPayment.has(invoice.id) || shownElsewhere.has(invoice.id) || bankEnteredHolds(invoice, today)
    if (isToPayWithoutAttest(accountingMethod, invoice, leftOut)) queue = addToQueue(queue, invoice, today)
  }
  return { attested: false, queue }
}
