// Enable Banking extension types

export interface StoredAccount {
  uid: string
  iban?: string
  // Swedish BBAN (clearing number + account number, no separator) when the
  // ASPSP provided one. Display and invoice-payee prefill only: dedup keys
  // stay IBAN-then-uid (see dedup_scope).
  bban?: string
  name?: string
  currency: string
  balance?: number
  // Bank-reported available balance from the same BALANCES response as
  // `balance` (booked). Absent when the ASPSP returns no available type.
  available_balance?: number
  balance_updated_at?: string
  // When false, the account is part of the PSD2 consent but the user has
  // chosen not to sync transactions from it. Treated as true if missing
  // (back-compat with rows that predate the per-account toggle).
  enabled?: boolean
  // BAS account number (e.g. '1930', '1932') the bank-side leg of every
  // transaction from this account posts to. Null/undefined falls back to the
  // mapping engine default (1930). Lets multicurrency setups route SEK→1930,
  // EUR→1932, USD→1933, etc., so year-end FX revaluation is clean.
  ledger_account?: string
  // The account scope used when deriving transaction external_ids at first
  // ingest (the normalized IBAN, or the provider uid the account had then).
  // Persisted so re-authorizations that mint a NEW uid keep producing the
  // SAME external_ids for accounts without an IBAN, instead of re-importing
  // the whole history. lib/sync.ts falls back to IBAN-then-uid when unset
  // (rows that predate this field) and stamps it on the next sync.
  dedup_scope?: string
  // Set by the OAuth callback when the account's IBAN is already booked by
  // ANOTHER of the user's companies. At one-session banks (SEB) the PSU's
  // single consent can cover accounts that belong in a sibling company's
  // books; such accounts are stored disabled and never mirrored into this
  // company's cash_accounts, and the picker renders the claim so the user
  // sees why the account is unchecked. Enabling one is a deliberate act.
  claimed_by_company_id?: string
  claimed_by_company_name?: string
  // Set by the OAuth callback when the account arrived deselected because the
  // user chose "Synkas ej" for the same IBAN on another connection row (any
  // company). Rendered as a note in the picker so the unchecked box is never
  // silent; cleared by the selection save when the user re-enables the
  // account.
  deselected_elsewhere?: boolean
  // Widest transactions history window (whole days before date_to) this
  // account's bank has ever ACCEPTED, stamped by lib/sync.ts after each
  // successful fetch. ASPSP_ERROR is Enable Banking's generic wrapper for any
  // upstream failure, so a rejected request cannot say whether the window was
  // too wide or the bank is refusing right now. A window no wider than this
  // has worked before, so a rejection of it is treated as the bank being
  // unavailable instead of walking the whole narrowing ladder (issue #2202).
  accepted_history_days?: number
}

// Re-exported from the client for lib/sync.ts; every other api-client type
// is imported from './lib/api-client' directly.
export type { TransactionsFetchStrategy } from './lib/api-client'
