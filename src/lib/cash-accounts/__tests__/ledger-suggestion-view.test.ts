import { describe, expect, it } from 'vitest'
import {
  ledgerSuggestionAction,
  ledgerSuggestionBody,
  ledgerSuggestionBookedNote,
  ledgerSuggestionConfirmTitle,
  ledgerSuggestionLine,
  ledgerSuggestionPickerReason,
  ledgerWithName,
  pickerPreselection,
  pickerSuggestions,
  type LedgerSuggestionAccount,
  type LedgerSuggestionView,
} from '../ledger-suggestion-view'

function account(overrides: Partial<LedgerSuggestionAccount> = {}): LedgerSuggestionAccount {
  return {
    cash_account_id: 'cash-a',
    connection_id: 'conn-1',
    uid: 'uid-a',
    label: '••4417',
    from_ledger: '1940',
    from_ledger_name: 'Övriga bankkonton',
    to_ledger: '1920',
    to_ledger_name: 'PlusGiro',
    basis: 'transactions',
    hits: 46,
    balance_date: null,
    booked_rows: 0,
    ...overrides,
  }
}

function move(overrides: Partial<LedgerSuggestionAccount> = {}): LedgerSuggestionView {
  return {
    id: 'move:cash-a>1920',
    kind: 'move',
    accounts: [account(overrides)],
    selection: { connection_id: 'conn-1', enabled_uids: ['uid-a'], account_mappings: [{ uid: 'uid-a', ledger_account: '1920' }] },
    one_click: true,
    two_connections: false,
  }
}

function swap(): LedgerSuggestionView {
  return {
    id: 'swap:cash-a>1920|cash-b>1940',
    kind: 'swap',
    accounts: [
      account({ booked_rows: 3 }),
      account({
        cash_account_id: 'cash-b', uid: 'uid-b', label: '••2210', from_ledger: '1920', from_ledger_name: 'PlusGiro',
        to_ledger: '1940', to_ledger_name: null, basis: 'balance', hits: 0, balance_date: '2025-12-31', booked_rows: 4,
      }),
    ],
    selection: {
      connection_id: 'conn-1',
      enabled_uids: ['uid-a', 'uid-b'],
      account_mappings: [{ uid: 'uid-a', ledger_account: '1920' }, { uid: 'uid-b', ledger_account: '1940' }],
    },
    one_click: true,
    two_connections: false,
  }
}

/** ••4417 books on 1931 but belongs on 1930, which ••2210 holds without evidence. */
function oneSidedSwap(first: Partial<LedgerSuggestionAccount> = {}, holder: Partial<LedgerSuggestionAccount> = {}): LedgerSuggestionView {
  return {
    id: 'one_sided_swap:cash-a>1930|cash-b>1931',
    kind: 'one_sided_swap',
    accounts: [
      account({ from_ledger: '1931', from_ledger_name: 'Bankkonto SEK', to_ledger: '1930', to_ledger_name: 'Företagskonto', ...first }),
      account({
        cash_account_id: 'cash-b', uid: 'uid-b', label: '••2210', from_ledger: '1930', from_ledger_name: 'Företagskonto',
        to_ledger: '1931', to_ledger_name: 'Bankkonto SEK', basis: null, hits: 0, balance_date: null, ...holder,
      }),
    ],
    selection: {
      connection_id: 'conn-1',
      enabled_uids: ['uid-a', 'uid-b'],
      account_mappings: [{ uid: 'uid-a', ledger_account: '1930' }, { uid: 'uid-b', ledger_account: '1931' }],
    },
    one_click: true,
    two_connections: false,
  }
}

describe('the attention line of a ledger suggestion', () => {
  it('is one sentence naming the account, where it books and where the books say it belongs', () => {
    expect(ledgerSuggestionLine(move())).toEqual({
      key: 'line_move',
      values: { account: '••4417', from: '1940', to: '1920 PlusGiro' },
    })
  })

  it('reads the same whatever the evidence: the balance and its day are the dialog\'s', () => {
    expect(ledgerSuggestionLine(move({ basis: 'balance', hits: 0, balance_date: '2025-12-31' }))).toEqual(
      ledgerSuggestionLine(move()),
    )
  })

  it('names both accounts of a swap', () => {
    expect(ledgerSuggestionLine(swap())).toEqual({ key: 'line_swap', values: { accountA: '••4417', accountB: '••2210' } })
  })

  it('names who holds the ledger account in a one-sided swap', () => {
    expect(ledgerSuggestionLine(oneSidedSwap())).toEqual({
      key: 'line_one_sided_swap',
      values: { accountA: '••4417', fromA: '1931', toA: '1930 Företagskonto', accountB: '••2210' },
    })
  })

  it('asks the change as the confirm title, with the numbers the button names', () => {
    expect(ledgerSuggestionConfirmTitle(move())).toEqual({ key: 'confirm_title_move', values: { to: '1920' } })
    expect(ledgerSuggestionConfirmTitle(swap())).toEqual({ key: 'confirm_title_swap', values: { a: '1920', b: '1940' } })
    expect(ledgerSuggestionConfirmTitle(oneSidedSwap())).toEqual({ key: 'confirm_title_swap', values: { a: '1930', b: '1931' } })
  })

  it('only uses message keys that exist in both locales', async () => {
    const [sv, en] = await Promise.all([
      import('@/messages/sv.json').then((m) => m.default.bank_ledger_suggestion as Record<string, string>),
      import('@/messages/en.json').then((m) => m.default.bank_ledger_suggestion as Record<string, string>),
    ])
    const keys = [move(), swap(), oneSidedSwap()].flatMap((s) => [ledgerSuggestionLine(s).key, ledgerSuggestionConfirmTitle(s).key])
    for (const key of [...keys, 'swap_two_connections', 'booked_rows']) {
      expect(sv[key], `sv ${key}`).toBeTypeOf('string')
      expect(en[key], `en ${key}`).toBeTypeOf('string')
    }
  })
})

describe('the sentence of a ledger suggestion', () => {
  it('counts the transactions already booked on the other account', () => {
    expect(ledgerSuggestionBody(move())).toEqual({
      key: 'move_transactions',
      values: { account: '••4417', from: '1940', to: '1920 PlusGiro', toNumber: '1920', hits: 46 },
    })
  })

  it('names the balance and its day when the suggestion rests on the balance', () => {
    expect(ledgerSuggestionBody(move({ basis: 'balance', hits: 2, balance_date: '2025-12-31' }))).toEqual({
      key: 'move_balance',
      values: { account: '••4417', from: '1940', to: '1920 PlusGiro', toNumber: '1920', date: '2025-12-31' },
    })
  })

  it('names both accounts and both numbers of a swap', () => {
    expect(ledgerSuggestionBody(swap())).toEqual({
      key: 'swap',
      values: { accountA: '••4417', fromA: '1940', toA: '1920 PlusGiro', accountB: '••2210', fromB: '1920', toB: '1940' },
    })
  })

  it('tells a one-sided swap apart: the account with the evidence, then who holds its ledger account', () => {
    expect(ledgerSuggestionBody(oneSidedSwap())).toEqual({
      key: 'one_sided_swap_transactions',
      values: {
        accountA: '••4417', fromA: '1931', toA: '1930 Företagskonto', toNumber: '1930', accountB: '••2210', hits: 46, holderBooked: 'no',
      },
    })
    expect(ledgerSuggestionBody(oneSidedSwap({ basis: 'balance', hits: 0, balance_date: '2025-12-31' }))).toEqual({
      key: 'one_sided_swap_balance',
      values: {
        accountA: '••4417', fromA: '1931', toA: '1930 Företagskonto', toNumber: '1930', accountB: '••2210', date: '2025-12-31', holderBooked: 'no',
      },
    })
  })

  it('does not say the holder has nothing booked there when it has', () => {
    expect(ledgerSuggestionBody(oneSidedSwap({}, { booked_rows: 4 })).values.holderBooked).toBe('yes')
  })

  it('adds the booked transactions only when there are any, counted once over both accounts of a swap', () => {
    expect(ledgerSuggestionBookedNote(move())).toBeNull()
    expect(ledgerSuggestionBookedNote(move({ booked_rows: 12 }))).toEqual({ key: 'booked_rows', values: { count: 12 } })
    expect(ledgerSuggestionBookedNote(swap())).toEqual({ key: 'booked_rows', values: { count: 7 } })
    expect(ledgerSuggestionBookedNote(oneSidedSwap())).toBeNull()
    expect(ledgerSuggestionBookedNote(oneSidedSwap({ booked_rows: 5 }, { booked_rows: 4 }))).toEqual({ key: 'booked_rows', values: { count: 9 } })
  })

  it('labels the button with the ledger account, or the two of either swap in order', () => {
    expect(ledgerSuggestionAction(move())).toEqual({ key: 'action_move', values: { to: '1920' } })
    expect(ledgerSuggestionAction(swap())).toEqual({ key: 'action_swap', values: { a: '1920', b: '1940' } })
    expect(ledgerSuggestionAction(oneSidedSwap())).toEqual({ key: 'action_swap', values: { a: '1930', b: '1931' } })
  })

  it('writes a ledger account with its chart name when it has one', () => {
    expect(ledgerWithName('1920', 'PlusGiro')).toBe('1920 PlusGiro')
    expect(ledgerWithName('1920', null)).toBe('1920')
  })
})

describe('the bank picker', () => {
  it('gives the reason beside a preselected account', () => {
    const suggestion = move()
    expect(ledgerSuggestionPickerReason({ account: suggestion.accounts[0], suggestion })).toEqual({
      key: 'picker_transactions',
      values: { to: '1920 PlusGiro', hits: 46 },
    })
    const onBalance = move({ basis: 'balance', balance_date: '2025-12-31' })
    expect(ledgerSuggestionPickerReason({ account: onBalance.accounts[0], suggestion: onBalance })).toEqual({
      key: 'picker_balance',
      values: { to: '1920 PlusGiro', date: '2025-12-31' },
    })
  })

  it('says who the account that makes room trades places with', () => {
    const suggestion = oneSidedSwap()
    expect(ledgerSuggestionPickerReason({ account: suggestion.accounts[1], suggestion })).toEqual({
      key: 'picker_trades_places',
      values: { to: '1931 Bankkonto SEK', other: '••4417', from: '1930 Företagskonto' },
    })
  })

  it('preselects only what one save of that connection can make', () => {
    const acrossConnections: LedgerSuggestionView = { ...swap(), selection: null, one_click: false, two_connections: true }
    const noUid: LedgerSuggestionView = { ...move({ uid: null }), selection: null, one_click: false }

    expect([...pickerPreselection([move(), acrossConnections, noUid], 'conn-1').keys()]).toEqual(['uid-a'])
    expect(pickerPreselection([move()], 'conn-2').size).toBe(0)
  })

  it('preselects both accounts of a swap, so that no two accounts share a ledger account', () => {
    for (const suggestion of [swap(), oneSidedSwap()]) {
      const preselected = [...pickerPreselection([suggestion], 'conn-1').entries()].map(([uid, entry]) => [uid, entry.account.to_ledger])
      expect(preselected).toHaveLength(2)
      expect(new Set(preselected.map(([, ledger]) => ledger)).size).toBe(2)
      expect(preselected).toEqual(suggestion.accounts.map((a) => [a.uid, a.to_ledger]))
    }
  })

  it('leaves a swap out whole when one of its accounts is not in the connection list', () => {
    const broken = oneSidedSwap({}, { uid: null })
    expect(pickerSuggestions([broken, move()], 'conn-1').map((s) => s.id)).toEqual(['move:cash-a>1920'])
    expect([...pickerPreselection([broken], 'conn-1').keys()]).toEqual([])
  })
})
