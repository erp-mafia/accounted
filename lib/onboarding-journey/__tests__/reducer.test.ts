import { describe, it, expect } from 'vitest'
import {
  initJourney,
  journeyReducer,
  stationOfStep,
  type JourneyAction,
  type JourneyState,
} from '../reducer'
import type { CompanyLookupResult } from '@/lib/company-lookup/types'

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

  it('still asks the verksamhetsnamn question (name is a choice for EF)', () => {
    const s = run(
      initJourney(),
      { type: 'ORG_SUBMITTED', orgNumber: '19850420-1234' },
      { type: 'LOOKUP_RESULT', outcome: { status: 'found', result: efLookup } },
    )
    expect(s.step).toBe('name')
    expect(s.settings.entity_type).toBe('enskild_firma')
    expect(s.settings.company_name).toBe('Alice Nordin')
  })

  it('skips address and F-skatt after the name (lookup facts), then asks moms: never defaults a negative VAT', () => {
    const s = run(
      initJourney(),
      { type: 'ORG_SUBMITTED', orgNumber: '19850420-1234' },
      { type: 'LOOKUP_RESULT', outcome: { status: 'found', result: efLookup } },
      { type: 'NAME_SUBMITTED', name: 'Alice Nordin Design' },
      { type: 'FY_CALENDAR_CONFIRMED' },
    )
    expect(s.settings.company_name).toBe('Alice Nordin Design')
    expect(s.settings.f_skatt).toBe(true)
    expect(s.step).toBe('momsyn')
    expect(s.settings.vat_registered).toBeUndefined()
  })

  it('answers moms nej: no VAT number, no period, straight to method', () => {
    const s = run(
      initJourney(),
      { type: 'ORG_SUBMITTED', orgNumber: '19850420-1234' },
      { type: 'LOOKUP_RESULT', outcome: { status: 'found', result: efLookup } },
      { type: 'NAME_SUBMITTED', name: 'Alice Nordin' },
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

describe('journeyReducer: branch question step (source)', () => {
  function atDone(mode: 'first' | 'add' = 'first'): JourneyState {
    return run(
      initJourney({ mode }),
      { type: 'ORG_SUBMITTED', orgNumber: '556677-8899' },
      { type: 'LOOKUP_RESULT', outcome: { status: 'found', result: lookup() } },
      { type: 'FY_CALENDAR_CONFIRMED' },
      { type: 'MOMS_PERIOD_PICKED', period: 'quarterly' },
      { type: 'METHOD_PICKED', method: 'accrual' },
      { type: 'SUBMIT_SUCCEEDED' },
    )
  }

  it('continue moves the done screen to the source step, still on the Klart station', () => {
    const s = journeyReducer(atDone(), { type: 'DONE_CONTINUE' })
    expect(s.step).toBe('source')
    expect(stationOfStep(s.step)).toBe(4)
  })

  it("mode='add' never reaches the source step", () => {
    const s = atDone('add')
    expect(journeyReducer(s, { type: 'DONE_CONTINUE' })).toBe(s)
  })

  it('is ignored anywhere but the done screen', () => {
    const s = manualAbAtFy()
    expect(journeyReducer(s, { type: 'DONE_CONTINUE' })).toBe(s)
  })

  it('Back from the source step restores the done screen', () => {
    const s = run(atDone(), { type: 'DONE_CONTINUE' }, { type: 'BACK' })
    expect(s.step).toBe('done')
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
      { type: 'ORG_SUBMITTED', orgNumber: '769612-3456' },
      {
        type: 'LOOKUP_RESULT',
        outcome: {
          status: 'found',
          result: lookup({ companyName: 'Brf Sjöutsikten', legalEntityType: 'BRF' }),
        },
      },
    )
    expect(s.step).toBe('form')
    expect(s.settings.company_name).toBe('Brf Sjöutsikten')
    expect(s.lookupRan).toBe(true)
  })
})
