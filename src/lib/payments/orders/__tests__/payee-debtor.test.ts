import { describe, expect, it } from 'vitest'
import { bicFromSwedishIban, paymentAccountContext, resolveDebtor } from '../debtor'
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
      alternative: null,
    })
  })

  it('defaults to the card and names the different account the invoice states', () => {
    const result = resolveOrderPayee({ payee_bankgiro: '5402-0102' }, CARD_BG)
    expect(result).toMatchObject({
      ok: true,
      payee: { type: 'bankgiro', bankgiro: '50501055' },
      source: 'supplier',
      alternative: { type: 'bankgiro', bankgiro: '54020102' },
    })
  })

  it('pays the invoice account only when a person chooses it, naming the card account as the other', () => {
    const result = resolveOrderPayee({ payee_bankgiro: '5402-0102' }, CARD_BG, { useStatedPayee: true })
    expect(result).toMatchObject({ ok: true, payee: { bankgiro: '54020102' }, source: 'invoice', alternative: { bankgiro: '50501055' } })
  })

  it('uses the card alone when the invoice states nothing', () => {
    // Whether the account is known, new or changed is decided by
    // create_payment_orders (tests/pg/payment-orders.pg.test.ts).
    expect(resolveOrderPayee({}, CARD_BG)).toMatchObject({ ok: true, source: 'supplier', alternative: null })
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
      debtor: { iban: 'SE3550000000054910000003', bban: null, bic: 'ESSESESS', name: 'Företagskonto', currency: 'SEK', bank_name: null, affiliated_aspsp_id: null, psu_type: null },
    })
  })

  it('keeps the sparbank behind a shared BIC and the account context of the connection on the snapshot', () => {
    const sparbank = { ...account, iban: 'SE7280000810340009783242' }
    expect(resolveDebtor(sparbank, { bank_name: 'Sparbanken Skåne', affiliated_aspsp_id: '08999', psu_type: 'personal' })).toEqual({
      ok: true,
      debtor: expect.objectContaining({ bic: 'SWEDSESS', bank_name: 'Sparbanken Skåne', affiliated_aspsp_id: '08999', psu_type: 'personal' }),
    })
    // An Enable Banking connection stores no affiliate: nothing is derived from the name.
    expect(resolveDebtor(sparbank, { bank_name: 'Sparbanken Skåne' })).toMatchObject({ ok: true, debtor: { affiliated_aspsp_id: null, psu_type: null } })
  })

  it('pays as private only for a connection made in the personal context', () => {
    expect(paymentAccountContext('personal')).toBe('private')
    expect(paymentAccountContext('business')).toBe('corporate')
    expect(paymentAccountContext(null)).toBe('corporate')
    expect(paymentAccountContext(undefined)).toBe('corporate')
  })

  it('falls back to the connection bank name for a code outside the clearing table', () => {
    // 9020: Länsförsäkringar, outside the clearing ranges the payment file trusts.
    const lf = { ...account, iban: 'SE5490200000090212345678' }
    expect(resolveDebtor(lf, { bank_name: 'Länsförsäkringar Bank' })).toMatchObject({ ok: true, debtor: { bic: 'ELLFSESS' } })
    // Neither the code nor a bank name identifies the bank: never guess a BIC.
    expect(resolveDebtor(lf, null)).toEqual({ ok: false, reason: 'bank_unknown' })
  })

  it('pays from a bank outside the tables by the BIC its Open Payments connection stores (crm#1314)', () => {
    // 971: a Swedish IBAN at a bank neither the clearing table nor the name table knows.
    const lunar = { ...account, iban: 'SE5497100000012345678901' }
    expect(bicFromSwedishIban('SE5497100000012345678901')).toBeNull()
    expect(resolveDebtor(lunar, { bank_name: 'Lunar', bic: 'LUNADK2B', affiliated_aspsp_id: null, psu_type: 'business' })).toEqual({
      ok: true,
      debtor: { iban: 'SE5497100000012345678901', bban: null, bic: 'LUNADK2B', name: 'Företagskonto', currency: 'SEK', bank_name: 'Lunar', affiliated_aspsp_id: null, psu_type: 'business' },
    })
    // The same account on an Enable Banking connection: no BIC stored, the tables cannot name it.
    expect(resolveDebtor(lunar, { bank_name: 'Lunar', bic: null })).toEqual({ ok: false, reason: 'bank_unknown' })
  })

  it("takes the connection's BIC over the tables' guess, and the tables when it stores none or a malformed one", () => {
    // 957: outside the clearing table; the name table would guess SWEDSESS from "sparbank".
    const outside = { ...account, iban: 'SE6295700000012345678901' }
    expect(resolveDebtor(outside, { bank_name: 'Sparbanken Test', bic: 'TESTSES1XXX' })).toMatchObject({ ok: true, debtor: { bic: 'TESTSES1XXX' } })
    expect(resolveDebtor(outside, { bank_name: 'Sparbanken Test', bic: ' testses1 ' })).toMatchObject({ ok: true, debtor: { bic: 'TESTSES1' } })
    expect(resolveDebtor(outside, { bank_name: 'Sparbanken Test', bic: 'NOT A BIC' })).toMatchObject({ ok: true, debtor: { bic: 'SWEDSESS' } })
    expect(resolveDebtor(account, { bank_name: 'SEB', bic: 'ESSESESS' })).toMatchObject({ ok: true, debtor: { bic: 'ESSESESS' } })
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
