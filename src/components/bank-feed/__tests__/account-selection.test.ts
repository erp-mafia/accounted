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
    const accounts = [account({ uid: 'a' }), account({ uid: 'b' })]
    const start = initialSelection(accounts)
    const toggled = toggleAccount(accounts, start, 'a')
    expect(toggled.a.enabled).toBe(false)
    expect(toggled.b).toEqual(start.b)
    const picked = setLedger(accounts, toggled, 'b', '1940')
    expect(picked.b.ledger).toBe('1940')
    expect(setLedger(accounts, picked, 'missing', '1940')).toBe(picked)
  })
})

describe('the currency default follows the ticked accounts (crm#1701)', () => {
  // A sole trader's accounts all read PRIV, so none is preselected and the
  // server deals in the bank's order: 1930 to the first account, the business
  // account (third) gets 1935. 1930 is where the company's bank-file history sits.
  const soleTrader = (overrides: Record<string, Partial<PolledAccount>> = {}): PolledAccount[] =>
    [
      { uid: 'private', name: 'Privatkonto', suggested_ledger_account: '1930' },
      { uid: 'bills', name: 'Räkningar', suggested_ledger_account: '1931' },
      { uid: 'business', name: 'Firmakonto', suggested_ledger_account: '1935' },
      { uid: 'savings', name: 'Buffert', suggested_ledger_account: '1936' },
    ].map((a) => account({ usage: 'PRIV', preselected: false, enabled: false, ledger_kept: false, ...a, ...overrides[a.uid] }))

  it('gives the account the person ticks 1930, trading numbers with the unticked one', () => {
    const accounts = soleTrader()
    const start = initialSelection(accounts)
    expect(start.business).toEqual({ enabled: false, ledger: '1935' })
    const ticked = toggleAccount(accounts, start, 'business')
    expect(ticked.business).toEqual({ enabled: true, ledger: '1930' })
    expect(ticked.private).toEqual({ enabled: false, ledger: '1935' })
    expect(ticked.bills).toEqual(start.bills)
    expect(selectionPayload(accounts, ticked).find((a) => a.uid === 'business')).toEqual({ uid: 'business', enabled: true, ledger_account: '1930' })
  })

  it('leaves 1930 on the first ticked account when another is ticked', () => {
    const accounts = soleTrader()
    const both = toggleAccount(accounts, toggleAccount(accounts, initialSelection(accounts), 'business'), 'private')
    expect(both.business.ledger).toBe('1930')
    expect(both.private).toEqual({ enabled: true, ledger: '1935' })
    expect(selectionBlocker(accounts, both)).toBeNull()
  })

  it('hands 1930 to the next ticked account of its currency when its account is unticked', () => {
    const accounts = soleTrader()
    let selection = toggleAccount(accounts, initialSelection(accounts), 'business')
    selection = toggleAccount(accounts, selection, 'bills')
    expect(selection.bills.ledger).toBe('1931')
    selection = toggleAccount(accounts, selection, 'business')
    expect(selection.bills).toEqual({ enabled: true, ledger: '1930' })
    expect(selection.business).toEqual({ enabled: false, ledger: '1931' })
  })

  it('never moves a number an account kept from before, nor one the screen cannot tell is fresh', () => {
    for (const accounts of [soleTrader({ private: { ledger_kept: true } }), soleTrader({ private: { ledger_kept: undefined } })]) {
      const ticked = toggleAccount(accounts, initialSelection(accounts), 'business')
      expect(ticked.business.ledger).toBe('1935')
      expect(ticked.private.ledger).toBe('1930')
    }
  })

  it('never moves the number of an account the company already books on', () => {
    const accounts = soleTrader({ private: { matches_existing: '1930' } })
    const ticked = toggleAccount(accounts, initialSelection(accounts), 'business')
    expect(ticked.business.ledger).toBe('1935')
    expect(ticked.private.ledger).toBe('1930')
  })

  it('gives a currency default only to an account of that currency', () => {
    const accounts = [
      ...soleTrader(),
      account({ uid: 'eur', currency: 'EUR', usage: 'PRIV', preselected: false, enabled: false, ledger_kept: false, suggested_ledger_account: '1937' }),
      account({ uid: 'eur-default', currency: 'EUR', usage: 'PRIV', preselected: false, enabled: false, ledger_kept: false, suggested_ledger_account: '1932' }),
    ]
    const ticked = toggleAccount(accounts, initialSelection(accounts), 'eur')
    expect(ticked.eur.ledger).toBe('1932')
    expect(ticked['eur-default'].ledger).toBe('1937')
    expect(ticked.private.ledger).toBe('1930')
  })

  it('moves nothing by itself once the person has picked a ledger', () => {
    const accounts = soleTrader()
    let selection = toggleAccount(accounts, initialSelection(accounts), 'business')
    // The pick sends 1930 back to the unticked private account, where the
    // next tick would otherwise fetch it.
    selection = setLedger(accounts, selection, 'business', '1935')
    expect(selection.business).toEqual({ enabled: true, ledger: '1935', picked: true })
    expect(selection.private).toEqual({ enabled: false, ledger: '1930' })
    selection = toggleAccount(accounts, selection, 'bills')
    expect(selection.bills.ledger).toBe('1931')
    expect(selection.private.ledger).toBe('1930')
  })

  it('leaves a default the server gave a preselected account with it, even unticked (crm#1498)', () => {
    const accounts = [
      account({ uid: 'named', ledger_kept: false, suggested_ledger_account: '1930' }),
      account({ uid: 'other', usage: 'PRIV', preselected: false, enabled: false, ledger_kept: false, suggested_ledger_account: '1931' }),
    ]
    let selection = toggleAccount(accounts, initialSelection(accounts), 'named')
    selection = toggleAccount(accounts, selection, 'other')
    expect(selection.other).toEqual({ enabled: true, ledger: '1931' })
    expect(selection.named).toEqual({ enabled: false, ledger: '1930' })
  })

  it('trades a picked number only with an account of the same currency', () => {
    const accounts = [
      ...soleTrader(),
      account({ uid: 'eur', currency: 'EUR', usage: 'PRIV', preselected: false, enabled: false, ledger_kept: false, suggested_ledger_account: '1932' }),
    ]
    let selection = toggleAccount(accounts, initialSelection(accounts), 'eur')
    selection = setLedger(accounts, selection, 'eur', '1930')
    expect(selection.private.ledger).toBe('1930')
  })

  it('trades a picked number an unticked account held, so ticking that account later gives no clash', () => {
    const accounts = soleTrader()
    let selection = toggleAccount(accounts, initialSelection(accounts), 'business')
    selection = setLedger(accounts, selection, 'business', '1935')
    expect(selection.private.ledger).toBe('1930')
    selection = toggleAccount(accounts, selection, 'private')
    const ledgers = selectionPayload(accounts, selection).filter((a) => a.enabled).map((a) => a.ledger_account)
    expect(ledgers.sort()).toEqual(['1930', '1935'])
  })

  it('keeps the server deal when it already gave 1930 to a preselected account', () => {
    const accounts = [
      account({ uid: 'named', ledger_kept: false, suggested_ledger_account: '1930' }),
      account({ uid: 'other', ledger_kept: false, suggested_ledger_account: '1931' }),
    ]
    expect(initialSelection(accounts)).toEqual({ named: { enabled: true, ledger: '1930' }, other: { enabled: true, ledger: '1931' } })
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
    const none = toggleAccount(accounts, initialSelection(accounts), 'a')
    expect(selectionBlocker(accounts, none)).toBe('none_enabled')
    expect(selectionBlocker(accounts, initialSelection(accounts))).toBe('ledger_missing')
    expect(selectionBlocker(accounts, setLedger(accounts, initialSelection(accounts), 'a', '1930'))).toBeNull()
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
