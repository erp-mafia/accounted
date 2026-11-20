import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { hasErrorEntry } from '@/lib/errors/structured-errors'
import {
  bankAccountLabel,
  ibanLast4,
  ledgerSyncedElsewhereMessage,
  namedSelectionRefusal,
  parseSelectionRefusalDetail,
  type SelectionRefusalDetail,
} from '../selection-refusal'

// The shape public.cash_account_refusal_detail() returns (20261005124500).
function detail(overrides: Record<string, unknown> = {}, account: Record<string, unknown> = {}) {
  return JSON.stringify({
    ledger_account: '1930',
    cash_account: {
      id: '7a0f0c1e-0000-4000-8000-000000000001', ledger_account: '1931', name: 'Företagskonto',
      iban_last4: '7466', currency: 'SEK', enabled: true, bank_name: 'SEB', connection_status: 'active', connection_live: true,
      ...account,
    },
    ...overrides,
  })
}
const parsed = (overrides: Record<string, unknown> = {}, account: Record<string, unknown> = {}) =>
  parseSelectionRefusalDetail(detail(overrides, account)) as SelectionRefusalDetail
const DASHES = /[\u2013\u2014]/

describe('parseSelectionRefusalDetail', () => {
  it('reads the detail the database attaches to a refusal', () => {
    expect(parsed({ dependencies: ['reconciliation-attachment'] })).toEqual({
      ledger_account: '1930',
      cash_account: {
        id: '7a0f0c1e-0000-4000-8000-000000000001', ledger_account: '1931', name: 'Företagskonto',
        iban_last4: '7466', currency: 'SEK', bank_name: 'SEB', connection_live: true,
      },
      dependencies: ['reconciliation-attachment'],
    })
  })

  it.each([
    ['no detail', null],
    ['a plain sentence', 'Failing row contains (...)'],
    ['broken JSON', '{"ledger_account":'],
    ['a ledger outside class 19', detail({ ledger_account: '2440' })],
    ['no cash account', JSON.stringify({ ledger_account: '1930' })],
    ['a cash account without id', detail({}, { id: null })],
  ])('ignores %s', (_label, raw) => {
    expect(parseSelectionRefusalDetail(raw)).toBeNull()
  })
})

describe('bankAccountLabel', () => {
  it.each([
    [{ name: 'Företagskonto', bank_name: 'SEB', iban_last4: '7466' }, 'bankkontot Företagskonto (SEB ••7466)'],
    [{ name: 'Företagskonto (SEK)' }, 'bankkontot Företagskonto (SEK)'],
    [{ bank_name: 'Swedbank', iban_last4: '1234' }, 'bankkontot Swedbank ••1234'],
    [{ name: '  ' }, 'ett annat bankkonto'],
  ])('names %j as %s', (account, label) => {
    expect(bankAccountLabel(account)).toBe(label)
  })

  it('takes the IBAN tail after removing the spaces banks format it with', () => {
    expect(ibanLast4('SE45 5000 0000 0583 9825 7466')).toBe('7466')
    expect(ibanLast4(null)).toBeUndefined()
  })
})

describe('namedSelectionRefusal', () => {
  it('names the account, both ledgers and the way out when the moving account cannot be retired', () => {
    const sentence = namedSelectionRefusal('CASH_ACCOUNT_RETIREMENT_HAS_DEPENDENCIES',
      parsed({ dependencies: ['reconciliation-attachment', 'invoice-configuration'] }))
    expect(sentence).toBe('Bankkontot Företagskonto (SEB ••7466) kan inte flyttas från 1931 till 1930 automatiskt, eftersom kontot på 1931 '
      + 'har underlag bifogade till en avstämning och har betalningsuppgifter för fakturor. Inget sparades. '
      + 'Behåll 1931, eller kontakta supporten så hjälper vi dig att flytta det.')
  })

  it('tells a ledger another connection syncs the same account onto apart from another physical account', () => {
    const claimed = namedSelectionRefusal('CASH_ACCOUNT_LEDGER_CLAIMED', parsed({}, { ledger_account: '1930' }))
    expect(claimed).toContain('Bokföringskonto 1930 används redan av bankkontot Företagskonto (SEB ••7466), som hämtas via en annan bankkoppling.')
    expect(claimed).toContain('koppla från den andra under Inställningar > Kopplingar > Bank')

    const synced = namedSelectionRefusal('CASH_ACCOUNT_KEEPER_IDENTITY_CONFLICT', parsed({}, { ledger_account: '1930' }))
    expect(synced).toBe(ledgerSyncedElsewhereMessage([{ ledger: '1930', label: 'bankkontot Företagskonto (SEB ••7466)' }]))
    expect(synced).toContain('Inställningar > Kopplingar > Bank, tre punkter vid den banken, Välj konton')

    const manual = namedSelectionRefusal('CASH_ACCOUNT_KEEPER_IDENTITY_CONFLICT',
      parsed({}, { ledger_account: '1930', name: 'Sparkonto', bank_name: null, connection_live: false }))
    expect(manual).toContain('Bokföringskonto 1930 tillhör redan bankkontot Sparkonto (••7466), ett annat bankkonto')
    expect(manual).toContain('ta bort det under Inställningar > Bokföring')
  })

  it('names the unchecked account that keeps the ledger because of its history', () => {
    expect(namedSelectionRefusal('BANK_SELECTION_YIELD_HAS_HISTORY', parsed({}, { ledger_account: '1930', connection_live: true })))
      .toContain('Bokföringskonto 1930 hör till bankkontot Företagskonto (SEB ••7466), som inte synkas men har transaktioner')
  })

  it.each([
    'CASH_ACCOUNT_RETIREMENT_HAS_DEPENDENCIES', 'CASH_ACCOUNT_RETIREMENT_IDENTITY_CONFLICT', 'CASH_ACCOUNT_RETIREMENT_STILL_LIVE',
    'CASH_ACCOUNT_LEDGER_CLAIMED', 'CASH_ACCOUNT_KEEPER_IDENTITY_CONFLICT', 'BANK_SELECTION_YIELD_HAS_HISTORY',
  ])('answers %s in Swedish without dashes', code => {
    const sentence = namedSelectionRefusal(code, parsed({ dependencies: ['invoice-reference'] }))
    expect(sentence).toMatch(/Inget sparades\./)
    expect(sentence).not.toMatch(DASHES)
    expect(sentence).not.toContain('undefined')
  })

  it('leaves the registry sentence standing without a detail or for another code', () => {
    expect(namedSelectionRefusal('CASH_ACCOUNT_LEDGER_CLAIMED', null)).toBeNull()
    expect(namedSelectionRefusal('BANK_CONFIGURATION_CHANGED', parsed())).toBeNull()
  })

  it('lists several contested ledgers in one sentence', () => {
    const sentence = ledgerSyncedElsewhereMessage([
      { ledger: '1930', label: 'bankkontot Företagskonto (SEB ••7466)' },
      { ledger: '1935', label: 'bankkontot Sparkonto' },
    ])
    expect(sentence).toContain('1930 av bankkontot Företagskonto (SEB ••7466) och 1935 av bankkontot Sparkonto')
    expect(sentence).not.toMatch(DASHES)
  })
})

// Each name the selection save can raise under 23514/23505 must have a
// registry entry: an unknown one is answered "Förfrågan innehåller ogiltiga
// uppgifter", which is how crm#1021 reached the user. Reads the newest
// definition of each function, so a later migration that adds a refusal
// fails here until the refusal gets a sentence.
describe('every selection refusal the database raises is registered', () => {
  const dir = resolve(__dirname, '../../../../supabase/migrations')
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()
  function latestDefinition(fn: string): string {
    const marker = `FUNCTION public.${fn}(`
    const file = [...files].reverse().find((f) => readFileSync(resolve(dir, f), 'utf8').includes(`CREATE OR REPLACE ${marker}`))
    expect(file, `no CREATE OR REPLACE FUNCTION public.${fn} in supabase/migrations`).toBeDefined()
    const sql = readFileSync(resolve(dir, file!), 'utf8')
    const start = sql.indexOf(`CREATE OR REPLACE ${marker}`)
    const body = sql.slice(start)
    const end = body.search(/\n\$(function)?\$;/)
    return end === -1 ? body : body.slice(0, end)
  }

  it.each(['save_bank_account_selection', 'promote_psd2_cash_account'])('%s', (fn) => {
    const refusals = [...latestDefinition(fn).matchAll(/RAISE EXCEPTION '([A-Z_]+)' USING ERRCODE = '(\w+)'/g)]
      .filter(([, , sqlstate]) => sqlstate === '23514' || sqlstate === '23505')
      .map(([, name]) => name)
    expect(refusals.length).toBeGreaterThan(0)
    expect(refusals.filter((name) => !hasErrorEntry(name))).toEqual([])
  })
})
