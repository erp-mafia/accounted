/**
 * What the set-off reads: invoices and supplier invoices as SetoffInvoiceFacts
 * and SetoffSupplierInvoiceFacts (./plan.ts), with their customer's and
 * supplier's canonical party, an open collection case on the claim and a
 * payment the bank may still carry out on the debt.
 *
 * Reads the parties table directly (merged_into) rather than lib/parties, so
 * the invoicing block takes no new edge to the parties feature.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { carriedSekOf } from '@/lib/bookkeeping/ledger-carried-sek'
import { isLedgerCurrency } from '@/lib/bookkeeping/currency-utils'
import { isOpenPaymentOrder, OPEN_PAYMENT_ORDER_CANDIDATE_STATUSES } from '@/lib/payments/orders/status'
import type { SetoffInvoiceFacts, SetoffSupplierInvoiceFacts } from './plan'

/** An invoice as the set-off reads it (every select of it here names these columns as a literal, for the phantom-column guard). */
export interface SetoffInvoiceRow {
  id: string
  invoice_number: string | null
  external_invoice_number: string | null
  status: string
  document_type: string | null
  credited_invoice_id: string | null
  currency: string | null
  total: number | string
  remaining_amount: number | string | null
  paid_amount: number | string | null
  deduction_total: number | string | null
  invoice_date: string
  due_date: string | null
  journal_entry_id: string | null
  customer_id: string | null
}

/** A supplier invoice as the set-off reads it (likewise). */
export interface SetoffSupplierInvoiceRow {
  id: string
  supplier_invoice_number: string | null
  arrival_number: number | null
  status: string
  is_credit_note: boolean | null
  currency: string | null
  total: number | string
  remaining_amount: number | string | null
  paid_amount: number | string | null
  invoice_date: string
  due_date: string | null
  registration_journal_entry_id: string | null
  bank_entered_at: string | null
  supplier_id: string | null
}

const num = (value: number | string | null | undefined): number => (value == null ? 0 : Number(value))

/** The longest merged_into chain followed, as canonical_party_id does. */
const MAX_MERGE_HOPS = 16

/**
 * Each party id's canonical party: merged_into followed to the surviving
 * party (canonical_party_id in SQL, migration 20260902210000). Ids that are
 * not the company's parties are left out of the map.
 */
export async function resolveCanonicalParties(
  supabase: SupabaseClient,
  companyId: string,
  partyIds: readonly string[],
): Promise<Map<string, string>> {
  const mergedInto = new Map<string, string | null>()
  let pending = [...new Set(partyIds)]
  for (let hop = 0; hop < MAX_MERGE_HOPS && pending.length > 0; hop++) {
    const { data, error } = await supabase
      .from('parties')
      .select('id, merged_into')
      .eq('company_id', companyId)
      .in('id', pending)
    if (error) throw new Error(`counterparty set-off: party lookup failed: ${error.message}`)
    for (const row of (data ?? []) as Array<{ id: string; merged_into: string | null }>) {
      mergedInto.set(row.id, row.merged_into)
    }
    pending = [...new Set((data ?? []).map((r) => (r as { merged_into: string | null }).merged_into).filter((id): id is string => !!id && !mergedInto.has(id)))]
  }
  const canonical = new Map<string, string>()
  for (const id of new Set(partyIds)) {
    if (!mergedInto.has(id)) continue
    let current = id
    for (let hop = 0; hop < MAX_MERGE_HOPS; hop++) {
      const next = mergedInto.get(current)
      if (!next || !mergedInto.has(next)) break
      current = next
    }
    canonical.set(id, current)
  }
  return canonical
}

/** The invoices among `invoiceIds` with an open collection case. */
export async function openCollectionInvoiceIds(
  supabase: SupabaseClient,
  companyId: string,
  invoiceIds: readonly string[],
): Promise<Set<string>> {
  if (invoiceIds.length === 0) return new Set()
  const { data, error } = await supabase
    .from('collection_cases')
    .select('invoice_id')
    .eq('company_id', companyId)
    .eq('is_open', true)
    .in('invoice_id', [...invoiceIds])
  if (error) throw new Error(`counterparty set-off: collection case lookup failed: ${error.message}`)
  return new Set((data ?? []).map((r) => (r as { invoice_id: string }).invoice_id))
}

/**
 * The supplier invoices among `rows` the bank may still pay in full: entered
 * at the bank, in a payment file that is not cancelled, or in an open payment
 * order (isOpenPaymentOrder). A set-off on top would pay the debt twice.
 */
export async function paymentInFlightSupplierInvoiceIds(
  supabase: SupabaseClient,
  companyId: string,
  rows: ReadonlyArray<Pick<SetoffSupplierInvoiceRow, 'id' | 'bank_entered_at'>>,
): Promise<Set<string>> {
  const inFlight = new Set(rows.filter((r) => r.bank_entered_at).map((r) => r.id))
  const ids = rows.map((r) => r.id)
  if (ids.length === 0) return inFlight

  const [orders, batchItems] = await Promise.all([
    supabase
      .from('payment_orders')
      .select('supplier_invoice_id, status, supplier_invoice_payment_id')
      .eq('company_id', companyId)
      .in('supplier_invoice_id', ids)
      .in('status', [...OPEN_PAYMENT_ORDER_CANDIDATE_STATUSES]),
    supabase
      .from('supplier_payment_batch_items')
      .select('supplier_invoice_id, batch:supplier_payment_batches!inner(status)')
      .eq('company_id', companyId)
      .in('supplier_invoice_id', ids)
      .eq('batch.status', 'created'),
  ])
  if (orders.error) throw new Error(`counterparty set-off: payment order lookup failed: ${orders.error.message}`)
  if (batchItems.error) throw new Error(`counterparty set-off: payment file lookup failed: ${batchItems.error.message}`)
  for (const order of (orders.data ?? []) as Array<{ supplier_invoice_id: string; status: string; supplier_invoice_payment_id: string | null }>) {
    if (isOpenPaymentOrder(order)) inFlight.add(order.supplier_invoice_id)
  }
  for (const item of (batchItems.data ?? []) as Array<{ supplier_invoice_id: string }>) {
    inFlight.add(item.supplier_invoice_id)
  }
  return inFlight
}

export function toSetoffInvoiceFacts(
  row: SetoffInvoiceRow,
  context: { partyId: string | null; collectionOpen: boolean; carriedSek?: number | null },
): SetoffInvoiceFacts {
  return {
    id: row.id,
    number: row.invoice_number ?? row.external_invoice_number ?? null,
    status: row.status,
    documentType: row.document_type,
    creditedInvoiceId: row.credited_invoice_id,
    currency: row.currency,
    total: num(row.total),
    remaining: row.remaining_amount == null ? num(row.total) : num(row.remaining_amount),
    paid: num(row.paid_amount),
    deductionTotal: num(row.deduction_total),
    invoiceDate: row.invoice_date,
    dueDate: row.due_date,
    booked: !!row.journal_entry_id,
    carriedSek: context.carriedSek ?? null,
    partyId: context.partyId,
    collectionOpen: context.collectionOpen,
  }
}

export function toSetoffSupplierInvoiceFacts(
  row: SetoffSupplierInvoiceRow,
  context: { partyId: string | null; paymentInFlight: boolean },
): SetoffSupplierInvoiceFacts {
  return {
    id: row.id,
    number: row.supplier_invoice_number,
    arrivalNumber: row.arrival_number,
    status: row.status,
    isCreditNote: row.is_credit_note === true,
    currency: row.currency,
    total: num(row.total),
    remaining: row.remaining_amount == null ? num(row.total) : num(row.remaining_amount),
    paid: num(row.paid_amount),
    invoiceDate: row.invoice_date,
    dueDate: row.due_date,
    booked: !!row.registration_journal_entry_id,
    partyId: context.partyId,
    paymentInFlight: context.paymentInFlight,
  }
}

export interface SetoffPairState {
  invoice: SetoffInvoiceFacts
  supplierInvoice: SetoffSupplierInvoiceFacts
  customerName: string | null
  supplierName: string | null
}

export type LoadSetoffPairResult =
  | { ok: true; state: SetoffPairState }
  | { ok: false; code: 'SETOFF_INVOICE_NOT_FOUND' | 'SETOFF_SUPPLIER_INVOICE_NOT_FOUND' }

/** The pair a set-off would settle, as the planner reads it. Throws on a failed read. */
export async function loadSetoffPair(
  supabase: SupabaseClient,
  companyId: string,
  invoiceId: string,
  supplierInvoiceId: string,
): Promise<LoadSetoffPairResult> {
  const [invoiceRes, supplierRes] = await Promise.all([
    supabase
      .from('invoices')
      .select(
        'id, invoice_number, external_invoice_number, status, document_type, credited_invoice_id, currency, total, remaining_amount, paid_amount, deduction_total, invoice_date, due_date, journal_entry_id, customer_id, customer:customers(name, party_id)',
      )
      .eq('company_id', companyId)
      .eq('id', invoiceId)
      .maybeSingle(),
    supabase
      .from('supplier_invoices')
      .select(
        'id, supplier_invoice_number, arrival_number, status, is_credit_note, currency, total, remaining_amount, paid_amount, invoice_date, due_date, registration_journal_entry_id, bank_entered_at, supplier_id, supplier:suppliers(name, party_id)',
      )
      .eq('company_id', companyId)
      .eq('id', supplierInvoiceId)
      .maybeSingle(),
  ])
  if (invoiceRes.error) throw new Error(`counterparty set-off: invoice lookup failed: ${invoiceRes.error.message}`)
  if (supplierRes.error) throw new Error(`counterparty set-off: supplier invoice lookup failed: ${supplierRes.error.message}`)
  if (!invoiceRes.data) return { ok: false, code: 'SETOFF_INVOICE_NOT_FOUND' }
  if (!supplierRes.data) return { ok: false, code: 'SETOFF_SUPPLIER_INVOICE_NOT_FOUND' }

  const invoiceRow = invoiceRes.data as unknown as SetoffInvoiceRow & { customer: { name: string | null; party_id: string | null } | null }
  const supplierRow = supplierRes.data as unknown as SetoffSupplierInvoiceRow & {
    supplier: { name: string | null; party_id: string | null } | null
  }
  const partyIds = [invoiceRow.customer?.party_id, supplierRow.supplier?.party_id].filter((id): id is string => !!id)
  const [canonical, collections, inFlight, carriedSek] = await Promise.all([
    resolveCanonicalParties(supabase, companyId, partyIds),
    openCollectionInvoiceIds(supabase, companyId, [invoiceRow.id]),
    paymentInFlightSupplierInvoiceIds(supabase, companyId, [supplierRow]),
    // What 151x carries when the issue verifikat booked the öresavrundning;
    // null (and no read) for every other invoice. A set-off is SEK only.
    isLedgerCurrency(invoiceRow.currency)
      ? carriedSekOf(supabase, companyId, 'customer', {
          id: invoiceRow.id,
          currency: invoiceRow.currency,
          // The remainder the planner uses (toSetoffInvoiceFacts) and the SQL reads.
          remaining_amount: invoiceRow.remaining_amount == null ? num(invoiceRow.total) : num(invoiceRow.remaining_amount),
          total: num(invoiceRow.total),
          paid_amount: num(invoiceRow.paid_amount),
          journal_entry_id: invoiceRow.journal_entry_id,
        })
      : null,
  ])
  const party = (id: string | null | undefined) => (id ? (canonical.get(id) ?? null) : null)
  return {
    ok: true,
    state: {
      invoice: toSetoffInvoiceFacts(invoiceRow, {
        partyId: party(invoiceRow.customer?.party_id),
        collectionOpen: collections.has(invoiceRow.id),
        carriedSek,
      }),
      supplierInvoice: toSetoffSupplierInvoiceFacts(supplierRow, {
        partyId: party(supplierRow.supplier?.party_id),
        paymentInFlight: inFlight.has(supplierRow.id),
      }),
      customerName: invoiceRow.customer?.name ?? null,
      supplierName: supplierRow.supplier?.name ?? null,
    },
  }
}

/** How many set-offs the pair already has, reversed ones included (the next id's ordinal). */
export async function countPairSetoffs(
  supabase: SupabaseClient,
  companyId: string,
  invoiceId: string,
  supplierInvoiceId: string,
): Promise<number> {
  const { count, error } = await supabase
    .from('counterparty_setoffs')
    .select('id', { count: 'exact', head: true })
    .eq('company_id', companyId)
    .eq('invoice_id', invoiceId)
    .eq('supplier_invoice_id', supplierInvoiceId)
  if (error) throw new Error(`counterparty set-off: set-off count failed: ${error.message}`)
  return count ?? 0
}
