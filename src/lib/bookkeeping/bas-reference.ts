/**
 * BAS Reference Data for Swedish Accounting
 *
 * Full BAS Kontoplan 2026 (~1,276 accounts) organized by account class.
 * Data files live in ./bas-data/ and are aggregated here.
 *
 * Reference: BAS Kontoplan 2026 v1.0
 * SRU codes follow Skatteverket's SRU specification for NE and INK2 forms.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BASReferenceAccount {
  account_number: string
  account_name: string
  account_class: number
  account_group: string
  account_type: 'asset' | 'liability' | 'equity' | 'revenue' | 'expense' | 'untaxed_reserves'
  normal_balance: 'debit' | 'credit'
  description: string
  sru_code: string | null
  k2_excluded: boolean
}

// ---------------------------------------------------------------------------
// Data (imported from per-class data files)
// ---------------------------------------------------------------------------

export { BAS_REFERENCE } from './bas-data'

// ---------------------------------------------------------------------------
// Lookup indexes (lazy-initialized for performance)
// ---------------------------------------------------------------------------

// Import BAS_REFERENCE for use in indexes (re-exported above for consumers)
import { BAS_REFERENCE } from './bas-data'

let _byAccountNumber: Map<string, BASReferenceAccount> | null = null

function getByAccountNumberIndex(): Map<string, BASReferenceAccount> {
  if (!_byAccountNumber) {
    _byAccountNumber = new Map()
    for (const account of BAS_REFERENCE) {
      _byAccountNumber.set(account.account_number, account)
    }
  }
  return _byAccountNumber
}

// ---------------------------------------------------------------------------
// Helper functions
// ---------------------------------------------------------------------------

/**
 * Look up a single BAS reference account by its account number.
 * Returns undefined if the account number is not in the reference data.
 */
export function getBASReference(accountNumber: string): BASReferenceAccount | undefined {
  return getByAccountNumberIndex().get(accountNumber)
}

/**
 * Check whether an account number exists in the BAS reference data.
 * Useful for validating that a user-entered account number is a standard BAS account.
 */
export function isStandardBASAccount(accountNumber: string): boolean {
  return getByAccountNumberIndex().has(accountNumber)
}
