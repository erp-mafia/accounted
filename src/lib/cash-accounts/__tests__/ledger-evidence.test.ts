import { describe, expect, it } from 'vitest'
import {
  HIT_DOMINANCE,
  MIN_TRANSACTION_HITS,
  suggestLedgerChanges,
  type EvidenceCashAccount,
  type LedgerEvidenceRow,
} from '../ledger-evidence'

function account(id: string, ledger: string, overrides: Partial<EvidenceCashAccount> = {}): EvidenceCashAccount {
  return { id, ledger_account: ledger, bank_connection_id: 'conn-1', enabled: true, connection_status: 'active', ...overrides }
}

function hits(cashAccountId: string, ledger: string, n: number): LedgerEvidenceRow {
  return { cash_account_id: cashAccountId, kind: 'transactions', ledger_account: ledger, hits: n, balance_date: null }
}

function balance(cashAccountId: string, ledger: string, day = '2025-12-31'): LedgerEvidenceRow {
  return { cash_account_id: cashAccountId, kind: 'balance', ledger_account: ledger, hits: null, balance_date: day }
}

describe('suggestLedgerChanges: transactions', () => {
  it('suggests the ledger account the unbooked rows are booked on', () => {
    expect(suggestLedgerChanges([account('a', '1940')], [hits('a', '1920', 46)])).toEqual([
      {
        kind: 'move',
        moves: [{ cashAccountId: 'a', connectionId: 'conn-1', from: '1940', to: '1920', basis: 'transactions', hits: 46, balanceDate: null }],
      },
    ])
  })

  it('needs the minimum number of rows', () => {
    expect(suggestLedgerChanges([account('a', '1940')], [hits('a', '1920', MIN_TRANSACTION_HITS - 1)])).toEqual([])
    expect(suggestLedgerChanges([account('a', '1940')], [hits('a', '1920', MIN_TRANSACTION_HITS)])).toHaveLength(1)
  })

  it('needs the rows on the other account to outnumber those on the current one', () => {
    const own = 4
    const short = [hits('a', '1940', own), hits('a', '1920', HIT_DOMINANCE * own - 1)]
    const enough = [hits('a', '1940', own), hits('a', '1920', HIT_DOMINANCE * own)]
    expect(suggestLedgerChanges([account('a', '1940')], short)).toEqual([])
    expect(suggestLedgerChanges([account('a', '1940')], enough)).toHaveLength(1)
  })

  it('says nothing when the rows sit on the current account', () => {
    expect(suggestLedgerChanges([account('a', '1930')], [hits('a', '1930', 80), hits('a', '1920', 2)])).toEqual([])
  })

  it('says nothing when two other accounts compete', () => {
    expect(suggestLedgerChanges([account('a', '1940')], [hits('a', '1920', 46), hits('a', '1921', 40)])).toEqual([])
  })

  it('reads numeric strings, and ignores rows that are not bank ledger accounts or of an unknown kind', () => {
    const rows: LedgerEvidenceRow[] = [
      { ...hits('a', '1920', 0), hits: '12' },
      hits('a', '2440', 500),
      { ...hits('a', '1921', 500), kind: 'booked' },
    ]
    expect(suggestLedgerChanges([account('a', '1940')], rows).map((s) => s.moves[0].to)).toEqual(['1920'])
  })
})

describe('suggestLedgerChanges: balance', () => {
  it('is enough on its own, with no matching row at all', () => {
    expect(suggestLedgerChanges([account('a', '1940')], [balance('a', '1920')])).toEqual([
      {
        kind: 'move',
        moves: [{ cashAccountId: 'a', connectionId: 'conn-1', from: '1940', to: '1920', basis: 'balance', hits: 0, balanceDate: '2025-12-31' }],
      },
    ])
  })

  it('carries the few rows that do match, without needing them', () => {
    const [suggestion] = suggestLedgerChanges([account('a', '1940')], [balance('a', '1920'), hits('a', '1920', 2)])
    expect(suggestion.moves[0]).toMatchObject({ basis: 'balance', hits: 2 })
  })

  it('says nothing when the current account matches', () => {
    expect(suggestLedgerChanges([account('a', '1940')], [balance('a', '1940')])).toEqual([])
    expect(suggestLedgerChanges([account('a', '1940')], [balance('a', '1940'), balance('a', '1920')])).toEqual([])
  })

  it('says nothing when it equals several other accounts', () => {
    expect(suggestLedgerChanges([account('a', '1940')], [balance('a', '1920'), balance('a', '1950')])).toEqual([])
  })
})

describe('suggestLedgerChanges: both kinds together', () => {
  it('names the rows as the basis when both agree, and keeps the balance day', () => {
    const [suggestion] = suggestLedgerChanges([account('a', '1940')], [hits('a', '1920', 46), balance('a', '1920', '2026-01-01')])
    expect(suggestion.moves[0]).toMatchObject({ to: '1920', basis: 'transactions', hits: 46, balanceDate: '2026-01-01' })
  })

  it('suggests nothing when they point at different accounts', () => {
    expect(suggestLedgerChanges([account('a', '1940')], [hits('a', '1920', 46), balance('a', '1950')])).toEqual([])
  })

  it('suggests nothing when the rows point away and the balance says the mapping is right', () => {
    expect(suggestLedgerChanges([account('a', '1940')], [hits('a', '1920', 46), balance('a', '1940')])).toEqual([])
  })

  it('suggests nothing when the balance points away and the rows say the mapping is right', () => {
    expect(suggestLedgerChanges([account('a', '1940')], [hits('a', '1940', 46), balance('a', '1920')])).toEqual([])
  })

  it('lets the rows stand when the balance equals the same account among others', () => {
    const rows = [hits('a', '1920', 46), balance('a', '1920'), balance('a', '1950')]
    expect(suggestLedgerChanges([account('a', '1940')], rows).map((s) => s.moves[0].to)).toEqual(['1920'])
  })
})

describe('suggestLedgerChanges: who holds the ledger account', () => {
  it('returns one swap when two accounts point at each other', () => {
    const accounts = [account('a', '1940'), account('b', '1920')]
    const rows = [hits('a', '1920', 46), balance('b', '1940', '2025-12-31')]
    expect(suggestLedgerChanges(accounts, rows)).toEqual([
      {
        kind: 'swap',
        moves: [
          { cashAccountId: 'b', connectionId: 'conn-1', from: '1920', to: '1940', basis: 'balance', hits: 0, balanceDate: '2025-12-31' },
          { cashAccountId: 'a', connectionId: 'conn-1', from: '1940', to: '1920', basis: 'transactions', hits: 46, balanceDate: null },
        ],
      },
    ])
  })

  it('returns the swap also when the two accounts come from different bank connections', () => {
    const accounts = [account('a', '1940'), account('b', '1920', { bank_connection_id: 'conn-2' })]
    const [swap] = suggestLedgerChanges(accounts, [hits('a', '1920', 46), hits('b', '1940', 30)])
    expect(swap.kind).toBe('swap')
    expect(swap.moves.map((m) => m.connectionId).sort()).toEqual(['conn-1', 'conn-2'])
  })

  it('trades places with a holder of the same connection that nothing in the books ties to its ledger account', () => {
    // The busy account got 1931 because a savings account took 1930.
    const accounts = [account('a', '1931'), account('b', '1930')]
    expect(suggestLedgerChanges(accounts, [hits('a', '1930', 46)])).toEqual([
      {
        kind: 'one_sided_swap',
        moves: [
          { cashAccountId: 'a', connectionId: 'conn-1', from: '1931', to: '1930', basis: 'transactions', hits: 46, balanceDate: null },
          // The holder only makes room: no evidence of its own.
          { cashAccountId: 'b', connectionId: 'conn-1', from: '1930', to: '1931', basis: null, hits: 0, balanceDate: null },
        ],
      },
    ])
  })

  it('trades places on a balance match alone, and when the holder has rows booked on unrelated accounts', () => {
    const accounts = [account('a', '1931'), account('b', '1930')]
    const rows = [balance('a', '1930', '2025-12-31'), hits('b', '1950', 2)]
    const [suggestion] = suggestLedgerChanges(accounts, rows)
    expect(suggestion.kind).toBe('one_sided_swap')
    expect(suggestion.moves.map((m) => [m.cashAccountId, m.to, m.basis])).toEqual([
      ['a', '1930', 'balance'],
      ['b', '1931', null],
    ])
  })

  it('does not trade places when a bank row of the holder is booked on its ledger account', () => {
    const accounts = [account('a', '1931'), account('b', '1930')]
    // One row is enough: the holder's placement then says something.
    expect(suggestLedgerChanges(accounts, [hits('a', '1930', 46), hits('b', '1930', 1)])).toEqual([])
  })

  it('does not trade places when the holder has a balance match on its ledger account', () => {
    const accounts = [account('a', '1931'), account('b', '1930')]
    expect(suggestLedgerChanges(accounts, [hits('a', '1930', 46), balance('b', '1930')])).toEqual([])
  })

  it('does not trade places with a holder of another bank connection', () => {
    const accounts = [account('a', '1931'), account('b', '1930', { bank_connection_id: 'conn-2' })]
    expect(suggestLedgerChanges(accounts, [hits('a', '1930', 46)])).toEqual([])
  })

  it('does not trade places with a holder that points at a third ledger account: its own move comes first', () => {
    const accounts = [account('a', '1931'), account('b', '1930')]
    const rows = [hits('a', '1930', 46), hits('b', '1950', 20)]
    expect(suggestLedgerChanges(accounts, rows).map((s) => [s.kind, s.moves[0].cashAccountId, s.moves[0].to])).toEqual([
      ['move', 'b', '1950'],
    ])
  })

  it('does not trade places when another account points at the ledger account the holder would get', () => {
    // c wants 1931, which a would hand to b.
    const accounts = [account('a', '1931'), account('b', '1930'), account('c', '1941')]
    expect(suggestLedgerChanges(accounts, [hits('a', '1930', 46), hits('c', '1931', 30)])).toEqual([])
  })

  it('lets the holder move first when its evidence points to a third account', () => {
    const accounts = [account('a', '1940'), account('b', '1920', { bank_connection_id: 'conn-2' })]
    const rows = [hits('a', '1920', 46), hits('b', '1950', 20)]
    // Only the holder's own move now; the other follows once 1920 is free.
    expect(suggestLedgerChanges(accounts, rows).map((s) => [s.kind, s.moves[0].cashAccountId, s.moves[0].to])).toEqual([
      ['move', 'b', '1950'],
    ])
    const afterwards = [account('a', '1940'), account('b', '1950', { bank_connection_id: 'conn-2' })]
    expect(suggestLedgerChanges(afterwards, [hits('a', '1920', 46)]).map((s) => s.moves[0].to)).toEqual(['1920'])
  })

  it('suggests a ledger account held by a row nothing syncs onto', () => {
    const holders = [
      account('m', '1920', { bank_connection_id: null }),
      account('m', '1920', { enabled: false }),
      account('m', '1920', { bank_connection_id: 'conn-old', connection_status: 'revoked' }),
    ]
    for (const holder of holders) {
      expect(suggestLedgerChanges([account('a', '1940'), holder], [hits('a', '1920', 46)]).map((s) => s.kind)).toEqual(['move'])
    }
  })

  it('leaves both alone when two accounts point at the same ledger account', () => {
    const accounts = [account('a', '1940'), account('b', '1941')]
    expect(suggestLedgerChanges(accounts, [hits('a', '1920', 46), hits('b', '1920', 46)])).toEqual([])
  })

  it('does not swap when a third account wants one of the two ledger accounts', () => {
    const accounts = [account('a', '1940'), account('b', '1920'), account('c', '1941')]
    const rows = [hits('a', '1920', 46), hits('b', '1940', 30), hits('c', '1940', 30)]
    expect(suggestLedgerChanges(accounts, rows)).toEqual([])
  })

  it('reads evidence only for accounts a live connection syncs onto', () => {
    const rows = [hits('a', '1920', 46)]
    expect(suggestLedgerChanges([account('a', '1940', { bank_connection_id: null })], rows)).toEqual([])
    expect(suggestLedgerChanges([account('a', '1940', { enabled: false })], rows)).toEqual([])
    expect(suggestLedgerChanges([account('a', '1940', { connection_status: 'revoked' })], rows)).toEqual([])
    // Evidence for an account that is not in the list is dropped.
    expect(suggestLedgerChanges([account('z', '1930')], rows)).toEqual([])
  })
})
