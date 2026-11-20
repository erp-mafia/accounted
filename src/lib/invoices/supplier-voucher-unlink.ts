/**
 * Undo a link between a supplier invoice and an existing verifikat.
 *
 * linkSupplierInvoiceToVoucher (supplier-voucher-matching.ts) marks an invoice
 * paid by pointing a supplier_invoice_payments row at a verifikat that is
 * already in the books. This takes exactly that row back: the row is deleted
 * and the invoice gets its amount back. The verifikat is right and is never
 * touched, so a storno is the wrong tool for a wrong link.
 *
 * Every rule lives in unlink_supplier_invoice_from_voucher (migration
 * 20261112100000): which rows are a plain link, what is refused and what
 * follows the row (a settled bank payment order, the invoice tag on the
 * verifikat's bank row). Nothing here decides; the RPC is the authority.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { createLogger } from '@/lib/logger'
import { isLedgerCurrency } from '@/lib/bookkeeping/currency-utils'
import { isPaymentSourceType } from '@/lib/bookkeeping/payment-sync'

const log = createLogger('supplier-voucher-unlink')

export type SupplierVoucherUnlinkErrorCode =
  | 'UNLINK_SI_VOUCHER_NOT_FOUND'
  | 'UNLINK_SI_VOUCHER_NOT_A_LINK'
  | 'UNLINK_SI_VOUCHER_PAYMENT_VOUCHER'
  | 'UNLINK_SI_VOUCHER_SETOFF'
  | 'UNLINK_SI_VOUCHER_SETTLEMENT_EVIDENCE'
  | 'UNLINK_SI_VOUCHER_FOREIGN_CURRENCY'
  | 'UNLINK_SI_VOUCHER_INVOICE_NOT_SETTLED'
  | 'UNLINK_SI_VOUCHER_CUTOFF_ALREADY_POSTED'
  | 'UNLINK_SI_VOUCHER_DB_ERROR'

export interface UnlinkSupplierInvoiceFromVoucherResult {
  paymentId: string
  journalEntryId: string
  unlinkedAmount: number
  invoiceStatus: 'partially_paid' | 'overdue' | 'approved' | 'registered'
  paidAmount: number
  remainingAmount: number
  /** The invoice's own document sits on the verifikat and stays there: a
   *  document on a posted verifikat is never moved (BFL 5 kap 6 §). */
  documentOnVoucher: boolean
}

interface RpcUnlinkOk {
  ok: true
  payment_id: string
  journal_entry_id: string
  unlinked_amount: number
  invoice_status: UnlinkSupplierInvoiceFromVoucherResult['invoiceStatus']
  paid_amount: number
  remaining_amount: number
  document_on_voucher?: boolean
}

interface RpcUnlinkErr {
  ok: false
  code: SupplierVoucherUnlinkErrorCode
  details?: Record<string, unknown>
}

export async function unlinkSupplierInvoiceFromVoucher(
  supabase: SupabaseClient,
  userId: string,
  companyId: string,
  params: { supplierInvoiceId: string; paymentId: string },
): Promise<
  | { ok: true; result: UnlinkSupplierInvoiceFromVoucherResult }
  | { ok: false; code: SupplierVoucherUnlinkErrorCode; details?: Record<string, unknown> }
> {
  const { data, error } = await supabase.rpc('unlink_supplier_invoice_from_voucher', {
    p_company_id: companyId,
    p_user_id: userId,
    p_supplier_invoice_id: params.supplierInvoiceId,
    p_payment_id: params.paymentId,
  })

  if (error) {
    log.error('unlink_supplier_invoice_from_voucher RPC error', {
      companyId,
      userId,
      supplierInvoiceId: params.supplierInvoiceId,
      paymentId: params.paymentId,
      message: error.message,
    })
    return { ok: false, code: 'UNLINK_SI_VOUCHER_DB_ERROR', details: { reason: error.message } }
  }

  const result = data as RpcUnlinkOk | RpcUnlinkErr | null
  if (!result) {
    return { ok: false, code: 'UNLINK_SI_VOUCHER_DB_ERROR', details: { reason: 'empty RPC response' } }
  }
  if (!result.ok) {
    return { ok: false, code: result.code, details: result.details }
  }

  log.info('supplier invoice unlinked from verifikat', {
    companyId,
    userId,
    supplierInvoiceId: params.supplierInvoiceId,
    paymentId: result.payment_id,
    journalEntryId: result.journal_entry_id,
    invoiceStatus: result.invoice_status,
  })

  return {
    ok: true,
    result: {
      paymentId: result.payment_id,
      journalEntryId: result.journal_entry_id,
      unlinkedAmount: Number(result.unlinked_amount),
      invoiceStatus: result.invoice_status,
      paidAmount: Number(result.paid_amount),
      remainingAmount: Number(result.remaining_amount),
      documentOnVoucher: result.document_on_voucher === true,
    },
  }
}

/** The columns of a payment row and its invoice the hint below reads. */
export interface UnlinkablePaymentRow {
  id: string
  journal_entry_id: string | null
  transaction_id: string | null
  notes: string | null
  currency: string | null
  payment_exchange_rate?: number | string | null
}

/**
 * Which of an invoice's payment rows the detail page offers "Koppla bort" on:
 * the rows the RPC would take as a plain link, judged on what a read can see.
 * A hint for the UI only. The RPC decides, under its locks, and also refuses
 * what is not visible here (a kvittning's set-off row, a posted kontantmetod
 * cut-off), with a message that says why.
 */
export async function unlinkablePaymentIds(
  supabase: SupabaseClient,
  companyId: string,
  invoice: { status: string; currency: string | null; payment_journal_entry_id: string | null },
  payments: UnlinkablePaymentRow[],
): Promise<string[]> {
  if (invoice.status !== 'paid' && invoice.status !== 'partially_paid') return []
  if (!isLedgerCurrency(invoice.currency)) return []

  const candidates = payments.filter(
    (p) =>
      p.transaction_id === null &&
      p.journal_entry_id !== null &&
      p.journal_entry_id !== invoice.payment_journal_entry_id &&
      isLedgerCurrency(p.currency) &&
      p.payment_exchange_rate == null &&
      !(p.notes ?? '').startsWith('settlement-evidence'),
  )
  if (candidates.length === 0) return []

  const { data, error } = await supabase
    .from('journal_entries')
    .select('id, source_type')
    .eq('company_id', companyId)
    .in('id', [...new Set(candidates.map((p) => p.journal_entry_id as string))])
  if (error) {
    // No hint is better than a wrong one: the action is simply not offered.
    log.warn('could not read the vouchers of payment rows; no unlink is offered', {
      companyId,
      reason: error.message,
    })
    return []
  }

  const sourceTypes = new Map(
    ((data ?? []) as Array<{ id: string; source_type: string | null }>).map((e) => [e.id, e.source_type]),
  )
  return candidates
    .filter((p) => {
      const entryId = p.journal_entry_id as string
      if (!sourceTypes.has(entryId)) return false
      const sourceType = sourceTypes.get(entryId)
      return !isPaymentSourceType(sourceType) && sourceType !== 'expense_claim' && sourceType !== 'counterparty_setoff'
    })
    .map((p) => p.id)
}
