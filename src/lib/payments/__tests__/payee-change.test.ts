import { describe, expect, it } from 'vitest'
import {
  cardColumnsForKey,
  cardPayeeKeys,
  classifyPayeeChange,
  payeeAlertFor,
  payeeHoldFor,
  payeeKeyGiro,
  payeeKeyLabel,
  statedPayeeKey,
} from '../payee-change'

const CARD_BG = { bankgiro: '5050-1055', plusgiro: null, clearing_number: null, account_number: null, bank_account: null, iban: null }

describe('statedPayeeKey and cardPayeeKeys: the database key format, normalised', () => {
  it('reads the stated account in payment_order_payee_check order and normalises digits and IBANs', () => {
    expect(statedPayeeKey({ payee_bankgiro: '5050-1055', payee_plusgiro: '12345-6' })).toBe('bankgiro:50501055')
    expect(statedPayeeKey({ payee_plusgiro: ' 1234 56-6 ' })).toBe('plusgiro:1234566')
    expect(statedPayeeKey({ payee_clearing: '8327-9', payee_account: '123 456 789' })).toBe('bank_account:83279:123456789')
    expect(statedPayeeKey({ payee_clearing: '8327', payee_account: null })).toBeNull()
    expect(statedPayeeKey({ payee_iban: 'se45 5000 0000 0583 9825 7466' })).toBe('iban:SE4550000000058398257466')
    expect(statedPayeeKey({})).toBeNull()
  })

  it('lists every account on the card in payment priority, the free text only with a separator', () => {
    expect(
      cardPayeeKeys({
        bankgiro: '5050-1055',
        plusgiro: '1234566',
        clearing_number: '3300',
        account_number: '7001011234',
        bank_account: '8327-9 123456789',
        iban: 'SE4550000000058398257466',
      }),
    ).toEqual([
      'bankgiro:50501055',
      'plusgiro:1234566',
      'bank_account:3300:7001011234',
      'bank_account:8327:9123456789',
      'iban:SE4550000000058398257466',
    ])
    expect(cardPayeeKeys({ bank_account: '83279123456789' })).toEqual([])
    expect(cardPayeeKeys({})).toEqual([])
  })
})

describe('classifyPayeeChange', () => {
  it('is same when the invoice states nothing, or an account the card holds (any of them)', () => {
    expect(classifyPayeeChange({ invoice: {}, card: CARD_BG })).toEqual({ kind: 'same', statedKey: null, cardKey: 'bankgiro:50501055' })
    expect(classifyPayeeChange({ invoice: { payee_bankgiro: '50501055' }, card: CARD_BG }).kind).toBe('same')
    // The card has both; the invoice prints only the plusgiro.
    expect(classifyPayeeChange({ invoice: { payee_plusgiro: '1234566' }, card: { ...CARD_BG, plusgiro: '123456-6' } }).kind).toBe('same')
  })

  it('is changed when the card has accounts and the invoice states another, also across types', () => {
    expect(classifyPayeeChange({ invoice: { payee_bankgiro: '9020-0001' }, card: CARD_BG })).toEqual({
      kind: 'changed',
      statedKey: 'bankgiro:90200001',
      cardKey: 'bankgiro:50501055',
    })
    // The backfill would have made this bankgiro the card's payment account silently.
    expect(classifyPayeeChange({ invoice: { payee_bankgiro: '9020-0001' }, card: { plusgiro: '1234566' } }).kind).toBe('changed')
    expect(classifyPayeeChange({ invoice: { payee_iban: 'SE4550000000058398257466' }, card: CARD_BG }).kind).toBe('changed')
  })

  it('is new_supplier_account when the card has no account at all', () => {
    expect(classifyPayeeChange({ invoice: { payee_bankgiro: '9020-0001' }, card: {} })).toEqual({
      kind: 'new_supplier_account',
      statedKey: 'bankgiro:90200001',
      cardKey: null,
    })
  })

  it('is first_payment for a card account nobody paid, only when the caller read the paid accounts', () => {
    const invoice = { payee_bankgiro: '5050-1055' }
    expect(classifyPayeeChange({ invoice, card: CARD_BG, paidPayeeKeys: [] }).kind).toBe('first_payment')
    expect(classifyPayeeChange({ invoice, card: CARD_BG, paidPayeeKeys: ['bankgiro:50501055'] }).kind).toBe('same')
    expect(classifyPayeeChange({ invoice, card: CARD_BG }).kind).toBe('same')
  })
})

describe('payeeAlertFor and payeeHoldFor', () => {
  it('alerts a changed account always, a new one only for a supplier paid before, never the rest', () => {
    expect(payeeAlertFor('changed', false)).toBe('changed')
    expect(payeeAlertFor('new_supplier_account', true)).toBe('new_supplier_account')
    expect(payeeAlertFor('new_supplier_account', false)).toBeNull()
    expect(payeeAlertFor('first_payment', true)).toBeNull()
    expect(payeeAlertFor('same', true)).toBeNull()
  })

  it('holds until confirmed; a rejection holds for good', () => {
    expect(payeeHoldFor('changed', null)).toBe('payee_unconfirmed')
    expect(payeeHoldFor('new_supplier_account', null)).toBe('payee_unconfirmed')
    expect(payeeHoldFor('changed', 'rejected')).toBe('payee_rejected')
    expect(payeeHoldFor('changed', 'confirmed')).toBeNull()
    expect(payeeHoldFor(null, 'rejected')).toBeNull()
  })
})

describe('labels and card columns', () => {
  it('labels a key as people read it and finds the giro for a lookup', () => {
    expect(payeeKeyLabel('bankgiro:50501055')).toBe('BG 5050-1055')
    expect(payeeKeyLabel('plusgiro:1234566')).toBe('PG 123456-6')
    expect(payeeKeyLabel('bank_account:8327:123456789')).toBe('8327 123456789')
    expect(payeeKeyLabel('iban:SE4550000000058398257466')).toBe('IBAN SE45 5000 0000 0583 9825 7466')
    expect(payeeKeyGiro('bankgiro:50501055')).toEqual({ giro: '50501055', type: 'bankgiro' })
    expect(payeeKeyGiro('bank_account:8327:123456789')).toBeNull()
  })

  it('writes the account so a payment reads it first, keeping lower accounts', () => {
    expect(cardColumnsForKey('bankgiro:90200001')).toEqual({ bankgiro: '9020-0001' })
    expect(cardColumnsForKey('plusgiro:1234566')).toEqual({ bankgiro: null, plusgiro: '123456-6' })
    expect(cardColumnsForKey('bank_account:8327:123456789')).toEqual({ bankgiro: null, plusgiro: null, clearing_number: '8327', account_number: '123456789' })
    expect(cardColumnsForKey('iban:SE4550000000058398257466')).toEqual({ iban: 'SE4550000000058398257466' })
    expect(cardColumnsForKey('nonsense')).toBeNull()
    // What it writes resolves back to the same key on the card.
    for (const key of ['bankgiro:90200001', 'plusgiro:1234566', 'bank_account:8327:123456789']) {
      expect(cardPayeeKeys({ ...CARD_BG, plusgiro: '1111111', ...cardColumnsForKey(key) })[0]).toBe(key)
    }
  })
})
