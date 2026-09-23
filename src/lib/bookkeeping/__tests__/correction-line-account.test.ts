import { describe, expect, it } from 'vitest'
import {
  changeCorrectionLineAccount,
  getSelectableCorrectionCatalog,
} from '../correction-line-account'

const accounts = [
  {
    account_number: '2393',
    account_name: 'Lån från närstående personer, långfristig del',
  },
  {
    account_number: '2893',
    account_name: 'Skulder till närstående personer, kortfristig del',
  },
]

describe('changeCorrectionLineAccount', () => {
  it('replaces a stale account-derived description when the account changes', () => {
    const result = changeCorrectionLineAccount(
      {
        account_number: '2393',
        line_description: 'Lån från närstående personer, långfristig del',
        debit_amount: '',
        credit_amount: '1000',
      },
      '2893',
      accounts,
    )

    expect(result).toEqual({
      account_number: '2893',
      line_description: 'Skulder till närstående personer, kortfristig del',
      debit_amount: '',
      credit_amount: '1000',
    })
  })

  it('preserves a user-authored line description', () => {
    const result = changeCorrectionLineAccount(
      {
        account_number: '2393',
        line_description: 'Lån enligt avtal 2026-07-01',
      },
      '2893',
      accounts,
    )

    expect(result.line_description).toBe('Lån enligt avtal 2026-07-01')
  })

  it('uses the BAS catalogue when the new account is not active', () => {
    const result = changeCorrectionLineAccount(
      {
        account_number: '2393',
        line_description: 'Lån från närstående personer, långfristig del',
      },
      '2893',
      accounts,
    )

    expect(result.line_description).toBe('Skulder till närstående personer, kortfristig del')
  })

  it('recognizes an account-derived description from a deactivated custom account', () => {
    const result = changeCorrectionLineAccount(
      {
        account_number: '2997',
        line_description: 'Avräkning projektägare',
      },
      '2893',
      [
        { account_number: '2997', account_name: 'Avräkning projektägare' },
        accounts[1],
      ],
    )

    expect(result.line_description).toBe('Skulder till närstående personer, kortfristig del')
  })

  it('prefers the company account name over a duplicate BAS catalogue name', () => {
    const result = changeCorrectionLineAccount(
      {
        account_number: '2393',
        line_description: 'Lån från närstående personer, långfristig del',
      },
      '2893',
      [
        accounts[0],
        { account_number: '2893', account_name: 'Avräkning ägare' },
        accounts[1],
      ],
    )

    expect(result.line_description).toBe('Avräkning ägare')
  })

  it('fills a blank description from the selected account', () => {
    const result = changeCorrectionLineAccount(
      { account_number: '2393', line_description: '' },
      '2893',
      accounts,
    )

    expect(result.line_description).toBe('Skulder till närstående personer, kortfristig del')
  })

  it('clears a derived description when the new account has no known name', () => {
    const result = changeCorrectionLineAccount(
      {
        account_number: '2393',
        line_description: 'Lån från närstående personer, långfristig del',
      },
      '9999',
      accounts,
    )

    expect(result.line_description).toBe('')
  })
})

describe('getSelectableCorrectionCatalog', () => {
  it('excludes deliberately deactivated company accounts from catalogue choices', () => {
    const result = getSelectableCorrectionCatalog(
      [
        { account_number: '2393', account_name: 'Långfristigt lån', is_active: true },
        { account_number: '2893', account_name: 'Kortfristigt lån', is_active: false },
      ],
      accounts,
    )

    expect(result).toEqual([accounts[0]])
  })
})
