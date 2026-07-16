import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchAllRows } from '@/lib/supabase/fetch-all'

/**
 * A followable reference from a verifikation back to its underlag: the customer
 * or supplier invoice that identifies what the affärshändelse avser and who the
 * motpart is.
 *
 * Surfacing these makes the verifieringskedja traceable from the verifikat side,
 * not only from the invoice side (BFL 5 kap 7§: hänvisning till underlag;
 * BFNAR 2013:2: the verification chain must be followable in both directions).
 *
 * Bank transactions are deliberately excluded: a bank line is the trace of the
 * affärshändelse, not its underlag. Counting it as underlag would wrongly silence
 * the "saknar underlag" warning for expenses that still genuinely need a kvitto.
 */
export type UnderlagReferenceType = 'invoice' | 'supplier_invoice'

export interface UnderlagReference {
  type: UnderlagReferenceType
  id: string
  /** invoice_number / supplier_invoice_number: the UI builds the label from this. */
  number: string
  /** Retained source document owned by a referenced supplier invoice, if any. */
  document_id?: string
}

interface InvoiceRow {
  id: string
  invoice_number: string
}

interface SupplierInvoiceRow {
  id: string
  supplier_invoice_number: string
  document_id?: string | null
}

/**
 * Resolve every customer/supplier invoice linked to a verifikation, across all
 * the deterministic FK paths the engine uses to book one:
 *   - invoices.journal_entry_id                    (faktureringsmetod registration / direct)
 *   - invoice_payments.journal_entry_id            (kontantmetod inbetalning / delbetalning)
 *   - supplier_invoices.registration_journal_entry_id / payment_journal_entry_id
 *   - supplier_invoice_payments.journal_entry_id   (delbetalning)
 *
 * Every query is company-scoped (defense in depth alongside RLS). Results are
 * deduplicated by id, so an invoice reachable via several paths appears once.
 */
export async function getJournalEntryUnderlagReferences(
  supabase: SupabaseClient,
  companyId: string,
  journalEntryId: string,
): Promise<UnderlagReference[]> {
  // --- Customer invoices ---------------------------------------------------
  const invoices = new Map<string, string>()

  // Direct link (faktureringsmetod registration, or invoices.journal_entry_id).
  const directInvoices = await fetchAllRows<InvoiceRow>(({ from, to }) =>
    supabase.from('invoices').select('id, invoice_number')
      .eq('company_id', companyId).eq('journal_entry_id', journalEntryId)
      .order('id', { ascending: true }).range(from, to),
  )

  for (const inv of (directInvoices ?? []) as InvoiceRow[]) {
    invoices.set(inv.id, inv.invoice_number)
  }

  // Payment rows (kontantmetod inbetalning, partial payments) → invoice_payments.
  const paymentRows = await fetchAllRows<{ id: string; invoice_id: string | null }>(({ from, to }) =>
    supabase.from('invoice_payments').select('id, invoice_id')
      .eq('journal_entry_id', journalEntryId).order('id', { ascending: true }).range(from, to),
  )

  const paymentInvoiceIds = new Set<string>()
  for (const row of (paymentRows ?? []) as { invoice_id: string | null }[]) {
    if (row.invoice_id && !invoices.has(row.invoice_id)) paymentInvoiceIds.add(row.invoice_id)
  }

  if (paymentInvoiceIds.size > 0) {
    const paidInvoices = await fetchAllRows<InvoiceRow>(({ from, to }) =>
      supabase.from('invoices').select('id, invoice_number')
        .eq('company_id', companyId).in('id', Array.from(paymentInvoiceIds))
        .order('id', { ascending: true }).range(from, to),
    )

    for (const inv of (paidInvoices ?? []) as InvoiceRow[]) {
      invoices.set(inv.id, inv.invoice_number)
    }
  }

  // --- Supplier invoices ---------------------------------------------------
  const supplierInvoices = new Map<string, { number: string; documentId?: string }>()

  // Registration booking (accrual) on the invoice itself.
  const registrationLinks = await fetchAllRows<SupplierInvoiceRow>(({ from, to }) =>
    supabase.from('supplier_invoices').select('id, supplier_invoice_number, document_id')
      .eq('company_id', companyId).eq('registration_journal_entry_id', journalEntryId)
      .order('id', { ascending: true }).range(from, to),
  )

  for (const si of (registrationLinks ?? []) as SupplierInvoiceRow[]) {
    supplierInvoices.set(si.id, {
      number: si.supplier_invoice_number,
      ...(si.document_id ? { documentId: si.document_id } : {}),
    })
  }

  // Payment booking on the invoice itself.
  const paymentLinks = await fetchAllRows<SupplierInvoiceRow>(({ from, to }) =>
    supabase.from('supplier_invoices').select('id, supplier_invoice_number, document_id')
      .eq('company_id', companyId).eq('payment_journal_entry_id', journalEntryId)
      .order('id', { ascending: true }).range(from, to),
  )

  for (const si of (paymentLinks ?? []) as SupplierInvoiceRow[]) {
    supplierInvoices.set(si.id, {
      number: si.supplier_invoice_number,
      ...(si.document_id ? { documentId: si.document_id } : {}),
    })
  }

  // Partial-payment rows → supplier_invoice_payments.
  const supplierPaymentRows = await fetchAllRows<{ id: string; supplier_invoice_id: string | null }>(
    ({ from, to }) => supabase.from('supplier_invoice_payments').select('id, supplier_invoice_id')
      .eq('journal_entry_id', journalEntryId).order('id', { ascending: true }).range(from, to),
  )

  const supplierPaymentIds = new Set<string>()
  for (const row of (supplierPaymentRows ?? []) as { supplier_invoice_id: string | null }[]) {
    if (row.supplier_invoice_id && !supplierInvoices.has(row.supplier_invoice_id)) {
      supplierPaymentIds.add(row.supplier_invoice_id)
    }
  }

  if (supplierPaymentIds.size > 0) {
    const paidSupplierInvoices = await fetchAllRows<SupplierInvoiceRow>(({ from, to }) =>
      supabase.from('supplier_invoices').select('id, supplier_invoice_number, document_id')
        .eq('company_id', companyId).in('id', Array.from(supplierPaymentIds))
        .order('id', { ascending: true }).range(from, to),
    )

    for (const si of (paidSupplierInvoices ?? []) as SupplierInvoiceRow[]) {
      supplierInvoices.set(si.id, {
        number: si.supplier_invoice_number,
        ...(si.document_id ? { documentId: si.document_id } : {}),
      })
    }
  }

  // --- Assemble ------------------------------------------------------------
  const references: UnderlagReference[] = []
  for (const [id, number] of invoices) references.push({ type: 'invoice', id, number })
  for (const [id, supplierInvoice] of supplierInvoices) {
    references.push({
      type: 'supplier_invoice',
      id,
      number: supplierInvoice.number,
      ...(supplierInvoice.documentId ? { document_id: supplierInvoice.documentId } : {}),
    })
  }
  return references
}
