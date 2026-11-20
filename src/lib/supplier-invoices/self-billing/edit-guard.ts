/**
 * The fields of an issued self-billing invoice an update may not change
 * (crm#1367): its number belongs to our series and its date is printed on the
 * document the seller received. Either change is a credit note and a new
 * invoice, never an edit. Pure: the dashboard PUT and the v1 PATCH both ask
 * it before anything is written; the database refuses the number change
 * anyway (guard_self_billing_identity).
 */
export function selfBilledLockedFields(
  changes: { supplier_invoice_number?: string | null; invoice_date?: string | null },
  existing: { is_self_billed?: boolean | null; supplier_invoice_number: string | null; invoice_date: string | null },
): Array<'supplier_invoice_number' | 'invoice_date'> {
  if (!existing.is_self_billed) return []
  const locked: Array<'supplier_invoice_number' | 'invoice_date'> = []
  if (changes.supplier_invoice_number !== undefined && changes.supplier_invoice_number !== existing.supplier_invoice_number) {
    locked.push('supplier_invoice_number')
  }
  if (changes.invoice_date !== undefined && changes.invoice_date !== existing.invoice_date) {
    locked.push('invoice_date')
  }
  return locked
}
