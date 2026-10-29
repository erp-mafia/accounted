import { describe, expect, it } from 'vitest'
import { initiatingPartyId, resolveBankFileIds } from '@/lib/payments/initiating-party'
import { isNordeaBic, isNordeaCompany, NORDEA_SIGNER_ID_PATTERN, resolveNordeaSignerId } from '@/lib/payments/nordea'

const SWEDBANK = { swedbank_signer_id: '123456789ORI0001', swedbank_corporate_pay_id: '123456789CPO0001' }

describe('Nordea by BIC and by company settings', () => {
  it('reads the bank part of the BIC', () => {
    expect(isNordeaBic('NDEASESS')).toBe(true)
    expect(isNordeaBic(' ndeasessxxx ')).toBe(true)
    expect(isNordeaBic('ESSESESS')).toBe(false)
    expect(isNordeaBic(null)).toBe(false)
  })

  it('follows the payment files chain: saved BIC, else clearing, else bank name', () => {
    expect(isNordeaCompany({ bic: 'NDEASESS' })).toBe(true)
    expect(isNordeaCompany({ clearing_number: '3300' })).toBe(true)
    expect(isNordeaCompany({ bank_name: 'Nordea Bank Abp' })).toBe(true)
    expect(isNordeaCompany({ bic: 'ESSESESS', bank_name: 'Nordea' })).toBe(false)
    expect(isNordeaCompany({})).toBe(false)
  })

  it('takes letters and digits up to Max35Text', () => {
    expect(NORDEA_SIGNER_ID_PATTERN.test('NB10000123456')).toBe(true)
    expect(NORDEA_SIGNER_ID_PATTERN.test('1234567890123')).toBe(true)
    expect(NORDEA_SIGNER_ID_PATTERN.test('NB-1000')).toBe(false)
    expect(NORDEA_SIGNER_ID_PATTERN.test('A'.repeat(36))).toBe(false)
  })
})

describe('resolveNordeaSignerId', () => {
  it('asks nothing of another bank', () => {
    expect(resolveNordeaSignerId('ESSESESS', null)).toEqual({ ok: true, signerId: null })
    expect(resolveNordeaSignerId('SWEDSESS', { nordea_signer_id: 'NB10000123456' })).toEqual({ ok: true, signerId: null })
  })

  it('needs the stored id at Nordea', () => {
    expect(resolveNordeaSignerId('NDEASESS', { nordea_signer_id: 'NB10000123456' })).toEqual({
      ok: true,
      signerId: 'NB10000123456',
    })
    expect(resolveNordeaSignerId('NDEASESS', { nordea_signer_id: '  ' })).toEqual({ ok: false })
    expect(resolveNordeaSignerId('NDEASESS', null)).toEqual({ ok: false })
  })
})

describe('resolveBankFileIds: what each debtor bank requires', () => {
  it('requires nothing at a bank that keys the agreement on the org number', () => {
    expect(resolveBankFileIds('HANDSESS', { ...SWEDBANK, nordea_signer_id: 'NB10000123456' })).toEqual({
      ok: true,
      ids: { swedbank: null, nordeaSignerId: null },
    })
  })

  it('names the empty Swedbank columns', () => {
    expect(resolveBankFileIds('SWEDSESS', { swedbank_signer_id: '123456789ORI0001' })).toEqual({
      ok: false,
      missing: 'swedbank_ids',
      fields: ['swedbank_corporate_pay_id'],
    })
    expect(resolveBankFileIds('SWEDSESS', SWEDBANK)).toEqual({
      ok: true,
      ids: { swedbank: { signerId: '123456789ORI0001', corporatePayId: '123456789CPO0001' }, nordeaSignerId: null },
    })
  })

  it("refuses a Nordea debtor without its Signer ID and carries the one it has", () => {
    expect(resolveBankFileIds('NDEASESS', SWEDBANK)).toEqual({
      ok: false,
      missing: 'nordea_signer_id',
      fields: ['nordea_signer_id'],
    })
    expect(resolveBankFileIds('NDEASESS', { nordea_signer_id: 'NB10000123456' })).toEqual({
      ok: true,
      ids: { swedbank: null, nordeaSignerId: 'NB10000123456' },
    })
  })
})

describe('initiatingPartyId', () => {
  const swedbank = { signerId: '123456789ORI0001', corporatePayId: '123456789CPO0001' }

  it('names the bank-assigned id with its scheme, else the org number digits without one', () => {
    expect(initiatingPartyId({ orgNumber: '556677-8899', swedbank })).toEqual({ id: '123456789ORI0001', scheme: 'BANK' })
    expect(initiatingPartyId({ orgNumber: '556677-8899', nordeaSignerId: 'NB10000123456' })).toEqual({
      id: 'NB10000123456',
      scheme: 'CUST',
    })
    expect(initiatingPartyId({ orgNumber: '556677-8899', swedbank: null, nordeaSignerId: null })).toEqual({
      id: '5566778899',
      scheme: null,
    })
    expect(initiatingPartyId({ orgNumber: '' })).toBeNull()
  })
})
