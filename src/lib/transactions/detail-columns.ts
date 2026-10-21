/**
 * The columns of one bank transaction read in full. Both single-row doors
 * select this one list, so they return the same fields: the v1 detail
 * endpoint (GET /api/v1/companies/{companyId}/transactions/{id}) and MCP
 * gnubok_get_transaction (read-with-vouchers.ts). Each kept its own copy
 * until crm#1347, and the MCP copy never had external_id: the only id that
 * ties a Stripe, bank feed or file import row to its source.
 *
 * A single-row drill-in is the caller's intentional request for the full
 * row: verbose by design. List reads stay minimal and keep their own lists.
 */
export const TRANSACTION_DETAIL_COLUMNS =
  'id, date, description, amount, currency, amount_sek, reference, merchant_name, ' +
  'counterparty_account, counterparty_iban, counterparty_org_number, instructed_amount, instructed_currency, ' +
  'balance_after, is_enriched, journal_entry_id, invoice_id, supplier_invoice_id, ' +
  'potential_invoice_id, is_business, category, receipt_id, document_id, ' +
  'external_id, import_source, reconciliation_method, cash_account_id, potential_match_method, created_at, updated_at'
