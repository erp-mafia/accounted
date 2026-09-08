import { describe, it, expect } from 'vitest'
import { initJourney, journeyReducer, type JourneyAction, type JourneyState } from '../reducer'
import type { CompanyLookupResult, CompanySearchHit } from '@/lib/company-lookup/types'

function lookup(overrides: Partial<CompanyLookupResult> = {}): CompanyLookupResult {
  return {
    companyName: 'Testbrand AB',
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

function hit(orgNumber: string, overrides: Partial<CompanyLookupResult> = {}): CompanySearchHit {
  return { orgNumber, result: lookup(overrides) }
}

function run(state: JourneyState, ...actions: JourneyAction[]): JourneyState {
  return actions.reduce(journeyReducer, state)
}

describe('journeyReducer: name search', () => {
  it('SEARCH_SUBMITTED clears the previous orgnr and facts and marks the lookup pending', () => {
    const prior = run(
      initJourney(),
      { type: 'ORG_SUBMITTED', orgNumber: '556677-8899' },
      { type: 'LOOKUP_RESULT', outcome: { status: 'not_found' } },
      { type: 'NOTFOUND_EDIT' },
    )
    const s = journeyReducer(prior, { type: 'SEARCH_SUBMITTED', query: 'Testbrand' })
    expect(s.step).toBe('orgnr')
    expect(s.lookupPending).toBe(true)
    expect(s.settings.org_number).toBeUndefined()
    expect(s.ticLookup).toBeNull()
    expect(s.searchHits).toEqual([])
  })

  it('a single hit resolves exactly like a typed orgnr', () => {
    const viaSearch = run(
      initJourney(),
      { type: 'SEARCH_SUBMITTED', query: 'Testbrand' },
      { type: 'SEARCH_RESULT', outcome: { status: 'found', hits: [hit('5566778899')] } },
    )
    const viaOrg = run(
      initJourney(),
      { type: 'ORG_SUBMITTED', orgNumber: '5566778899' },
      { type: 'LOOKUP_RESULT', outcome: { status: 'found', result: lookup() } },
    )
    expect(viaSearch.step).toBe('fy')
    expect(viaSearch.settings).toEqual(viaOrg.settings)
    expect(viaSearch.lookupRan).toBe(true)
    expect(viaSearch.searchHits).toEqual([])
    expect(viaSearch.lookupPending).toBe(false)
  })

  it('several hits stay on the orgnr step and wait for a pick', () => {
    const s = run(
      initJourney(),
      { type: 'SEARCH_SUBMITTED', query: 'Testbrand' },
      {
        type: 'SEARCH_RESULT',
        outcome: { status: 'found', hits: [hit('1111111111'), hit('2222222222')] },
      },
    )
    expect(s.step).toBe('orgnr')
    expect(s.lookupPending).toBe(false)
    expect(s.searchHits.map((h) => h.orgNumber)).toEqual(['1111111111', '2222222222'])
    expect(s.settings.org_number).toBeUndefined()
    expect(s.lookupRan).toBe(false)
  })

  it('SEARCH_HIT_PICKED applies the picked hit as lookup facts and advances', () => {
    const waiting = run(
      initJourney(),
      { type: 'SEARCH_SUBMITTED', query: 'Testbrand' },
      {
        type: 'SEARCH_RESULT',
        outcome: {
          status: 'found',
          hits: [hit('1111111111'), hit('2222222222', { companyName: 'Testbrand Bygg AB' })],
        },
      },
    )
    const s = journeyReducer(waiting, {
      type: 'SEARCH_HIT_PICKED',
      hit: hit('2222222222', { companyName: 'Testbrand Bygg AB' }),
    })
    expect(s.step).toBe('fy')
    expect(s.searchHits).toEqual([])
    expect(s.lookupRan).toBe(true)
    expect(s.settings).toMatchObject({
      org_number: '2222222222',
      entity_type: 'aktiebolag',
      company_name: 'Testbrand Bygg AB',
      f_skatt: true,
    })
  })

  it('a picked ceased hit routes to the ceased step like a typed orgnr would', () => {
    const s = run(
      initJourney(),
      { type: 'SEARCH_SUBMITTED', query: 'Testbrand' },
      {
        type: 'SEARCH_RESULT',
        outcome: { status: 'found', hits: [hit('1111111111'), hit('2222222222', { isCeased: true })] },
      },
      { type: 'SEARCH_HIT_PICKED', hit: hit('2222222222', { isCeased: true }) },
    )
    expect(s.step).toBe('ceased')
    expect(s.settings.org_number).toBe('2222222222')
  })

  it('a hit without a mappable entity type goes to the form step', () => {
    const s = run(
      initJourney(),
      { type: 'SEARCH_SUBMITTED', query: 'Testbrand' },
      {
        type: 'SEARCH_RESULT',
        outcome: { status: 'found', hits: [hit('1111111111', { legalEntityType: 'HB' })] },
      },
    )
    expect(s.step).toBe('form')
  })

  it('SEARCH_HIT_PICKED is ignored off the orgnr step', () => {
    const atFy = run(
      initJourney(),
      { type: 'SEARCH_SUBMITTED', query: 'Testbrand' },
      { type: 'SEARCH_RESULT', outcome: { status: 'found', hits: [hit('1111111111')] } },
    )
    expect(atFy.step).toBe('fy')
    const s = journeyReducer(atFy, { type: 'SEARCH_HIT_PICKED', hit: hit('2222222222') })
    expect(s).toBe(atFy)
  })

  it('no match stays on the step with the nomatch note (no orgnr to continue with)', () => {
    const s = run(
      initJourney(),
      { type: 'SEARCH_SUBMITTED', query: 'Nothing Like This' },
      { type: 'SEARCH_RESULT', outcome: { status: 'not_found' } },
    )
    expect(s.step).toBe('orgnr')
    expect(s.lookupPending).toBe(false)
    expect(s.lookupNote).toBe('nomatch')
    expect(s.searchHits).toEqual([])
  })

  it('error and disabled stay on the step with the error note', () => {
    for (const status of ['error', 'disabled'] as const) {
      const s = run(
        initJourney(),
        { type: 'SEARCH_SUBMITTED', query: 'Testbrand' },
        { type: 'SEARCH_RESULT', outcome: { status } },
      )
      expect(s.step).toBe('orgnr')
      expect(s.lookupNote).toBe('error')
    }
  })

  it('aborted only clears the pending flag', () => {
    const s = run(
      initJourney(),
      { type: 'SEARCH_SUBMITTED', query: 'Testbrand' },
      { type: 'SEARCH_RESULT', outcome: { status: 'aborted' } },
    )
    expect(s.step).toBe('orgnr')
    expect(s.lookupPending).toBe(false)
    expect(s.lookupNote).toBe('none')
  })

  it('a stale SEARCH_RESULT without a pending search is ignored', () => {
    const idle = initJourney()
    const s = journeyReducer(idle, {
      type: 'SEARCH_RESULT',
      outcome: { status: 'found', hits: [hit('1111111111')] },
    })
    expect(s).toBe(idle)
  })

  it('a fresh ORG_SUBMITTED drops waiting hits and the nomatch note', () => {
    const waiting = run(
      initJourney(),
      { type: 'SEARCH_SUBMITTED', query: 'Testbrand' },
      {
        type: 'SEARCH_RESULT',
        outcome: { status: 'found', hits: [hit('1111111111'), hit('2222222222')] },
      },
    )
    const s = journeyReducer(waiting, { type: 'ORG_SUBMITTED', orgNumber: '556677-8899' })
    expect(s.searchHits).toEqual([])
    expect(s.lookupNote).toBe('none')
    expect(s.lookupPending).toBe(true)
  })

  it('Back from a step reached via a pick returns to an orgnr step with no hits', () => {
    const s = run(
      initJourney(),
      { type: 'SEARCH_SUBMITTED', query: 'Testbrand' },
      {
        type: 'SEARCH_RESULT',
        outcome: { status: 'found', hits: [hit('1111111111'), hit('2222222222')] },
      },
      { type: 'SEARCH_HIT_PICKED', hit: hit('2222222222') },
      { type: 'BACK' },
    )
    expect(s.step).toBe('orgnr')
    expect(s.searchHits).toEqual([])
  })
})
