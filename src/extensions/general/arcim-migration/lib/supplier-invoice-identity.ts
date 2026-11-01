/**
 * How a provider's supplier invoice is matched to a stored row when a repair
 * pass joins the two (the import itself matches inside
 * commit_provider_migration_records).
 *
 * Fortnox numbers every supplier invoice itself (löpnummer, `GivenNumber`, the
 * record id its mapper hands on), apart from the number the supplier printed
 * (`InvoiceNumber`, the supplier number since crm#1157). An invoice imported
 * from Fortnox keeps the löpnummer in `fortnox_number`, and a row imported
 * before that column holds it as its supplier number. The supplier number
 * alone never identifies a Fortnox record: suppliers reuse one on invoice
 * after invoice (crm#1039).
 */

/**
 * The number a listed provider invoice is matched to a stored row on: the
 * löpnummer for a Fortnox record, the supplier's number for any other.
 */
export function listedMatchNumber(provider: string, dto: { id: string; invoiceNumber: string }): string | null {
  return (provider === 'fortnox' && dto.id?.trim()) || dto.invoiceNumber
}

/**
 * The number a stored row is matched to a listed provider invoice on: for
 * Fortnox its löpnummer, which a row imported before fortnox_number existed
 * holds as its supplier number.
 */
export function storedMatchNumber(
  provider: string,
  row: { supplier_invoice_number: string | null; fortnox_number?: string | null },
): string | null {
  return provider === 'fortnox' ? (row.fortnox_number ?? row.supplier_invoice_number) : row.supplier_invoice_number
}
