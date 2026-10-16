/**
 * Where a bank connection is finished or renewed, by who reads it.
 * Dependency-free (like ./return-url), so the transactions chips can use it.
 *
 * An Open Payments row continues in Koppla banken: `?bank_connect=<id>`
 * reopens the flow for that connection (useBankConnectResume), which for a
 * row waiting for its accounts polls once and lands on the account choice,
 * and `&renew=1` opens it as a renewal. An Enable Banking row keeps its own
 * panel's picker, `?select_accounts=<id>`.
 */
import { BANK_CONNECT_RETURN_PARAM } from './return-url'

export interface ConnectionLinkRow {
  id: string
  aggregator?: string | null
}

const OPEN_PAYMENTS = 'open_payments'

export function isOpenPaymentsRow(row: { aggregator?: string | null }): boolean {
  return row.aggregator === OPEN_PAYMENTS
}

/** The page that finishes the account choice for a connection waiting for it. */
export function chooseAccountsHref(row: ConnectionLinkRow): string {
  const id = encodeURIComponent(row.id)
  return isOpenPaymentsRow(row) ? `/settings/banking?${BANK_CONNECT_RETURN_PARAM}=${id}` : `/settings/banking?select_accounts=${id}`
}

/** The page that renews an Open Payments connection whose consent is over. */
export function renewOpenPaymentsHref(row: Pick<ConnectionLinkRow, 'id'>): string {
  return `/settings/banking?${BANK_CONNECT_RETURN_PARAM}=${encodeURIComponent(row.id)}&renew=1`
}
