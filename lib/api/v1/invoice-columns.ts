/**
 * Shared v1 invoice response projections.
 *
 * The create (POST), detail (GET), and draft-update (PATCH) endpoints all
 * return the same invoice shape; keeping the column lists in one module
 * prevents response-shape drift between them (a PATCH caller must see the
 * same fields a GET caller does). Explicit projection: excludes user_id,
 * company_id (internal scoping) and the encrypted personnummer blob
 * (deduction_personnummer_last4 is the display-safe representation).
 * Schema migrations adding columns must update these lists before the
 * field becomes visible on the public API.
 */

export const INVOICE_FULL_COLUMNS =
  'id, invoice_number, customer_id, invoice_date, due_date, delivery_date, status, currency, exchange_rate, exchange_rate_date, subtotal, subtotal_sek, vat_amount, vat_amount_sek, total, total_sek, ore_rounding, vat_treatment, vat_rate, moms_ruta, your_reference, our_reference, invoice_marking, notes, payment_link_url, stripe_payment_link_id, payment_link_auto, reverse_charge_text, credited_invoice_id, document_type, converted_from_id, valid_until, quote_status, quote_decided_at, paid_at, paid_amount, remaining_amount, default_dimensions, deduction_total, deduction_personnummer_last4, created_at, updated_at'

/**
 * Projection for the v1 PDF download route. Narrower than INVOICE_FULL_COLUMNS
 * (no payment-link/dimension internals), but it MUST contain every column the
 * render path reads to compute the customer-facing amount: getAmountToPay
 * derives "Att betala" from total, ore_rounding, deduction_total and
 * credited_invoice_id, and the same figure is locked into the Swish QR
 * (editmask 0). A column missing here silently zeroes that part of the
 * calculation for this surface only: the v1 PDF then disagrees with the
 * dashboard PDF and the sent email for the same invoice, which is exactly
 * the byte-equivalence this endpoint promises. delivery_date is statutory
 * content on top of that: ML 17 kap 24 § requires leveransdatum on the
 * invoice when it differs from the invoice date, and the template renders it
 * exactly then. Pinned by __tests__/invoice-columns.test.ts.
 */
export const INVOICE_PDF_COLUMNS =
  'id, invoice_number, customer_id, invoice_date, due_date, delivery_date, status, document_type, ' +
  'currency, subtotal, vat_amount, total, ore_rounding, vat_treatment, vat_rate, moms_ruta, ' +
  'reverse_charge_text, your_reference, our_reference, invoice_marking, notes, credited_invoice_id, ' +
  'paid_amount, remaining_amount, deduction_total, deduction_personnummer_last4'

export const INVOICE_ITEM_FULL_COLUMNS =
  'id, sort_order, line_type, description, quantity, unit, unit_price, discount_percent, line_total, vat_rate, vat_amount, article_id, revenue_account, deduction_type, deduction_amount, labor_hours, work_type, housing_designation, apartment_number, brf_org_number, dimensions, created_at'
