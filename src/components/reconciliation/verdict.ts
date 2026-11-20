import type { ReconciliationStatus } from '@/lib/reconciliation/schemas'

/**
 * The two checks the reconciliation verdict sentence rests on, kept apart
 * from the page so they can be tested.
 *
 * A difference the status does not know is no agreement (crm#1701): the page
 * read `Math.abs(difference ?? 0)`, so a skattekonto without any saldo from
 * Skatteverket, or an account whose ledger could not be read, said "stämmer".
 */
export function sidesAgree(status: Pick<ReconciliationStatus, 'is_reconciled' | 'difference'>): boolean {
  return status.is_reconciled || (status.difference != null && Math.abs(status.difference) < 0.005)
}

/**
 * A skattekonto with rows but no saldo from Skatteverket (a file import, or
 * a company that never fetched one): there is nothing to compare the books
 * with, and the sentence says so instead of a verdict.
 */
export function lacksSkatteverketSaldo(status: Pick<ReconciliationStatus, 'kind' | 'external_balance'>): boolean {
  return status.kind === 'skattekonto' && status.external_balance == null
}

/**
 * The skattekonto lacks a saldo because the company has no Skatteverket
 * connection (crm#1701): the page says that, not "never fetched", since a
 * company that disconnected did fetch one once.
 */
export function skatteverketNotConnected(status: Pick<ReconciliationStatus, 'kind' | 'skattekonto'>): boolean {
  return status.kind === 'skattekonto' && status.skattekonto?.saldo_missing_reason === 'not_connected'
}
