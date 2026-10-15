/**
 * The one encoder for a Swedish domestic bank-account payee in a pain.001
 * file (crm#1218, crm#1219). Every account number here is invented.
 */
import { describe, it, expect } from 'vitest'
import { creditorAccountForm, domesticCreditorAccount } from '../creditor-account'
import { swedbankCreditorAccount } from '../swedbank'
import { PayeeAccountError } from '@/lib/salary/payment/bank-account'

const NAME = 'Sara Svensson'
const SWEDBANK_IDS = { signerId: '123456789ORI0001', corporatePayId: '123456789CPO0001' }

describe('creditorAccountForm: the debtor bank decides, it reads the file', () => {
  it.each(['DABASESX', 'dabasesx', ' DABASESX ', 'DABASESXXXX', 'NDEASESS', 'ndeasessxxx'])(
    '%s reads the clearing inside the BBAN',
    (bic) => {
      expect(creditorAccountForm(bic, null)).toBe('full_bban')
    },
  )

  it.each(['ESSESESS', 'HANDSESS', 'SWEDSESS', 'SVEASESS', 'ELLFSESS', ''])('%s keeps the split form', (bic) => {
    expect(creditorAccountForm(bic, null)).toBe('split')
    expect(creditorAccountForm(bic, undefined)).toBe('split')
  })

  it('takes Swedbank MIG 2.0 whenever the Swedbank ids are present', () => {
    expect(creditorAccountForm('SWEDSESS', SWEDBANK_IDS)).toBe('swedbank_iso2')
  })
})

describe('domesticCreditorAccount, full BBAN (Danske Bank, Nordea)', () => {
  it('writes a Danske Bank account as clearing + account, 11 digits, the clearing kept in CdtrAgt', () => {
    expect(domesticCreditorAccount(NAME, '1344', '2045678', 'full_bban')).toEqual({
      memberId: '1344',
      accountId: '13442045678',
    })
  })

  it('reads an account typed with its clearing in front the same way', () => {
    expect(domesticCreditorAccount(NAME, '1344', '13442045678', 'full_bban')).toEqual({
      memberId: '1344',
      accountId: '13442045678',
    })
    expect(domesticCreditorAccount(NAME, '1344', '1344-204 567 8', 'full_bban').accountId).toBe('13442045678')
  })

  it('writes a Handelsbanken account as clearing + 9 digits, 13 in all', () => {
    expect(domesticCreditorAccount(NAME, '6000', '123456789', 'full_bban')).toEqual({
      memberId: '6000',
      accountId: '6000123456789',
    })
  })

  it('writes a Nordea personkonto as 3300 + the 10-digit number, 14 in all', () => {
    expect(domesticCreditorAccount(NAME, '3300', '8001011234', 'full_bban')).toEqual({
      memberId: '3300',
      accountId: '33008001011234',
    })
  })

  it('writes a Swedbank 5-digit clearing as the 15 digits Swedbank states, 8CCCC + zero-filled account', () => {
    expect(domesticCreditorAccount(NAME, '83279', '1234567890', 'full_bban')).toEqual({
      memberId: '8327',
      accountId: '832791234567890',
    })
    expect(domesticCreditorAccount(NAME, '8327-9', '12345678', 'full_bban').accountId).toBe('832790012345678')
  })

  it('derives the fifth digit of an 8xxx clearing stored with four, as Swedbank MIG 2.0 does', () => {
    const full = domesticCreditorAccount(NAME, '8327', '1234567890', 'full_bban')
    expect(full.accountId).toBe(swedbankCreditorAccount(NAME, '8327', '1234567890').accountId)
    expect(full.accountId).toBe('832791234567890')
  })

  it('stays within Nordea\'s 11-15 digits for every ordinary account', () => {
    for (const [clearing, account] of [
      ['1344', '2045678'],
      ['5037', '1234567'],
      ['6000', '123456789'],
      ['3300', '8001011234'],
      ['7001', '1234567'],
      ['83279', '1234567890'],
    ]) {
      const { accountId } = domesticCreditorAccount(NAME, clearing, account, 'full_bban')
      expect(accountId).toMatch(/^\d{11,15}$/)
    }
  })
})

describe('domesticCreditorAccount, the other forms are unchanged', () => {
  it('split: the 4-digit clearing in CdtrAgt, the account alone in CdtrAcct', () => {
    expect(domesticCreditorAccount(NAME, '1344', '2045678', 'split')).toEqual({ memberId: '1344', accountId: '2045678' })
    expect(domesticCreditorAccount(NAME, '83279', '1234567890', 'split')).toEqual({
      memberId: '8327',
      accountId: '91234567890',
    })
  })

  it('swedbank_iso2: exactly the Swedbank MIG 2.0 routing', () => {
    for (const [clearing, account] of [
      ['83279', '1234567890'],
      ['8327', '12345678'],
      ['1344', '2045678'],
    ]) {
      expect(domesticCreditorAccount(NAME, clearing, account, 'swedbank_iso2')).toEqual(
        swedbankCreditorAccount(NAME, clearing, account),
      )
    }
  })
})

describe('domesticCreditorAccount refuses what no file can carry, in every form', () => {
  const FORMS = ['split', 'full_bban', 'swedbank_iso2'] as const

  it.each(FORMS)('%s: an IBAN without a clearing number is refused by name, never encoded', (form) => {
    let error: unknown = null
    try {
      domesticCreditorAccount(NAME, '', 'SE4550000000058398257466', form)
    } catch (err) {
      error = err
    }
    expect(error).toBeInstanceOf(PayeeAccountError)
    expect((error as PayeeAccountError).problem).toBe('clearing_format')
    expect((error as PayeeAccountError).message).toContain(NAME)
    expect((error as PayeeAccountError).message).not.toMatch(/\d{4,}/)
  })

  it.each(FORMS)('%s: an IBAN typed into the account field is refused, never stripped to digits', (form) => {
    expect(() => domesticCreditorAccount(NAME, '5000', 'SE4550000000058398257466', form)).toThrow(PayeeAccountError)
  })
})
