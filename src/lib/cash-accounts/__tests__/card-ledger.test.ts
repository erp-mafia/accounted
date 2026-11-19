import { describe, it, expect } from 'vitest'
import {
  CARD_LEDGER_ORDER,
  cardLedgersOf,
  isCardCashAccount,
  isCardLedgerAccount,
  suggestCardLedger,
} from '../card-ledger'

describe('isCardLedgerAccount', () => {
  it.each(['2480', '2485', '2489', '2890', '2894', '2896', '2899'])('accepts %s', (account) => {
    expect(isCardLedgerAccount(account)).toBe(true)
  })

  it.each(['2893', '2891', '2892', '2895', '2897', '2898', '2440', '1930', '2490', '28900', '', null, undefined])(
    'refuses %s',
    (account) => {
      expect(isCardLedgerAccount(account as string)).toBe(false)
    },
  )
})

describe('isCardCashAccount / cardLedgersOf', () => {
  it('reads a row without kind as a bank row', () => {
    expect(isCardCashAccount({})).toBe(false)
    expect(isCardCashAccount({ kind: 'bank' })).toBe(false)
    expect(isCardCashAccount({ kind: 'card' })).toBe(true)
    expect(isCardCashAccount(null)).toBe(false)
  })

  it('lists the card ledgers only', () => {
    expect(cardLedgersOf([
      { kind: 'bank', ledger_account: '1930' },
      { kind: 'card', ledger_account: '2890' },
      { ledger_account: '1686' },
      { kind: 'card', ledger_account: '2899' },
    ])).toEqual(['2890', '2899'])
  })
})

describe('suggestCardLedger', () => {
  it('suggests 2890 when nothing uses it', () => {
    expect(suggestCardLedger({ taken: ['1930'], usage: {} })).toEqual({ ledger: '2890', skipped: null })
  })

  it('suggests 2899 and reports 2890 when other verifikat use 2890', () => {
    expect(suggestCardLedger({ taken: ['1930'], usage: { '2890': { lines: 12, balance: -8450 } } })).toEqual({
      ledger: '2899',
      skipped: { ledger: '2890', lines: 12, balance: -8450 },
    })
  })

  it('skips a ledger another card holds without reporting it', () => {
    expect(suggestCardLedger({ taken: ['2890'], usage: {} })).toEqual({ ledger: '2899', skipped: null })
  })

  it('reports only a used ledger ahead of the suggestion', () => {
    // 2890 free and unused: suggested; 2899 used further down is not news.
    expect(suggestCardLedger({ taken: [], usage: { '2899': { lines: 3 } } })).toEqual({ ledger: '2890', skipped: null })
  })

  it('walks 2894, 2896 and kontokredit after 2899', () => {
    const usage = { '2890': { lines: 1 }, '2899': { lines: 2 }, '2894': { lines: 1 } }
    expect(suggestCardLedger({ taken: ['2896'], usage }).ledger).toBe('2480')
  })

  it('suggests the first free ledger, flagged, when every free one is in use', () => {
    const usage = Object.fromEntries(CARD_LEDGER_ORDER.map((ledger) => [ledger, { lines: 1 }]))
    expect(suggestCardLedger({ taken: ['2890'], usage })).toEqual({
      ledger: '2899',
      skipped: { ledger: '2899', lines: 1 },
    })
  })

  it('answers null when every card ledger is taken', () => {
    expect(suggestCardLedger({ taken: CARD_LEDGER_ORDER, usage: {} })).toEqual({ ledger: null, skipped: null })
  })

  it('never suggests 2893', () => {
    expect(CARD_LEDGER_ORDER).not.toContain('2893')
    expect(CARD_LEDGER_ORDER.every(isCardLedgerAccount)).toBe(true)
  })
})
