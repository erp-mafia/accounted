/**
 * The K3 steps of the canonical model that need the size class: the
 * first-K3-year status, the disclosure matrix applied to the document, and
 * the kassaflödesanalys a mindre företag's K3 document leaves out.
 */
import { describe, expect, it } from 'vitest'
import { applyCashFlowOmission, applyK3Disclosures, k3FirstYearStatus } from '../model'
import type { buildArsredovisningData, K3BuildContext } from '../build-data'
import { emptyAnnualReportProfile, type AnnualReportEligibilityResult } from '../compliance-types'
import type { DisclosureFacts } from '../disclosures'

type Report = Awaited<ReturnType<typeof buildArsredovisningData>>

const eligibility = (size: AnnualReportEligibilityResult['size_classification']): AnnualReportEligibilityResult => ({
  k2_eligible: false,
  digital_filing_eligible: false,
  size_classification: size,
  k2_relief_rule: 'eligible',
  issues: [],
  digital_issues: [],
})

const profile = {
  ...emptyAnnualReportProfile('company-1', 'period-1'),
  is_public_limited_company: false,
  securities_traded_on_regulated_market: false,
}

const facts: Omit<DisclosureFacts, 'publicCompany'> = {
  goodwill: 0,
  capitalizedDevelopment: 0,
  inventory: 25000,
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
}

const previousYear = { fiscal_period_id: 'fp-2025', framework: 'k3' as const, source: 'election' as const, reliable: true }

function report(entityType = 'aktiebolag'): Report {
  return {
    accounting_framework: 'k3',
    company: { entity_type: entityType },
    forvaltningsberattelse: { description: 'Konsultverksamhet.' },
    noter: [
      { number: 1, title: 'Redovisnings- och värderingsprinciper', body: 'Årsredovisningen är upprättad enligt K3.', key: 'redovisningsprinciper' },
      { number: 2, title: 'Medelantal anställda', body: '2' },
    ],
    disclosures: { omit_kassaflodesanalys: false, kassaflodesanalys_omission_confirmed: false },
    kassaflodesanalys: { rows: [] },
    warnings: [],
  } as unknown as Report
}

describe('k3FirstYearStatus', () => {
  it('trusts a reliable record of the previous year over the profile', () => {
    expect(k3FirstYearStatus({ previousYear, hasPreviousPeriod: true, profileAnswer: 'k2' })).toBe('not_first')
    expect(
      k3FirstYearStatus({ previousYear: { ...previousYear, framework: 'k2' }, hasPreviousPeriod: true, profileAnswer: 'k3' }),
    ).toBe('after_k2')
  })

  it('asks the profile when the record is only the company default', () => {
    const unreliable = { ...previousYear, source: 'company_default' as const, reliable: false }
    expect(k3FirstYearStatus({ previousYear: unreliable, hasPreviousPeriod: true, profileAnswer: null })).toBe('unknown')
    expect(k3FirstYearStatus({ previousYear: unreliable, hasPreviousPeriod: true, profileAnswer: 'k3' })).toBe('not_first')
    expect(k3FirstYearStatus({ previousYear: unreliable, hasPreviousPeriod: true, profileAnswer: 'k2' })).toBe('after_k2')
  })

  it('takes "no previous report" only when Accounted holds no previous year', () => {
    const none = { fiscal_period_id: null, framework: null, source: null, reliable: false }
    expect(k3FirstYearStatus({ previousYear: none, hasPreviousPeriod: false, profileAnswer: 'none' })).toBe('new_company')
    const unreliable = { ...previousYear, source: 'company_default' as const, reliable: false }
    expect(k3FirstYearStatus({ previousYear: unreliable, hasPreviousPeriod: true, profileAnswer: 'none' })).toBe('unknown')
  })
})

describe('applyK3Disclosures', () => {
  const context = (answers: K3BuildContext['answers']): K3BuildContext => ({ facts, answers, previousYear })

  it('prints the answers where they belong and renumbers the notes', () => {
    const value = report()
    const evaluations = applyK3Disclosures(
      value,
      context({
        'pr.varulager': { choice: 'fifo' },
        'fb.externa_faktorer': { applies: true, text: 'Höjda räntor har ökat räntekostnaderna.' },
        'not.avvikelser': { applies: true, text: 'Skälen för avvikelsen.' },
        'not.handelser_efter_balansdagen': { applies: false },
      }),
      eligibility('smaller'),
      profile,
      'not_first',
    )
    expect(value.k3_disclosures).toBe(evaluations)
    expect(value.k3_first_year).toBe('not_first')
    expect(value.k3_forvaltningsberattelse).toEqual([
      {
        concept: 'ViktigaExternaFaktorerPaverkatForetagetStallningResultat',
        heading: 'Viktiga externa faktorer',
        text: 'Höjda räntor har ökat räntekostnaderna.',
      },
    ])
    expect(value.noter[0].body).toMatch(/^Årsredovisningen är upprättad enligt K3\.\n\nVarulager: /)
    expect(value.noter.map((note) => [note.number, note.title])).toEqual([
      [1, 'Redovisnings- och värderingsprinciper'],
      [2, 'Avvikelser från redovisningsprinciper'],
      [3, 'Medelantal anställda'],
      [4, 'Väsentliga händelser efter balansdagen'],
    ])
    expect(value.noter[3].body).toBe('Inga väsentliga händelser har inträffat efter räkenskapsårets slut.')
  })

  it('evaluates the större list for a större företag and leaves open questions open', () => {
    const value = report()
    const evaluations = applyK3Disclosures(value, context({}), eligibility('larger'), profile, 'not_first')
    expect(evaluations.find((e) => e.id === 'not.narstaende_publikt')).toBeUndefined()
    expect(evaluations.find((e) => e.id === 'not.handelser_efter_balansdagen')?.status).toBe('missing')
    expect(value.noter).toHaveLength(2)
  })
})

describe('applyCashFlowOmission for K3', () => {
  const metrics = {
    current: { employees: 2, balance_sheet_total: 1_000_000, net_revenue: 2_000_000 },
    previous: { employees: 2, balance_sheet_total: 1_000_000, net_revenue: 2_000_000 },
  }

  it('leaves the kassaflödesanalys out of a mindre företag document whatever the choice', () => {
    const value = report()
    applyCashFlowOmission(value, eligibility('smaller'), metrics, profile)
    expect(value.kassaflodesanalys).toBeUndefined()
    expect(value.kassaflodesanalys_omission).toMatchObject({ omitted: true, withheld: true, requested: false })
  })

  it('never withholds it from a form that must always have one (a bostadsrättsförening, ÅRL 2 kap. 1 §)', () => {
    const value = report('bostadsrattsforening')
    applyCashFlowOmission(value, eligibility('smaller'), metrics, profile)
    expect(value.kassaflodesanalys).toBeDefined()
    expect(value.kassaflodesanalys_omission).toMatchObject({ rule: 'forbidden', omitted: false, required_by_form: true })
    expect(value.kassaflodesanalys_omission?.withheld).toBeUndefined()
  })

  it('does not honour a request to leave it out of a bostadsrättsförening document', () => {
    const value = report('bostadsrattsforening')
    value.disclosures.omit_kassaflodesanalys = true
    value.disclosures.kassaflodesanalys_omission_confirmed = true
    applyCashFlowOmission(value, eligibility('smaller'), metrics, profile)
    expect(value.kassaflodesanalys).toBeDefined()
    expect(value.kassaflodesanalys_omission).toMatchObject({ rule: 'forbidden', requested: true, omitted: false })
  })

  it('keeps it for a större företag', () => {
    const value = report()
    applyCashFlowOmission(value, eligibility('larger'), metrics, profile)
    expect(value.kassaflodesanalys).toBeDefined()
    expect(value.kassaflodesanalys_omission).toMatchObject({ rule: 'forbidden', omitted: false })
    expect(value.kassaflodesanalys_omission?.withheld).toBeUndefined()
  })
})
