import { describe, expect, it } from 'vitest'
import { bicFromSwedishIban, resolveDebtor } from '../debtor'
import { normalizeSignerPersonalNumber } from '@/lib/auth/bankid-signer'
import { resolveOrderPayee } from '../payee'

const CARD_BG = { bankgiro: '5050-1055', plusgiro: null, bank_account: null }
const NO_CARD = { bankgiro: null, plusgiro: null, bank_account: null }

describe('resolveOrderPayee', () => {
  it('pays the card account when the invoice states the same one', () => {
    expect(resolveOrderPayee({ payee_bankgiro: '5050-1055' }, CARD_BG)).toEqual({
      ok: true,
      payee: { type: 'bankgiro', bankgiro: '50501055' },
      source: 'supplier',
      check: 'known',
      alternative: null,
    })
  })

  it('defaults to the card and flags a different account on the invoice', () => {
    const result = resolveOrderPayee({ payee_bankgiro: '5402-0102' }, CARD_BG)
    expect(result).toMatchObject({
      ok: true,
      payee: { type: 'bankgiro', bankgiro: '50501055' },
      source: 'supplier',
      check: 'changed',
      alternative: { type: 'bankgiro', bankgiro: '54020102' },
    })
  })

  it('pays the invoice account only when a person chooses it, still flagged as changed', () => {
    const result = resolveOrderPayee({ payee_bankgiro: '5402-0102' }, CARD_BG, { useStatedPayee: true })
    expect(result).toMatchObject({ ok: true, payee: { bankgiro: '54020102' }, source: 'invoice', check: 'changed' })
  })

  it('uses the invoice account as new when the card has none, and the card alone as known', () => {
    expect(resolveOrderPayee({ payee_plusgiro: '123 45 6-6' }, NO_CARD)).toMatchObject({
      ok: true,
      payee: { type: 'plusgiro', plusgiro: '1234566' },
      source: 'invoice',
      check: 'new',
    })
    expect(resolveOrderPayee({}, CARD_BG)).toMatchObject({ ok: true, source: 'supplier', check: 'known' })
  })

  it('refuses when neither source resolves, naming what can be fixed', () => {
    expect(resolveOrderPayee({}, NO_CARD)).toEqual({ ok: false, reason: 'payee_missing' })
    expect(resolveOrderPayee({ payee_bankgiro: '1234-5678' }, NO_CARD)).toEqual({ ok: false, reason: 'payee_invalid' })
    expect(resolveOrderPayee({}, { ...NO_CARD, bankgiro: '1234-5678' })).toEqual({ ok: false, reason: 'payee_invalid' })
  })
})

describe('resolveDebtor', () => {
  const account = { iban: 'SE35 5000 0000 0549 1000 0003', currency: 'SEK', name: 'Företagskonto', enabled: true }

  it('names the bank from the IBAN bank code', () => {
    expect(bicFromSwedishIban('SE3550000000054910000003')).toBe('ESSESESS')
    expect(bicFromSwedishIban('SE7280000810340009783242')).toBe('SWEDSESS')
    expect(bicFromSwedishIban('SE6860000000000123456789')).toBe('HANDSESS')
    expect(resolveDebtor(account, null)).toEqual({
      ok: true,
      debtor: { iban: 'SE3550000000054910000003', bban: null, bic: 'ESSESESS', name: 'Företagskonto', currency: 'SEK', bank_name: null },
    })
  })

  it('falls back to the connection bank name for a code outside the clearing table', () => {
    // 9020: Länsförsäkringar, outside the clearing ranges the payment file trusts.
    const lf = { ...account, iban: 'SE5490200000090212345678' }
    expect(resolveDebtor(lf, 'Länsförsäkringar Bank')).toMatchObject({ ok: true, debtor: { bic: 'ELLFSESS' } })
    // Neither the code nor a bank name identifies the bank: never guess a BIC.
    expect(resolveDebtor(lf, null)).toEqual({ ok: false, reason: 'bank_unknown' })
  })

  it('refuses a disabled account, another currency and a missing or invalid IBAN', () => {
    expect(resolveDebtor({ ...account, enabled: false }, null)).toEqual({ ok: false, reason: 'account_disabled' })
    expect(resolveDebtor({ ...account, currency: 'EUR' }, null)).toEqual({ ok: false, reason: 'not_sek' })
    expect(resolveDebtor({ ...account, iban: null }, null)).toEqual({ ok: false, reason: 'iban_missing' })
    expect(resolveDebtor({ ...account, iban: 'SE3550000000054910000004' }, null)).toEqual({ ok: false, reason: 'iban_missing' })
  })
})

describe('normalizeSignerPersonalNumber', () => {
  it('accepts 10 or 12 digits with a valid check digit and returns 12', () => {
    expect(normalizeSignerPersonalNumber('19900101-1239')).toBe('199001011239')
    expect(normalizeSignerPersonalNumber('900101-1239')).toBe('199001011239')
    expect(normalizeSignerPersonalNumber('199001011238')).toBeNull()
    expect(normalizeSignerPersonalNumber('')).toBeNull()
    expect(normalizeSignerPersonalNumber(null)).toBeNull()
  })
})
