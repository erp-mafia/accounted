/**
 * Before a supplier invoice is registered: is its number, or its payment
 * reference, already on a live invoice of the same supplier?
 *
 * The number is unique per supplier among live invoices
 * (idx_supplier_invoices_company_supplier_number), so a hit there is the
 * invoice the create route will refuse. A payment reference has no such
 * rule, and must not get one: a supplier that invoices through a
 * fakturaservice prints the same OCR on every invoice. So the reference only
 * warns, and how loudly depends on what the supplier's own invoices say:
 *
 *   - on ONE other live invoice it may be the same invoice registered under
 *     another number: a person acknowledges it before registering;
 *   - on two or more it is how this supplier invoices: nothing is asked.
 *
 * Live is the unique index's own predicate: not credited, not reversed.
 * References are compared on their digits (normalizeOcrReference), as every
 * matcher compares them, so an OCR typed in groups is the same reference. A
 * reference without a digit is free text and is not looked for.
 *
 * The supplier is the supplier card (supplier_id). suppliers.org_number is
 * not unique per company (20260908094409), so two cards of one legal entity
 * are two suppliers here, as they are to the unique index.
 *
 * Advisory only: the editor asks through GET /api/supplier-invoices/exists,
 * and no door refuses a reused reference.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { formatVoucher } from '@/lib/bookkeeping/voucher-series-resolver'
import { dbError } from '@/lib/errors/db-error'
import { isPersonPayer } from '@/lib/expenses/payer'
import { normalizeOcrReference } from '@/lib/invariants/reference-number'
import type { SupplierInvoiceFormData } from '@/lib/supplier-invoices/form-payload'

/** The invoice that already carries the number or the reference, as a warning names it. */
export interface RegisteredSupplierInvoice {
  id: string
  /** Null when the document carried none: arrival_number then names it. */
  supplier_invoice_number: string | null
  arrival_number: number
  invoice_date: string
  /** Total incl. VAT; shown through supplierInvoiceDisplayFigures with ore_rounding. */
  total: number
  currency: string
  /** Per-invoice öresavrundning flag: decides the amount the invoice list shows. */
  ore_rounding: boolean | null
  status: string
  /**
   * The verifikat it is booked on: the registration, else the payment (under
   * kontantmetoden the payment is the booking). Null while it is not booked.
   */
  voucher: { journal_entry_id: string; label: string } | null
}

export interface SupplierInvoiceReferenceReuse {
  /** The newest other live invoice of the supplier that carries the reference. */
  invoice: RegisteredSupplierInvoice
  /** How many other live invoices of the supplier carry it. */
  count: number
  /** False once the reference is the supplier's normal (referenceReuseNeedsAcknowledgement). */
  needs_acknowledgement: boolean
}

export interface SupplierInvoiceDuplicateLookup {
  /** The live invoice of the supplier with this number, which the create route refuses. */
  number: RegisteredSupplierInvoice | null
  /** The reference on other live invoices of the supplier, under another number. */
  reference: SupplierInvoiceReferenceReuse | null
}

/** From this many invoices on one reference, reuse is how the supplier invoices. */
const ROUTINE_REFERENCE_REUSE_FROM = 2

/** A reference on one other invoice is acknowledged; on more it is the supplier's normal. */
export function referenceReuseNeedsAcknowledgement(count: number): boolean {
  return count > 0 && count < ROUTINE_REFERENCE_REUSE_FROM
}

/** The editor fields the lookup is asked about. */
export type DuplicateLookupFields = Pick<
  SupplierInvoiceFormData,
  'supplier_id' | 'supplier_invoice_number' | 'payment_reference' | 'payer'
>

/**
 * The query string the editor asks GET /api/supplier-invoices/exists with, or
 * null when there is nothing to ask: no supplier yet (one being created
 * inline has no id), or neither a number nor a reference with a digit in it.
 * A person's utlägg is paid already: it has no reference to pay with, and
 * the editor shows no reference field for it.
 */
export function duplicateLookupQuery(fields: DuplicateLookupFields): string | null {
  const number = (fields.supplier_invoice_number ?? '').trim()
  const reference =
    !isPersonPayer(fields.payer) && normalizeOcrReference(fields.payment_reference)
      ? fields.payment_reference.trim()
      : ''
  if (!fields.supplier_id || (!number && !reference)) return null
  const params = new URLSearchParams({ supplier_id: fields.supplier_id })
  if (number) params.set('number', number)
  if (reference) params.set('reference', reference)
  return params.toString()
}

/**
 * Whether the editor shows its review dialog before it registers. An
 * aktiebolag's invoice always passes it. An enskild firma's, and a person's
 * utlägg, register without it, unless there is a reused reference to
 * acknowledge: the dialog is where that is done.
 */
export function registrationPassesReview(facts: { isEF: boolean; personPaid: boolean; acknowledges: boolean }): boolean {
  return facts.acknowledges || (!facts.isEF && !facts.personPaid)
}

/** Rows a reference lookup reads: the LIKE below leaves the supplier's matches and little else. */
const REFERENCE_CANDIDATE_LIMIT = 200

interface InvoiceRow {
  id: string
  supplier_invoice_number: string | null
  arrival_number: number
  invoice_date: string
  total: number
  currency: string | null
  ore_rounding: boolean | null
  status: string
  payment_reference: string | null
  registration_journal_entry_id: string | null
  payment_journal_entry_id: string | null
}

interface VoucherRow {
  id: string
  voucher_series: string | null
  voucher_number: number | null
}

const bookedOn = (row: InvoiceRow): string | null => row.registration_journal_entry_id ?? row.payment_journal_entry_id

/**
 * Look the number and the reference up among the supplier's live invoices.
 * Either may be absent. Served by the partial unique index (the number) and
 * idx_supplier_invoices_supplier (the reference: one supplier's invoices are
 * few, and the LIKE narrows them before they leave the database).
 */
export async function lookupSupplierInvoiceDuplicates(
  supabase: SupabaseClient,
  companyId: string,
  input: { supplierId: string; number?: string | null; reference?: string | null },
): Promise<SupplierInvoiceDuplicateLookup> {
  const number = (input.number ?? '').trim()
  const referenceDigits = normalizeOcrReference(input.reference)

  const [numberRes, referenceRes] = await Promise.all([
    number
      ? supabase
          .from('supplier_invoices')
          .select('id, supplier_invoice_number, arrival_number, invoice_date, total, currency, ore_rounding, status, payment_reference, registration_journal_entry_id, payment_journal_entry_id')
          .eq('company_id', companyId)
          .eq('supplier_id', input.supplierId)
          .eq('supplier_invoice_number', number)
          .not('status', 'in', '(credited,reversed)')
          .limit(1)
      : Promise.resolve({ data: [], error: null }),
    referenceDigits
      ? supabase
          .from('supplier_invoices')
          .select('id, supplier_invoice_number, arrival_number, invoice_date, total, currency, ore_rounding, status, payment_reference, registration_journal_entry_id, payment_journal_entry_id')
          .eq('company_id', companyId)
          .eq('supplier_id', input.supplierId)
          .not('status', 'in', '(credited,reversed)')
          // The digits in order with anything between them: every reference
          // that is equal on its digits, and few others. Equality is decided below.
          .like('payment_reference', `%${[...referenceDigits].join('%')}%`)
          .order('invoice_date', { ascending: false })
          .order('arrival_number', { ascending: false })
          .limit(REFERENCE_CANDIDATE_LIMIT)
      : Promise.resolve({ data: [], error: null }),
  ])
  if (numberRes.error) throw dbError(numberRes.error)
  if (referenceRes.error) throw dbError(referenceRes.error)

  const numberRow = ((numberRes.data ?? []) as InvoiceRow[])[0] ?? null
  // Under another number: the invoice with this number is the number's hit.
  const sharing = ((referenceRes.data ?? []) as InvoiceRow[]).filter(
    (row) =>
      normalizeOcrReference(row.payment_reference) === referenceDigits &&
      (!number || row.supplier_invoice_number !== number),
  )
  const referenceRow = sharing[0] ?? null

  const voucherIds = [numberRow, referenceRow]
    .map((row) => row && bookedOn(row))
    .filter((id): id is string => !!id)
  const vouchers = new Map<string, VoucherRow>()
  if (voucherIds.length > 0) {
    const { data, error } = await supabase
      .from('journal_entries')
      .select('id, voucher_series, voucher_number')
      .eq('company_id', companyId)
      .in('id', voucherIds)
    if (error) throw dbError(error)
    for (const entry of (data ?? []) as VoucherRow[]) vouchers.set(entry.id, entry)
  }

  const named = (row: InvoiceRow): RegisteredSupplierInvoice => {
    const entry = vouchers.get(bookedOn(row) ?? '')
    return {
      id: row.id,
      supplier_invoice_number: row.supplier_invoice_number,
      arrival_number: row.arrival_number,
      invoice_date: row.invoice_date,
      total: Number(row.total),
      currency: row.currency ?? 'SEK',
      ore_rounding: row.ore_rounding ?? null,
      status: row.status,
      // A draft has no number yet: nothing to name.
      voucher: entry?.voucher_number ? { journal_entry_id: entry.id, label: formatVoucher(entry) } : null,
    }
  }

  return {
    number: numberRow ? named(numberRow) : null,
    reference: referenceRow
      ? {
          invoice: named(referenceRow),
          count: sharing.length,
          needs_acknowledgement: referenceReuseNeedsAcknowledgement(sharing.length),
        }
      : null,
  }
}
