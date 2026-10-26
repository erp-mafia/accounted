import { describe, expect, it } from 'vitest'
import { ledgerChoices, ledgersHeldElsewhere, syncedAccountsOf, type CashAccountRowLike } from '../ledger-rows'

function row(id: string, overrides: Partial<CashAccountRowLike> = {}): CashAccountRowLike {
  return {
    id,
    bank_connection_id: 'conn-1',
    external_uid: `uid-${id}`,
    enabled: true,
    name: `Konto ${id}`,
    iban: `SE45 5000 0000 0583 9825 ${id}`,
    currency: 'SEK',
    ledger_account: '1930',
    bank_connection: { status: 'active' },
    ...overrides,
  }
}

const chart = [
  { account_number: '1910', account_name: 'Kassa' },
  { account_number: '1930', account_name: 'Företagskonto' },
  { account_number: '1931', account_name: 'Bankkonto SEK' },
  { account_number: '2440', account_name: 'Leverantörsskulder' },
]
const name = (ledger: string) => `Namn ${ledger}`

describe('syncedAccountsOf', () => {
  it('lists the enabled accounts this connection syncs, in ledger order, with the IBAN tail', () => {
    const rows = [
      row('4308', { ledger_account: '1931' }),
      row('1030', { ledger_account: '1930' }),
      row('9999', { enabled: false }),
      row('8888', { bank_connection_id: 'conn-2' }),
      row('7777', { bank_connection_id: null, external_uid: null }),
    ]

    expect(syncedAccountsOf('conn-1', rows)).toEqual([
      { cashAccountId: '1030', uid: 'uid-1030', name: 'Konto 1030', ibanLast4: '1030', currency: 'SEK', ledger: '1930' },
      { cashAccountId: '4308', uid: 'uid-4308', name: 'Konto 4308', ibanLast4: '4308', currency: 'SEK', ledger: '1931' },
    ])
  })
})

describe('ledgerChoices', () => {
  it('offers the chart\'s bank accounts, never another class', () => {
    expect(ledgerChoices('1931', chart, new Set(), name).map((c) => [c.account_number, c.account_name])).toEqual([
      ['1910', 'Kassa'],
      ['1930', 'Företagskonto'],
      ['1931', 'Bankkonto SEK'],
    ])
  })

  it('leaves out an account another connection syncs onto, but always keeps the current one, named when the chart lacks it', () => {
    const choices = ledgerChoices('1937', chart, new Set(['1930', '1937']), name).map((c) => [c.account_number, c.account_name])
    expect(choices).toEqual([['1910', 'Kassa'], ['1931', 'Bankkonto SEK'], ['1937', 'Namn 1937']])
  })
})

describe('ledgersHeldElsewhere', () => {
  it('counts only enabled accounts of other live connections', () => {
    const rows = [
      row('a', { ledger_account: '1930' }),
      row('b', { bank_connection_id: 'conn-2', ledger_account: '1940' }),
      row('c', { bank_connection_id: 'conn-3', ledger_account: '1941', bank_connection: { status: 'revoked' } }),
      row('d', { bank_connection_id: 'conn-2', ledger_account: '1942', enabled: false }),
      row('e', { bank_connection_id: null, external_uid: null, ledger_account: '1920' }),
    ]
    expect([...ledgersHeldElsewhere('conn-1', rows)]).toEqual(['1940'])
  })
})
