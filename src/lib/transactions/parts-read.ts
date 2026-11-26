/**
 * Reading the Bankgirot split of a bank row for the doors: the session route
 * GET /api/transactions/[id]/parts, the v1 transaction detail and the MCP
 * uncategorized list. One shape everywhere: each part with the open invoice
 * ingest suggested for it (number, counterparty, what is left to pay), so a
 * reader can prefill the batch allocation without a second lookup.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { isMatchableInvoiceStatus, isMatchableSupplierInvoiceStatus } from '@/lib/bookkeeping/matchable-statuses'
import { ID_READ_CHUNK } from '@/lib/supabase/read-in-slices'
import { chunk } from '@/lib/utils'
import type { BankTransactionPart } from '@/types'

export interface TransactionPartSuggestedInvoice {
  kind: 'customer_invoice' | 'supplier_invoice'
  /** invoices.id or supplier_invoices.id, by `kind`. */
  invoice_id: string
  invoice_number: string | null
  counterparty_name: string | null
  remaining_amount: number
  currency: string
}

export interface TransactionPartView {
  part_id: string
  seq: number
  amount: number
  currency: string
  counterparty_name: string | null
  counterparty_org_number: string | null
  counterparty_account: string | null
  reference: string | null
  invoice_numbers: string[]
  message: string | null
  suggestion_reason: BankTransactionPart['suggestion_reason']
  /** The open invoice ingest suggested; null when none, or when it is no longer open. */
  suggested_invoice: TransactionPartSuggestedInvoice | null
}

/** One allocation of the batch allocation (MatchBatchSchema), as a split prefills it. */
export type BatchAllocationPrefill =
  | { kind: 'customer_invoice'; invoice_id: string; amount: number }
  | { kind: 'supplier_invoice'; supplier_invoice_id: string; amount: number }

/** What GET /api/transactions/[id]/parts answers. */
export interface TransactionPartsResponse {
  parts: TransactionPartView[]
  /**
   * The batch allocation the split asks for, when ingest marked the row a
   * complete split (potential_match_method = 'bankgiro_split') and every
   * suggested invoice is still open; null otherwise, and the person fills
   * the allocation part by part.
   */
  batch_suggestion: { allocations: BatchAllocationPrefill[] } | null
}

type StoredPart = Pick<BankTransactionPart, 'amount' | 'suggested_invoice_id' | 'suggested_supplier_invoice_id'>

/**
 * The allocations a complete split asks for, ready for match_batch_allocate:
 * one per part, each with its suggested invoice and the part's amount. Null
 * unless every part has a suggestion of one kind (an incomplete split is
 * filled in by a person, part by part).
 */
export function batchAllocationsFromParts(parts: readonly StoredPart[]): BatchAllocationPrefill[] | null {
  if (parts.length === 0) return null
  const allocations: BatchAllocationPrefill[] = []
  for (const part of parts) {
    const amount = Math.abs(Number(part.amount))
    if (part.suggested_invoice_id) allocations.push({ kind: 'customer_invoice', invoice_id: part.suggested_invoice_id, amount })
    else if (part.suggested_supplier_invoice_id) allocations.push({ kind: 'supplier_invoice', supplier_invoice_id: part.suggested_supplier_invoice_id, amount })
    else return null
  }
  const kinds = new Set(allocations.map((a) => a.kind))
  return kinds.size === 1 ? allocations : null
}

interface CustomerInvoiceSummary {
  id: string
  invoice_number: string | null
  remaining_amount: number | string | null
  currency: string | null
  status: string | null
  customer: { name?: string | null } | null
}

interface SupplierInvoiceSummary {
  id: string
  supplier_invoice_number: string | null
  arrival_number: number | null
  remaining_amount: number | string | null
  currency: string | null
  status: string | null
  supplier: { name?: string | null } | null
}

/**
 * The row's parts in the bank's order with their suggested invoices. Empty
 * for a row without a split. Throws on a refused read.
 */
export async function readTransactionParts(
  supabase: SupabaseClient,
  companyId: string,
  transactionId: string,
): Promise<TransactionPartView[]> {
  const { data, error } = await supabase
    .from('bank_transaction_parts')
    .select('*')
    .eq('company_id', companyId)
    .eq('transaction_id', transactionId)
    .order('seq', { ascending: true })
  if (error) throw error
  const parts = (data ?? []) as BankTransactionPart[]
  if (parts.length === 0) return []

  const invoiceIds = parts.flatMap((p) => (p.suggested_invoice_id ? [p.suggested_invoice_id] : []))
  const supplierInvoiceIds = parts.flatMap((p) => (p.suggested_supplier_invoice_id ? [p.suggested_supplier_invoice_id] : []))

  // In slices of ID_READ_CHUNK: a BgMax deposit or an Autogiro settle day
  // has one part per payment, with no cap, and the ids travel in the GET
  // query string, which the gateway refuses past its limit. Reads by
  // primary key: a slice answers at most ID_READ_CHUNK rows.
  const invoices = new Map<string, TransactionPartSuggestedInvoice>()
  for (const ids of chunk(invoiceIds, ID_READ_CHUNK)) {
    const { data: rows, error: invoiceError } = await supabase
      .from('invoices')
      .select('id, invoice_number, remaining_amount, currency, status, customer:customers(name)')
      .eq('company_id', companyId)
      .in('id', ids)
    if (invoiceError) throw invoiceError
    for (const row of (rows ?? []) as unknown as CustomerInvoiceSummary[]) {
      const remaining = Number(row.remaining_amount ?? 0)
      if (!isMatchableInvoiceStatus(row.status) || remaining <= 0) continue
      invoices.set(row.id, {
        kind: 'customer_invoice',
        invoice_id: row.id,
        invoice_number: row.invoice_number,
        counterparty_name: row.customer?.name ?? null,
        remaining_amount: remaining,
        currency: row.currency ?? 'SEK',
      })
    }
  }
  for (const ids of chunk(supplierInvoiceIds, ID_READ_CHUNK)) {
    const { data: rows, error: supplierError } = await supabase
      .from('supplier_invoices')
      .select('id, supplier_invoice_number, arrival_number, remaining_amount, currency, status, supplier:suppliers(name)')
      .eq('company_id', companyId)
      .in('id', ids)
    if (supplierError) throw supplierError
    for (const row of (rows ?? []) as unknown as SupplierInvoiceSummary[]) {
      const remaining = Number(row.remaining_amount ?? 0)
      if (!isMatchableSupplierInvoiceStatus(row.status) || remaining <= 0) continue
      invoices.set(row.id, {
        kind: 'supplier_invoice',
        invoice_id: row.id,
        invoice_number: row.supplier_invoice_number ?? (row.arrival_number != null ? `LF-${row.arrival_number}` : null),
        counterparty_name: row.supplier?.name ?? null,
        remaining_amount: remaining,
        currency: row.currency ?? 'SEK',
      })
    }
  }

  return parts.map((part) => {
    const suggested = invoices.get(part.suggested_invoice_id ?? part.suggested_supplier_invoice_id ?? '') ?? null
    return {
      part_id: part.id,
      seq: part.seq,
      amount: Number(part.amount),
      currency: part.currency,
      counterparty_name: part.counterparty_name,
      counterparty_org_number: part.counterparty_org_number,
      counterparty_account: part.counterparty_account,
      reference: part.reference,
      invoice_numbers: part.invoice_numbers ?? [],
      message: part.message,
      suggestion_reason: suggested ? part.suggestion_reason : null,
      suggested_invoice: suggested,
    }
  })
}
