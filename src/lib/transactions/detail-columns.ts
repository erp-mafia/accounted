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
 *
 * The bank's own words and ids ride here too: original_description is the
 * bank's verbatim text (the drawer's "Bankens text"), which a renamed title
 * no longer shows, and provider_transaction_id / end_to_end_id are the bank's
 * ids for the row (a bank feed row's external_id is derived from its content,
 * never the bank's id). Agents asked for them to tell a resent row from a
 * genuine second payment. The match the transactions page suggests
 * (potential_supplier_invoice_id, potential_journal_entry_id and its
 * confidence, beside potential_invoice_id), the rate the drawer shows, the
 * payment rail and when the title was edited are here for the same reason:
 * what a person sees on the row, an agent can read.
 * __tests__/detail-columns.test.ts names every other column and why it is
 * left out, so a new column is a decision, not a silent gap.
 */
export const TRANSACTION_DETAIL_COLUMNS =
  'id, date, value_date, description, original_description, amount, currency, amount_sek, reference, merchant_name, ' +
  'counterparty_account, counterparty_iban, counterparty_org_number, instructed_amount, instructed_currency, ' +
  'balance_after, is_enriched, journal_entry_id, invoice_id, supplier_invoice_id, ' +
  'potential_invoice_id, potential_supplier_invoice_id, potential_journal_entry_id, potential_match_confidence, ' +
  'is_business, category, receipt_id, document_id, exchange_rate, exchange_rate_date, transaction_method, title_edited_at, ' +
  'external_id, provider_transaction_id, end_to_end_id, import_source, reconciliation_method, cash_account_id, potential_match_method, created_at, updated_at'
