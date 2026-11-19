import { describe, expect, it } from 'vitest'
import { debtorPartyId, initiatingPartyId, resolveBankFileIds } from '@/lib/payments/initiating-party'
import {
  isNordeaBic,
  isNordeaCompany,
  NORDEA_AGREEMENT_ID_PATTERN,
  NORDEA_SIGNER_ID_PATTERN,
  resolveNordeaFileIds,
} from '@/lib/payments/nordea'

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

describe('resolveNordeaFileIds', () => {
  const NORDEA = { nordea_signer_id: 'NB10000123456', nordea_agreement_id: 'NB123456' }

  it('asks nothing of another bank', () => {
    expect(resolveNordeaFileIds('ESSESESS', null)).toEqual({ ok: true, ids: null })
    expect(resolveNordeaFileIds('SWEDSESS', NORDEA)).toEqual({ ok: true, ids: null })
  })

  it('needs both stored ids at Nordea, naming the Signer ID first', () => {
    expect(resolveNordeaFileIds('NDEASESS', NORDEA)).toEqual({
      ok: true,
      ids: { signerId: 'NB10000123456', agreementId: 'NB123456' },
    })
    // crm#1530: the Signer ID alone got the file past the upload, then Nordea
    // rejected it for the missing CCM agreement id.
    expect(resolveNordeaFileIds('NDEASESS', { nordea_signer_id: 'NB10000123456' })).toEqual({
      ok: false,
      missing: 'nordea_agreement_id',
    })
    expect(resolveNordeaFileIds('NDEASESS', { nordea_signer_id: '  ', nordea_agreement_id: 'NB123456' })).toEqual({
      ok: false,
      missing: 'nordea_signer_id',
    })
    expect(resolveNordeaFileIds('NDEASESS', null)).toEqual({ ok: false, missing: 'nordea_signer_id' })
  })

  it('takes letters and digits as an agreement id, normalised beforehand', () => {
    expect(NORDEA_AGREEMENT_ID_PATTERN.test('NB123456')).toBe(true)
    expect(NORDEA_AGREEMENT_ID_PATTERN.test('1234567890')).toBe(true)
    expect(NORDEA_AGREEMENT_ID_PATTERN.test('NB 123456')).toBe(false)
    expect(NORDEA_AGREEMENT_ID_PATTERN.test('A'.repeat(36))).toBe(false)
  })
})

describe('resolveBankFileIds: what each debtor bank requires', () => {
  it('requires nothing at a bank that keys the agreement on the org number', () => {
    expect(resolveBankFileIds('HANDSESS', { ...SWEDBANK, nordea_signer_id: 'NB10000123456', nordea_agreement_id: 'NB123456' })).toEqual({
      ok: true,
      ids: { swedbank: null, nordeaSignerId: null, nordeaAgreementId: null },
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
      ids: {
        swedbank: { signerId: '123456789ORI0001', corporatePayId: '123456789CPO0001' },
        nordeaSignerId: null,
        nordeaAgreementId: null,
      },
    })
  })

  it('refuses a Nordea debtor without both its ids, naming the empty columns, and carries the ones it has', () => {
    expect(resolveBankFileIds('NDEASESS', SWEDBANK)).toEqual({
      ok: false,
      missing: 'nordea_signer_id',
      fields: ['nordea_signer_id', 'nordea_agreement_id'],
    })
    expect(resolveBankFileIds('NDEASESS', { nordea_signer_id: 'NB10000123456' })).toEqual({
      ok: false,
      missing: 'nordea_agreement_id',
      fields: ['nordea_agreement_id'],
    })
    expect(resolveBankFileIds('NDEASESS', { nordea_signer_id: 'NB10000123456', nordea_agreement_id: 'NB123456' })).toEqual({
      ok: true,
      ids: { swedbank: null, nordeaSignerId: 'NB10000123456', nordeaAgreementId: 'NB123456' },
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

describe('debtorPartyId', () => {
  const swedbank = { signerId: '123456789ORI0001', corporatePayId: '123456789CPO0001' }

  it("names the bank's agreement id with scheme BANK, else the org number digits without one", () => {
    expect(debtorPartyId({ orgNumber: '556677-8899', swedbank })).toEqual({ id: '123456789CPO0001', scheme: 'BANK' })
    // Nordea's MIG: "Customer agreement (Nordea's CCM agreement) identification
    // with Nordea is mandatory (BANK)" (crm#1530).
    expect(
      debtorPartyId({ orgNumber: '556677-8899', nordeaSignerId: 'NB10000123456', nordeaAgreementId: 'NB123456' }),
    ).toEqual({ id: 'NB123456', scheme: 'BANK' })
    // A Nordea batch made before the agreement id was stored keeps the org number.
    expect(debtorPartyId({ orgNumber: '556677-8899', nordeaSignerId: 'NB10000123456' })).toEqual({
      id: '5566778899',
      scheme: null,
    })
    expect(debtorPartyId({ orgNumber: '' })).toBeNull()
  })
})
