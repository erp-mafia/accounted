import { describe, expect, it } from 'vitest'
import { accountTransactionsHref, reconciliationHref } from '../account-links'

describe('reconciliationHref', () => {
  it('opens the account by its key, encoded the way the bokslut checklist links it', () => {
    expect(reconciliationHref({ account_key: 'bank:abc-123', kind: 'bank' })).toBe('/reconciliation?account=bank%3Aabc-123')
    expect(reconciliationHref({ account_key: 'skattekonto', kind: 'skattekonto' })).toBe('/reconciliation?account=skattekonto')
    expect(reconciliationHref({ account_key: 'manual:1510', kind: 'manual' })).toBe('/reconciliation?account=manual%3A1510')
  })

  it('carries ?autorun=1 to a bank account only: the matcher preview runs on banks alone', () => {
    expect(reconciliationHref({ account_key: 'bank:abc', kind: 'bank' }, { autorun: true })).toBe(
      '/reconciliation?account=bank%3Aabc&autorun=1',
    )
    expect(reconciliationHref({ account_key: 'skattekonto', kind: 'skattekonto' }, { autorun: true })).toBe(
      '/reconciliation?account=skattekonto',
    )
    expect(reconciliationHref({ account_key: 'manual:2440', kind: 'manual' }, { autorun: true })).toBe(
      '/reconciliation?account=manual%3A2440',
    )
  })
})

describe('accountTransactionsHref', () => {
  it('filters Transaktioner to a bank account by its cash account id', () => {
    expect(accountTransactionsHref({ account_key: 'bank:abc-123', kind: 'bank' })).toBe('/transactions?source=acct%3Aabc-123')
  })

  it('has no transactions list for the skattekonto or a balance account', () => {
    expect(accountTransactionsHref({ account_key: 'skattekonto', kind: 'skattekonto' })).toBeNull()
    expect(accountTransactionsHref({ account_key: 'manual:1510', kind: 'manual' })).toBeNull()
  })
})
