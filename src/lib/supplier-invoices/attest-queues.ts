/**
 * The two queues the attest policy puts a company's supplier invoices in, as
 * the one who pays sees them, for the companies a policy governs (the policy
 * on, faktureringsmetoden): waiting for attest (the policy holds it back,
 * paymentWaitsForAttest, and it can still be attested,
 * canApproveSupplierInvoice) and ready to pay (everything else that waits to
 * be paid, lib/supplier-invoices/to-pay.ts: attested, or below the policy's
 * threshold). The byrå client list's two columns count them
 * (lib/clients/fetch-client-overview.ts) and the client's Att göra Betala row
 * counts the same ready invoices (loadToPayQueue), less the ones Att göra
 * shows under a failed payment instead. A company without a policy has no
 * queues: there an approval is one click by whoever pays, nobody waits on it.
 *
 * What a company has to pay, policy or not, is loadToPayQueue below: the
 * invoices that wait to be paid, the Att göra Betala row, the Att betala tab
 * and status=to_pay alike.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { chunk } from '@/lib/utils'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { PAYABLE_SUPPLIER_INVOICE_STATUSES } from '@/lib/payments/batch-eligibility'
import { isOpenPaymentOrder, OPEN_PAYMENT_ORDER_CANDIDATE_STATUSES } from '@/lib/payments/orders/status'
import { paymentWaitsForAttest, type AttestInvoiceFacts, type AttestPolicy } from './attest-policy'
import { loadAttestPolicy, toPolicy, type PolicyRow } from './attest-policy-read'
import { canApproveSupplierInvoice, companyAttestsSupplierInvoices, FULLY_PAID_EPSILON, isOverduePayable } from './lifecycle'
import { bankEnteredHolds } from './stages'
import { waitsToBePaid } from './to-pay'

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
  // Only a company the policy governs has queues: the policy on, faktureringsmetoden.
  if (!policy.enabled || !companyAttestsSupplierInvoices(accountingMethod)) return null
  // Held back by the policy: waiting for attest while it can still be given.
  if (paymentWaitsForAttest(policy, accountingMethod, invoice)) {
    return invoice.remaining_amount > FULLY_PAID_EPSILON && canApproveSupplierInvoice(invoice) ? 'waiting' : null
  }
  // Everything else is ready exactly when it waits to be paid, the invoices
  // below the threshold included: the Att göra Betala row and the Att betala
  // tab count the same (lib/supplier-invoices/to-pay.ts).
  return waitsToBePaid(invoice, { atTheBank: leftOut, waitsForAttest: false }) ? 'ready' : null
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
   * igenom"), so one payment is one row there. Read only when some invoice
   * could be ready. The byrå client list passes nothing: there a failed
   * payment is simply still to pay.
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
 * invoices still owed, and the bank payments of the ones the policy does
 * not hold. The caller owns authorization: every id is read as-is. Throws
 * on a failed read; each surface decides how it degrades.
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

  // What the policy does not hold back could be ready, and may already be at the bank.
  const readyCandidates = new Map<string, string[]>()
  for (const invoice of invoices) {
    const policy = policies.get(invoice.company_id)
    if (!policy || paymentWaitsForAttest(policy, methods.get(invoice.company_id) ?? null, invoice)) continue
    readyCandidates.set(invoice.company_id, [...(readyCandidates.get(invoice.company_id) ?? []), invoice.id])
  }
  const inBankPayment = await readInBankPayment(supabase, readyCandidates)
  const shownElsewhere = readyCandidates.size > 0 && options.leaveOut ? await options.leaveOut() : new Set<string>()
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

/** What one company's payer has to pay. */
export interface ToPayQueue {
  queue: AttestQueue
}

/**
 * The supplier invoices one company has to pay, as the Att göra Betala row
 * counts them: every invoice that waits to be paid (lib/supplier-invoices/to-pay.ts
 * waitsToBePaid), the one population the Att betala tab and status=to_pay
 * read too. Under an attest policy that is what its attest does not hold
 * back, the invoices below its threshold included; elsewhere an invoice not
 * attested yet waits to be paid as well, as the payment file pays it
 * (crm#1631 counted only attested ones, and the tab it opens showed more).
 * Less what another row shows (options.leaveOut: the payment_failed row), so
 * one payment is one row. Throws on a failed read, like loadAttestQueues.
 */
export async function loadToPayQueue(
  supabase: SupabaseClient,
  companyId: string,
  today: string,
  options: LoadAttestQueuesOptions = {},
): Promise<ToPayQueue> {
  const [{ data: settings, error }, policy] = await Promise.all([
    supabase.from('company_settings').select('accounting_method').eq('company_id', companyId).maybeSingle(),
    loadAttestPolicy(supabase, companyId, today),
  ])
  if (error) throw error
  const accountingMethod = (settings as { accounting_method?: string | null } | null)?.accounting_method ?? null
  const waitsForAttest = (invoice: AttestQueueInvoice) => paymentWaitsForAttest(policy, accountingMethod, invoice)

  // Before the bank and the other rows are asked: what nothing but the bank could still take out.
  const candidates = (await readOwedInvoices(supabase, [companyId])).filter(
    (invoice) =>
      invoice.company_id === companyId &&
      waitsToBePaid(invoice, { atTheBank: bankEnteredHolds(invoice, today), waitsForAttest: waitsForAttest(invoice) }),
  )
  if (candidates.length === 0) return { queue: EMPTY_ATTEST_QUEUE }
  const inBankPayment = await readInBankPayment(supabase, new Map([[companyId, candidates.map((c) => c.id)]]))
  const shownElsewhere = options.leaveOut ? await options.leaveOut() : new Set<string>()

  let queue = EMPTY_ATTEST_QUEUE
  for (const invoice of candidates) {
    if (inBankPayment.has(invoice.id) || shownElsewhere.has(invoice.id)) continue
    queue = addToQueue(queue, invoice, today)
  }
  return { queue }
}
