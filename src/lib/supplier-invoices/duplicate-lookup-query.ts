/**
 * The supplier-invoice editor's side of the duplicate lookup: what it asks
 * GET /api/supplier-invoices/exists, and whether its review dialog comes
 * first. The rules and the read are duplicate-lookup.ts.
 *
 * Pure and dependency-light: the editor imports it, and the lookup reads the
 * payment ladder (stages.ts, lifecycle-stages.ts), which a browser bundle has
 * no use for.
 */
import { isPersonPayer } from '@/lib/expenses/payer'
import { isIsoDateShaped } from '@/lib/invariants/iso-date'
import { normalizeOcrReference } from '@/lib/invariants/reference-number'
import type { SupplierInvoiceFormData } from '@/lib/supplier-invoices/form-payload'
import { CURRENCIES } from '@/types'

/** The editor fields the lookup is asked about. */
export type DuplicateLookupFields = Pick<
  SupplierInvoiceFormData,
  'supplier_id' | 'supplier_invoice_number' | 'payment_reference' | 'payer'
> &
  Partial<Pick<SupplierInvoiceFormData, 'invoice_date' | 'currency'>> & {
    /** The amount to pay as the editor shows it (its figures.toPay). */
    total?: number | null
  }

/**
 * The query string the editor asks GET /api/supplier-invoices/exists with, or
 * null when there is nothing to ask: no supplier yet (one being created
 * inline has no id), or neither a number nor a reference with a digit in it.
 * A person's utlägg is paid already: it has no reference to pay with, and
 * the editor shows no reference field for it.
 *
 * With a reference, the invoice date, the amount to pay and the currency go
 * along when the date is filled in: among the invoices that share the
 * reference they tell the same document registered again (duplicate-lookup.ts).
 * Only in a currency an invoice can be registered in (the route takes no
 * other): a reading's other code would otherwise cost every warning.
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
  const date = (fields.invoice_date ?? '').trim()
  const currency = fields.currency || 'SEK'
  if (
    reference &&
    isIsoDateShaped(date) &&
    typeof fields.total === 'number' &&
    Number.isFinite(fields.total) &&
    (CURRENCIES as readonly string[]).includes(currency)
  ) {
    params.set('invoice_date', date)
    params.set('total', String(fields.total))
    params.set('currency', currency)
  }
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
