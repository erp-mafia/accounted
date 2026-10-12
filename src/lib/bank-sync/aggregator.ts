/**
 * The service that reaches a connected bank: bank_connections.aggregator
 * (migration 20261012120000). bank_connections.provider names the BANK (a
 * slug like 'seb-se'); this names the aggregator between Accounted and it.
 *
 * Every row that existed before Open Payments is 'enable_banking'. A code
 * path that talks to one aggregator filters on its value, so a connection is
 * never synced, probed, renewed or revoked through the other one: their
 * session ids mean nothing to each other.
 */

export type BankAggregator = 'enable_banking' | 'open_payments'

export const ENABLE_BANKING_AGGREGATOR: BankAggregator = 'enable_banking'
export const OPEN_PAYMENTS_AGGREGATOR: BankAggregator = 'open_payments'

/** The provider-session namespace of an aggregator (bank_session_revocations.provider). */
export const AGGREGATOR_SESSION_NAMESPACE: Readonly<Record<BankAggregator, string>> = {
  enable_banking: 'enablebanking',
  open_payments: 'openpayments',
}

/** bank_connections.provider for an Open Payments row: the bank is named by bic and bank_name instead. */
export const OPEN_PAYMENTS_PROVIDER_SLUG = 'open_payments'

export function isBankAggregator(value: unknown): value is BankAggregator {
  return value === 'enable_banking' || value === 'open_payments'
}

/**
 * A row's aggregator, defaulting to Enable Banking: the column is NOT NULL
 * with that default, so an absent value only comes from a select that did not
 * ask for it, and every such row predates Open Payments.
 */
export function aggregatorOf(row: { aggregator?: string | null } | null | undefined): BankAggregator {
  return row?.aggregator === 'open_payments' ? 'open_payments' : 'enable_banking'
}
