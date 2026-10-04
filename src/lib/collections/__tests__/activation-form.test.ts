import { describe, it, expect } from 'vitest'
import {
  findPayoutOption,
  isAmount,
  isSwedishPostalCode,
  isSwedishVatNumber,
  normalizeOwnerPersonalNumber,
  OnboardingBodySchema,
  ownerPersonalNumberFromOrgNumber,
  pastDateError,
  payoutOptions,
  SettingsPatchSchema,
  SignatureBodySchema,
  validateCompanyStep,
  validateKycStep,
  validateRulesStep,
  type CompanyStepInput,
} from '../activation-form'

const NOW = new Date('2026-10-04T08:00:00Z')

const company: CompanyStepInput = {
  name: 'Test AB',
  addressLine1: 'Storgatan 1',
  addressLine2: null,
  postalCode: '111 22',
  city: 'Stockholm',
  email: 'a@b.se',
  phone: null,
  vatRegistered: false,
  vatNumber: null,
  ownerPersonalNumber: null,
  payout: { cashAccountId: 'acc', kind: 'bankgiro' },
}

describe('payout choices', () => {
  const account = {
    id: 'acc',
    name: 'Företagskonto',
    ledger_account: '1930',
    enabled: true,
    bankgiro: '5050-1055',
    plusgiro: '4 77 22-4',
    clearing_number: '8327-9',
    account_number: '914 123 456-7',
  }

  it('offers bankgiro, plusgiro and bank account per enabled bank account, digits only', () => {
    expect(payoutOptions([account]).map((o) => [o.kind, o.number, o.ledgerAccount])).toEqual([
      ['bankgiro', '50501055', '1930'],
      ['plusgiro', '477224', '1930'],
      ['bank_account', '83279-9141234567', '1930'],
    ])
  })

  it('never pays out to a disabled account, a till or a payment provider\'s clearing account', () => {
    expect(payoutOptions([{ ...account, enabled: false }])).toEqual([])
    expect(payoutOptions([{ ...account, ledger_account: '1910' }])).toEqual([])
    expect(payoutOptions([{ ...account, ledger_account: '1686' }])).toEqual([])
  })

  it('leaves out numbers that cannot be sent', () => {
    const short = payoutOptions([{ ...account, bankgiro: '123', plusgiro: '4-2', clearing_number: null }])
    expect(short).toEqual([])
  })

  it('finds the chosen option by account and kind', () => {
    const options = payoutOptions([account])
    expect(findPayoutOption(options, { cashAccountId: 'acc', kind: 'plusgiro' })?.number).toBe('477224')
    expect(findPayoutOption(options, { cashAccountId: 'other', kind: 'plusgiro' })).toBeNull()
  })
})

describe('the owner of an enskild firma', () => {
  it('expands the firm\'s org number to twelve digits with the century', () => {
    expect(ownerPersonalNumberFromOrgNumber('811218-9876', NOW)).toBe('198112189876')
    expect(ownerPersonalNumberFromOrgNumber('8112189877', NOW)).toBeNull()
    expect(ownerPersonalNumberFromOrgNumber(null, NOW)).toBeNull()
  })

  it('accepts ten or twelve digits, with - or +, and samordningsnummer', () => {
    expect(normalizeOwnerPersonalNumber('19811218-9876', NOW)).toBe('198112189876')
    expect(normalizeOwnerPersonalNumber('811218-9876', NOW)).toBe('198112189876')
    // + marks a person aged 100 or more: the century before.
    expect(normalizeOwnerPersonalNumber('251010-1237', NOW)).toBe('202510101237')
    expect(normalizeOwnerPersonalNumber('251010+1237', NOW)).toBe('192510101237')
    // Samordningsnummer: day + 60.
    expect(normalizeOwnerPersonalNumber('701063-2391', NOW)).toBe('197010632391')
    expect(normalizeOwnerPersonalNumber('701063-2392', NOW)).toBeNull()
    expect(normalizeOwnerPersonalNumber('abc', NOW)).toBeNull()
  })
})

describe('rules', () => {
  it('reads amounts as kronor with at most two decimals', () => {
    expect(isAmount(0)).toBe(true)
    expect(isAmount(100.5)).toBe(true)
    expect(isAmount(100.55)).toBe(true)
    expect(isAmount(100.555)).toBe(false)
    expect(isAmount(-1)).toBe(false)
    expect(isAmount(Number.NaN)).toBe(false)
  })

  it('takes dates that are real and not after today', () => {
    expect(pastDateError('2026-10-04', '2026-10-04')).toBeNull()
    expect(pastDateError('2026-10-05', '2026-10-04')).toBe('date_in_future')
    expect(pastDateError('2026-02-30', '2026-10-04')).toBe('invalid_date')
  })

  it('requires the reminder choice only where it is offered, and a whole interest agreement', () => {
    const base = { minimumAmount: 100, defaultStartStep: 'reminder' as const, reminderFeeTermsSince: null, lateInterest: null, ladderMode: null }
    expect(validateRulesStep(base, { today: '2026-10-04', requireLadderChoice: true })).toEqual({ ladderMode: 'required' })
    expect(validateRulesStep(base, { today: '2026-10-04', requireLadderChoice: false })).toEqual({})
    expect(
      validateRulesStep({ ...base, lateInterest: { percent: 101, agreedSince: '' } }, { today: '2026-10-04', requireLadderChoice: false }),
    ).toEqual({ lateInterestPercent: 'invalid_percent', lateInterestAgreedSince: 'invalid_date' })
  })
})

describe('company and know-your-customer steps', () => {
  it('checks the fields a provider needs', () => {
    expect(validateCompanyStep(company, { soleTrader: false })).toEqual({})
    expect(isSwedishPostalCode('11122')).toBe(true)
    expect(isSwedishPostalCode('1112')).toBe(false)
    expect(isSwedishVatNumber('SE 5560 1257 9001')).toBe(true)
    expect(isSwedishVatNumber('556012579001')).toBe(false)
    expect(
      validateCompanyStep({ ...company, name: ' ', vatRegistered: true, vatNumber: null, payout: null }, { soleTrader: true, now: NOW }),
    ).toEqual({ name: 'required', vatNumber: 'required', ownerPersonalNumber: 'required', payout: 'required' })
  })

  it('asks for a description whenever a question is answered yes', () => {
    const kyc = {
      businessDescription: 'Bygg',
      invoicesAbroad: true,
      invoicesAbroadDescription: null,
      pep: true,
      pepDescription: ' ',
      sanctions: false,
      sanctionsDescription: null,
    }
    expect(validateKycStep(kyc)).toEqual({ invoicesAbroadDescription: 'required', pepDescription: 'required' })
  })
})

describe('request schemas', () => {
  it('words a refused field with its error key', () => {
    const parsed = OnboardingBodySchema.safeParse({
      company: { ...company, payout: { cashAccountId: '33333333-3333-4333-8333-333333333333', kind: 'bankgiro' } },
      kyc: { businessDescription: 'x', invoicesAbroad: false, invoicesAbroadDescription: null, pep: false, pepDescription: null, sanctions: false, sanctionsDescription: null },
      rules: { minimumAmount: 1, defaultStartStep: 'reminder', reminderFeeTermsSince: null, lateInterest: null, ladderMode: 'off' },
    })
    expect(parsed.success).toBe(false)
    expect(parsed.error!.issues.map((i) => [i.path.join('.'), i.message])).toEqual([['kyc.businessDescription', 'required']])
  })

  it('needs a signer e-mail only when the provider mails the link', () => {
    expect(SignatureBodySchema.safeParse({ sendToSigner: false, signerEmail: null }).success).toBe(true)
    expect(SignatureBodySchema.safeParse({ sendToSigner: true, signerEmail: null }).success).toBe(false)
    expect(SignatureBodySchema.safeParse({ sendToSigner: true, signerEmail: 'vd@test.se' }).data?.language).toBe('sv')
  })

  it('refuses an empty settings change', () => {
    expect(SettingsPatchSchema.safeParse({}).success).toBe(false)
    expect(SettingsPatchSchema.safeParse({ distributionEnabled: false }).success).toBe(true)
  })
})
