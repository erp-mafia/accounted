import { describe, it, expect } from 'vitest'
import { formatRedovisare } from '@/lib/skatteverket/format'
import { generateKU10Xml } from '@/lib/salary/ku/ku10-generator'
import { generateAGIXml } from '@/lib/salary/agi/xml-generator'
import { runPreflightChecks } from '@/lib/bokslut/ixbrl/validate/rules'
import type { IxbrlArsredovisningInput } from '@/lib/bokslut/ixbrl/types'

/**
 * The four Skatteverket- and Bolagsverket-bound export paths must agree about
 * what a valid org number is.
 *
 * Before `lib/invariants/org-number.ts` they did not: the SRU converter stripped
 * hyphens only and threw on a space, KU10 stripped the first hyphen only, AGI
 * stripped every non-digit (so stray letters passed), and the årsredovisning
 * validator rejected the 12-digit form and skipped the check digit. A company
 * stored in one of the awkward forms could file AGI for a year and then fail at
 * the årsredovisning deadline with a message that did not say why.
 *
 * This test is the guard on that agreement. If a future change makes one path
 * accept an input the others reject, it fails here rather than at a customer's
 * deadline.
 */

const AB_10 = '5560125790'

/** The input forms a Swedish user or a provider API actually produces. */
const EQUIVALENT_FORMS = ['5560125790', '556012-5790', '556012 5790', '165560125790']

/** The subset that is already 10 digits, ignoring separators. */
const TEN_DIGIT_FORMS = ['5560125790', '556012-5790', '556012 5790']

function ku10CompanyFixture(orgNumber: string) {
  return {
    orgNumber,
    companyName: 'Testbolaget AB',
    year: 2025,
    contactName: 'Test Testsson',
    contactPhone: '0700000000',
    contactEmail: 'test@example.com',
  }
}

function agiCompanyFixture(orgNumber: string) {
  return {
    orgNumber,
    companyName: 'Testbolaget AB',
    periodYear: 2025,
    periodMonth: 3,
    contactName: 'Test Testsson',
    contactPhone: '0700000000',
    contactEmail: 'test@example.com',
  }
}

function ixbrlInputFixture(orgNumber: string): IxbrlArsredovisningInput {
  // Only the org-number rule (code 1035) is asserted below. The remaining
  // fields exist so the other preflight rules can run without throwing; their
  // verdicts are filtered out.
  return {
    company: { name: 'Testbolaget AB', orgNumber },
    period: { start: '2025-01-01', end: '2025-12-31' },
    isFirstFiscalYear: false,
    forvaltningsberattelse: {
      allmantOmVerksamheten: 'Bolaget bedriver konsultverksamhet.',
      resultatdisposition: { balanseratResultat: 0, aretsResultat: 0, summa: 0 },
    },
    faststallelseintyg: {
      arsstammaDatum: '2026-05-15',
      genereratDatum: '2026-05-20',
      resultatdispositionDecision: 'enligt_forslag',
      resultatdispositionOutcome: 'balanseras_i_ny_rakning',
      signerFirstName: 'Test',
      signerLastName: 'Testsson',
    },
    underskrifter: {
      dateringsdatum: '2026-05-10',
      signers: [{ firstName: 'Test', lastName: 'Testsson', role: 'Styrelseledamot' }],
    },
    totals: {
      aretsResultat: { current: 0, previous: 0 },
      egetKapitalSkulder: { current: 0, previous: 0 },
      tillgangar: { current: 0, previous: 0 },
    },
    rr: [],
    br: [],
    warnings: [],
  } as unknown as IxbrlArsredovisningInput
}

/** Does the årsredovisning preflight raise the org-number issue (code 1035)? */
function ixbrlRejects(orgNumber: string): boolean {
  const result = runPreflightChecks(ixbrlInputFixture(orgNumber))
  return result.issues.some((i) => i.code === '1035')
}

/** Does the SRU redovisare conversion throw? */
function redovisareRejects(orgNumber: string): boolean {
  try {
    formatRedovisare(orgNumber, 'aktiebolag')
    return false
  } catch {
    return true
  }
}

/** Does the AGI generator refuse to build for this org number? */
function agiRejects(orgNumber: string): boolean {
  try {
    generateAGIXml(
      agiCompanyFixture(orgNumber),
      [],
      { totalTax: 0, totalAvgifterBasis: 0, totalAvgifterAmount: 0, totalSjuklonekostnad: 0 } as never,
    )
    return false
  } catch {
    return true
  }
}

describe('org number: the four export paths agree', () => {
  it.each(EQUIVALENT_FORMS)('accepts %s everywhere', (form) => {
    expect(redovisareRejects(form), 'SRU redovisare conversion').toBe(false)
    expect(ixbrlRejects(form), 'årsredovisning preflight').toBe(false)
    expect(agiRejects(form), 'AGI generator').toBe(false)
    expect(() => generateKU10Xml(ku10CompanyFixture(form), []), 'KU10 generator').not.toThrow()
  })

  it('produces the same redovisare identity from every equivalent form', () => {
    const identities = EQUIVALENT_FORMS.map((f) => formatRedovisare(f, 'aktiebolag'))
    expect(new Set(identities).size, `got ${JSON.stringify(identities)}`).toBe(1)
    expect(identities[0]).toBe('165560125790')
  })

  it('emits a separator-free identity into the KU10 file', () => {
    for (const form of TEN_DIGIT_FORMS) {
      const xml = generateKU10Xml(ku10CompanyFixture(form), [])
      const match = xml.match(/<Organisationsnummer>([^<]*)<\/Organisationsnummer>/)
      // Guard against a vacuous assertion: the element must actually be there.
      expect(match, `input form ${form}: no <Organisationsnummer> in output`).not.toBeNull()
      expect(match?.[1], `input form ${form}`).toBe(AB_10)
    }
  })

  /**
   * OPEN QUESTION, deliberately pinned rather than changed.
   *
   * KU10 strips separators but does not fold the 12-digit form down to the
   * canonical 10 digits, so a company stored as `165560125790` files with 12
   * digits. Whether Skatteverket's KU10 schema wants 10 or 12 here is a Swedish
   * domain question that the `swedish-payroll` skill does not cover, and
   * CLAUDE.md forbids answering it from training data.
   *
   * This is pre-existing behaviour (the old `replace('-', '')` did the same);
   * this test pins it so the answer, when we get it, is a deliberate change with
   * a failing test to update rather than a silent drift.
   */
  it('PINNED: KU10 passes a 12-digit stored org number through unfolded', () => {
    const xml = generateKU10Xml(ku10CompanyFixture('165560125790'), [])
    const match = xml.match(/<Organisationsnummer>([^<]*)<\/Organisationsnummer>/)
    expect(match?.[1]).toBe('165560125790')
  })

  it.each([
    ['5560125790x', 'stray characters'],
    ['55601', 'too short'],
  ])('rejects %s (%s) on every path that validates', (bad) => {
    expect(redovisareRejects(bad), 'SRU redovisare conversion').toBe(true)
    expect(ixbrlRejects(bad), 'årsredovisning preflight').toBe(true)
    expect(agiRejects(bad), 'AGI generator').toBe(true)
  })

  it('surfaces a bad check digit without blocking the filing', () => {
    const badCheckDigit = '5560125791'
    const result = runPreflightChecks(ixbrlInputFixture(badCheckDigit))
    const orgIssues = result.issues.filter((i) => i.code === '1035')

    expect(orgIssues).toHaveLength(1)
    // Warn, not error: a wrong check digit is surfaced to the user, but we do
    // not block Skicka in on a domain assumption we have not verified against a
    // primary source. See the rationale in validate/rules.ts.
    expect(orgIssues[0].severity).toBe('warn')
    // The org-number verdict must not be among the errors that block Skicka in.
    // (`result.ok` is not asserted here: this fixture is minimal and trips other
    // unrelated rules. The org-number rule's own severity is the contract.)
    expect(result.errors.some((i) => i.code === '1035')).toBe(false)

    // Export-time conversion stays permissive by design: see org-number.ts.
    expect(redovisareRejects(badCheckDigit), 'SRU redovisare conversion').toBe(false)
  })

  it('the canonical form is what the display helper round-trips to', () => {
    expect(formatRedovisare(AB_10, 'aktiebolag')).toBe('165560125790')
  })
})
