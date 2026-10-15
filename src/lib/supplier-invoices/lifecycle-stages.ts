import type { SupabaseClient } from '@supabase/supabase-js'
import { deriveStage, type InvoiceLifecycle, type OpenPaymentInstruction } from './stages'
import { isOpenPaymentOrder, OPEN_PAYMENT_ORDER_CANDIDATE_STATUSES } from '@/lib/payments/orders/status'

/**
 * Derive the lifecycle stage of every supplier invoice of a company (or a
 * subset) from what the ledger already knows: status and approved_at on the
 * invoice, membership in an open payment batch or an open bank payment order,
 * the bank row that paid it, and the account sign-off that covers that row.
 * One read wave, no writes.
 */

interface InvoiceRow {
  id: string
  status: string
  approved_at: string | null
  is_credit_note: boolean
}

interface BatchItemRow {
  supplier_invoice_id: string
  batch: { id: string; status: string; created_at: string } | null
}

interface OrderRow {
  id: string
  supplier_invoice_id: string
  status: string
  created_at: string
  supplier_invoice_payment_id: string | null
}

interface TxRow {
  id: string
  supplier_invoice_id: string
  date: string
  cash_account_id: string | null
}

interface SignoffRow {
  account_key: string
  through_date: string
}

const IN_CHUNK = 150

async function inChunks<T>(ids: string[], run: (chunk: string[]) => Promise<T[]>): Promise<T[]> {
  const out: T[] = []
  for (let i = 0; i < ids.length; i += IN_CHUNK) {
    out.push(...(await run(ids.slice(i, i + IN_CHUNK))))
  }
  return out
}

/**
 * The open payment instructions covering these invoices, keyed by invoice id
 * (invoices nothing covers are left out). The one reading of "in payment":
 * the lifecycle stage, the supplier invoice list and its Att betala queue all
 * come from here.
 *
 * A payment file is open while its batch is 'created' (the only other status
 * is 'cancelled'). A bank payment order is open by isOpenPaymentOrder: not
 * failed, rejected or cancelled, and an executed one only until its debit is
 * matched, the same rule the database uses to refuse a second order or a file
 * for the invoice. Reads by invoice id, so the rows read are bounded by the
 * invoices asked about.
 */
export async function loadOpenPaymentInstructions(
  supabase: SupabaseClient,
  companyId: string,
  invoiceIds: string[],
): Promise<Map<string, OpenPaymentInstruction>> {
  const ids = [...new Set(invoiceIds)]
  const out = new Map<string, OpenPaymentInstruction>()
  if (ids.length === 0) return out
  const entry = (id: string): OpenPaymentInstruction => {
    let current = out.get(id)
    if (!current) {
      current = { batch: null, payment_order: null }
      out.set(id, current)
    }
    return current
  }

  const items = await inChunks(ids, async (chunk) => {
    const { data, error } = await supabase
      .from('supplier_payment_batch_items')
      .select('supplier_invoice_id, batch:supplier_payment_batches!inner(id, status, created_at)')
      .eq('company_id', companyId)
      .in('supplier_invoice_id', chunk)
    if (error) throw error
    return (data ?? []) as unknown as BatchItemRow[]
  })
  for (const item of items) {
    if (item.batch?.status !== 'created') continue
    const current = entry(item.supplier_invoice_id)
    // The newest open file when an invoice sits in several.
    if (!current.batch || item.batch.created_at > current.batch.created_at) {
      current.batch = { id: item.batch.id, created_at: item.batch.created_at }
    }
  }

  const orders = await inChunks(ids, async (chunk) => {
    const { data, error } = await supabase
      .from('payment_orders')
      .select('id, supplier_invoice_id, status, created_at, supplier_invoice_payment_id')
      .eq('company_id', companyId)
      .in('supplier_invoice_id', chunk)
      .in('status', OPEN_PAYMENT_ORDER_CANDIDATE_STATUSES)
    if (error) throw error
    return (data ?? []) as OrderRow[]
  })
  for (const order of orders) {
    if (!isOpenPaymentOrder(order)) continue
    entry(order.supplier_invoice_id).payment_order = { id: order.id, status: order.status, created_at: order.created_at }
  }
  return out
}

export async function computeSupplierInvoiceLifecycle(
  supabase: SupabaseClient,
  companyId: string,
  invoiceIds?: string[],
): Promise<Record<string, InvoiceLifecycle>> {
  let invoiceQuery = supabase
    .from('supplier_invoices')
    .select('id, status, approved_at, is_credit_note')
    .eq('company_id', companyId)
  if (invoiceIds && invoiceIds.length > 0) invoiceQuery = invoiceQuery.in('id', invoiceIds.slice(0, IN_CHUNK))
  const { data: invoiceData, error: invoiceError } = await invoiceQuery
  if (invoiceError) throw invoiceError
  const invoices = (invoiceData ?? []) as InvoiceRow[]
  if (invoices.length === 0) return {}

  // Open files and open bank payment orders. A paid invoice still in an old
  // file reads as paid regardless (deriveStage); an order only counts while
  // the invoice is unpaid: an executed order counts until its debit is
  // matched to the invoice.
  const open = await loadOpenPaymentInstructions(supabase, companyId, invoices.map((i) => i.id))

  // Paying bank rows, then the sign-offs that cover them.
  const paidIds = invoices.filter((i) => i.status === 'paid').map((i) => i.id)
  const txByInvoice = new Map<string, TxRow[]>()
  const signoffByAccount = new Map<string, string>()
  if (paidIds.length > 0) {
    const txs = await inChunks(paidIds, async (chunk) => {
      const { data, error } = await supabase
        .from('transactions')
        .select('id, supplier_invoice_id, date, cash_account_id')
        .eq('company_id', companyId)
        .in('supplier_invoice_id', chunk)
      if (error) throw error
      return (data ?? []) as TxRow[]
    })
    for (const tx of txs) {
      const list = txByInvoice.get(tx.supplier_invoice_id) ?? []
      list.push(tx)
      txByInvoice.set(tx.supplier_invoice_id, list)
    }
    if (txs.length > 0) {
      const { data: signoffs, error: signoffError } = await supabase
        .from('account_reconciliations')
        .select('account_key, through_date')
        .eq('company_id', companyId)
        .is('reopened_at', null)
      if (signoffError) throw signoffError
      for (const s of (signoffs ?? []) as SignoffRow[]) {
        const prev = signoffByAccount.get(s.account_key)
        if (!prev || s.through_date > prev) signoffByAccount.set(s.account_key, s.through_date)
      }
    }
  }

  const result: Record<string, InvoiceLifecycle> = {}
  for (const inv of invoices) {
    const batch = open.get(inv.id)?.batch ?? null
    const order = inv.status !== 'paid' ? (open.get(inv.id)?.payment_order ?? null) : null
    const txs = txByInvoice.get(inv.id) ?? []
    // Latest paying row decides the paid date; every row must be signed off
    // for the invoice to count as reconciled.
    const latest = txs.reduce<TxRow | null>((a, b) => (!a || b.date > a.date ? b : a), null)
    let reconciledThrough: string | null = null
    if (txs.length > 0) {
      const covered = txs.map((tx) => {
        if (!tx.cash_account_id) return null
        const through = signoffByAccount.get(`bank:${tx.cash_account_id}`)
        return through && through >= tx.date ? through : null
      })
      if (covered.every((c) => c !== null)) {
        reconciledThrough = covered.reduce<string>((a, b) => (b! < a ? b! : a), covered[0]!)
      }
    }
    result[inv.id] = {
      stage: deriveStage({
        status: inv.status,
        approved_at: inv.approved_at,
        is_credit_note: inv.is_credit_note,
        in_open_batch: batch !== null || order !== null,
        reconciled: reconciledThrough !== null,
      }),
      approved_at: inv.approved_at,
      batch,
      payment_order: order,
      paid: latest ? { transaction_id: latest.id, date: latest.date } : null,
      reconciled_through: reconciledThrough,
    }
  }
  return result
}
