import { describe, expect, it } from 'vitest'
import {
  accountDisplayName,
  initialSelection,
  isPrivateAccount,
  ledgerLabel,
  ledgerLocked,
  ledgerOptionsFor,
  selectionBlocker,
  selectionPayload,
  setLedger,
  toggleAccount,
} from '../account-selection'
import type { PolledAccount } from '../open-payments-client'

function account(overrides: Partial<PolledAccount> = {}): PolledAccount {
  return {
    uid: 'a1',
    iban: 'SE4550000000058398257466',
    bban: '58398257466',
    name: 'Företagskonto',
    currency: 'SEK',
    usage: 'ORGA',
    preselected: true,
    enabled: true,
    suggested_ledger_account: '1930',
    matches_existing: null,
    ...overrides,
  }
}

const CHART = [
  { account_number: '1930', account_name: 'Företagskonto' },
  { account_number: '1940', account_name: 'Övriga bankkonton' },
  { account_number: '1510', account_name: 'Kundfordringar' },
]

describe('initialSelection', () => {
  it('turns company accounts on and private ones off, each with its ledger', () => {
    const selection = initialSelection([
      account({ uid: 'orga', preselected: true, suggested_ledger_account: '1930' }),
      account({ uid: 'priv', usage: 'PRIV', preselected: false, suggested_ledger_account: null }),
    ])
    expect(selection.orga).toEqual({ enabled: true, ledger: '1930' })
    expect(selection.priv).toEqual({ enabled: false, ledger: null })
  })

  it('keeps the ledger an account already books on over the suggestion', () => {
    const selection = initialSelection([account({ uid: 'kept', matches_existing: '1932', suggested_ledger_account: '1930' })])
    expect(selection.kept.ledger).toBe('1932')
  })
})

describe('toggleAccount and setLedger', () => {
  it('flip and pick without touching other accounts', () => {
    const start = initialSelection([account({ uid: 'a' }), account({ uid: 'b' })])
    const toggled = toggleAccount(start, 'a')
    expect(toggled.a.enabled).toBe(false)
    expect(toggled.b).toEqual(start.b)
    const picked = setLedger(toggled, 'b', '1940')
    expect(picked.b.ledger).toBe('1940')
    expect(setLedger(picked, 'missing', '1940')).toBe(picked)
  })
})

describe('ledgerLocked and isPrivateAccount', () => {
  it('locks an account the company booked before and marks PRIV', () => {
    expect(ledgerLocked(account({ matches_existing: '1930' }))).toBe(true)
    expect(ledgerLocked(account())).toBe(false)
    expect(isPrivateAccount(account({ usage: 'PRIV' }))).toBe(true)
    expect(isPrivateAccount(account())).toBe(false)
  })
})

describe('selectionBlocker', () => {
  it('refuses nothing enabled and an enabled account without a ledger', () => {
    const accounts = [account({ uid: 'a', suggested_ledger_account: null })]
    const none = toggleAccount(initialSelection(accounts), 'a')
    expect(selectionBlocker(accounts, none)).toBe('none_enabled')
    expect(selectionBlocker(accounts, initialSelection(accounts))).toBe('ledger_missing')
    expect(selectionBlocker(accounts, setLedger(initialSelection(accounts), 'a', '1930'))).toBeNull()
  })

  it('names a consent the bank signed without listing any account, not an unticked box (crm#1445)', () => {
    expect(selectionBlocker([], {})).toBe('no_accounts')
    expect(selectionBlocker([], initialSelection([]))).toBe('no_accounts')
  })
})

describe('selectionPayload', () => {
  it('sends every account, with the ledger only when on', () => {
    const accounts = [account({ uid: 'on' }), account({ uid: 'off', usage: 'PRIV', preselected: false, suggested_ledger_account: '1940' })]
    expect(selectionPayload(accounts, initialSelection(accounts))).toEqual([
      { uid: 'on', enabled: true, ledger_account: '1930' },
      { uid: 'off', enabled: false, ledger_account: null },
    ])
  })
})

describe('ledgerOptionsFor', () => {
  const name = (ledger: string) => `Bankkonto ${ledger}`

  it('offers the chart’s 19xx accounts, leaving out ones another enabled account took', () => {
    const accounts = [account({ uid: 'a', suggested_ledger_account: '1930' }), account({ uid: 'b', suggested_ledger_account: '1940' })]
    const options = ledgerOptionsFor('b', CHART, initialSelection(accounts), name)
    expect(options.map((o) => o.account_number)).toEqual(['1940'])
  })

  it('puts a suggested account the chart lacks first, named by the fallback', () => {
    const accounts = [account({ uid: 'a', suggested_ledger_account: '1933' })]
    const options = ledgerOptionsFor('a', CHART, initialSelection(accounts), name)
    expect(options[0]).toEqual({ account_number: '1933', account_name: 'Bankkonto 1933' })
    expect(options.map((o) => o.account_number)).toEqual(['1933', '1930', '1940'])
  })
})

describe('ledgerLabel and accountDisplayName', () => {
  it('names the ledger from the chart and the account from what the bank sent', () => {
    expect(ledgerLabel('1930', CHART, () => 'x')).toBe('1930 Företagskonto')
    expect(ledgerLabel('1935', CHART, (l) => `Bankkonto ${l}`)).toBe('1935 Bankkonto 1935')
    expect(accountDisplayName(account(), 'Bankkonto')).toBe('Företagskonto')
    expect(accountDisplayName(account({ name: ' ' }), 'Bankkonto')).toBe('SE4550000000058398257466')
    expect(accountDisplayName(account({ name: null, iban: null }), 'Bankkonto')).toBe('58398257466')
    expect(accountDisplayName(account({ name: null, iban: null, bban: null }), 'Bankkonto')).toBe('Bankkonto')
  })
})
