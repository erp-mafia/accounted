import { describe, expect, it } from 'vitest'
import { PayeeAccountError } from '@/lib/salary/payment/bank-account'
import {
  isSwedbankBic,
  isSwedbankCompany,
  normalizeSwedbankId,
  resolveSwedbankFileIds,
  SWEDBANK_CORPORATE_PAY_ID_PATTERN,
  SWEDBANK_SIGNER_ID_PATTERN,
  swedbankCreditorAccount,
} from '../swedbank'

describe('isSwedbankBic', () => {
  it('reads the bank part of the BIC: case, whitespace and branch code do not matter', () => {
    for (const bic of ['SWEDSESS', 'swedsess', ' SWEDSESS ', 'SWEDSESSXXX', 'SWED SESS']) {
      expect(isSwedbankBic(bic), bic).toBe(true)
    }
  })

  it('is false for every other bank and for no BIC', () => {
    for (const bic of ['HANDSESS', 'ESSESESS', 'NDEASESS', 'DABASESX', 'SWEDSES', '', null, undefined]) {
      expect(isSwedbankBic(bic), String(bic)).toBe(false)
    }
  })
})

describe('isSwedbankCompany', () => {
  it('trusts a saved BIC first', () => {
    expect(isSwedbankCompany({ bic: 'SWEDSESS', clearing_number: '6000' })).toBe(true)
    expect(isSwedbankCompany({ bic: 'HANDSESS', clearing_number: '8327' })).toBe(false)
  })

  it('derives the bank from the clearing number when no BIC is saved: Swedbank 7xxx and the savings banks 8xxx', () => {
    expect(isSwedbankCompany({ bic: null, clearing_number: '7889' })).toBe(true)
    expect(isSwedbankCompany({ bic: '', clearing_number: '8327-9' })).toBe(true)
    expect(isSwedbankCompany({ bic: null, clearing_number: '6000' })).toBe(false)
  })

  it('falls back to the bank name', () => {
    expect(isSwedbankCompany({ bank_name: 'Swedbank' })).toBe(true)
    expect(isSwedbankCompany({ bank_name: 'Handelsbanken' })).toBe(false)
    expect(isSwedbankCompany({})).toBe(false)
  })
})

describe('normalizeSwedbankId and the documented formats', () => {
  it('drops spaces and hyphens and upper-cases what was typed', () => {
    expect(normalizeSwedbankId('123456789-ori-0001')).toBe('123456789ORI0001')
    expect(normalizeSwedbankId(' 123456789 CPO 0001 ')).toBe('123456789CPO0001')
  })

  it('matches the MIG 2.0 examples and refuses an org number or a swapped id', () => {
    expect(SWEDBANK_SIGNER_ID_PATTERN.test('123456789ORI0001')).toBe(true)
    expect(SWEDBANK_CORPORATE_PAY_ID_PATTERN.test('123456789CPO0001')).toBe(true)
    expect(SWEDBANK_SIGNER_ID_PATTERN.test('5566778899')).toBe(false)
    expect(SWEDBANK_SIGNER_ID_PATTERN.test('123456789CPO0001')).toBe(false)
    expect(SWEDBANK_CORPORATE_PAY_ID_PATTERN.test('123456789ORI0001')).toBe(false)
  })
})

describe('resolveSwedbankFileIds', () => {
  const ids = { swedbank_signer_id: '123456789ORI0001', swedbank_corporate_pay_id: '123456789CPO0001' }

  it('asks nothing of a debtor at another bank, stored ids or not', () => {
    expect(resolveSwedbankFileIds('HANDSESS', ids)).toEqual({ ok: true, ids: null })
    expect(resolveSwedbankFileIds('ESSESESS', null)).toEqual({ ok: true, ids: null })
  })

  it('hands a Swedbank debtor both ids', () => {
    expect(resolveSwedbankFileIds('SWEDSESS', ids)).toEqual({
      ok: true,
      ids: { signerId: '123456789ORI0001', corporatePayId: '123456789CPO0001' },
    })
  })

  it('is not ok for a Swedbank debtor missing either id: Swedbank refuses such a file', () => {
    expect(resolveSwedbankFileIds('SWEDSESS', null)).toEqual({ ok: false })
    expect(resolveSwedbankFileIds('SWEDSESS', { swedbank_signer_id: '123456789ORI0001' })).toEqual({ ok: false })
    expect(resolveSwedbankFileIds('swedsess', { ...ids, swedbank_corporate_pay_id: '  ' })).toEqual({ ok: false })
  })
})

describe('swedbankCreditorAccount', () => {
  it('keeps the separate form for a 4-digit clearing that does not start with 8', () => {
    expect(swedbankCreditorAccount('Anna', '6000', '123456789')).toEqual({ memberId: '6000', accountId: '123456789' })
    expect(swedbankCreditorAccount('Sven', '7889', '3960210')).toEqual({ memberId: '7889', accountId: '3960210' })
  })

  it('writes a 5-digit 8xxxx clearing as MmbId 8CCCC and a 15-digit BBAN, the Validex example', () => {
    expect(swedbankCreditorAccount('Karl', '8901-1', '914 616 842-3')).toEqual({
      memberId: '89011',
      accountId: '890119146168423',
    })
  })

  it('zero-fills a short account to 15 digits', () => {
    expect(swedbankCreditorAccount('Karl', '89112', '4245210')).toEqual({
      memberId: '89112',
      accountId: '891120004245210',
    })
  })

  it('derives the fifth clearing digit (mod 10) when the clearing is stored with four digits', () => {
    expect(swedbankCreditorAccount('Karl', '8901', '9146168423')).toEqual({
      memberId: '89011',
      accountId: '890119146168423',
    })
  })

  it('refuses an account no file can carry, naming the payee', () => {
    expect(() => swedbankCreditorAccount('Eva', '12', '1')).toThrow(PayeeAccountError)
  })
})
