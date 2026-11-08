import { describe, expect, it } from 'vitest'
import {
  DISCLOSURE_REQUIREMENTS,
  collectDisclosureFacts,
  disclosureIssues,
  evaluateDisclosures,
  evaluateRequirement,
  normalizeDisclosureAnswers,
  requirementsFor,
  temporaryDifferenceSignals,
  type DisclosureContext,
  type DisclosureFacts,
} from '..'

function facts(overrides: Partial<DisclosureFacts> = {}): DisclosureFacts {
  return {
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
    ...overrides,
  }
}

function ctx(overrides: Partial<DisclosureContext> = {}): DisclosureContext {
  return {
    framework: 'k3',
    size: 'smaller',
    facts: facts(),
    answers: {},
    firstYear: 'not_first',
    ...overrides,
  }
}

const requirement = (id: string) => {
  const found = DISCLOSURE_REQUIREMENTS.find((r) => r.id === id)
  if (!found) throw new Error(`no requirement ${id}`)
  return found
}

describe('the K3 disclosure matrix', () => {
  it('has unique ids, a code and a source on every requirement', () => {
    const ids = DISCLOSURE_REQUIREMENTS.map((r) => r.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const r of DISCLOSURE_REQUIREMENTS) {
      expect(r.code).toMatch(/^AR-/)
      expect(r.sources.length).toBeGreaterThan(0)
      expect(r.frameworks).toContain('k3')
    }
  })

  it('never applies to a K2 report', () => {
    expect(requirementsFor('k2', 'smaller')).toEqual([])
  })

  it('leaves the related-party note (ÅRL 5:23 andra stycket) to a mindre publikt aktiebolag', () => {
    const r = requirement('not.narstaende_publikt')
    expect(r.sizes).toEqual(['smaller'])
    expect(evaluateRequirement(r, ctx()).status).toBe('not_applicable')
    expect(evaluateRequirement(r, ctx({ facts: facts({ publicCompany: true }) })).status).toBe('missing')
  })

  it('asks an unanswered question and never treats it as a no', () => {
    const e = evaluateRequirement(requirement('not.handelser_efter_balansdagen'), ctx())
    expect(e.status).toBe('missing')
    expect(e.code).toBe('AR-K3-NOTE-EVENTS-AFTER')
    expect(e.content).toBeNull()
  })

  it('prints the stated none text when the user answers that nothing happened', () => {
    const e = evaluateRequirement(
      requirement('not.handelser_efter_balansdagen'),
      ctx({ answers: { 'not.handelser_efter_balansdagen': { applies: false } } }),
    )
    expect(e.status).toBe('met')
    expect(e.content).toBe('Inga väsentliga händelser har inträffat efter räkenskapsårets slut.')
  })

  it('needs the text once the user says a requirement applies', () => {
    const answers = { 'not.handelser_efter_balansdagen': { applies: true } }
    expect(evaluateRequirement(requirement('not.handelser_efter_balansdagen'), ctx({ answers })).status).toBe('missing')
    const typed = { 'not.handelser_efter_balansdagen': { applies: true, text: 'Bolaget förvärvade en fastighet i februari.' } }
    const e = evaluateRequirement(requirement('not.handelser_efter_balansdagen'), ctx({ answers: typed }))
    expect(e.status).toBe('met')
    expect(e.content).toBe('Bolaget förvärvade en fastighet i februari.')
  })

  it('asks for typed text when the chosen option prints none of its own', () => {
    const r = requirement('pr.intakter_uppdrag')
    const withContracts = facts({ contractsInProgress: 12000 })
    expect(evaluateRequirement(r, ctx({ facts: withContracts })).status).toBe('missing')
    const chosen = evaluateRequirement(
      r,
      ctx({ facts: withContracts, answers: { 'pr.intakter_uppdrag': { choice: 'successiv' } } }),
    )
    expect(chosen.status).toBe('missing')
    const described = evaluateRequirement(
      r,
      ctx({
        facts: withContracts,
        answers: { 'pr.intakter_uppdrag': { choice: 'successiv', text: 'Graden fastställs utifrån nedlagda kostnader.' } },
      }),
    )
    expect(described.status).toBe('met')
    expect(described.content).toContain('Graden fastställs utifrån nedlagda kostnader.')
    const fardigstallande = evaluateRequirement(
      r,
      ctx({ facts: withContracts, answers: { 'pr.intakter_uppdrag': { choice: 'fardigstallande' } } }),
    )
    expect(fardigstallande.status).toBe('met')
  })

  // K3 names its two methods successiv vinstavräkning (23.17-23.27) and,
  // for a juridisk person, färdigställandemetoden (23.31-23.37);
  // huvudregeln and alternativregeln are K2's names (6.15-6.25).
  it('names each pågående uppdrag choice as K3 names the method it prints', () => {
    const r = requirement('pr.intakter_uppdrag')
    expect(r.choices?.map((c) => [c.value, c.label])).toEqual([
      ['successiv', 'Successiv vinstavräkning'],
      ['fardigstallande', 'Färdigställandemetoden'],
    ])
    const withContracts = facts({ contractsInProgress: 12000 })
    const printed = (answer: { choice: string; text?: string }) =>
      evaluateRequirement(r, ctx({ facts: withContracts, answers: { 'pr.intakter_uppdrag': answer } })).content ?? ''
    const successiv = printed({ choice: 'successiv', text: 'Graden fastställs utifrån nedlagda kostnader.' })
    expect(successiv).toContain('enligt successiv vinstavräkning, i takt med färdigställandegraden')
    expect(successiv).not.toContain('färdigställandemetod')
    const fardigstallande = printed({ choice: 'fardigstallande' })
    expect(fardigstallande).toContain('enligt färdigställandemetoden (K3 punkt 23.31)')
    expect(fardigstallande).toContain('när uppdraget i allt väsentligt har slutförts')
    expect(fardigstallande).not.toContain('successiv vinstavräkning')
    for (const choice of r.choices ?? []) {
      expect(`${choice.label} ${choice.text ?? ''}`).not.toMatch(/alternativregel|huvudregel/i)
    }
  })

  it('asks again when the stored answer is one of the old, mislabelled choices', () => {
    const r = requirement('pr.intakter_uppdrag')
    const withContracts = facts({ contractsInProgress: 12000 })
    for (const choice of ['alternativregeln', 'fardigstallandemetoden']) {
      const stored = { 'pr.intakter_uppdrag': { choice, text: 'Graden fastställs utifrån nedlagda kostnader.' } }
      expect(evaluateRequirement(r, ctx({ facts: withContracts, answers: stored })).status).toBe('missing')
    }
  })

  it('is not applicable when the books hold nothing it concerns', () => {
    expect(evaluateRequirement(requirement('pr.varulager'), ctx()).status).toBe('not_applicable')
    expect(evaluateRequirement(requirement('pr.goodwill'), ctx()).status).toBe('not_applicable')
    expect(evaluateRequirement(requirement('fb.egna_aktier'), ctx()).status).toBe('not_applicable')
  })

  it('applies from a fact in the books, with the hint', () => {
    const e = evaluateRequirement(requirement('not.rattelse'), ctx({ facts: facts({ equityKinds: ['rattelse_av_fel'] }) }))
    expect(e.applicability).toBe('applies')
    expect(e.hint).toMatch(/rättats/)
  })

  it('takes the development model from the books when a later phase feeds it', () => {
    const e = evaluateRequirement(
      requirement('pr.utveckling'),
      ctx({ facts: facts({ developmentModel: 'kostnadsforingsmodellen' }) }),
    )
    expect(e.status).toBe('met')
    expect(e.content).toMatch(/kostnadsföringsmodellen/)
  })

  it('fails closed on what Accounted does not support, whatever the answer', () => {
    const fairValue = evaluateRequirement(requirement('not.verkligt_varde'), ctx({ facts: facts({ fairValueReserve: true }) }))
    expect(fairValue.status).toBe('unsupported')
    expect(fairValue.code).toBe('AR-K3-FAIR-VALUE-UNSUPPORTED')
    const goingConcern = evaluateRequirement(
      requirement('fb.fortlevnad'),
      ctx({ answers: { 'fb.fortlevnad': { choice: 'tillampas_inte' } } }),
    )
    expect(goingConcern.status).toBe('unsupported')
    expect(goingConcern.code).toBe('AR-K3-GOING-CONCERN-UNSUPPORTED')
    const unclassified = evaluateRequirement(
      requirement('fb.eget_kapital'),
      ctx({
        facts: facts({
          equityUnclassified: [
            { journal_entry_id: 'e1', voucher: 'A12', entry_date: '2026-03-01', description: null, amount: -5000, concepts: ['BalanseratResultat'] },
          ],
        }),
      }),
    )
    expect(unclassified.status).toBe('unsupported')
    expect(unclassified.code).toBe('AR-K3-EQUITY-UNCLASSIFIED')
  })

  it('blocks fixed assets in the ledger that the register cannot roll forward (ÅRL 5:8)', () => {
    const r = requirement('not.anlaggningstillgangar')
    expect(evaluateRequirement(r, ctx()).status).toBe('not_applicable')
    const missing = evaluateRequirement(r, ctx({ facts: facts({ fixedAssetsInLedger: true }) }))
    expect(missing.status).toBe('missing')
    expect(missing.message).toMatch(/anläggningsregistret/)
    const printed = evaluateRequirement(
      r,
      ctx({ facts: facts({ fixedAssetsInLedger: true, fixedAssetNoteFromRegister: true }) }),
    )
    expect(printed.status).toBe('met')
  })

  it('treats a requirement met by an existing field as met without asking', () => {
    const e = evaluateRequirement(requirement('fb.verksamhet'), ctx())
    expect(e.status).toBe('met')
    expect(e.existing).toMatch(/description/)
  })

  it('prints the first-year note for a new company only', () => {
    const r = requirement('not.forsta_k3_aret')
    expect(evaluateRequirement(r, ctx({ firstYear: 'not_first' })).status).toBe('not_applicable')
    const e = evaluateRequirement(r, ctx({ firstYear: 'new_company' }))
    expect(e.status).toBe('met')
    expect(e.content).toMatch(/första gången/)
    expect(e.content).toMatch(/35\.21-35\.30/)
  })

  it('asks a publikt aktiebolag only about the MTF prospectus note (ÅRL 5:18 a)', () => {
    const r = requirement('not.mtf_prospekt')
    expect(evaluateRequirement(r, ctx()).status).toBe('not_applicable')
    expect(evaluateRequirement(r, ctx({ facts: facts({ publicCompany: true }) })).status).toBe('missing')
  })

  it('reports one blocking issue per open requirement, in the section it is fixed in', () => {
    const issues = disclosureIssues(evaluateDisclosures(ctx()))
    expect(issues.every((issue) => issue.severity === 'error')).toBe(true)
    expect(issues.map((issue) => issue.code)).toContain('AR-K3-NOTE-EVENTS-AFTER')
    expect(issues.find((issue) => issue.code === 'AR-K3-FB-MAJOR-OWNERS')?.section).toBe('management_report')
    expect(issues.find((issue) => issue.code === 'AR-K3-NOTE-EVENTS-AFTER')?.section).toBe('notes')
  })

  it('is met in full by a complete set of answers for a plain company', () => {
    const answers = Object.fromEntries(
      evaluateDisclosures(ctx())
        .filter((e) => e.status === 'missing')
        .map((e) => [
          e.id,
          e.producer === 'confirmed'
            ? { applies: false, confirmed: true }
            : e.choices.length > 0
              ? { applies: false, choice: e.choices[0].value }
              : { applies: false },
        ]),
    )
    const evaluations = evaluateDisclosures(ctx({ answers }))
    expect(disclosureIssues(evaluations)).toEqual([])
  })
})

describe('normalizeDisclosureAnswers', () => {
  it('keeps known ids and the four answer fields only', () => {
    expect(
      normalizeDisclosureAnswers({
        'not.handelser_efter_balansdagen': { applies: true, text: 'Text', extra: 1 },
        'okand.fraga': { applies: true },
        'fb.agare': { text: '   ' },
        'fb.fortlevnad': { choice: 'tillampas', confirmed: 'yes' },
      }),
    ).toEqual({
      'not.handelser_efter_balansdagen': { applies: true, text: 'Text' },
      'fb.fortlevnad': { choice: 'tillampas' },
    })
    expect(normalizeDisclosureAnswers(null)).toEqual({})
    expect(normalizeDisclosureAnswers(['x'])).toEqual({})
  })
})

describe('collectDisclosureFacts', () => {
  const row = (account_number: string, closing: number, period = 0) => ({
    account_number,
    opening_debit: 0,
    opening_credit: 0,
    period_debit: period,
    period_credit: 0,
    closing_debit: closing > 0 ? closing : 0,
    closing_credit: closing < 0 ? -closing : 0,
  })

  it('reads the balances the requirements key on', () => {
    const f = collectDisclosureFacts({
      tbFullRows: [row('1070', 50000), row('1460', 1200), row('1470', 300), row('2094', 0, 100), row('1310', 1000), row('1370', 400)],
      assets: [{ category: 'building', disposed_at: null }],
      equitySpecification: undefined,
      equityBelowHalfShareCapital: false,
      publicCompany: null,
      fixedAssetNoteFromRegister: false,
    })
    expect(f.goodwill).toBe(50000)
    expect(f.inventory).toBe(1200)
    expect(f.contractsInProgress).toBe(300)
    expect(f.ownShares).toBe(true)
    expect(f.financialFixedAssets).toBe(true)
    expect(f.buildingAssets).toBe(true)
    expect(f.deferredTaxInBooks.asset).toBe(400)
  })

  it('splits booked deferred tax from the hints for the profile question', () => {
    const signals = temporaryDifferenceSignals(
      facts({ deferredTaxInBooks: { asset: 0, liability: 12000, expense: 1 }, buildingAssets: true }),
    )
    expect(signals.booked).toHaveLength(2)
    expect(signals.booked[0]).toMatch(/2240/)
    expect(signals.hints).toEqual(['företaget har byggnader eller markanläggningar'])
    expect(temporaryDifferenceSignals(facts())).toEqual({ booked: [], hints: [] })
  })
})
