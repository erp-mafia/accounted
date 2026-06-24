import { describe, it, expect } from 'vitest'
import { resolveAccount } from '@/lib/cash-accounts/resolve-account'
import type { CashAccount } from '@/types'

function makeCashAccount(overrides: Partial<CashAccount> = {}): CashAccount {
  return {
    id: 'ca-1',
    company_id: 'company-1',
    bank_connection_id: null,
    external_uid: null,
    iban: null,
    bg_pg: null,
    name: null,
    currency: 'SEK',
    ledger_account: '1930',
    balance: null,
    balance_updated_at: null,
    enabled: true,
    is_primary: true,
    source: 'manual',
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
    ...overrides,
  }
}

describe('resolveAccount', () => {
  it('returns the ledger_account for the bound cash account when cash_account_id matches', () => {
    const accounts = [
      makeCashAccount({ id: 'ca-1', ledger_account: '1930' }),
      makeCashAccount({ id: 'ca-2', ledger_account: '1940', is_primary: false }),
    ]
    const result = resolveAccount(accounts, 'ca-2', 'SEK')
    expect(result).toEqual({ account: '1940', fallback: false })
  })

  it('falls back to the sole enabled same-currency account when cash_account_id is null', () => {
    const accounts = [makeCashAccount({ id: 'ca-1', ledger_account: '1920', currency: 'EUR' })]
    const result = resolveAccount(accounts, null, 'EUR')
    expect(result).toEqual({ account: '1920', fallback: false })
  })

  it('falls back to 1930 when cash_account_id is null and multiple same-currency accounts exist', () => {
    const accounts = [
      makeCashAccount({ id: 'ca-1', ledger_account: '1930', currency: 'SEK' }),
      makeCashAccount({ id: 'ca-2', ledger_account: '1940', currency: 'SEK', is_primary: false }),
    ]
    const result = resolveAccount(accounts, null, 'SEK')
    expect(result).toEqual({ account: '1930', fallback: true })
  })

  it('falls back to 1930 when cash_account_id does not match any account', () => {
    const accounts = [makeCashAccount({ id: 'ca-1', ledger_account: '1930' })]
    const result = resolveAccount(accounts, 'ca-unknown', 'SEK')
    expect(result).toEqual({ account: '1930', fallback: true })
  })

  it('falls back to 1930 when accounts list is empty', () => {
    const result = resolveAccount([], null, 'SEK')
    expect(result).toEqual({ account: '1930', fallback: true })
  })

  it('ignores disabled accounts in the currency fallback path', () => {
    const accounts = [
      makeCashAccount({ id: 'ca-1', ledger_account: '1930', enabled: true }),
      makeCashAccount({ id: 'ca-2', ledger_account: '1940', enabled: false, is_primary: false }),
    ]
    // Only one enabled SEK account → resolves without fallback
    const result = resolveAccount(accounts, null, 'SEK')
    expect(result).toEqual({ account: '1930', fallback: false })
  })
})
