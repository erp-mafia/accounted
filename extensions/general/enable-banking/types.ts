// Enable Banking extension types

export interface StoredAccount {
  uid: string
  iban?: string
  name?: string
  currency: string
  balance?: number
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
}

// Re-export API types from the client
export type {
  ASPSP,
  AuthMethod,
  AuthResponse,
  SessionResponse,
  AccountInfo,
  Balance,
  BalanceResponse,
  Transaction as EnableBankingTransaction,
  TransactionsResponse,
  TransactionsFetchStrategy,
  Bank,
  BankTransaction,
} from './lib/api-client'
