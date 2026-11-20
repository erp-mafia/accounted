import { describe, expect, it } from 'vitest'
import sv from '@/messages/sv.json'
import en from '@/messages/en.json'
import {
  buildGiroRegister,
  counterpartyGiroDigits,
  giroCounterpartyForWire,
  giroKey,
  giroSentence,
  giroShortLabel,
  mayReadGiro,
  readGiroCounterparty,
  type GiroCounterparty,
  type GiroRow,
} from '../giro-counterparty'

// Valid check digits (Luhn), invented numbers: 123-4566, 999-0003 and
// 1234-5674 are bankgiro numbers, 12345-5 a plusgiro number.
const OWN_BG = '123-4566'
const SUPPLIER_BG = '999-0003'
const SUPPLIER_BG8 = '1234-5674'
const SUPPLIER_PG = '12345-5'

const register = buildGiroRegister({
  own: [{ bankgiro: OWN_BG, plusgiro: null }],
  suppliers: [
    { name: 'Leverantör AB', bankgiro: SUPPLIER_BG, plusgiro: null },
    { name: 'Plusleverantör AB', bankgiro: null, plusgiro: SUPPLIER_PG },
    { name: 'Faktura Finans AB', bankgiro: SUPPLIER_BG8, plusgiro: null },
    { name: 'Annan Kund AB', bankgiro: SUPPLIER_BG8, plusgiro: null },
    // A card that wrongly carries the company's own bankgiro never names a row.
    { name: 'Felregistrerad AB', bankgiro: '1234566', plusgiro: null },
  ],
})

function row(overrides: Partial<GiroRow>): GiroRow {
  return { amount: -100, description: '', merchant_name: null, counterparty_account: null, reference: null, ...overrides }
}

describe('giroKey', () => {
  it('drops formatting and the zero padding banks add', () => {
    expect(giroKey('123-4566')).toBe('1234566')
    expect(giroKey('0000001234566')).toBe('1234566')
    expect(giroKey(null)).toBe('')
  })
})

describe('readGiroCounterparty: Bankgirot through the company own giro', () => {
  it.each([
    ['BG 123-4566  00012', 'SEB deposit with serial'],
    ['BG 1234566', 'unformatted'],
    ['BGGIRERING 1234566', 'Danske Bank'],
    ['BI  1234566 00012', 'Danske Bank'],
    ['1234566: Bankgiro inbetalning', 'Swedbank statement file'],
    ['1234566 BG-INSÄTTNING', 'Länsförsäkringar'],
  ])('reads %s (%s) as a deposit to the own bankgiro on file', (description) => {
    expect(readGiroCounterparty(row({ amount: 500, description }), register)).toEqual({
      kind: 'own_deposit',
      scheme: 'bankgiro',
      giro: OWN_BG,
      onFile: true,
    })
  })

  it('reads the Swedbank feed, which sends the number as the reference', () => {
    expect(
      readGiroCounterparty(row({ amount: 500, description: 'Bankgiro inbetalning', reference: '1234566' }), register),
    ).toMatchObject({ kind: 'own_deposit', giro: OWN_BG, onFile: true })
  })

  it('says likely, not on file, when the company has no bankgiro registered', () => {
    expect(readGiroCounterparty(row({ amount: 500, description: 'BG 555-0009 00003' }), register)).toEqual({
      kind: 'own_deposit',
      scheme: 'bankgiro',
      giro: '555-0009',
      onFile: false,
    })
    expect(readGiroCounterparty(row({ amount: 500, description: 'BG 555-0009' }), null)).toMatchObject({ onFile: false })
  })

  it('reads a leverantörsbetalning as a payout from the own bankgiro, even when a supplier card carries it', () => {
    expect(readGiroCounterparty(row({ amount: -900, description: 'LBE 123-4566' }), register)).toEqual({
      kind: 'own_payout',
      scheme: 'bankgiro',
      giro: OWN_BG,
      onFile: true,
    })
    expect(readGiroCounterparty(row({ amount: -900, description: 'LBS9990-0003' }), register)).toMatchObject({
      kind: 'own_payout',
      onFile: false,
    })
  })

  it('never reads a phrase against the sign of the row', () => {
    expect(readGiroCounterparty(row({ amount: -500, description: '1234566: Bankgiro inbetalning' }), register)).toMatchObject({
      kind: 'own_payout',
      onFile: true,
    })
    expect(readGiroCounterparty(row({ amount: 500, description: 'LBE 555-0009' }), register)).toBeNull()
  })

  it('ignores a phrase whose number fails the check digit', () => {
    expect(readGiroCounterparty(row({ amount: 500, description: 'BG 555-0001' }), null)).toBeNull()
  })

  it('reads a bare number as the own giro only when it is the one on file', () => {
    expect(readGiroCounterparty(row({ amount: 500, description: '1234566 00017' }), register)).toMatchObject({
      kind: 'own_deposit',
      onFile: true,
    })
    expect(readGiroCounterparty(row({ amount: 500, description: '5550009 00017' }), register)).toBeNull()
  })
})

describe('readGiroCounterparty: a supplier from the register', () => {
  it('names the supplier behind the counterparty bankgiro of an outgoing row', () => {
    expect(
      readGiroCounterparty(row({ description: '40012345678', counterparty_account: SUPPLIER_BG }), register),
    ).toEqual({ kind: 'supplier', scheme: 'bankgiro', giro: SUPPLIER_BG, name: 'Leverantör AB' })
  })

  it('names it from a BG or PG number in the text, zero padded or not', () => {
    expect(readGiroCounterparty(row({ description: 'BG 0000009990003' }), register)).toMatchObject({ name: 'Leverantör AB' })
    expect(readGiroCounterparty(row({ description: '999-0003' }), register)).toMatchObject({ name: 'Leverantör AB' })
    expect(readGiroCounterparty(row({ description: 'PG 12345-5' }), register)).toEqual({
      kind: 'supplier',
      scheme: 'plusgiro',
      giro: SUPPLIER_PG,
      name: 'Plusleverantör AB',
    })
  })

  it('names nobody when several suppliers share the number (a factoring company)', () => {
    expect(readGiroCounterparty(row({ counterparty_account: SUPPLIER_BG8, description: '4001234' }), register)).toBeNull()
  })

  it('never names a supplier on a deposit: the giro on an incoming row is the receiving one', () => {
    expect(readGiroCounterparty(row({ amount: 500, counterparty_account: SUPPLIER_BG }), register)).toBeNull()
  })

  it('never trusts a bare number for a supplier', () => {
    expect(readGiroCounterparty(row({ description: '9990003' }), register)).toBeNull()
  })

  it('adds nothing when the bank already named the counterparty', () => {
    expect(readGiroCounterparty(row({ description: 'SOLAR SVERIGE AB BG 999-0003' }), register)).toBeNull()
    expect(
      readGiroCounterparty(row({ description: '40012345678', merchant_name: 'Leverantör AB', counterparty_account: SUPPLIER_BG }), register),
    ).toBeNull()
    expect(readGiroCounterparty(row({ amount: 500, description: 'Kund AB BG 123-4566' }), register)).toBeNull()
  })

  it('reads the bank text, not a title the person edited', () => {
    expect(
      readGiroCounterparty(row({ amount: 500, description: 'Kundbetalning', original_description: 'BG 123-4566 00012' }), register),
    ).toMatchObject({ kind: 'own_deposit' })
  })

  it('names nobody without a register, and for an unknown giro', () => {
    expect(readGiroCounterparty(row({ counterparty_account: SUPPLIER_BG }), null)).toBeNull()
    expect(readGiroCounterparty(row({ counterparty_account: '555-0009' }), register)).toBeNull()
  })
})

describe('counterpartyGiroDigits (the supplier-invoice matcher)', () => {
  it('returns the counterparty giro numbers of the row, named or not', () => {
    expect(counterpartyGiroDigits(row({ counterparty_account: SUPPLIER_BG, description: '40012345678' }))).toEqual(['9990003'])
    expect(counterpartyGiroDigits(row({ description: 'SOLAR SVERIGE AB BG 999-0003' }))).toEqual(['9990003'])
    expect(counterpartyGiroDigits(row({ description: 'TIC BG 0000009990003 Bg-bet. via internet' }))).toEqual(['9990003'])
  })

  it('returns nothing for Bankgirot settlement through the own giro, or a bare number', () => {
    expect(counterpartyGiroDigits(row({ description: 'LBE 999-0003' }))).toEqual([])
    expect(counterpartyGiroDigits(row({ description: '9990003' }))).toEqual([])
  })
})

describe('mayReadGiro', () => {
  it('is true only for rows a register could add something to', () => {
    expect(mayReadGiro(row({ amount: 500, description: 'BG 123-4566 00012' }))).toBe(true)
    expect(mayReadGiro(row({ counterparty_account: SUPPLIER_BG }))).toBe(true)
    expect(mayReadGiro(row({ description: 'Spotify AB' }))).toBe(false)
    expect(mayReadGiro(row({ description: 'Kortköp 123456' }))).toBe(false)
  })
})

describe('the words for a reading (drawer sentence, list label, API)', () => {
  const readings: GiroCounterparty[] = [
    { kind: 'own_deposit', scheme: 'bankgiro', giro: OWN_BG, onFile: true },
    { kind: 'own_deposit', scheme: 'bankgiro', giro: '555-0009', onFile: false },
    { kind: 'own_payout', scheme: 'plusgiro', giro: SUPPLIER_PG, onFile: true },
    { kind: 'own_payout', scheme: 'bankgiro', giro: '555-0009', onFile: false },
    { kind: 'supplier', scheme: 'bankgiro', giro: SUPPLIER_BG, name: 'Leverantör AB' },
  ]

  it('says likely when only the phrasing says the giro is the own one', () => {
    expect(readings.map((r) => giroSentence(r).key)).toEqual([
      'giro_own_deposit',
      'giro_own_deposit_likely',
      'giro_own_payout',
      'giro_own_payout_likely',
      'giro_supplier',
    ])
    expect(giroSentence(readings[4]!).values).toEqual({ giro: SUPPLIER_BG, scheme: 'bankgiro', name: 'Leverantör AB' })
    expect(giroShortLabel(readings[4]!)).toBe('Leverantör AB')
    expect(giroShortLabel(readings[0]!)).toEqual({ key: 'giro_short_own', values: { scheme: 'bankgiro' } })
    expect(giroShortLabel(readings[1]!)).toEqual({ key: 'giro_short_own_likely', values: {} })
  })

  it('has every message in Swedish and English', () => {
    const keys = new Set<string>(['drawer_counterparty'])
    for (const r of readings) {
      keys.add(giroSentence(r).key)
      const label = giroShortLabel(r)
      if (typeof label !== 'string') keys.add(label.key)
    }
    for (const messages of [sv, en] as Array<{ tx_inbox_card: Record<string, string> }>) {
      for (const key of keys) expect(messages.tx_inbox_card[key], key).toBeTruthy()
    }
  })

  it('carries snake case on the wire, with on_file or name', () => {
    expect(giroCounterpartyForWire(readings[1]!)).toEqual({ kind: 'own_deposit', scheme: 'bankgiro', giro: '555-0009', on_file: false })
    expect(giroCounterpartyForWire(readings[4]!)).toEqual({ kind: 'supplier', scheme: 'bankgiro', giro: SUPPLIER_BG, name: 'Leverantör AB' })
  })
})
