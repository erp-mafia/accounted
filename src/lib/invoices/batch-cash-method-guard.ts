import type { SupabaseClient } from '@supabase/supabase-js'
import { ID_READ_CHUNK } from '@/lib/reconciliation/limits'
import { chunk } from '@/lib/utils'
import { checkAccountingMethod } from '@/lib/company/accounting-method'
import { buildInvoiceCashLines } from '@/lib/bookkeeping/invoice-lines'
import { resolveCompanyEntityType } from '@/lib/company/entity-type'
import { isLedgerCurrency } from '@/lib/bookkeeping/currency-utils'
import { ORE_ROUNDING_SETTLEMENT_MAX, equalOre, isZeroOre, roundOre } from '@/lib/money'
import type { EntityType, Invoice } from '@/types'

// One unbooked supplier invoice paid by the whole row: the single bank match (PH 243).
export { settleSingleSupplierPayment, type SupplierAllocation } from '@/lib/invoices/batch-cash-single-supplier'

/**
 * Kontantmetoden guard for the samlingsbetalning / batch allocation
 * (match_batch_allocate RPC).
 *
 * The RPC settles every allocation as a pure clearing entry: customer
 * invoices are credited to 1510, supplier invoices debited to 2440. That is
 * correct only when the invoice already sits on the ledger (booked at issue
 * or registration). Under kontantmetoden nothing is booked at issue: revenue
 * + utgående moms (or cost + ingående moms) are recognised at PAYMENT. A
 * batch over such invoices therefore books the bank movement against an
 * empty 1510/2440 and the sale or purchase, with its moms, never reaches the
 * ledger at all.
 *
 * The per-invoice paths book these through the generated cash entries
 * (createInvoiceCashEntry / the supplier cash entry). Customer invoices in
 * SEK paid in full are booked by the batch too (crm#1539): each one's part
 * of the samlingsverifikat is that same generated entry without its bank
 * leg (planBatchCashLines below, the RPC's p_cash_lines), so the RPC grows
 * no second kontantmetoden booking implementation. What that entry cannot
 * carry (supplier invoices, a mix with booked invoices, a foreign currency,
 * an installment) still refuses and routes to the per-invoice paths.
 *
 * The test mirrors the single-invoice routes: the invoice's own booking
 * state decides, not only the company setting. An invoice booked at issue
 * before a switch to kontantmetoden still has a receivable/payable to clear,
 * so the batch stays allowed for it.
 */

export interface BatchAllocationRef {
  kind: 'customer_invoice' | 'supplier_invoice'
  invoice_id?: string | null
  supplier_invoice_id?: string | null
}

export interface CashMethodUnbookedInvoice {
  kind: 'customer_invoice' | 'supplier_invoice'
  id: string
  invoice_number: string | null
}

export type CashMethodBatchCheck =
  | { ok: true; unbooked: CashMethodUnbookedInvoice[] }
  | { ok: false; error: unknown }

export async function findCashMethodUnbookedAllocations(
  supabase: SupabaseClient,
  companyId: string,
  allocations: readonly BatchAllocationRef[],
): Promise<CashMethodBatchCheck> {
  // Fail closed (accounted#58): a failed read or a missing row refuses the
  // batch instead of reading as faktureringsmetoden.
  const method = checkAccountingMethod(
    await supabase
      .from('company_settings')
      .select('accounting_method')
      .eq('company_id', companyId)
      .maybeSingle(),
  )
  if (!method.ok) return { ok: false, error: method.error }
  if (method.accountingMethod !== 'cash') return { ok: true, unbooked: [] }

  const customerIds = Array.from(
    new Set(
      allocations.flatMap((a) =>
        a.kind === 'customer_invoice' && a.invoice_id ? [a.invoice_id] : [],
      ),
    ),
  )
  const supplierIds = Array.from(
    new Set(
      allocations.flatMap((a) =>
        a.kind === 'supplier_invoice' && a.supplier_invoice_id ? [a.supplier_invoice_id] : [],
      ),
    ),
  )

  const unbooked: CashMethodUnbookedInvoice[] = []

  // Read in slices: a full batch of ids in one `.in()` overruns the gateway's
  // URL limit (lib/reconciliation/limits.ts).
  for (const part of chunk(customerIds, ID_READ_CHUNK)) {
    const { data, error } = await supabase
      .from('invoices')
      .select('id, invoice_number, journal_entry_id')
      .in('id', part)
      .eq('company_id', companyId)
    if (error) return { ok: false, error }
    for (const row of (data ?? []) as {
      id: string
      invoice_number: string | null
      journal_entry_id: string | null
    }[]) {
      if (!row.journal_entry_id) {
        unbooked.push({ kind: 'customer_invoice', id: row.id, invoice_number: row.invoice_number })
      }
    }
  }

  for (const part of chunk(supplierIds, ID_READ_CHUNK)) {
    const { data, error } = await supabase
      .from('supplier_invoices')
      .select('id, supplier_invoice_number, registration_journal_entry_id')
      .in('id', part)
      .eq('company_id', companyId)
    if (error) return { ok: false, error }
    for (const row of (data ?? []) as {
      id: string
      supplier_invoice_number: string | null
      registration_journal_entry_id: string | null
    }[]) {
      if (!row.registration_journal_entry_id) {
        unbooked.push({
          kind: 'supplier_invoice',
          id: row.id,
          invoice_number: row.supplier_invoice_number,
        })
      }
    }
  }

  return { ok: true, unbooked }
}

/**
 * Kontantmetoden in a samlingsbetalning (crm#1539): one bank row that pays
 * several customer invoices which have no verifikat yet.
 *
 * Under kontantmetoden the sale is booked at payment, so there is no 1510 for
 * match_batch_allocate to clear. Each invoice's part of the samlingsverifikat
 * is instead exactly what the single-invoice cash match books
 * (buildInvoiceCashLines, the one builder for that entry): försäljning and
 * utgående moms per rate, the customer's share only on a ROT/RUT invoice
 * (bokslutsmetoden's first step, Skatteverket's share waits for its payout),
 * and a sub-krona gap to what arrived on 3740. Its bank leg is left off: the
 * RPC books one bank leg for the whole row. What is left credits, net, the
 * allocation's amount, which the RPC checks per invoice (p_cash_lines,
 * migration 20261031100700).
 *
 * Planned only for what that entry can carry: every allocation a customer
 * invoice with no verifikat (never a mix with booked invoices: the verifikat
 * takes one source type), SEK on a SEK row (öresavrundning is a whole-krona
 * rule; a foreign invoice settles with a kursdiff the batch cannot see
 * here), nothing paid before and the allocation within a krona of what is
 * owed (the whole-payment entry; installments are the single match's
 * pro-rata rule). Anything else keeps the refusal, with the reason.
 */

/** One revenue, moms or öresavrundning line, as match_batch_allocate's p_cash_lines takes it. */
export interface BatchCashLine {
  account_number: string
  debit_amount: number
  credit_amount: number
  line_description?: string
  dimensions?: Record<string, string>
}

export type BatchCashUnsupported =
  | 'supplier_invoice'
  | 'mixed_with_booked'
  | 'foreign_currency'
  | 'partial_payment'
  | 'customer_share_mismatch'

export type BatchCashPlan =
  | { ok: true; cashLines: Record<string, BatchCashLine[]> }
  | { ok: false; unsupported: BatchCashUnsupported; invoiceId?: string }
  | { ok: false; error: unknown }

export interface BatchCashAllocation {
  kind: 'customer_invoice' | 'supplier_invoice'
  invoice_id?: string | null
  supplier_invoice_id?: string | null
  amount: number
}

type CashInvoiceRow = Pick<
  Invoice,
  | 'id'
  | 'invoice_number'
  | 'currency'
  | 'exchange_rate'
  | 'vat_treatment'
  | 'delivery_country'
  | 'subtotal'
  | 'subtotal_sek'
  | 'vat_amount'
  | 'vat_amount_sek'
  | 'total'
  | 'total_sek'
  | 'items'
  | 'default_dimensions'
  | 'deduction_total'
  | 'paid_amount'
  | 'remaining_amount'
>

/**
 * The p_cash_lines of a pure function: what the RPC books for each
 * allocation, from the invoice rows. Exported for the tests and the preview.
 */
export function buildBatchCashLines(
  allocations: readonly BatchCashAllocation[],
  invoices: ReadonlyMap<string, CashInvoiceRow>,
  transactionCurrency: string | null,
  entityType: EntityType,
): Exclude<BatchCashPlan, { ok: false; error: unknown }> {
  const cashLines: Record<string, BatchCashLine[]> = {}
  for (const allocation of allocations) {
    if (allocation.kind !== 'customer_invoice' || !allocation.invoice_id) {
      return { ok: false, unsupported: 'supplier_invoice' }
    }
    const invoiceId = allocation.invoice_id
    const invoice = invoices.get(invoiceId)
    if (!invoice) return { ok: false, unsupported: 'mixed_with_booked', invoiceId }
    if (!isLedgerCurrency(invoice.currency) || !isLedgerCurrency(transactionCurrency)) {
      return { ok: false, unsupported: 'foreign_currency', invoiceId }
    }
    const remaining = roundOre(invoice.remaining_amount ?? invoice.total)
    if (!isZeroOre(invoice.paid_amount ?? 0) || Math.abs(roundOre(remaining - allocation.amount)) >= ORE_ROUNDING_SETTLEMENT_MAX) {
      return { ok: false, unsupported: 'partial_payment', invoiceId }
    }

    const amount = roundOre(allocation.amount)
    const { lines } = buildInvoiceCashLines(invoice, entityType, undefined, BANK_LEG_MARKER, amount, undefined, {
      deferDeductionShare: true,
    })
    const bankLeg = lines.filter((line) => line.account_number === BANK_LEG_MARKER)
    const rest = lines.filter((line) => line.account_number !== BANK_LEG_MARKER)
    // The builder takes what arrived on its bank leg when the customer share
    // (from the items) is within a krona of it; when the share it derives
    // disagrees with the stored remaining_amount it books the share, and the
    // invoice cannot settle on this row.
    if (bankLeg.length !== 1 || !equalOre(bankLeg[0]!.debit_amount, amount) || bankLeg[0]!.credit_amount !== 0) {
      return { ok: false, unsupported: 'customer_share_mismatch', invoiceId }
    }
    cashLines[invoiceId] = rest.map((line) => ({
      account_number: line.account_number,
      debit_amount: roundOre(line.debit_amount),
      credit_amount: roundOre(line.credit_amount),
      ...(line.line_description ? { line_description: line.line_description } : {}),
      ...(line.dimensions && Object.keys(line.dimensions).length > 0 ? { dimensions: line.dimensions } : {}),
    }))
  }
  return { ok: true, cashLines }
}

/**
 * A placeholder account for the bank leg the builder adds and this plan
 * drops (the RPC books the real one on the row's settlement account). Not a
 * BAS account, so it can never be mistaken for a revenue or moms line.
 */
const BANK_LEG_MARKER = 'BANK'

/**
 * Plan the cash lines for a batch the kontantmetoden guard flagged
 * (findCashMethodUnbookedAllocations): reads the invoices with their items
 * and the company's entity type, then buildBatchCashLines.
 */
export async function planBatchCashLines(
  supabase: SupabaseClient,
  companyId: string,
  transactionId: string,
  allocations: readonly BatchCashAllocation[],
  unbooked: readonly CashMethodUnbookedInvoice[],
): Promise<BatchCashPlan> {
  if (unbooked.some((u) => u.kind === 'supplier_invoice')) return { ok: false, unsupported: 'supplier_invoice' }
  const unbookedIds = new Set(unbooked.map((u) => u.id))
  const booked = allocations.find((a) => a.kind !== 'customer_invoice' || !a.invoice_id || !unbookedIds.has(a.invoice_id))
  if (booked) {
    return booked.kind === 'customer_invoice'
      ? { ok: false, unsupported: 'mixed_with_booked', invoiceId: booked.invoice_id ?? undefined }
      : { ok: false, unsupported: 'supplier_invoice' }
  }

  const { data: txRow, error: txError } = await supabase
    .from('transactions')
    .select('currency')
    .eq('id', transactionId)
    .eq('company_id', companyId)
    .maybeSingle()
  if (txError) return { ok: false, error: txError }
  // A missing row is the RPC's refusal (BATCH_TX_NOT_FOUND): plan nothing.
  if (!txRow) return { ok: true, cashLines: {} }

  const invoices = new Map<string, CashInvoiceRow>()
  for (const part of chunk([...unbookedIds], ID_READ_CHUNK)) {
    const { data, error } = await supabase
      .from('invoices')
      .select(
        'id, invoice_number, currency, exchange_rate, vat_treatment, delivery_country, subtotal, subtotal_sek, vat_amount, vat_amount_sek, total, total_sek, default_dimensions, deduction_total, paid_amount, remaining_amount, items:invoice_items(*)',
      )
      .in('id', part)
      .eq('company_id', companyId)
    if (error) return { ok: false, error }
    for (const row of (data ?? []) as CashInvoiceRow[]) invoices.set(row.id, row)
  }

  let entityType: EntityType
  try {
    entityType = await resolveCompanyEntityType(supabase, companyId)
  } catch (error) {
    return { ok: false, error }
  }
  return buildBatchCashLines(allocations, invoices, (txRow as { currency: string | null }).currency, entityType)
}
