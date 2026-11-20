import { describe, expect, it } from 'vitest'
import { XMLValidator } from 'fast-xml-parser'
import { AUDITOR_OPINIONS } from '@/lib/bokslut/arsredovisning/workflow-schemas'
import { getRegistry } from '../taxonomy/registry'
import { generateK2IxbrlDocument } from '../document/k2-document'
import { runPreflightChecks } from '../validate/rules'
import {
  AUDITOR_OPINION_DEFINITIONS,
  buildRevisorspateckning,
  pateckningDatum,
  pateckningLead,
  pateckningMening,
  splitRoster,
  type IxbrlRevisorspateckning,
} from '../revisorspateckning'
import { makeInput } from './fixtures'

const TODAY = '2026-06-10'

function withPateckning(pateckning: IxbrlRevisorspateckning) {
  const input = makeInput()
  input.revisorspateckning = pateckning
  return input
}

const STANDARD: IxbrlRevisorspateckning = {
  required: true,
  revisionsbolag: null,
  opinion: 'unmodified',
  revisorer: [
    // After the board's last signature (2026-02-21 in the fixture) and three
    // weeks before the AGM (2026-03-15), ABL 9 kap. 28 §.
    { firstName: 'Rita', lastName: 'Revisor', titel: 'Auktoriserad revisor', huvudansvarig: null, signedDate: '2026-02-21' },
  ],
}

describe('the roster split', () => {
  it('keeps the revisor out of the board and drops declined slots', () => {
    const { board, revisorer } = splitRoster([
      { signer_name: 'Karl Karlsson', role: 'Styrelseledamot', signed_at: null, status: 'pending' },
      { signer_name: 'Rita Revisor', role: 'auktoriserad  revisor', signed_at: null, status: 'pending' },
      { signer_name: 'Olle Ordförande', role: 'Styrelseordförande', signed_at: null, status: 'declined' },
    ])
    expect(board.map((row) => row.signer_name)).toEqual(['Karl Karlsson'])
    expect(revisorer.map((row) => row.signer_name)).toEqual(['Rita Revisor'])
  })
})

describe('buildRevisorspateckning', () => {
  const profile = { auditor_report_required: true, auditor_firm_name: null, auditor_opinion: null }

  it('is null when no revisionsberättelse is required and no revisor is in the roster', () => {
    expect(buildRevisorspateckning([], { ...profile, auditor_report_required: false })).toBeNull()
    expect(buildRevisorspateckning([], { ...profile, auditor_report_required: null })).toBeNull()
  })

  it('keeps a required påteckning without revisor so preflight can block it', () => {
    expect(buildRevisorspateckning([], profile)).toEqual({
      required: true,
      revisionsbolag: null,
      opinion: null,
      revisorer: [],
    })
  })

  it('reads the date in Stockholm and marks the huvudansvarig revisor only with a firm', () => {
    const rows = [
      { signer_name: 'Rita Maria Revisor', role: 'Huvudansvarig revisor', signed_at: '2026-02-23T23:30:00Z' },
      { signer_name: 'Sven Granskare', role: 'Auktoriserad revisor', signed_at: null },
    ]
    const withFirm = buildRevisorspateckning(rows, {
      ...profile,
      auditor_firm_name: '  Revisionsbyrån AB ',
      auditor_opinion: 'modified',
    })
    expect(withFirm).toEqual({
      required: true,
      revisionsbolag: 'Revisionsbyrån AB',
      opinion: 'modified',
      revisorer: [
        { firstName: 'Rita Maria', lastName: 'Revisor', titel: 'Huvudansvarig revisor', huvudansvarig: true, signedDate: '2026-02-24' },
        { firstName: 'Sven', lastName: 'Granskare', titel: 'Auktoriserad revisor', huvudansvarig: false, signedDate: null },
      ],
    })
    const withoutFirm = buildRevisorspateckning(rows, profile)
    expect(withoutFirm?.revisorer.map((revisor) => revisor.huvudansvarig)).toEqual([null, null])
  })
})

describe('the påteckning sentence', () => {
  it('speaks for one revisor or several (ABL 9 kap. 28 a §)', () => {
    expect(pateckningLead(1)).toBe('Min revisionsberättelse har lämnats')
    expect(pateckningLead(2)).toBe('Vår revisionsberättelse har lämnats')
    // A revisionsbolag speaks as "vår", as in the official K3 example.
    expect(pateckningLead(1, true)).toBe('Vår revisionsberättelse har lämnats')
    expect(pateckningMening('avstyrkt_rr', 1, true)).toBe('Vi har i denna avstyrkt att resultaträkningen fastställs.')
    expect(pateckningMening('avstyrkt_rr_br', 1)).toBe(
      'Jag har i denna avstyrkt att resultaträkningen och balansräkningen fastställs.',
    )
    expect(pateckningMening('varken_br', 2)).toBe(
      'Vi har i denna varken till- eller avstyrkt att balansräkningen fastställs.',
    )
    expect(pateckningMening('unmodified', 1)).toBeNull()
    expect(pateckningMening(null, 1)).toBeNull()
  })

  it('is dated when every revisor has given it, with the latest date', () => {
    expect(pateckningDatum([{ signedDate: '2026-02-20' }, { signedDate: '2026-02-24' }])).toBe('2026-02-24')
    expect(pateckningDatum([{ signedDate: '2026-02-20' }, { signedDate: null }])).toBeNull()
    expect(pateckningDatum([])).toBeNull()
  })

  it('maps every stored opinion, and every member exists in the K2 registry', () => {
    const registry = getRegistry('k2-ab-2024-09-12')
    for (const opinion of AUDITOR_OPINIONS) {
      const definition = AUDITOR_OPINION_DEFINITIONS[opinion]
      expect(definition).toBeDefined()
      if (definition.member) expect(registry.concepts[definition.member]).toBeDefined()
      expect(Boolean(definition.member)).toBe(Boolean(definition.sentence))
    }
  })
})

describe('the revisorspåteckning in the K2 iXBRL document', () => {
  it('tags the standard påteckning date, the revisor tuple and keeps the XHTML well-formed', () => {
    const { xhtml } = generateK2IxbrlDocument(withPateckning(STANDARD))
    expect(XMLValidator.validate(xhtml)).toBe(true)
    expect(xhtml).toContain('<h3>Revisorspåteckning</h3>')
    expect(xhtml).toMatch(
      /Min revisionsberättelse har lämnats <ix:nonNumeric contextRef="period0" name="se-gen-base:RevisorspateckningRevisionsberattelseEnligtStandardutformning">2026-02-21<\/ix:nonNumeric>\./,
    )
    expect(xhtml).toContain('name="se-gaap-ext:UnderskriftRevisorspateckningTuple"')
    expect(xhtml).toMatch(/name="se-gen-base:UnderskriftHandlingTitel" tupleRef="UnderskriftRevisorspateckningTuple\d+" order="3.0">Auktoriserad revisor</)
    // No firm: neither the firm name nor the huvudansvarig flag is tagged.
    expect(xhtml).not.toContain('ValtRevisionsbolagsnamn')
    expect(xhtml).not.toContain('UnderskriftRevisorspateckningRevisorHuvudansvarig')
    // The board's tuples are unchanged: two signers.
    expect(xhtml.match(/name="se-gaap-ext:UnderskriftArsredovisningForetradareTuple"/g)).toHaveLength(2)
  })

  it('tags a modified revisionsberättelse with the avstyrkt sentence, the firm and the huvudansvarig revisor', () => {
    const { xhtml } = generateK2IxbrlDocument(
      withPateckning({
        ...STANDARD,
        revisionsbolag: 'Revisionsbyrån AB',
        opinion: 'avstyrkt_br',
        revisorer: [
          { firstName: 'Rita', lastName: 'Revisor', titel: 'Huvudansvarig revisor', huvudansvarig: true, signedDate: '2026-02-24' },
          { firstName: 'Sven', lastName: 'Granskare', titel: 'Auktoriserad revisor', huvudansvarig: false, signedDate: '2026-02-23' },
        ],
      }),
    )
    expect(XMLValidator.validate(xhtml)).toBe(true)
    expect(xhtml).toContain('Vår revisionsberättelse har lämnats')
    expect(xhtml).toContain('name="se-gen-base:RevisorspateckningRevisionsberattelseAvvikerStandardutformning">2026-02-24<')
    expect(xhtml).not.toContain('RevisorspateckningRevisionsberattelseEnligtStandardutformning')
    expect(xhtml).toContain('Vi har i denna avstyrkt att balansräkningen fastställs.')
    expect(xhtml).toContain('se-mem-base:RevisorspateckningMeningAvstyrktAttBalansrakningFaststallsMember')
    expect(xhtml).toContain('name="se-cd-base:ValtRevisionsbolagsnamn">Revisionsbyrån AB<')
    expect(xhtml).toMatch(/name="se-gen-base:UnderskriftRevisorspateckningRevisorHuvudansvarig" tupleRef="UnderskriftRevisorspateckningTuple\d+" order="4.0">true</)
    expect(xhtml).toMatch(/UnderskriftRevisorspateckningRevisorHuvudansvarig" tupleRef="UnderskriftRevisorspateckningTuple\d+" order="4.0">false</)
  })

  it('tags nothing for an unanswered opinion and shows a placeholder for a missing date', () => {
    const { xhtml } = generateK2IxbrlDocument(
      withPateckning({
        ...STANDARD,
        opinion: null,
        revisorer: [{ ...STANDARD.revisorer[0], signedDate: null }],
      }),
    )
    expect(xhtml).toContain('Min revisionsberättelse har lämnats [datum saknas].')
    expect(xhtml).not.toContain('RevisorspateckningRevisionsberattelse')
  })

  it('emits no påteckning for a company without revisor', () => {
    const { xhtml } = generateK2IxbrlDocument(makeInput())
    expect(xhtml).not.toContain('Revisorspåteckning')
  })
})

describe('revisorspåteckning preflight', () => {
  const codes = (pateckning: IxbrlRevisorspateckning) =>
    runPreflightChecks(withPateckning(pateckning), TODAY).issues.map((issue) => `${issue.code}:${issue.severity}`)

  it('passes a complete standard påteckning', () => {
    expect(runPreflightChecks(withPateckning(STANDARD), TODAY).errors).toEqual([])
  })

  it('blocks a required revisionsberättelse without revisor, date or opinion', () => {
    expect(codes({ ...STANDARD, revisorer: [] })).toContain('ACC-REVISOR-MISSING:error')
    expect(codes({ ...STANDARD, revisorer: [{ ...STANDARD.revisorer[0], signedDate: null }] })).toContain(
      'ACC-REVISOR-DATE:error',
    )
    expect(codes({ ...STANDARD, opinion: null })).toContain('ACC-REVISOR-OPINION:error')
  })

  it('blocks a revisionsbolag without huvudansvarig revisor', () => {
    expect(codes({ ...STANDARD, revisionsbolag: 'Revisionsbyrån AB' })).toContain('ACC-REVISOR-HUVUDANSVARIG:error')
    expect(
      codes({
        ...STANDARD,
        revisionsbolag: 'Revisionsbyrån AB',
        revisorer: [{ ...STANDARD.revisorer[0], titel: 'Huvudansvarig revisor', huvudansvarig: true }],
      }),
    ).not.toContain('ACC-REVISOR-HUVUDANSVARIG:error')
  })

  it('warns about the order of dates and a revisor who is not required', () => {
    // The fixture's board signs 2026-02-20 and 2026-02-21, the AGM is 2026-03-15.
    const early = { ...STANDARD, revisorer: [{ ...STANDARD.revisorer[0], signedDate: '2026-02-20' }] }
    expect(codes(early)).toContain('ACC-REVISOR-ORDER:warn')
    const late = { ...STANDARD, revisorer: [{ ...STANDARD.revisorer[0], signedDate: '2026-03-01' }] }
    expect(codes(late)).toContain('ACC-REVISOR-AGM:warn')
    expect(codes(STANDARD)).not.toContain('ACC-REVISOR-AGM:warn')
    expect(codes({ ...STANDARD, required: false })).toContain('ACC-REVISOR-NOT-REQUIRED:warn')
  })
})
