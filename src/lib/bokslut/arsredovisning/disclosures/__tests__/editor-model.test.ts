import { describe, expect, it } from 'vitest'
import {
  contentApplies,
  disclosureAnswersPatch,
  editableDisclosures,
  equityOverridesPatch,
  takesText,
} from '../editor-model'
import { DISCLOSURE_REQUIREMENTS, evaluateDisclosures, evaluateRequirement, type DisclosureFacts } from '..'

const facts: DisclosureFacts = {
  goodwill: 0,
  capitalizedDevelopment: 0,
  inventory: 0,
  contractsInProgress: 0,
  shareholderLoans: 0,
  ownShares: false,
  deferredTaxInBooks: { asset: 0, liability: 0, expense: 0 },
  buildingAssets: false,
  componentAssets: false,
  financialFixedAssets: false,
  fixedAssetsInLedger: false,
  fixedAssetNoteFromRegister: false,
  fairValueReserve: false,
  revaluationReserveChanged: false,
  equityKinds: [],
  equityUnclassified: [],
  equityBelowHalfShareCapital: false,
  publicCompany: false,
}

const evaluate = (id: string) =>
  evaluateRequirement(DISCLOSURE_REQUIREMENTS.find((r) => r.id === id)!, {
    framework: 'k3',
    size: 'smaller',
    facts: { ...facts, contractsInProgress: 1 },
    answers: {},
  })

describe('editableDisclosures', () => {
  it('shows the questions the books cannot answer, nothing met by a field of its own', () => {
    const ids = editableDisclosures(
      evaluateDisclosures({ framework: 'k3', size: 'smaller', facts, answers: {} }),
    ).map((e) => e.id)
    expect(ids).toContain('not.handelser_efter_balansdagen')
    expect(ids).toContain('pr.bidrag')
    expect(ids).not.toContain('fb.verksamhet')
    expect(ids).not.toContain('pr.varulager')
    expect(ids).not.toContain('not.medelantal')
  })
})

describe('contentApplies and takesText', () => {
  it('opens the text once the user says yes, or straight away when it applies', () => {
    const asked = evaluate('not.handelser_efter_balansdagen')
    expect(contentApplies(asked, undefined)).toBe(false)
    expect(contentApplies(asked, { applies: true })).toBe(true)
    expect(takesText(asked, { applies: true })).toBe(true)
    const contracts = evaluate('pr.intakter_uppdrag')
    expect(contentApplies(contracts, undefined)).toBe(true)
    expect(takesText(contracts, { choice: 'alternativregeln' })).toBe(false)
    expect(takesText(contracts, { choice: 'fardigstallandemetoden' })).toBe(true)
  })
})

describe('the save patches', () => {
  it('sends only changed answers and null for a cleared one', () => {
    expect(
      disclosureAnswersPatch(
        { 'fb.agare': { applies: false }, 'not.rattelse': { applies: false } },
        { 'fb.agare': { applies: false }, 'not.rattelse': { text: '  ' }, 'not.avvikelser': { applies: true, text: 'Skäl' } },
      ),
    ).toEqual({ 'not.rattelse': null, 'not.avvikelser': { applies: true, text: 'Skäl' } })
  })

  it('sends only changed classifications', () => {
    expect(
      equityOverridesPatch(
        { a: 'rattelse_av_fel', b: 'utdelning' },
        { a: 'rattelse_av_fel', b: undefined, c: 'nyemission' },
      ),
    ).toEqual({ b: null, c: 'nyemission' })
  })
})
