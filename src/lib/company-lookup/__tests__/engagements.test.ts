import { describe, it, expect } from 'vitest'
import { addableEngagements, isCeasedCompanyStatus } from '../engagements'
import type { EnrichmentCompanyRole } from '../types'

// Synthetic identifiers only: the Volvo org number used across the test
// suite, the synthetic personnummer 800101-1231, and made-up 55699999xx
// numbers for the other companies.
const OWN_AB = '5560125790'
const OWN_PNR = '8001011231'

function role(overrides: Partial<EnrichmentCompanyRole> = {}): EnrichmentCompanyRole {
  return {
    companyId: 1,
    companyRegistrationNumber: '5569999990',
    legalName: 'Exempel AB',
    legalEntityType: 'Aktiebolag',
    positionTypes: ['boardMember'],
    positionDescriptions: ['Styrelseledamot'],
    positionStart: '2015-01-01',
    positionEnd: null,
    ...overrides,
  }
}

describe('isCeasedCompanyStatus', () => {
  it('treats a missing status as an active company', () => {
    expect(isCeasedCompanyStatus(undefined)).toBe(false)
    expect(isCeasedCompanyStatus(null)).toBe(false)
    expect(isCeasedCompanyStatus('')).toBe(false)
  })

  it('flags every terminal status seen in production', () => {
    for (const status of [
      'Deregistered',
      'DeregisteredNewHolder',
      'DissolvedByMergerProcedure',
      'BankruptcyProceedingsTerminated',
      'LiquidationTerminated',
      'CompanyStruckOff',
      'CompanyStruckOffOwnRequest',
      'CompanyStruckOffByRegistrationOffice',
      'CompanyStruckOffTradeRegisterAct',
    ]) {
      expect(isCeasedCompanyStatus(status), status).toBe(true)
    }
  })

  it('keeps companies that are mid-proceeding or outlive the event', () => {
    // Companies with the last four of these statuses are booked in
    // Accounted today; the first three still exist while the proceeding runs.
    for (const status of [
      'LiquidationDecided',
      'BankruptcyProceedingsCommenced',
      'ReorganizationOfBusinessCommenced',
      'ReorganizationOfBusinessEnded',
      'LiquidationEnds',
      'BankruptcyTerminatedWithSurplus',
      'AcquisitionTerminated',
    ]) {
      expect(isCeasedCompanyStatus(status), status).toBe(false)
    }
  })

  it('fails open on a status it does not know', () => {
    expect(isCeasedCompanyStatus('SomeFutureStatus')).toBe(false)
    expect(isCeasedCompanyStatus('Aktivt')).toBe(false)
  })
})

describe('addableEngagements', () => {
  it('offers an active company the user does not have yet', () => {
    const active = role()
    expect(addableEngagements([active], [OWN_AB])).toEqual([active])
  })

  it('drops companies that no longer exist (crm#1034)', () => {
    const roles = [
      role({ companyRegistrationNumber: '5569999991', companyStatus: 'Deregistered' }),
      role({ companyRegistrationNumber: '5569999992', companyStatus: 'DissolvedByMergerProcedure' }),
      role({ companyRegistrationNumber: '5569999993', companyStatus: 'LiquidationTerminated' }),
    ]
    expect(addableEngagements(roles, [OWN_AB])).toEqual([])
  })

  it('keeps a company in an ongoing proceeding', () => {
    const inLiquidation = role({ companyStatus: 'LiquidationDecided' })
    expect(addableEngagements([inLiquidation], [])).toEqual([inLiquidation])
  })

  it('leaves out the companies the user already has, whatever the formatting', () => {
    const own = role({ companyRegistrationNumber: OWN_AB })
    expect(addableEngagements([own], ['556012-5790'])).toEqual([])
  })

  it("matches a sole trader's 16-digit TIC number to the stored personnummer", () => {
    const ownFirm = role({
      companyRegistrationNumber: `19${OWN_PNR}0001`,
      legalEntityType: 'Enskild näringsidkare',
      positionTypes: ['owner'],
    })
    expect(addableEngagements([ownFirm], [OWN_PNR])).toEqual([])
    expect(addableEngagements([ownFirm], ['19800101-1231'])).toEqual([])
  })

  it('drops a position the register has closed, keeps one with no end', () => {
    const ended = role({ companyRegistrationNumber: '5569999994', positionEnd: '2019-06-30' })
    const open = role({ companyRegistrationNumber: '5569999995' })
    // TIC omits positionEnd altogether, which reads as undefined, not null.
    delete (open as Partial<EnrichmentCompanyRole>).positionEnd
    expect(addableEngagements([ended, open], [])).toEqual([open])
  })

  it('keeps an engagement whose registration number cannot be keyed', () => {
    const unkeyed = role({ companyRegistrationNumber: '80200000000001' })
    expect(addableEngagements([unkeyed], [OWN_AB])).toEqual([unkeyed])
  })

  it('reads anything but an array as no engagements', () => {
    expect(addableEngagements(null, [OWN_AB])).toEqual([])
    expect(addableEngagements(undefined, [])).toEqual([])
    expect(addableEngagements({ companyRoles: [] }, [])).toEqual([])
  })

  it('leaves only the live, unadded company in the reported mix', () => {
    const own = role({ companyRegistrationNumber: OWN_AB })
    const struckOff = role({ companyRegistrationNumber: '5569999996', companyStatus: 'CompanyStruckOff' })
    const bankrupt = role({ companyRegistrationNumber: '5569999997', companyStatus: 'BankruptcyProceedingsTerminated' })
    const board = role({ companyRegistrationNumber: '5569999998', legalEntityType: 'Bostadsrättsförening' })
    expect(addableEngagements([own, struckOff, bankrupt, board], [OWN_AB, null])).toEqual([board])
  })
})
