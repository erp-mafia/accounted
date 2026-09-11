import type { SupabaseClient } from '@supabase/supabase-js'
import { deriveStage, type InvoiceLifecycle } from './stages'

/**
 * Derive the lifecycle stage of every supplier invoice of a company (or a
 * subset) from what the ledger already knows: status and approved_at on the
 * invoice, membership in an open payment batch, the bank row that paid it,
 * and the account sign-off that covers that row. One read wave, no writes.
 */

interface InvoiceRow {
  id: string
  status: string
  approved_at: string | null
  is_credit_note: boolean
}

interface BatchRow {
  id: string
  created_at: string
}

interface BatchItemRow {
  batch_id: string
  supplier_invoice_id: string
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

  // Open batches: created, not cancelled. A batch stays "open" until its
  // invoices are paid; a paid invoice reads as paid regardless (deriveStage).
  const { data: batchData, error: batchError } = await supabase
    .from('supplier_payment_batches')
    .select('id, created_at')
    .eq('company_id', companyId)
    .eq('status', 'created')
  if (batchError) throw batchError
  const batches = new Map((batchData ?? []).map((b) => [(b as BatchRow).id, b as BatchRow]))

  const batchByInvoice = new Map<string, BatchRow>()
  if (batches.size > 0) {
    const items = await inChunks([...batches.keys()], async (chunk) => {
      const { data, error } = await supabase
        .from('supplier_payment_batch_items')
        .select('batch_id, supplier_invoice_id')
        .eq('company_id', companyId)
        .in('batch_id', chunk)
      if (error) throw error
      return (data ?? []) as BatchItemRow[]
    })
    for (const item of items) {
      const batch = batches.get(item.batch_id)
      if (batch) batchByInvoice.set(item.supplier_invoice_id, batch)
    }
  }

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
    const batch = batchByInvoice.get(inv.id) ?? null
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
        in_open_batch: batch !== null,
        reconciled: reconciledThrough !== null,
      }),
      approved_at: inv.approved_at,
      batch: batch ? { id: batch.id, created_at: batch.created_at } : null,
      paid: latest ? { transaction_id: latest.id, date: latest.date } : null,
      reconciled_through: reconciledThrough,
    }
  }
  return result
}
