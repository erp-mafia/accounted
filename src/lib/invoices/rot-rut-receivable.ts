/**
 * What a begäran's invoices actually carry on 1513, so a fully paid payout can
 * clear the receivable to the öre.
 *
 * The invoice debits 1513 with öre (the per-item deduction), the begäran asks
 * Skatteverket for whole kronor (BegartBelopp is truncated, rot-rut-file.ts),
 * and Skatteverket pays exactly that. Without the öre remainder the payout
 * voucher leaves up to 0,99 kr per invoice on 1513 forever.
 *
 * The receivable per invoice is the net 1513 amount on that invoice's own
 * live vouchers: the invoice voucher (fakturametoden) and its payment vouchers
 * (kontantmetoden debits 1513 at payment). A remainder is attributable only
 * when it is exactly what truncation leaves: 0 <= receivable - requested < 1
 * kr for every invoice. Anything else (a reversed or missing voucher, a voucher
 * shared with another invoice, a credited invoice, a difference of a krona or
 * more) is not rounding, and the caller books the payout without it.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { ORE_ROUNDING_SETTLEMENT_MAX, roundOre } from '@/lib/money'
import { ROT_RUT_RECEIVABLE_ACCOUNT } from '@/lib/invoices/apply-invoice-payment'

export interface InvoiceReceivable {
  invoiceId: string
  requested: number
  receivable: number
  /** receivable - requested: the öre truncation left on 1513. */
  rounding: number
}

export type RequestReceivable =
  | {
      attributable: true
      invoices: InvoiceReceivable[]
      /** Sum of the invoices' 1513 receivable. */
      receivable: number
      /** Sum of the per-invoice remainders; 0 for whole-kronor invoices. */
      rounding: number
    }
  | { attributable: false; reason: string }

function notAttributable(reason: string): RequestReceivable {
  return { attributable: false, reason }
}

export async function getRequestReceivable(
  supabase: SupabaseClient,
  companyId: string,
  requestId: string,
): Promise<RequestReceivable> {
  const { data: items, error: itemsError } = await supabase
    .from('rot_rut_payout_request_items')
    .select('invoice_id, requested_amount')
    .eq('request_id', requestId)
  if (itemsError) return notAttributable('items query failed')
  const itemRows = (items ?? []) as Array<{ invoice_id: string; requested_amount: number | string }>
  if (itemRows.length === 0) return notAttributable('no items')
  const invoiceIds = itemRows.map((item) => item.invoice_id)

  const [invoicesResult, paymentsResult] = await Promise.all([
    supabase
      .from('invoices')
      .select('id, journal_entry_id')
      .eq('company_id', companyId)
      .in('id', invoiceIds),
    supabase
      .from('invoice_payments')
      .select('invoice_id, journal_entry_id')
      .in('invoice_id', invoiceIds)
      .not('journal_entry_id', 'is', null),
  ])
  if (invoicesResult.error || paymentsResult.error) return notAttributable('invoice query failed')
  const invoiceRows = (invoicesResult.data ?? []) as Array<{ id: string; journal_entry_id: string | null }>
  if (invoiceRows.length !== new Set(invoiceIds).size) return notAttributable('invoice not found')

  // Every voucher each invoice owns, deduplicated (a kontantmetod invoice can
  // point at its own payment voucher).
  const vouchersByInvoice = new Map<string, Set<string>>(invoiceIds.map((id) => [id, new Set<string>()]))
  for (const invoice of invoiceRows) {
    if (invoice.journal_entry_id) vouchersByInvoice.get(invoice.id)!.add(invoice.journal_entry_id)
  }
  for (const payment of (paymentsResult.data ?? []) as Array<{ invoice_id: string; journal_entry_id: string }>) {
    vouchersByInvoice.get(payment.invoice_id)?.add(payment.journal_entry_id)
  }

  // A voucher shared by two invoices (a batch payment) carries 1513 lines that
  // cannot be told apart per invoice: nothing is attributable then.
  const owner = new Map<string, string>()
  for (const [invoiceId, vouchers] of vouchersByInvoice) {
    for (const voucherId of vouchers) {
      if (owner.has(voucherId) && owner.get(voucherId) !== invoiceId) {
        return notAttributable('voucher shared between invoices')
      }
      owner.set(voucherId, invoiceId)
    }
  }
  if (owner.size === 0) return notAttributable('no vouchers')

  const voucherIds = [...owner.keys()]
  const { data: entries, error: entriesError } = await supabase
    .from('journal_entries')
    .select('id, status, reversed_by_id')
    .eq('company_id', companyId)
    .in('id', voucherIds)
  if (entriesError) return notAttributable('voucher query failed')
  const live = new Set(
    ((entries ?? []) as Array<{ id: string; status: string; reversed_by_id: string | null }>)
      .filter((entry) => entry.status === 'posted' && !entry.reversed_by_id)
      .map((entry) => entry.id),
  )

  const receivableByInvoice = new Map<string, number>(invoiceIds.map((id) => [id, 0]))
  if (live.size > 0) {
    const { data: lines, error: linesError } = await supabase
      .from('journal_entry_lines')
      .select('journal_entry_id, debit_amount, credit_amount')
      .in('journal_entry_id', [...live])
      .eq('account_number', ROT_RUT_RECEIVABLE_ACCOUNT)
    if (linesError) return notAttributable('line query failed')
    for (const line of (lines ?? []) as Array<{
      journal_entry_id: string
      debit_amount: number | string | null
      credit_amount: number | string | null
    }>) {
      const invoiceId = owner.get(line.journal_entry_id)
      if (!invoiceId) continue
      receivableByInvoice.set(
        invoiceId,
        receivableByInvoice.get(invoiceId)! + Number(line.debit_amount ?? 0) - Number(line.credit_amount ?? 0),
      )
    }
  }

  const perInvoice: InvoiceReceivable[] = []
  for (const item of itemRows) {
    const requested = roundOre(Number(item.requested_amount))
    const receivable = roundOre(receivableByInvoice.get(item.invoice_id) ?? 0)
    const rounding = roundOre(receivable - requested)
    // Exactly what truncating to whole kronor leaves, never more.
    if (rounding < 0 || rounding >= ORE_ROUNDING_SETTLEMENT_MAX) {
      return notAttributable('remainder is not öre truncation')
    }
    perInvoice.push({ invoiceId: item.invoice_id, requested, receivable, rounding })
  }

  return {
    attributable: true,
    invoices: perInvoice,
    receivable: roundOre(perInvoice.reduce((sum, inv) => sum + inv.receivable, 0)),
    rounding: roundOre(perInvoice.reduce((sum, inv) => sum + inv.rounding, 0)),
  }
}

export interface PayoutOreRounding {
  rounding: number
  /** Invoices the rounding spans: each contributes under a krona. */
  invoiceCount: number
}

const NO_ROUNDING: PayoutOreRounding = { rounding: 0, invoiceCount: 0 }

/**
 * The öre rounding a fully paid leg books: the request's total remainder when
 * the payout equals the requested kronor and every invoice is attributable,
 * else 0 (the voucher then stays exactly as before).
 */
export async function getPayoutOreRounding(
  supabase: SupabaseClient,
  companyId: string,
  request: { id: string; requested_total: number | string },
  paidAmount: number,
): Promise<PayoutOreRounding> {
  const requestedTotal = roundOre(Number(request.requested_total))
  if (roundOre(paidAmount) !== requestedTotal) return NO_ROUNDING
  const receivable = await getRequestReceivable(supabase, companyId, request.id)
  if (!receivable.attributable) return NO_ROUNDING
  // The items must add up to the header, or the remainder belongs to nothing.
  const itemsTotal = roundOre(receivable.invoices.reduce((sum, inv) => sum + inv.requested, 0))
  if (itemsTotal !== requestedTotal) return NO_ROUNDING
  return { rounding: receivable.rounding, invoiceCount: receivable.invoices.length }
}
