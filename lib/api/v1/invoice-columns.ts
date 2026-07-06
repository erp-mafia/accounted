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
  'id, invoice_number, customer_id, invoice_date, due_date, delivery_date, status, currency, exchange_rate, exchange_rate_date, subtotal, subtotal_sek, vat_amount, vat_amount_sek, total, total_sek, vat_treatment, vat_rate, moms_ruta, your_reference, our_reference, notes, reverse_charge_text, credited_invoice_id, document_type, converted_from_id, paid_at, paid_amount, remaining_amount, default_dimensions, deduction_total, deduction_personnummer_last4, created_at, updated_at'

export const INVOICE_ITEM_FULL_COLUMNS =
  'id, sort_order, line_type, description, quantity, unit, unit_price, line_total, vat_rate, vat_amount, article_id, revenue_account, deduction_type, deduction_amount, labor_hours, work_type, housing_designation, apartment_number, brf_org_number, dimensions, created_at'
