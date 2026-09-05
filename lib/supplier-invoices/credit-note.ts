/**
 * Where a supplier credit note rests, from the moment it is created.
 *
 * A kreditfaktura from a supplier is the reversal of an invoice we already
 * registered: Accounted creates it from the original with Kreditera, books
 * the reversing verifikat in the same request and moves the original to
 * 'credited'. Nothing is left to attest and nothing is left to pay, so the
 * row must never enter the payable lifecycle (registered, approved, overdue,
 * paid, partially_paid).
 *
 * It used to be inserted at that lifecycle's entry state, 'registered', which
 * every consumer reads as "waiting for attest": the worklist counted it as
 * "1 leverantörsfaktura att attestera" while the detail page (correctly)
 * offered no attest for a credit note, so the item could never be cleared
 * (support case 2026-09-04). 'credited' is the status the provider importers
 * already give incoming credit notes, and the CHECK constraint
 * supplier_invoices_credit_note_not_payable (20260904190000) holds every
 * writer to it.
 */
export const SUPPLIER_CREDIT_NOTE_STATUS = 'credited' as const

/**
 * The columns of the original that a credit note mirrors. Deliberately a
 * structural type (not Pick<SupplierInvoice>): the v1 route reads the original
 * through a narrower projection whose vat_treatment is a plain string.
 */
export interface SupplierCreditNoteSource {
  id: string
  supplier_id: string
  supplier_invoice_number: string
  currency: string
  exchange_rate: number | null
  vat_treatment: string
  reverse_charge: boolean
  subtotal: number
  subtotal_sek: number | null
  vat_amount: number
  vat_amount_sek: number | null
  total: number
  total_sek: number | null
  default_dimensions?: Record<string, string> | null
}

export interface SupplierCreditNoteContext {
  userId: string
  companyId: string
  arrivalNumber: number
  /** ISO yyyy-MM-dd: the credit note's invoice and due date. */
  date: string
}

/**
 * The supplier_invoices row for a credit note that reverses `original`.
 *
 * One builder for the three creation paths (dashboard route, MCP executor,
 * v1 API) so the resting status, the zero remaining amount and the copied
 * amounts cannot drift between them.
 */
export function buildSupplierCreditNoteRow(
  original: SupplierCreditNoteSource,
  ctx: SupplierCreditNoteContext,
) {
  return {
    user_id: ctx.userId,
    company_id: ctx.companyId,
    supplier_id: original.supplier_id,
    arrival_number: ctx.arrivalNumber,
    supplier_invoice_number: `KREDIT-${original.supplier_invoice_number}`,
    invoice_date: ctx.date,
    due_date: ctx.date,
    status: SUPPLIER_CREDIT_NOTE_STATUS,
    currency: original.currency,
    exchange_rate: original.exchange_rate,
    vat_treatment: original.vat_treatment,
    reverse_charge: original.reverse_charge,
    subtotal: original.subtotal,
    subtotal_sek: original.subtotal_sek,
    vat_amount: original.vat_amount,
    vat_amount_sek: original.vat_amount_sek,
    total: original.total,
    total_sek: original.total_sek,
    // A credit note is never a payable: nothing remains to pay on it.
    remaining_amount: 0,
    is_credit_note: true,
    credited_invoice_id: original.id,
    // Copy the original's dimension bag so the reversal nets against the
    // same dimension cells in reports (dimensions PR7).
    default_dimensions: original.default_dimensions ?? {},
  }
}
