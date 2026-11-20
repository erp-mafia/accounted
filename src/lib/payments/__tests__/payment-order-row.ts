/**
 * A payment order as the bank payments counter reads it: sent to the bank,
 * with the bank's payment id, at `sent`, or never. Timestamps carry
 * milliseconds like the month bounds do: the payroll fake db compares them
 * as text.
 */
export function paymentOrderRow(companyId: string, id: string, at: { created: string; sent: string | null }) {
  return { id, company_id: companyId, cash_account_id: 'a1', provider_payment_id: at.sent ? `pay-${id}` : null, created_at: at.created, submitted_at: at.sent }
}
