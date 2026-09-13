/**
 * Bank feed port.
 *
 * The ledger's contract for "give me the booked transactions of one bank
 * account for a date window". Adapters implement it: a direct PSD2 provider
 * running on this installation's own credentials, the Accounted Connect
 * service speaking the public wire contract, a sandbox. The ledger never
 * learns which one answered: everything downstream of this port (stored
 * external ids, dedup, ingest, the raw-page archive, balances) is provider
 * neutral and lives in the caller.
 *
 * Two rules keep adapters swappable without re-consent or re-import:
 *
 * 1. Consents and sessions stay on the installation. An adapter receives the
 *    session id per call when it needs one (`needsSessionId`); it never owns
 *    the consent.
 * 2. Stored keys are computed by the ledger from `booking_date`, `amount`
 *    and the ledger's own account scope. An adapter returns booked rows only
 *    (a pending row has no stable date) and never mints identifiers.
 *
 * Adapters are registered in lib/bank-feed/registry.ts; the registry, not
 * the adapters, decides which one serves a company.
 */

export type BankFeedStrategy = 'default' | 'longest'

/** One booked transaction, normalized. Nullable rather than optional: the wire form. */
export interface BookedBankTransaction {
  /** ISO calendar date the bank booked the row on. The ledger date and the dedup anchor. */
  booking_date: string
  /** Signed: money in positive, money out negative. */
  amount: number
  currency: string
  /** Never empty: adapters fall back to a neutral label. */
  description: string
  counterparty_name: string | null
  /** IBAN or domestic account identifier as the bank sent it; the ledger classifies. */
  counterparty_account: string | null
  reference: string | null
  merchant_category_code: string | null
  bank_transaction_code: string | null
  proprietary_bank_transaction_code: string | null
}

export interface BankFeedSyncInput {
  companyId: string
  connectionId: string
  /** The PSD2 session behind the connection; null when the adapter does not need one. */
  sessionId: string | null
  accountUid: string
  accountCurrency: string
  /**
   * The widest history window (days) this bank has answered for the account
   * before, when known. Lets an adapter tell "window refused" from "bank
   * down" on a first-page rejection.
   */
  acceptedHistoryDays?: number
  fromDate: string
  toDate: string
  strategy?: BankFeedStrategy
}

export interface BankFeedSyncResult {
  transactions: BookedBankTransaction[]
  /** Raw provider pages, verbatim, for the installation's archive (BFL 7 kap). */
  rawPages: string[]
  /** Rows the provider returned without a booking date and the adapter dropped. */
  skippedPending: number
  /**
   * The from-date the bank actually answered when it refused the requested
   * window and a narrower one was used. Undefined when the window was served
   * as asked.
   */
  effectiveFromDate?: string
  /** True when the bank refused the requested window and the history was cut. */
  narrowed: boolean
}

export interface BankFeedAdapter {
  /** Stable identifier, lower case: 'enable-banking', 'connect', ... */
  readonly provider: string
  /** True when `syncBooked` must receive the connection's session id. */
  readonly needsSessionId: boolean
  syncBooked(input: BankFeedSyncInput): Promise<BankFeedSyncResult>
}
