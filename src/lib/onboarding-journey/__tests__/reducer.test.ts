import { afterEach, describe, it, expect, vi } from 'vitest'
import {
  initJourney,
  journeyBack,
  journeyReducer,
  stationOfStep,
  type JourneyAction,
  type JourneyState,
} from '../reducer'
import type { CompanyLookupResult } from '@/lib/company-lookup/types'
import { computeFiscalPeriod } from '@/lib/company/compute-fiscal-period'

function lookup(overrides: Partial<CompanyLookupResult> = {}): CompanyLookupResult {
  return {
    companyName: 'Nordvik Bygg & Konsult AB',
    isCeased: false,
    address: { street: 'Storgatan 1', postalCode: '211 34', city: 'Malmö' },
    registration: { fTax: true, vat: true },
    bankAccounts: [],
    email: null,
    phone: null,
    sniCodes: [],
    fiscalYear: { startMonthDay: '01-01', endMonthDay: '12-31' },
    legalEntityType: 'AB',
    registrationDate: null,
    ...overrides,
  }
}

function run(state: JourneyState, ...actions: JourneyAction[]): JourneyState {
  return actions.reduce(journeyReducer, state)
}

/** Manual AB path up to the fiscal-year station. */
function manualAbAtFy(): JourneyState {
  return run(
    initJourney(),
    { type: 'ORG_SUBMITTED', orgNumber: '559999-9999' },
    { type: 'LOOKUP_RESULT', outcome: { status: 'not_found' } },
    { type: 'NOTFOUND_CONTINUE' },
    { type: 'ENTITY_PICKED', entityType: 'aktiebolag' },
    { type: 'NAME_SUBMITTED', name: 'Testbolaget AB' },
    { type: 'ADDRESS_SUBMITTED', addressLine1: 'Gatan 1', postalCode: '123 45', city: 'Lund' },
    { type: 'FSKATT_ANSWERED', fskatt: true },
  )
}

describe('journeyReducer: AB found via lookup', () => {
  it('lands on the fiscal-year station with name/address/F-skatt as facts', () => {
    const s = run(
      initJourney(),
      { type: 'ORG_SUBMITTED', orgNumber: '556677-8899' },
      { type: 'LOOKUP_RESULT', outcome: { status: 'found', result: lookup() } },
    )
    expect(s.step).toBe('fy')
    expect(s.lookupRan).toBe(true)
    expect(s.settings).toMatchObject({
      org_number: '556677-8899',
      entity_type: 'aktiebolag',
      company_name: 'Nordvik Bygg & Konsult AB',
      address_line1: 'Storgatan 1',
      postal_code: '211 34',
      city: 'Malmö',
      f_skatt: true,
    })
  })

  it('skips the moms question only for a POSITIVE VAT registration', () => {
    const s = run(
      initJourney(),
      { type: 'ORG_SUBMITTED', orgNumber: '556677-8899' },
      { type: 'LOOKUP_RESULT', outcome: { status: 'found', result: lookup() } },
      { type: 'FY_CALENDAR_CONFIRMED' },
    )
    expect(s.step).toBe('moms')
    expect(s.settings.vat_registered).toBe(true)
    expect(s.settings.vat_number).toBe('SE556677889901')
  })

  it('collects the full wizard payload through to submit', () => {
    const s = run(
      initJourney(),
      { type: 'ORG_SUBMITTED', orgNumber: '556677-8899' },
      { type: 'LOOKUP_RESULT', outcome: { status: 'found', result: lookup() } },
      { type: 'FY_CALENDAR_CONFIRMED' },
      { type: 'MOMS_PERIOD_PICKED', period: 'quarterly' },
      { type: 'METHOD_PICKED', method: 'accrual' },
    )
    expect(s.submitting).toBe(true)
    expect(s.settings).toMatchObject({
      entity_type: 'aktiebolag',
      company_name: 'Nordvik Bygg & Konsult AB',
      org_number: '556677-8899',
      address_line1: 'Storgatan 1',
      postal_code: '211 34',
      city: 'Malmö',
      f_skatt: true,
      fiscal_year_start_month: 1,
      vat_registered: true,
      vat_number: 'SE556677889901',
      moms_period: 'quarterly',
      accounting_method: 'accrual',
    })
    const done = journeyReducer(s, { type: 'SUBMIT_SUCCEEDED' })
    expect(done.step).toBe('done')
    expect(stationOfStep(done.step)).toBe(4)
  })
})

describe('journeyReducer: EF found via lookup', () => {
  const efLookup = lookup({
    companyName: 'Alice Nordin',
    legalEntityType: 'Enskild näringsidkare',
    registration: { fTax: true, vat: false },
  })

  it('takes the name from the lookup and goes straight to the fiscal year: Enter is the whole step', () => {
    const s = run(
      initJourney(),
      { type: 'ORG_SUBMITTED', orgNumber: '19850420-1234' },
      { type: 'LOOKUP_RESULT', outcome: { status: 'found', result: efLookup } },
    )
    expect(s.step).toBe('fy')
    expect(s.settings.entity_type).toBe('enskild_firma')
    expect(s.settings.company_name).toBe('Alice Nordin')
  })

  it('still names the verksamhet when no lookup answered', () => {
    const s = run(
      initJourney(),
      { type: 'ORG_SUBMITTED', orgNumber: '19850420-1234' },
      { type: 'LOOKUP_RESULT', outcome: { status: 'not_found' } },
      { type: 'NOTFOUND_CONTINUE' },
      { type: 'ENTITY_PICKED', entityType: 'enskild_firma' },
    )
    expect(s.step).toBe('name')
  })

  it('skips address and F-skatt (lookup facts), then asks moms: never defaults a negative VAT', () => {
    const s = run(
      initJourney(),
      { type: 'ORG_SUBMITTED', orgNumber: '19850420-1234' },
      { type: 'LOOKUP_RESULT', outcome: { status: 'found', result: efLookup } },
      { type: 'FY_CALENDAR_CONFIRMED' },
    )
    expect(s.settings.company_name).toBe('Alice Nordin')
    expect(s.settings.f_skatt).toBe(true)
    expect(s.step).toBe('momsyn')
    expect(s.settings.vat_registered).toBeUndefined()
  })

  it('answers moms nej: no VAT number, no period, straight to method', () => {
    const s = run(
      initJourney(),
      { type: 'ORG_SUBMITTED', orgNumber: '19850420-1234' },
      { type: 'LOOKUP_RESULT', outcome: { status: 'found', result: efLookup } },
      { type: 'FY_CALENDAR_CONFIRMED' },
      { type: 'VAT_ANSWERED', registered: false },
    )
    expect(s.step).toBe('method')
    expect(s.settings.vat_registered).toBe(false)
    expect(s.settings.vat_number).toBeNull()
    expect(s.settings.moms_period).toBeNull()
  })
})

describe('journeyReducer: manual path (not found)', () => {
  it('walks form → name → address → F-skatt → fy', () => {
    let s = run(
      initJourney(),
      { type: 'ORG_SUBMITTED', orgNumber: '559999-9999' },
      { type: 'LOOKUP_RESULT', outcome: { status: 'not_found' } },
    )
    expect(s.step).toBe('notfound')
    s = journeyReducer(s, { type: 'NOTFOUND_CONTINUE' })
    expect(s.step).toBe('form')
    s = journeyReducer(s, { type: 'ENTITY_PICKED', entityType: 'aktiebolag' })
    expect(s.step).toBe('name')
    s = journeyReducer(s, { type: 'NAME_SUBMITTED', name: 'Testbolaget AB' })
    expect(s.step).toBe('address')
    s = journeyReducer(s, { type: 'ADDRESS_SUBMITTED', city: 'Lund' })
    expect(s.step).toBe('fskatt')
    s = journeyReducer(s, { type: 'FSKATT_ANSWERED', fskatt: false })
    expect(s.step).toBe('fy')
    expect(s.settings.f_skatt).toBe(false)
    expect(s.lookupRan).toBe(false)
  })

  it('address can be skipped (empty submit) and is only asked once', () => {
    const s = run(
      initJourney(),
      { type: 'ORG_SUBMITTED', orgNumber: '559999-9999' },
      { type: 'LOOKUP_RESULT', outcome: { status: 'not_found' } },
      { type: 'NOTFOUND_CONTINUE' },
      { type: 'ENTITY_PICKED', entityType: 'aktiebolag' },
      { type: 'NAME_SUBMITTED', name: 'Testbolaget AB' },
      { type: 'ADDRESS_SUBMITTED' },
    )
    expect(s.step).toBe('fskatt')
    expect(s.settings.address_line1).toBeUndefined()
  })

  // crm#1382 / crm#1419: a newly registered enskild firma is not in the
  // register yet. Its org number is the owner's personnummer, so the form
  // is settled by the number and the manual path starts at its questions.
  const NEW_FIRM = '19850420-1230' // fictional, Luhn-valid personnummer

  it('a personnummer not found continues manually as an enskild firma, without the picker', () => {
    const notfound = run(
      initJourney(),
      { type: 'ORG_SUBMITTED', orgNumber: NEW_FIRM },
      { type: 'LOOKUP_RESULT', outcome: { status: 'not_found' } },
    )
    expect(notfound.step).toBe('notfound')
    const s = journeyReducer(notfound, { type: 'NOTFOUND_CONTINUE' })
    expect(s.step).toBe('name')
    expect(s.settings.entity_type).toBe('enskild_firma')
    expect(s.settings.org_number).toBe(NEW_FIRM)
    expect(s.lookupRan).toBe(false)
  })

  it('Back from the settled form returns to notfound with the form unset', () => {
    const s = run(
      initJourney(),
      { type: 'ORG_SUBMITTED', orgNumber: NEW_FIRM },
      { type: 'LOOKUP_RESULT', outcome: { status: 'not_found' } },
      { type: 'NOTFOUND_CONTINUE' },
      { type: 'BACK' },
    )
    expect(s.step).toBe('notfound')
    expect(s.settings.entity_type).toBeUndefined()
    expect(s.settings.org_number).toBe(NEW_FIRM)
  })

  it('a failed lookup on a personnummer also settles enskild firma', () => {
    const s = run(
      initJourney(),
      { type: 'ORG_SUBMITTED', orgNumber: NEW_FIRM },
      { type: 'LOOKUP_RESULT', outcome: { status: 'error' } },
    )
    expect(s.step).toBe('name')
    expect(s.settings.entity_type).toBe('enskild_firma')
  })

  it('a juridisk person not found still asks the form', () => {
    const s = run(
      initJourney(),
      { type: 'ORG_SUBMITTED', orgNumber: '556036-0793' },
      { type: 'LOOKUP_RESULT', outcome: { status: 'not_found' } },
      { type: 'NOTFOUND_CONTINUE' },
    )
    expect(s.step).toBe('form')
    expect(s.settings.entity_type).toBeUndefined()
  })

  it('the manual enskild firma path collects the full payload through to submit', () => {
    const s = run(
      initJourney(),
      { type: 'ORG_SUBMITTED', orgNumber: NEW_FIRM },
      { type: 'LOOKUP_RESULT', outcome: { status: 'not_found' } },
      { type: 'NOTFOUND_CONTINUE' },
      { type: 'NAME_SUBMITTED', name: 'Alice Nordin Konsult' },
      { type: 'ADDRESS_SUBMITTED', addressLine1: 'Gatan 1', postalCode: '123 45', city: 'Lund' },
      { type: 'FSKATT_ANSWERED', fskatt: true },
      { type: 'FY_CALENDAR_CONFIRMED' },
      { type: 'VAT_ANSWERED', registered: true },
      { type: 'MOMS_PERIOD_PICKED', period: 'yearly' },
      { type: 'METHOD_PICKED', method: 'cash' },
    )
    expect(s.submitting).toBe(true)
    expect(s.settings).toMatchObject({
      entity_type: 'enskild_firma',
      org_number: NEW_FIRM,
      company_name: 'Alice Nordin Konsult',
      f_skatt: true,
      fiscal_year_start_month: 1,
      vat_registered: true,
      vat_number: 'SE850420123001',
      moms_period: 'yearly',
      accounting_method: 'cash',
    })
  })

  it('notfound → edit clears the orgnr and returns to the question', () => {
    const s = run(
      initJourney(),
      { type: 'ORG_SUBMITTED', orgNumber: '559999-9999' },
      { type: 'LOOKUP_RESULT', outcome: { status: 'not_found' } },
      { type: 'NOTFOUND_EDIT' },
    )
    expect(s.step).toBe('orgnr')
    expect(s.settings.org_number).toBeUndefined()
  })
})

describe('journeyReducer: ceased company', () => {
  it('interjects the ceased step and can continue with facts', () => {
    let s = run(
      initJourney(),
      { type: 'ORG_SUBMITTED', orgNumber: '556012-3456' },
      { type: 'LOOKUP_RESULT', outcome: { status: 'found', result: lookup({ isCeased: true }) } },
    )
    expect(s.step).toBe('ceased')
    s = journeyReducer(s, { type: 'CEASED_CONTINUE' })
    expect(s.step).toBe('fy')
    expect(s.settings.company_name).toBe('Nordvik Bygg & Konsult AB')
  })

  it('ceased → edit returns to the orgnr question', () => {
    const s = run(
      initJourney(),
      { type: 'ORG_SUBMITTED', orgNumber: '556012-3456' },
      { type: 'LOOKUP_RESULT', outcome: { status: 'found', result: lookup({ isCeased: true }) } },
      { type: 'CEASED_EDIT' },
    )
    expect(s.step).toBe('orgnr')
    expect(s.settings.org_number).toBeUndefined()
  })
})

describe('journeyReducer: BankID prefill', () => {
  it.each(['disabled', 'error'] as const)('keeps a sole trader BankID name when lookup is %s', (status) => {
    const s = run(
      initJourney({ initialOrgNumber: '900101-0017', initialEntityType: 'enskild_firma', initialLegalName: 'Jane Doe' }),
      { type: 'ORG_SUBMITTED', orgNumber: '900101-0017' },
      { type: 'LOOKUP_RESULT', outcome: { status } },
    )
    expect(s.step).toBe('address')
    expect(s.settings.company_name).toBe('Jane Doe')
  })
  const init = () =>
    initJourney({
      initialOrgNumber: '556677-8899',
      initialEntityType: 'aktiebolag',
      initialLegalName: 'Nordvik Bygg & Konsult AB',
    })

  it('a successful lookup on the deep-linked orgnr yields the facts path', () => {
    const s = run(
      init(),
      { type: 'ORG_SUBMITTED', orgNumber: '556677-8899' },
      { type: 'LOOKUP_RESULT', outcome: { status: 'found', result: lookup() } },
    )
    expect(s.step).toBe('fy')
    expect(s.lookupRan).toBe(true)
  })

  it('lookup failure degrades to questions: address and F-skatt are ASKED, VAT never defaulted', () => {
    let s = run(
      init(),
      { type: 'ORG_SUBMITTED', orgNumber: '556677-8899' },
      { type: 'LOOKUP_RESULT', outcome: { status: 'error' } },
    )
    // Name/entity from CompanyRoles survive as prefill; the rest is asked.
    expect(s.step).toBe('address')
    expect(s.lookupNote).toBe('error')
    expect(s.lookupRan).toBe(false)
    s = run(
      s,
      { type: 'ADDRESS_SUBMITTED', city: 'Malmö' },
      { type: 'FSKATT_ANSWERED', fskatt: true },
      { type: 'FY_CALENDAR_CONFIRMED' },
    )
    expect(s.step).toBe('momsyn')
    expect(s.settings.vat_registered).toBeUndefined()
  })

  it('a disabled lookup surface degrades silently (no advisory note)', () => {
    const s = run(
      init(),
      { type: 'ORG_SUBMITTED', orgNumber: '556677-8899' },
      { type: 'LOOKUP_RESULT', outcome: { status: 'disabled' } },
    )
    expect(s.step).toBe('address')
    expect(s.lookupNote).toBe('none')
  })

  it('without any prefill a disabled lookup goes to the form question', () => {
    const s = run(
      initJourney(),
      { type: 'ORG_SUBMITTED', orgNumber: '556677-8899' },
      { type: 'LOOKUP_RESULT', outcome: { status: 'disabled' } },
    )
    expect(s.step).toBe('form')
  })
})

describe('journeyReducer: fiscal-year branches', () => {
  it('first year: start + end dates, ongoing start month derived from the end', () => {
    const s = run(
      manualAbAtFy(),
      { type: 'FY_FIRST_SELECTED' },
      { type: 'FY_START_PICKED', date: '2026-03-14' },
      { type: 'FY_END_PICKED', date: '2026-12-31' },
    )
    expect(s.settings).toMatchObject({
      is_first_fiscal_year: true,
      first_year_start: '2026-03-14',
      first_year_end: '2026-12-31',
      fiscal_year_start_month: 1,
    })
    expect(s.step).toBe('momsyn')
  })

  it('first year ending mid-year points the ongoing year at the next month', () => {
    const s = run(
      manualAbAtFy(),
      { type: 'FY_FIRST_SELECTED' },
      { type: 'FY_START_PICKED', date: '2026-03-14' },
      { type: 'FY_END_PICKED', date: '2027-06-30' },
    )
    expect(s.settings.fiscal_year_start_month).toBe(7)
  })

  it('an extended first year: the dates picked are the period that gets created', () => {
    const s = run(
      manualAbAtFy(),
      { type: 'FY_FIRST_SELECTED' },
      { type: 'FY_START_PICKED', date: '2026-09-10' },
      { type: 'FY_END_PICKED', date: '2027-12-31' },
    )
    expect(computeFiscalPeriod(s.settings)).toEqual({
      error: null,
      startStr: '2026-09-10',
      endStr: '2027-12-31',
      periodName: 'Första räkenskapsåret 2026/2027',
    })
  })

  it('the first-year dates are one step from the end-month picker, and Back returns to it', () => {
    // "Annat räkenskapsår" is where someone looking for an extended year
    // lands; the picker there only makes twelve-month years.
    const atMonth = run(manualAbAtFy(), { type: 'FY_OTHER_SELECTED' })
    expect(atMonth.step).toBe('fymonth')
    const atStart = journeyReducer(atMonth, { type: 'FY_FIRST_SELECTED' })
    expect(atStart.step).toBe('fystart')
    expect(journeyReducer(atStart, { type: 'BACK' }).step).toBe('fymonth')
    const s = run(
      atStart,
      { type: 'FY_START_PICKED', date: '2026-02-10' },
      { type: 'FY_END_PICKED', date: '2027-06-30' },
    )
    expect(s.settings).toMatchObject({
      is_first_fiscal_year: true,
      first_year_start: '2026-02-10',
      first_year_end: '2027-06-30',
      fiscal_year_start_month: 7,
    })
    expect(s.step).toBe('momsyn')
  })

  it('a first year picked after a calendar-year answer replaces it, and the other way round', () => {
    const calendar = run(manualAbAtFy(), { type: 'FY_CALENDAR_CONFIRMED' })
    expect(calendar.settings.is_first_fiscal_year).toBe(false)
    const first = run(
      journeyReducer(calendar, { type: 'BACK' }),
      { type: 'FY_FIRST_SELECTED' },
      { type: 'FY_START_PICKED', date: '2026-09-10' },
      { type: 'FY_END_PICKED', date: '2027-12-31' },
    )
    expect(first.settings).toMatchObject({ is_first_fiscal_year: true, first_year_end: '2027-12-31' })
    const again = run(journeyReducer(first, { type: 'STATION_JUMP', station: 1 }), { type: 'FY_CALENDAR_CONFIRMED' })
    expect(again.settings).toMatchObject({ is_first_fiscal_year: false, fiscal_year_start_month: 1 })
    expect(again.settings.first_year_start).toBeUndefined()
    expect(again.settings.first_year_end).toBeUndefined()
  })

  it('brutet år: end month picks the following start month', () => {
    const s = run(manualAbAtFy(), { type: 'FY_OTHER_SELECTED' }, { type: 'FY_END_MONTH_PICKED', endMonth: 6 })
    expect(s.settings.fiscal_year_start_month).toBe(7)
    expect(s.settings.is_first_fiscal_year).toBe(false)
  })

  it('brutet år resolving to December is a plain calendar year', () => {
    const s = run(manualAbAtFy(), { type: 'FY_OTHER_SELECTED' }, { type: 'FY_END_MONTH_PICKED', endMonth: 12 })
    expect(s.settings.fiscal_year_start_month).toBe(1)
  })
})

describe('journeyReducer: Back and station jumps', () => {
  it('restores draft answers without repeating company creation or lookup requests', () => {
    const saved = { ...initJourney(), step: 'name' as const, settings: { company_name: 'Acme AB' }, submitting: true, lookupPending: true }
    const restored = journeyReducer(initJourney(), { type: 'RESTORE', state: saved })
    expect(restored).toMatchObject({ step: 'name', settings: { company_name: 'Acme AB' }, submitting: false, lookupPending: false })
    expect(journeyReducer(restored, { type: 'DRAFT_SETTINGS', settings: { company_name: 'Acme Holdings AB' } }).settings.company_name).toBe('Acme Holdings AB')
  })

  it('keeps later answers when reviewing an earlier question for the same company', () => {
    const earlier = { ...initJourney(), step: 'name' as const, settings: { org_number: '556677-8899', company_name: 'Acme AB' } }
    const current = { ...earlier, step: 'fskatt' as const, settings: { ...earlier.settings, address_line1: 'Example Street 1', city: 'Stockholm' } }
    const restored = journeyReducer(current, { type: 'RESTORE', state: earlier })
    expect(restored.settings.address_line1).toBe('Example Street 1')
    expect(restored.step).toBe('name')
  })
  it('Back restores each step to its ENTRY state (answers roll back)', () => {
    const atFy = manualAbAtFy()
    let s = journeyReducer(atFy, { type: 'BACK' })
    expect(s.step).toBe('fskatt')
    expect(s.settings.f_skatt).toBeUndefined()
    s = journeyReducer(s, { type: 'BACK' })
    expect(s.step).toBe('address')
    expect(s.settings.address_line1).toBeUndefined()
    expect(s.settings.city).toBeUndefined()
    s = journeyReducer(s, { type: 'BACK' })
    expect(s.step).toBe('name')
    expect(s.settings.company_name).toBeUndefined()
    s = journeyReducer(s, { type: 'BACK' })
    expect(s.step).toBe('form')
    expect(s.settings.entity_type).toBeUndefined()
  })

  it('a station jump rewinds to the first step of that station', () => {
    const s = run(
      initJourney(),
      { type: 'ORG_SUBMITTED', orgNumber: '556677-8899' },
      { type: 'LOOKUP_RESULT', outcome: { status: 'found', result: lookup() } },
      { type: 'FY_CALENDAR_CONFIRMED' },
      { type: 'MOMS_PERIOD_PICKED', period: 'quarterly' },
      { type: 'STATION_JUMP', station: 1 },
    )
    expect(s.step).toBe('fy')
    expect(s.settings.moms_period).toBeUndefined()
    expect(s.settings.fiscal_year_start_month).toBeUndefined()
    // The lookup facts from station 0 survive.
    expect(s.settings.company_name).toBe('Nordvik Bygg & Konsult AB')
  })

  it('jumping to the Företaget station lands on the orgnr question', () => {
    const s = run(
      manualAbAtFy(),
      { type: 'FY_CALENDAR_CONFIRMED' },
      { type: 'STATION_JUMP', station: 0 },
    )
    expect(s.step).toBe('orgnr')
    expect(s.settings.company_name).toBeUndefined()
  })

  it('ignores jumps to the current or a later station', () => {
    const s = manualAbAtFy()
    expect(journeyReducer(s, { type: 'STATION_JUMP', station: 1 })).toBe(s)
    expect(journeyReducer(s, { type: 'STATION_JUMP', station: 3 })).toBe(s)
  })
})

describe('journeyReducer: entity change wipe', () => {
  it('a genuine entity change wipes org/name and all downstream answers', () => {
    let s = run(manualAbAtFy(), { type: 'FY_CALENDAR_CONFIRMED' }, { type: 'VAT_ANSWERED', registered: false })
    expect(s.step).toBe('method')
    // Defensive guard: an entity change with answers on file (however the UI
    // reaches it) resets the flow to the orgnr question and wipes downstream.
    s = journeyReducer(s, { type: 'ENTITY_PICKED', entityType: 'enskild_firma' })
    expect(s.step).toBe('orgnr')
    expect(s.settings.entity_type).toBe('enskild_firma')
    expect(s.settings.org_number).toBeUndefined()
    expect(s.settings.company_name).toBeUndefined()
    expect(s.settings.vat_registered).toBeUndefined()
    expect(s.settings.moms_period).toBeUndefined()
    expect(s.settings.accounting_method).toBeUndefined()
  })

  it('a station jump to Företaget already rolls entity back, so re-picking is first-time', () => {
    let s = run(manualAbAtFy(), { type: 'FY_CALENDAR_CONFIRMED' }, { type: 'VAT_ANSWERED', registered: false })
    s = run(
      s,
      { type: 'STATION_JUMP', station: 0 },
      { type: 'ORG_SUBMITTED', orgNumber: '559999-9999' },
      { type: 'LOOKUP_RESULT', outcome: { status: 'not_found' } },
      { type: 'NOTFOUND_CONTINUE' },
      { type: 'ENTITY_PICKED', entityType: 'enskild_firma' },
    )
    // Entry snapshots already wiped the old answers at the jump; the fresh
    // pick proceeds forward (no second wipe needed).
    expect(s.step).toBe('name')
    expect(s.settings.entity_type).toBe('enskild_firma')
    expect(s.settings.vat_registered).toBeUndefined()
    expect(s.settings.accounting_method).toBeUndefined()
  })

  it('first-time entity selection keeps a deep-link prefill', () => {
    const s = run(
      initJourney({ initialOrgNumber: '556677-8899', initialLegalName: 'Nordvik AB' }),
      { type: 'ORG_SUBMITTED', orgNumber: '556677-8899' },
      { type: 'LOOKUP_RESULT', outcome: { status: 'error' } },
      { type: 'ENTITY_PICKED', entityType: 'aktiebolag' },
    )
    expect(s.settings.org_number).toBe('556677-8899')
    expect(s.settings.company_name).toBe('Nordvik AB')
  })
})

describe('journeyReducer: server errors', () => {
  function submitted(): JourneyState {
    return run(
      initJourney(),
      { type: 'ORG_SUBMITTED', orgNumber: '556677-8899' },
      { type: 'LOOKUP_RESULT', outcome: { status: 'found', result: lookup() } },
      { type: 'FY_CALENDAR_CONFIRMED' },
      { type: 'MOMS_PERIOD_PICKED', period: 'monthly' },
      { type: 'METHOD_PICKED', method: 'cash' },
    )
  }

  it('org_number_invalid travels back to the orgnr question, keeping answers', () => {
    const s = journeyReducer(submitted(), { type: 'SUBMIT_FAILED', code: 'org_number_invalid' })
    expect(s.step).toBe('orgnr')
    expect(s.serverError).toBe('org_number_invalid')
    expect(s.submitting).toBe(false)
    expect(s.lookupRan).toBe(false)
    expect(s.settings.accounting_method).toBe('cash')
  })

  it('period_invalid returns to the fiscal-year station', () => {
    const s = journeyReducer(submitted(), { type: 'SUBMIT_FAILED', code: 'period_invalid' })
    expect(s.step).toBe('fy')
    expect(s.serverError).toBe('period_invalid')
  })

  it('generic failure stays on method with a retry state', () => {
    const s = journeyReducer(submitted(), { type: 'SUBMIT_FAILED', code: 'generic' })
    expect(s.step).toBe('method')
    expect(s.serverError).toBe('generic')
    expect(s.submitting).toBe(false)
  })

  it('any new answer clears the server error', () => {
    const failed = journeyReducer(submitted(), { type: 'SUBMIT_FAILED', code: 'org_number_invalid' })
    const s = run(failed, { type: 'ORG_SUBMITTED', orgNumber: '556677-8899' })
    expect(s.serverError).toBeNull()
  })
})

describe('journeyReducer: done screen', () => {
  function atDone(): JourneyState {
    return run(
      initJourney({ mode: 'first' }),
      { type: 'ORG_SUBMITTED', orgNumber: '556677-8899' },
      { type: 'LOOKUP_RESULT', outcome: { status: 'found', result: lookup() } },
      { type: 'FY_CALENDAR_CONFIRMED' },
      { type: 'MOMS_PERIOD_PICKED', period: 'quarterly' },
      { type: 'METHOD_PICKED', method: 'accrual' },
      { type: 'SUBMIT_SUCCEEDED' },
    )
  }

  it('the done screen is the last step: only its own button leaves it', () => {
    const s = atDone()
    expect(s.step).toBe('done')
    expect(stationOfStep(s.step)).toBe(4)
  })

  it('has no Tillbaka: the company exists, and back there used to open the app, which is the next act', () => {
    const s = atDone()
    expect(s.history.length).toBeGreaterThan(0)
    expect(journeyBack(s, '/')).toEqual({ kind: 'none' })
    expect(journeyBack(s, null)).toEqual({ kind: 'none' })
  })
})

describe('journeyBack: what Tillbaka does on each question', () => {
  it('steps back inside the journey on every question that has one before it', () => {
    let s = manualAbAtFy()
    const visited: string[] = []
    while (s.history.length > 0) {
      visited.push(s.step)
      // With or without a page to leave for: a question behind always wins.
      expect(journeyBack(s, '/select-company'), s.step).toEqual({ kind: 'step' })
      expect(journeyBack(s, null), s.step).toEqual({ kind: 'step' })
      const before = s
      s = journeyReducer(s, { type: 'BACK' })
      // Back lands on an earlier question and answers nothing on the way.
      expect(stationOfStep(s.step)).toBeLessThanOrEqual(stationOfStep(before.step))
      expect(s.history.length).toBe(before.history.length - 1)
    }
    expect(visited).toEqual(['fy', 'fskatt', 'address', 'name', 'form', 'notfound'])
    expect(s.step).toBe('orgnr')
  })

  it('leaves the first question for a page that renders, or is not shown', () => {
    const first = initJourney()
    expect(journeyBack(first, '/select-company')).toEqual({ kind: 'exit', href: '/select-company' })
    expect(journeyBack(first, null)).toEqual({ kind: 'none' })
  })

  it('drops a date pick that arrives after Tillbaka left the start question', () => {
    // The picker sends the date a moment after the tap; pressed in between,
    // Tillbaka was overtaken and the journey moved on to the end date.
    const atStart = run(manualAbAtFy(), { type: 'FY_FIRST_SELECTED' })
    expect(atStart.step).toBe('fystart')
    const back = journeyReducer(atStart, { type: 'BACK' })
    expect(back.step).toBe('fy')
    const late = journeyReducer(back, { type: 'FY_START_PICKED', date: '2026-03-14' })
    expect(late).toBe(back)
    expect(late.settings.first_year_start).toBeUndefined()
  })

  it('never answers the question it leaves: the skipped address stays unasked after Back', () => {
    const skipped = run(
      initJourney(),
      { type: 'ORG_SUBMITTED', orgNumber: '559999-9999' },
      { type: 'LOOKUP_RESULT', outcome: { status: 'not_found' } },
      { type: 'NOTFOUND_CONTINUE' },
      { type: 'ENTITY_PICKED', entityType: 'aktiebolag' },
      { type: 'NAME_SUBMITTED', name: 'Testbolaget AB' },
      { type: 'ADDRESS_SUBMITTED' },
    )
    expect(skipped).toMatchObject({ step: 'fskatt', addressAsked: true })
    const back = journeyReducer(skipped, { type: 'BACK' })
    expect(back).toMatchObject({ step: 'address', addressAsked: false })
    expect(journeyReducer(back, { type: 'BACK' })).toMatchObject({ step: 'name', addressAsked: false })
  })
})

describe('journeyReducer: robustness', () => {
  it('ignores a LOOKUP_RESULT when no lookup is pending', () => {
    const s = initJourney()
    expect(journeyReducer(s, { type: 'LOOKUP_RESULT', outcome: { status: 'not_found' } })).toBe(s)
  })

  it('ignores an aborted lookup (stays on orgnr, pending cleared)', () => {
    const s = run(
      initJourney(),
      { type: 'ORG_SUBMITTED', orgNumber: '556677-8899' },
      { type: 'LOOKUP_RESULT', outcome: { status: 'aborted' } },
    )
    expect(s.step).toBe('orgnr')
    expect(s.lookupPending).toBe(false)
  })

  it('ignores Back while submitting and with empty history', () => {
    const fresh = initJourney()
    expect(journeyReducer(fresh, { type: 'BACK' })).toBe(fresh)
  })

  it('an unmappable entity type from the lookup falls through to the form question', () => {
    const s = run(
      initJourney(),
      { type: 'ORG_SUBMITTED', orgNumber: '969612-3456' },
      {
        type: 'LOOKUP_RESULT',
        outcome: {
          status: 'found',
          result: lookup({ companyName: 'Sjöutsikten Gruvbolag', legalEntityType: 'Gruvbolag' }),
        },
      },
    )
    expect(s.step).toBe('form')
    expect(s.plannedForm).toBeNull()
    expect(s.settings.company_name).toBe('Sjöutsikten Gruvbolag')
    expect(s.lookupRan).toBe(true)
  })

  it('a kommanditbolag from the lookup stops before the picker instead of passing as an aktiebolag (PH 207)', () => {
    const s = run(
      initJourney(),
      { type: 'ORG_SUBMITTED', orgNumber: '969612-3456' },
      {
        type: 'LOOKUP_RESULT',
        outcome: { status: 'found', result: lookup({ companyName: 'Sjöutsikten KB', legalEntityType: 'Kommanditbolag' }) },
      },
    )
    expect(s.step).toBe('planned')
    expect(s.plannedForm).toBe('kommanditbolag')
    expect(s.settings.entity_type).toBeUndefined()
  })
})

describe('journeyReducer: a form Accounted has scoped but cannot create yet', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  const brfLookup = lookup({ companyName: 'Brf Sjöutsikten', legalEntityType: 'Bostadsrättsförening' })

  it('stops on the planned step instead of offering the picker, and names the form', () => {
    const s = run(
      initJourney(),
      { type: 'ORG_SUBMITTED', orgNumber: '769612-3456' },
      { type: 'LOOKUP_RESULT', outcome: { status: 'found', result: brfLookup } },
    )
    expect(s.step).toBe('planned')
    expect(s.plannedForm).toBe('bostadsrattsforening')
    expect(s.settings.entity_type).toBeUndefined()
    expect(s.settings.company_name).toBe('Brf Sjöutsikten')
    expect(s.lookupRan).toBe(true)
  })

  it('PLANNED_EDIT returns to the orgnr question and forgets the form', () => {
    const s = run(
      initJourney(),
      { type: 'ORG_SUBMITTED', orgNumber: '769612-3456' },
      { type: 'LOOKUP_RESULT', outcome: { status: 'found', result: brfLookup } },
      { type: 'PLANNED_EDIT' },
    )
    expect(s.step).toBe('orgnr')
    expect(s.plannedForm).toBeNull()
    expect(s.settings.org_number).toBeUndefined()
  })

  it('PLANNED_CONTINUE reaches the picker with the form still named; Back returns to the stop', () => {
    const atForm = run(
      initJourney(),
      { type: 'ORG_SUBMITTED', orgNumber: '769612-3456' },
      { type: 'LOOKUP_RESULT', outcome: { status: 'found', result: brfLookup } },
      { type: 'PLANNED_CONTINUE' },
    )
    expect(atForm.step).toBe('form')
    expect(atForm.plannedForm).toBe('bostadsrattsforening')
    const back = journeyReducer(atForm, { type: 'BACK' })
    expect(back.step).toBe('planned')
    expect(back.plannedForm).toBe('bostadsrattsforening')
  })

  it('a fresh orgnr clears the planned form', () => {
    const s = run(
      initJourney(),
      { type: 'ORG_SUBMITTED', orgNumber: '769612-3456' },
      { type: 'LOOKUP_RESULT', outcome: { status: 'found', result: brfLookup } },
      { type: 'PLANNED_CONTINUE' },
      { type: 'ENTITY_PICKED', entityType: 'aktiebolag' },
      { type: 'ORG_SUBMITTED', orgNumber: '556677-8899' },
    )
    expect(s.plannedForm).toBeNull()
  })

  it('an SCB row for a planned form with no registry hit stops after "continue manually"', () => {
    const s = run(
      initJourney(),
      {
        type: 'SUGGESTION_PICKED',
        suggestion: {
          orgNumber: '7176001234',
          name: 'Samfälligheten Åsen',
          city: 'Lund',
          legalEntityType: 'Samfällighetsförening',
          active: true,
        },
      },
      { type: 'LOOKUP_RESULT', outcome: { status: 'not_found' } },
      { type: 'NOTFOUND_CONTINUE' },
    )
    expect(s.step).toBe('planned')
    expect(s.plannedForm).toBe('samfallighetsforening')
  })

  it('a flagged-off ideell förening from the registry is a stop too, not a picker', () => {
    vi.stubEnv('NEXT_PUBLIC_IDEELL_FORENING_ENABLED', '')
    const s = run(
      initJourney(),
      { type: 'ORG_SUBMITTED', orgNumber: '802400-1234' },
      {
        type: 'LOOKUP_RESULT',
        outcome: { status: 'found', result: lookup({ companyName: 'Byalaget', legalEntityType: 'Ideell förening' }) },
      },
    )
    expect(s.step).toBe('planned')
    expect(s.plannedForm).toBe('ideell_forening')
  })

  it('a creatable ideell förening is prefilled like any registered form (name is a fact)', () => {
    vi.stubEnv('NEXT_PUBLIC_IDEELL_FORENING_ENABLED', 'true')
    const s = run(
      initJourney(),
      { type: 'ORG_SUBMITTED', orgNumber: '802400-1234' },
      {
        type: 'LOOKUP_RESULT',
        outcome: { status: 'found', result: lookup({ companyName: 'Byalaget', legalEntityType: 'Ideell förening' }) },
      },
    )
    expect(s.step).toBe('fy')
    expect(s.plannedForm).toBeNull()
    expect(s.settings.entity_type).toBe('ideell_forening')
  })

  it('only a form whose org number is a personnummer re-asks a prefilled name', () => {
    vi.stubEnv('NEXT_PUBLIC_IDEELL_FORENING_ENABLED', 'true')
    const forening = run(
      initJourney(),
      {
        type: 'SUGGESTION_PICKED',
        suggestion: { orgNumber: '8024001234', name: 'Byalaget', city: 'Lund', legalEntityType: 'Ideell förening', active: true },
      },
      { type: 'LOOKUP_RESULT', outcome: { status: 'disabled' } },
    )
    // The registered name is a fact: straight to the address question.
    expect(forening.step).toBe('address')
    const firma = run(
      initJourney(),
      {
        type: 'SUGGESTION_PICKED',
        suggestion: { orgNumber: '8001011234', name: 'ANDERSSON, ANNA', city: 'Lund', legalEntityType: 'EF', active: true },
      },
      { type: 'LOOKUP_RESULT', outcome: { status: 'disabled' } },
    )
    expect(firma.step).toBe('name')
  })
})

describe('registry hint after a TIC miss (SCB knew the org number)', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  const hint = (overrides: Partial<import('@/lib/company-lookup/types').RegistryHint> = {}) => ({
    source: 'scb' as const,
    companyName: 'Segelsällskapet Gambit',
    legalEntityType: 'Ideell förening',
    address: { street: 'Hamnvägen 3', postalCode: '76140', city: 'Norrtälje' },
    registration: { fTax: null, vat: null },
    ...overrides,
  })

  it('settles the form, the name and the address, then asks what SCB does not know', () => {
    vi.stubEnv('NEXT_PUBLIC_IDEELL_FORENING_ENABLED', 'true')
    const s = run(
      initJourney(),
      { type: 'ORG_SUBMITTED', orgNumber: '802233-4455' },
      { type: 'LOOKUP_RESULT', outcome: { status: 'not_found', registry: hint() } },
    )
    expect(s.settings.entity_type).toBe('ideell_forening')
    expect(s.settings.company_name).toBe('Segelsällskapet Gambit')
    expect(s.settings.city).toBe('Norrtälje')
    expect(s.settings.f_skatt).toBeUndefined()
    expect(s.lookupRan).toBe(false)
    expect(s.plannedForm).toBeNull()
    expect(s.step).toBe('fskatt')
  })

  it('takes F-skatt from SCB when stated and asks for an address it lacks', () => {
    vi.stubEnv('NEXT_PUBLIC_IDEELL_FORENING_ENABLED', 'true')
    const s = run(
      initJourney(),
      { type: 'ORG_SUBMITTED', orgNumber: '802233-4455' },
      {
        type: 'LOOKUP_RESULT',
        outcome: { status: 'not_found', registry: hint({ address: null, registration: { fTax: true, vat: null } }) },
      },
    )
    expect(s.settings.f_skatt).toBe(true)
    expect(s.step).toBe('address')
  })

  it('stops on the planned form when SCB names one Accounted cannot create yet', () => {
    vi.stubEnv('NEXT_PUBLIC_IDEELL_FORENING_ENABLED', 'true')
    const s = run(
      initJourney(),
      { type: 'ORG_SUBMITTED', orgNumber: '769600-0000' },
      {
        type: 'LOOKUP_RESULT',
        outcome: { status: 'not_found', registry: hint({ companyName: 'Brf Hamnen', legalEntityType: 'Bostadsrättsförening' }) },
      },
    )
    expect(s.step).toBe('planned')
    expect(s.plannedForm).toBe('bostadsrattsforening')
    expect(s.settings.entity_type).toBeUndefined()
    expect(s.settings.company_name).toBe('Brf Hamnen')
  })

  it('stops on ideell förening while its creation flag is off', () => {
    vi.stubEnv('NEXT_PUBLIC_IDEELL_FORENING_ENABLED', '')
    const s = run(
      initJourney(),
      { type: 'ORG_SUBMITTED', orgNumber: '802233-4455' },
      { type: 'LOOKUP_RESULT', outcome: { status: 'not_found', registry: hint() } },
    )
    expect(s.step).toBe('planned')
    expect(s.plannedForm).toBe('ideell_forening')
  })

  it('a miss without a hint still goes to the not-found stop', () => {
    const s = run(
      initJourney(),
      { type: 'ORG_SUBMITTED', orgNumber: '802233-4455' },
      { type: 'LOOKUP_RESULT', outcome: { status: 'not_found' } },
    )
    expect(s.step).toBe('notfound')
  })
})

describe('journeyReducer: a company without an org number', () => {
  /** A byrå adding a test client: no number, the manual path to the VAT question. */
  function withoutOrgAtMomsyn(): JourneyState {
    return run(
      initJourney({ mode: 'add' }),
      { type: 'NO_ORG_CONTINUE' },
      { type: 'ENTITY_PICKED', entityType: 'aktiebolag' },
      { type: 'NAME_SUBMITTED', name: 'Testbolaget AB' },
      { type: 'ADDRESS_SUBMITTED', addressLine1: 'Gatan 1', postalCode: '123 45', city: 'Lund' },
      { type: 'FSKATT_ANSWERED', fskatt: true },
      { type: 'FY_CALENDAR_CONFIRMED' },
    )
  }

  it('leaves the orgnr step for the form picker with no number and no lookup', () => {
    const s = journeyReducer(initJourney({ mode: 'add' }), { type: 'NO_ORG_CONTINUE' })
    expect(s.step).toBe('form')
    expect(s.settings.org_number).toBeUndefined()
    expect(s.lookupRan).toBe(false)
    expect(s.lookupPending).toBe(false)
    expect(journeyReducer(s, { type: 'BACK' }).step).toBe('orgnr')
  })

  it('reaches the create step with vat_registered false and no org number', () => {
    const s = run(
      withoutOrgAtMomsyn(),
      { type: 'VAT_ANSWERED', registered: false },
      { type: 'METHOD_PICKED', method: 'accrual' },
    )
    expect(s.submitting).toBe(true)
    expect(s.settings).toMatchObject({
      entity_type: 'aktiebolag',
      company_name: 'Testbolaget AB',
      f_skatt: true,
      vat_registered: false,
      vat_number: null,
      moms_period: null,
      accounting_method: 'accrual',
    })
    expect(s.settings.org_number).toBeUndefined()
  })

  it('a VAT-registered answer goes back to the orgnr step instead of a company with no momsregistreringsnummer', () => {
    const before = withoutOrgAtMomsyn()
    expect(before.step).toBe('momsyn')
    const s = journeyReducer(before, { type: 'VAT_ANSWERED', registered: true })
    expect(s.step).toBe('orgnr')
    expect(s.serverError).toBe('vat_needs_org_number')
    expect(s.settings.vat_registered).toBeUndefined()
    expect(s.settings.company_name).toBe('Testbolaget AB')
    // Entering the number clears the note and runs the lookup as usual.
    const typed = journeyReducer(s, { type: 'ORG_SUBMITTED', orgNumber: '559999-9999' })
    expect(typed.serverError).toBeNull()
    expect(typed.lookupPending).toBe(true)
  })

  it('a name search keeps the VAT reason for the number until a hit is picked (crm#1909)', () => {
    const sent = journeyReducer(withoutOrgAtMomsyn(), { type: 'VAT_ANSWERED', registered: true })
    const hit = { orgNumber: '5566778899', result: lookup() }
    const waiting = run(
      sent,
      { type: 'SEARCH_SUBMITTED', query: 'Testbolaget' },
      { type: 'SEARCH_RESULT', outcome: { status: 'found', hits: [hit] } },
    )
    // The UI hides "Fortsätt utan" on this reason: continuing without a
    // number would drop every kept answer and loop back to the VAT question.
    expect(waiting.step).toBe('orgnr')
    expect(waiting.serverError).toBe('vat_needs_org_number')
    const picked = journeyReducer(waiting, { type: 'SEARCH_HIT_PICKED', hit })
    expect(picked.serverError).toBeNull()
    expect(picked.settings.org_number).toBe('5566778899')
  })

  it('drops a BankID prefill: the name and form belonged to a number', () => {
    const s = journeyReducer(
      initJourney({ initialOrgNumber: '556677-8899', initialEntityType: 'aktiebolag', initialLegalName: 'Nordvik Bygg & Konsult AB' }),
      { type: 'NO_ORG_CONTINUE' },
    )
    expect(s.step).toBe('form')
    expect(s.settings).toEqual({})
    expect(s.viaPrefill).toBe(false)
  })

  it('drops the answers a refused number left on the orgnr step', () => {
    const refused = run(
      initJourney(),
      { type: 'ORG_SUBMITTED', orgNumber: '556677-8899' },
      { type: 'LOOKUP_RESULT', outcome: { status: 'found', result: lookup() } },
      { type: 'FY_CALENDAR_CONFIRMED' },
      { type: 'MOMS_PERIOD_PICKED', period: 'quarterly' },
      { type: 'METHOD_PICKED', method: 'accrual' },
      { type: 'SUBMIT_FAILED', code: 'org_number_invalid' },
    )
    expect(refused.step).toBe('orgnr')
    expect(refused.settings.company_name).toBe('Nordvik Bygg & Konsult AB')
    const s = journeyReducer(refused, { type: 'NO_ORG_CONTINUE' })
    expect(s.step).toBe('form')
    expect(s.settings).toEqual({})
    expect(s.ticLookup).toBeNull()
  })

  it('is ignored off the orgnr step and while a lookup runs', () => {
    const atForm = journeyReducer(initJourney(), { type: 'NO_ORG_CONTINUE' })
    expect(journeyReducer(atForm, { type: 'NO_ORG_CONTINUE' })).toBe(atForm)
    const looking = journeyReducer(initJourney(), { type: 'ORG_SUBMITTED', orgNumber: '556677-8899' })
    expect(journeyReducer(looking, { type: 'NO_ORG_CONTINUE' })).toBe(looking)
  })

  it('a personnummer typed after the VAT bounce settles enskild firma over the aktiebolag picked without it', () => {
    const s = run(
      withoutOrgAtMomsyn(),
      { type: 'VAT_ANSWERED', registered: true },
      { type: 'ORG_SUBMITTED', orgNumber: '19900101-0017' },
      { type: 'LOOKUP_RESULT', outcome: { status: 'not_found' } },
      { type: 'NOTFOUND_CONTINUE' },
    )
    expect(s.settings.entity_type).toBe('enskild_firma')
    expect(s.settings.org_number).toBe('19900101-0017')
    // The name and the answers the aktiebolag shaped are asked again.
    expect(s.settings.company_name).toBeUndefined()
    expect(s.settings.fiscal_year_start_month).toBeUndefined()
    expect(s.settings.vat_registered).toBeUndefined()
    expect(s.step).toBe('name')
  })

  it('a typed number still asks for VAT normally', () => {
    const s = run(manualAbAtFy(), { type: 'FY_CALENDAR_CONFIRMED' }, { type: 'VAT_ANSWERED', registered: true })
    expect(s.step).toBe('moms')
    expect(s.serverError).toBeNull()
    expect(s.settings.vat_registered).toBe(true)
  })
})
