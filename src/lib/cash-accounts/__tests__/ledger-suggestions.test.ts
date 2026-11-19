import { describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createTableMockSupabase } from '@/tests/helpers'
import { loadLedgerSuggestions } from '../ledger-suggestions'

const COMPANY = 'company-1'

function cashRow(id: string, ledger: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    ledger_account: ledger,
    bank_connection_id: 'conn-1',
    enabled: true,
    external_uid: `uid-${id}`,
    iban: `SE00000000000000000${id.padStart(5, '0')}`,
    name: `Konto ${id}`,
    currency: 'SEK',
    ...overrides,
  }
}

function stored(id: string, overrides: Record<string, unknown> = {}) {
  return { uid: `uid-${id}`, iban: `SE00000000000000000${id.padStart(5, '0')}`, currency: 'SEK', enabled: true, ...overrides }
}

function connection(id: string, accounts: unknown[], overrides: Record<string, unknown> = {}) {
  return { id, bank_name: 'Testbanken', status: 'active', accounts_data: accounts, ...overrides }
}

function hits(cashAccountId: string, ledger: string, n: number) {
  return { cash_account_id: cashAccountId, kind: 'transactions', ledger_account: ledger, hits: n, balance_date: null }
}

function balance(cashAccountId: string, ledger: string, day: string) {
  return { cash_account_id: cashAccountId, kind: 'balance', ledger_account: ledger, hits: null, balance_date: day }
}

function setup(tables: Record<string, unknown>) {
  const mock = createTableMockSupabase(
    Object.fromEntries(Object.entries(tables).map(([key, data]) => [key, { data }])),
  )
  return { ...mock, client: mock.supabase as unknown as SupabaseClient }
}

describe('loadLedgerSuggestions', () => {
  it('reads no ledger evidence for a company with no connected bank account', async () => {
    const { client, findCall } = setup({
      bank_connections: [],
      cash_accounts: [cashRow('1', '1930', { bank_connection_id: null, external_uid: null })],
    })

    expect(await loadLedgerSuggestions(client, COMPANY)).toEqual({ connectionFound: true, suggestions: [] })
    expect(findCall('rpc:cash_account_ledger_evidence', 'rpc')).toBeUndefined()
  })

  it('does not count an account left on a revoked connection as connected', async () => {
    const { client, findCall } = setup({
      bank_connections: [connection('conn-1', [stored('4417')], { status: 'revoked' })],
      cash_accounts: [cashRow('4417', '1940')],
    })

    expect((await loadLedgerSuggestions(client, COMPANY)).suggestions).toEqual([])
    expect(findCall('rpc:cash_account_ledger_evidence', 'rpc')).toBeUndefined()
  })

  it('answers a move with its names, its booked transactions and the picker request that makes it', async () => {
    const { client, findCall } = setup({
      bank_connections: [
        connection('conn-1', [
          stored('4417'),
          stored('2210'),
          stored('9999', { enabled: false }),
          // A mirror card account is never switched on, whatever its flag says.
          { uid: 'uid-card', name: 'SVEA_MQ_Debit_B2B', currency: 'SEK', enabled: true },
        ]),
      ],
      cash_accounts: [cashRow('4417', '1940'), cashRow('2210', '1930')],
      'rpc:cash_account_ledger_evidence': [hits('4417', '1920', 46)],
      chart_of_accounts: [
        { account_number: '1920', account_name: 'PlusGiro' },
        { account_number: '1940', account_name: 'Övriga bankkonton' },
      ],
      'rpc:cash_account_booked_rows': 12,
    })

    const { suggestions } = await loadLedgerSuggestions(client, COMPANY)

    expect(suggestions).toEqual([
      {
        id: 'move:4417>1920',
        kind: 'move',
        accounts: [
          {
            cash_account_id: '4417',
            connection_id: 'conn-1',
            uid: 'uid-4417',
            label: '••4417',
            from_ledger: '1940',
            from_ledger_name: 'Övriga bankkonton',
            to_ledger: '1920',
            to_ledger_name: 'PlusGiro',
            basis: 'transactions',
            hits: 46,
            balance_date: null,
            booked_rows: 12,
          },
        ],
        // Only the moved account is mapped: every other account keeps its ledger account.
        selection: {
          connection_id: 'conn-1',
          enabled_uids: ['uid-4417', 'uid-2210'],
          account_mappings: [{ uid: 'uid-4417', ledger_account: '1920' }],
        },
        one_click: true,
        two_connections: false,
      },
    ])
    expect(findCall('rpc:cash_account_ledger_evidence', 'rpc')).toEqual([{ p_company_id: COMPANY }])
    expect(findCall('rpc:cash_account_booked_rows', 'rpc')).toEqual([{ p_company_id: COMPANY, p_cash_account_id: '4417' }])
    expect(findCall('chart_of_accounts', 'in')).toEqual(['account_number', ['1940', '1920']])
  })

  it('names an account without an IBAN by its name, and a ledger account without a chart name by its number', async () => {
    const { client } = setup({
      bank_connections: [connection('conn-1', [stored('1', { iban: undefined })])],
      cash_accounts: [cashRow('1', '1940', { iban: null, name: 'Sparkonto' })],
      'rpc:cash_account_ledger_evidence': [balance('1', '1920', '2025-12-31')],
      chart_of_accounts: [],
      'rpc:cash_account_booked_rows': 0,
    })

    const [suggestion] = (await loadLedgerSuggestions(client, COMPANY)).suggestions
    expect(suggestion.accounts[0]).toMatchObject({
      label: 'Sparkonto',
      to_ledger_name: null,
      basis: 'balance',
      hits: 0,
      balance_date: '2025-12-31',
      booked_rows: 0,
    })
  })

  it('makes a swap inside one connection a single save', async () => {
    const { client } = setup({
      bank_connections: [connection('conn-1', [stored('4417'), stored('2210')])],
      cash_accounts: [cashRow('4417', '1940'), cashRow('2210', '1920')],
      'rpc:cash_account_ledger_evidence': [hits('4417', '1920', 46), hits('2210', '1940', 30)],
      chart_of_accounts: [],
      'rpc:cash_account_booked_rows': 0,
    })

    const [swap] = (await loadLedgerSuggestions(client, COMPANY)).suggestions
    expect(swap).toMatchObject({ id: 'swap:2210>1940|4417>1920', kind: 'swap', one_click: true, two_connections: false })
    expect(swap.selection).toEqual({
      connection_id: 'conn-1',
      enabled_uids: ['uid-4417', 'uid-2210'],
      account_mappings: [
        { uid: 'uid-2210', ledger_account: '1940' },
        { uid: 'uid-4417', ledger_account: '1920' },
      ],
    })
  })

  it('makes a one-sided swap a single save that moves both accounts', async () => {
    const { client, findCalls } = setup({
      bank_connections: [connection('conn-1', [stored('4417'), stored('2210')])],
      // The busy account sits on 1931 because the other one took 1930.
      cash_accounts: [cashRow('4417', '1931'), cashRow('2210', '1930')],
      'rpc:cash_account_ledger_evidence': [hits('4417', '1930', 46)],
      chart_of_accounts: [{ account_number: '1930', account_name: 'Företagskonto' }],
      'rpc:cash_account_booked_rows': 0,
    })

    const [swap] = (await loadLedgerSuggestions(client, COMPANY)).suggestions
    expect(swap).toMatchObject({ id: 'one_sided_swap:2210>1931|4417>1930', kind: 'one_sided_swap', one_click: true, two_connections: false })
    // The account with the evidence first, then the one that makes room.
    expect(swap.accounts.map((a) => [a.label, a.from_ledger, a.to_ledger, a.basis, a.hits])).toEqual([
      ['••4417', '1931', '1930', 'transactions', 46],
      ['••2210', '1930', '1931', null, 0],
    ])
    // Both accounts are mapped in the one request: one half would put two accounts on 1930.
    expect(swap.selection).toEqual({
      connection_id: 'conn-1',
      enabled_uids: ['uid-4417', 'uid-2210'],
      account_mappings: [
        { uid: 'uid-4417', ledger_account: '1930' },
        { uid: 'uid-2210', ledger_account: '1931' },
      ],
    })
    // Rows booked under the current mapping are counted for both accounts.
    expect(findCalls('rpc:cash_account_booked_rows', 'rpc').map(([args]) => (args as { p_cash_account_id: string }).p_cash_account_id)).toEqual([
      '4417',
      '2210',
    ])
  })

  it('offers no single save for a swap across two connections', async () => {
    const { client } = setup({
      bank_connections: [connection('conn-1', [stored('4417')]), connection('conn-2', [stored('2210')])],
      cash_accounts: [cashRow('4417', '1940'), cashRow('2210', '1920', { bank_connection_id: 'conn-2' })],
      'rpc:cash_account_ledger_evidence': [hits('4417', '1920', 46), hits('2210', '1940', 30)],
      chart_of_accounts: [],
      'rpc:cash_account_booked_rows': 0,
    })

    const [swap] = (await loadLedgerSuggestions(client, COMPANY)).suggestions
    expect(swap).toMatchObject({ kind: 'swap', selection: null, one_click: false, two_connections: true })
  })

  it('keeps the picker request but not the one click while the connection waits for its account selection', async () => {
    const { client } = setup({
      bank_connections: [connection('conn-1', [stored('4417')], { status: 'pending_selection' })],
      cash_accounts: [cashRow('4417', '1940')],
      'rpc:cash_account_ledger_evidence': [hits('4417', '1920', 46)],
      chart_of_accounts: [],
      'rpc:cash_account_booked_rows': 0,
    })

    const [suggestion] = (await loadLedgerSuggestions(client, COMPANY)).suggestions
    expect(suggestion.one_click).toBe(false)
    expect(suggestion.selection?.account_mappings).toEqual([{ uid: 'uid-4417', ledger_account: '1920' }])
  })

  it('finds the account by IBAN when a renewed consent gave it a new uid', async () => {
    const { client } = setup({
      bank_connections: [connection('conn-1', [stored('4417', { uid: 'uid-renewed', iban: 'se00 0000 0000 0000 0000 4417' })])],
      cash_accounts: [cashRow('4417', '1940', { iban: 'SE0000000000000000004417' })],
      'rpc:cash_account_ledger_evidence': [hits('4417', '1920', 46)],
      chart_of_accounts: [],
      'rpc:cash_account_booked_rows': 0,
    })

    const [suggestion] = (await loadLedgerSuggestions(client, COMPANY)).suggestions
    expect(suggestion.accounts[0].uid).toBe('uid-renewed')
    expect(suggestion.selection?.account_mappings).toEqual([{ uid: 'uid-renewed', ledger_account: '1920' }])
  })

  it('offers no save for an account that is missing from, or switched off in, its connection', async () => {
    for (const accounts of [[stored('other')], [stored('4417', { enabled: false })]]) {
      const { client } = setup({
        bank_connections: [connection('conn-1', accounts)],
        cash_accounts: [cashRow('4417', '1940', { iban: 'SE0000000000000000004417' })],
        'rpc:cash_account_ledger_evidence': [hits('4417', '1920', 46)],
        chart_of_accounts: [],
        'rpc:cash_account_booked_rows': 0,
      })

      const [suggestion] = (await loadLedgerSuggestions(client, COMPANY)).suggestions
      expect(suggestion).toMatchObject({ selection: null, one_click: false, two_connections: false })
    }
  })

  it('answers only the asked connection, and says so when the company has no such connection', async () => {
    const tables = {
      bank_connections: [connection('conn-1', [stored('4417')]), connection('conn-2', [stored('2210')])],
      cash_accounts: [cashRow('4417', '1940'), cashRow('2210', '1941', { bank_connection_id: 'conn-2' })],
      'rpc:cash_account_ledger_evidence': [hits('4417', '1920', 46), hits('2210', '1921', 30)],
      chart_of_accounts: [],
      'rpc:cash_account_booked_rows': 0,
    }

    const all = await loadLedgerSuggestions(setup(tables).client, COMPANY)
    expect(all.suggestions.map((s) => s.id)).toEqual(['move:4417>1920', 'move:2210>1921'])

    const one = await loadLedgerSuggestions(setup(tables).client, COMPANY, { connectionId: 'conn-2' })
    expect(one.suggestions.map((s) => s.id)).toEqual(['move:2210>1921'])

    const missing = setup(tables)
    expect(await loadLedgerSuggestions(missing.client, COMPANY, { connectionId: 'conn-3' })).toEqual({
      connectionFound: false,
      suggestions: [],
    })
    expect(missing.findCall('rpc:cash_account_ledger_evidence', 'rpc')).toBeUndefined()
  })

  it('throws a failed read with its database code, never an empty answer', async () => {
    const mock = createTableMockSupabase({
      bank_connections: { data: [connection('conn-1', [stored('4417')])] },
      cash_accounts: { data: [cashRow('4417', '1940')] },
      'rpc:cash_account_ledger_evidence': { error: { message: 'canceling statement due to statement timeout', code: '57014' } },
    })

    await expect(loadLedgerSuggestions(mock.supabase as unknown as SupabaseClient, COMPANY)).rejects.toMatchObject({ code: '57014' })
  })
})
