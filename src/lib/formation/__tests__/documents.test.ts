import { describe, expect, it } from 'vitest'
import { emptyAnswers, type FormationAnswers } from '../answers'
import type { FormationDocument } from '../document-model'
import { renderDocx } from '../docx'
import type { DocumentContext } from '../documents/context'
import { buildAktiebok } from '../documents/aktiebok'
import { VERKSAMT_STEPS, buildAnswerSheet } from '../documents/answer-sheet'
import { BANK_NOTES, buildBankChecklist } from '../documents/bank'
import { buildBolagetMarkdown } from '../documents/bolaget-md'
import { buildBolagsordning } from '../documents/bolagsordning'
import { firstFiscalYear, fiscalYearText, shareRanges } from '../documents/facts'
import { kr } from '../documents/format'
import { FORMATION_DOCUMENTS, buildFormationDocument } from '../documents/index'
import { buildSkatteverket } from '../documents/skatteverket'
import { SIGNATORY_RULE_TEXT } from '../documents/signatory'
import { buildStiftelseurkund } from '../documents/stiftelseurkund'
import { buildStyrelseprotokoll } from '../documents/styrelseprotokoll'

// Published Skatteverket test personnummer and a valid test org number.
const PNR_A = '195001182046'
const PNR_B = '201212121212'
const ORG = '5595386219'

const ctx: DocumentContext = { today: '2026-11-20', deedDate: '2026-11-21' }
const registered: DocumentContext = {
  today: '2026-12-10',
  deedDate: '2026-11-21',
  registration: { orgNumber: ORG, name: 'Testbolaget Nord AB', date: '2026-12-03' },
}

function base(): FormationAnswers {
  return {
    ...emptyAnswers(),
    names: ['Testbolaget Nord AB', 'Nordtest AB'],
    description: 'konsultverksamhet inom systemutveckling och drift av webbtjänster',
    seat: 'Stockholm',
    address: { co: '', street: 'Testgatan 1', postalCode: '11122', city: 'Stockholm' },
    contact: { name: 'Test Testsson', email: 'test@example.se', phone: '+46701234567' },
    bank: 'svea',
    tax: { expectedTurnover: 600_000, expectedProfit: 150_000, ownerSalary: 'later', vatPeriod: 'quarter' },
  }
}

/** One founder on the board, a second person as deputy. */
function solo(): FormationAnswers {
  return {
    ...base(),
    parties: [
      { id: 'a', type: 'person', name: 'Test Testsson', personnummer: PNR_A, email: '', shares: 500, roles: ['ledamot', 'vd'] },
      { id: 'b', type: 'person', name: 'Deputy Person', personnummer: PNR_B, email: '', shares: 0, roles: ['suppleant'] },
    ],
  }
}

/** Two founders, both on the board, one of them chair and VD, plus a deputy. */
function duo(): FormationAnswers {
  return {
    ...base(),
    signatoryRule: 'board_or_two',
    parties: [
      { id: 'a', type: 'person', name: 'Anna Ägare', personnummer: PNR_A, email: '', shares: 300, roles: ['ledamot', 'ordforande', 'vd'] },
      { id: 'b', type: 'person', name: 'Bo Bolagsman', personnummer: PNR_B, email: '', shares: 200, roles: ['ledamot'] },
      { id: 'c', type: 'person', name: 'Cecilia Suppleant', personnummer: '', email: '', shares: 0, roles: ['suppleant'] },
    ],
  }
}

/** A person and a holding company as founders. */
function withCompany(): FormationAnswers {
  return {
    ...base(),
    parties: [
      { id: 'a', type: 'person', name: 'Test Testsson', personnummer: PNR_A, email: '', shares: 250, roles: ['ledamot'] },
      { id: 'h', type: 'company', name: 'Holding AB', orgNumber: ORG, signatories: ['Test Testsson'], shares: 250, controlledBy: ['Test Testsson'] },
      { id: 'b', type: 'person', name: 'Deputy Person', personnummer: PNR_B, email: '', shares: 0, roles: ['suppleant'] },
    ],
  }
}

/** Every string a document carries, for content assertions. */
function texts(doc: FormationDocument): string[] {
  const out = [doc.title, doc.subtitle ?? '', doc.footer ?? '']
  for (const b of doc.blocks) {
    switch (b.kind) {
      case 'heading':
      case 'paragraph':
        out.push(b.text)
        break
      case 'list':
        out.push(...b.items)
        break
      case 'table':
        out.push(...b.head, ...b.rows.flat())
        break
      case 'fields':
        for (const r of b.rows) out.push(r.label, r.value)
        break
      case 'signatures':
        for (const p of b.people) out.push(p.name, p.caption ?? '')
        break
    }
  }
  return out
}

const all = (doc: FormationDocument) => texts(doc).join('\n')
const headings = (doc: FormationDocument) => doc.blocks.filter((b) => b.kind === 'heading').map((b) => (b as { text: string }).text)
const fieldValue = (doc: FormationDocument, label: string) => {
  for (const b of doc.blocks) if (b.kind === 'fields') for (const r of b.rows) if (r.label === label) return r.value
  return undefined
}

describe('the document catalog', () => {
  const fixtures: Array<[string, FormationAnswers]> = [
    ['a solo founder with a deputy', solo()],
    ['two founders', duo()],
    ['a person and a company', withCompany()],
    ['empty answers', emptyAnswers()],
  ]

  for (const [label, answers] of fixtures) {
    for (const c of [ctx, registered]) {
      it(`builds every available document for ${label}${c.registration ? ' after registration' : ''}`, async () => {
        for (const entry of FORMATION_DOCUMENTS.filter((d) => d.available(answers))) {
          const doc = entry.build(answers, c)
          expect(doc.slug).toBe(entry.slug)
          expect(doc.blocks.length).toBeGreaterThan(0)
          const text = all(doc)
          expect(text).not.toMatch(/[\u2013\u2014]/)
          expect(text).not.toMatch(/undefined|NaN|null|\[object/)
          if (entry.formats.includes('docx')) expect((await renderDocx(doc)).length).toBeGreaterThan(0)
        }
      })
    }
  }

  it('offers the shareholders agreement only with two or more founders', () => {
    const entry = FORMATION_DOCUMENTS.find((d) => d.slug === 'aktieagaravtal')!
    expect(entry.available(solo())).toBe(false)
    expect(entry.available(duo())).toBe(true)
    expect(buildFormationDocument('aktieagaravtal', solo(), ctx)).toBeNull()
    expect(buildFormationDocument('aktieagaravtal', duo(), ctx)?.title).toBe('Aktieägaravtal')
  })

  it('returns null for an unknown slug', () => {
    expect(buildFormationDocument('nope', solo(), ctx)).toBeNull()
  })

  it('keys titles under formation.documents and offers the read-only sheets as PDF only', () => {
    for (const d of FORMATION_DOCUMENTS) expect(d.titleKey).toBe(`formation.documents.${d.slug}`)
    const formats = Object.fromEntries(FORMATION_DOCUMENTS.map((d) => [d.slug, d.formats]))
    expect(formats.verksamt).toEqual(['pdf'])
    expect(formats.skatteverket).toEqual(['pdf'])
    expect(formats.bank).toEqual(['pdf'])
    expect(formats.bolagsordning).toEqual(['pdf', 'docx'])
  })
})

describe('signatory rule texts', () => {
  it('reads the way the board decides it', () => {
    expect(SIGNATORY_RULE_TEXT).toEqual({
      board: 'Bolagets firma tecknas av styrelsen.',
      board_or_each: 'Bolagets firma tecknas av styrelsen. Firman tecknas även av styrelseledamöterna var för sig.',
      board_or_two: 'Bolagets firma tecknas av styrelsen. Firman tecknas även av två styrelseledamöter i förening.',
    })
  })
})

describe('buildAnswerSheet', () => {
  it('has one heading per verksamt.se step, in order', () => {
    const doc = buildAnswerSheet(solo(), ctx)
    expect(headings(doc)).toEqual(VERKSAMT_STEPS.map((s, i) => `${i + 1}. ${s}`))
    expect(doc.blocks[0]).toMatchObject({ kind: 'paragraph', muted: true })
  })

  it('lists the deputy with personnummer and role, and the board limits', () => {
    const text = all(buildAnswerSheet(solo(), ctx))
    expect(text).toContain('Deputy Person')
    expect(text).toContain('20121212-1212')
    expect(text).toContain('Styrelsesuppleant')
    expect(text).toContain('19500118-2046')
    expect(text).toContain('Stiftare, Styrelseledamot, VD')
    const doc = buildAnswerSheet(solo(), ctx)
    expect(fieldValue(doc, 'Styrelsesuppleanter, lägst')).toBe('1')
    expect(fieldValue(doc, 'Styrelseledamöter, högst')).toBe('10')
  })

  it('uses the e-service labels in steps 1 to 3', () => {
    const doc = buildAnswerSheet(solo(), ctx)
    expect(fieldValue(doc, 'Förnamn och efternamn')).toBe('Test Testsson')
    expect(fieldValue(doc, 'Telefonnummer med landskod')).toBe('+46701234567')
    expect(fieldValue(doc, 'Postnummer')).toBe('11122')
    expect(fieldValue(doc, 'Namnförslag 2')).toBe('Nordtest AB')
    expect(fieldValue(doc, 'Verksamhetsbeskrivning')).toBe(
      'Aktiebolaget ska bedriva konsultverksamhet inom systemutveckling och drift av webbtjänster.',
    )
  })

  it('names the signers and the fees in step 13', () => {
    const doc = buildAnswerSheet(withCompany(), ctx)
    expect(fieldValue(doc, 'Avgift för registreringen')).toBe('2 400 kr')
    expect(fieldValue(doc, 'Avgift för anmälan av verklig huvudman')).toBe('250 kr')
    expect(fieldValue(doc, 'Totalt att betala')).toBe('2 650 kr')
    expect(fieldValue(doc, 'Holding AB')).toContain('firmatecknare: Test Testsson')
    expect(fieldValue(doc, 'Frivilliga bestämmelser')).toBe('Inga')
  })

  it('states the first fiscal year without a registration date', () => {
    expect(fieldValue(buildAnswerSheet(solo(), ctx), 'Första räkenskapsåret')).toBe(
      'Från registreringen till och med den 31 december närmast efter',
    )
    const longer = { ...solo(), fiscalYearStartMonth: 5, extendFirstYear: true }
    expect(fieldValue(buildAnswerSheet(longer, ctx), 'Första räkenskapsåret')).toBe(
      'Förlängt: från registreringen till och med den 30 april året därpå (högst 18 månader)',
    )
  })

  it('reports beneficial owners, or that there is none above 25 percent', () => {
    expect(all(buildAnswerSheet(duo(), ctx))).toContain('Verklig huvudman 2: Bo Bolagsman')
    const four = { ...base(), parties: ['a', 'b', 'c', 'd'].map((id) => ({ id, type: 'person' as const, name: id, personnummer: '', email: '', shares: 125, roles: [] })) }
    expect(fieldValue(buildAnswerSheet(four, ctx), 'Verklig huvudman')).toBe('Ingen person äger eller kontrollerar mer än 25 procent')
  })
})

describe('buildBolagsordning', () => {
  it('mirrors the template sections with min and max limits', () => {
    const doc = buildBolagsordning(solo(), ctx)
    expect(doc.title).toBe('Bolagsordning för Testbolaget Nord AB')
    expect(headings(doc)).toHaveLength(10)
    const text = all(doc)
    expect(text).toContain('Aktiebolagets företagsnamn är Testbolaget Nord AB.')
    expect(text).toContain('Styrelsen har sitt säte i Stockholm.')
    expect(text).toContain('Aktiekapitalet ska vara lägst 25 000 kronor och högst 100 000 kronor.')
    expect(text).toContain('Antalet aktier ska vara lägst 500 och högst 2 000.')
    expect(text).toContain('Styrelsen ska ha lägst 1 och högst 10 styrelseledamöter med lägst 1 och högst 10 styrelsesuppleanter.')
    expect(text).toContain('Aktiebolaget ska inte ha någon revisor.')
    expect(text).toContain('Aktiebolagets räkenskapsår är från den 1 januari till den 31 december.')
    expect(text).toContain('Kallelse sker genom e-post eller brev med posten.')
  })

  it('drops the deputy floor with three board members and writes the auditor clause', () => {
    const a = duo()
    a.parties[2] = { ...a.parties[2], roles: ['ledamot'] } as FormationAnswers['parties'][number]
    a.auditor = { has: true, name: 'Revisor AB' }
    const text = all(buildBolagsordning(a, ctx))
    expect(text).toContain('med lägst 0 och högst 10 styrelsesuppleanter')
    expect(text).toContain('Revisorn ska granska aktiebolagets årsredovisning')
  })

  it('writes a non-calendar fiscal year', () => {
    expect(fiscalYearText(7)).toBe('från den 1 juli till den 30 juni')
    expect(fiscalYearText(3)).toBe('från den 1 mars till den sista februari')
  })
})

describe('buildStiftelseurkund', () => {
  it('follows Bolagsverket\'s template: subscribes every share at the quota value and names the board', () => {
    const doc = buildStiftelseurkund(duo(), ctx)
    const text = all(doc)
    expect(doc.subtitle).toContain('verksamt.se skapar den elektroniska stiftelseurkunden')
    expect(text).toContain('Undertecknade stiftare är överens om att bilda ett aktiebolag med företagsnamnet Testbolaget Nord AB.')
    expect(text).toContain('De som tecknar aktier ska betala 50 kr för varje aktie.')
    expect(text).toContain('Cecilia Suppleant')
    expect(text).toContain('Bolaget ska inte ha någon revisor.')
    expect(text).toContain('Aktiebolaget är bildat när alla stiftare har skrivit under stiftelseurkunden.')
    // The template has no formation-costs clause (ABL 2 kap. 8 § asks for one only for costs beyond the fees).
    expect(text).not.toContain('Kostnader för bildandet')
    expect(fieldValue(doc, 'Datum')).toBe('2026-11-21')
    const table = doc.blocks.find((b) => b.kind === 'table' && b.head[0] === 'Namn' && b.head[2] === 'Antal aktier')
    expect(table && table.kind === 'table' && table.rows).toEqual([
      ['Anna Ägare', '19500118-2046', '300', '15 000 kr'],
      ['Bo Bolagsman', '20121212-1212', '200', '10 000 kr'],
      ['Summa', '', '500', '25 000 kr'],
    ])
  })

  it('lets a founding company sign through its signatories', () => {
    const sig = buildStiftelseurkund(withCompany(), { today: ctx.today }).blocks.find((b) => b.kind === 'signatures')
    expect(sig && sig.kind === 'signatures' && sig.people).toEqual([
      { name: 'Test Testsson', caption: 'Stiftare' },
      { name: 'Test Testsson', caption: 'För Holding AB, stiftare' },
    ])
    expect(fieldValue(buildStiftelseurkund(withCompany(), { today: ctx.today }), 'Datum')).toBe('____________')
  })
})

describe('buildStyrelseprotokoll', () => {
  it('is a sole member decision for a one-member board', () => {
    const doc = buildStyrelseprotokoll(solo(), ctx)
    expect(doc.title).toBe('Beslut av ensam styrelseledamot')
    expect(headings(doc).some((h) => h.includes('Val av ordförande'))).toBe(false)
    // Without a chair section the rest renumber: §3 is the VD.
    expect(headings(doc)).toContain('§ 3 Verkställande direktör')
    expect(all(doc)).toContain(SIGNATORY_RULE_TEXT.board)
    expect(all(doc)).not.toContain('Justeras')
  })

  it('is minutes with a chair and a Justeras line for two members', () => {
    const doc = buildStyrelseprotokoll(duo(), ctx)
    expect(doc.title).toBe('Protokoll från konstituerande styrelsemöte')
    expect(headings(doc).slice(0, 3)).toEqual(['§ 1 Öppnande', '§ 2 Val av ordförande', '§ 3 Firmateckning'])
    const text = all(doc)
    expect(text).toContain('Styrelsen valde Anna Ägare till styrelsens ordförande.')
    expect(text).toContain(SIGNATORY_RULE_TEXT.board_or_two)
    expect(text).toContain('Justeras')
    const signed = doc.blocks.filter((b) => b.kind === 'signatures').flatMap((b) => (b.kind === 'signatures' ? b.people.map((p) => p.name) : []))
    expect(signed.sort()).toEqual(['Anna Ägare', 'Bo Bolagsman'])
  })

  it('omits the VD section when there is none and states the first fiscal year once registered', () => {
    const a = solo()
    a.parties[0] = { ...a.parties[0], roles: ['ledamot'] } as FormationAnswers['parties'][number]
    const doc = buildStyrelseprotokoll(a, registered)
    expect(headings(doc).some((h) => h.includes('Verkställande direktör'))).toBe(false)
    expect(all(doc)).toContain('Det första räkenskapsåret är 2026-12-03 till 2026-12-31.')
  })
})

describe('buildAktiebok', () => {
  it('numbers the shares in party order and the ranges add up', () => {
    const a = withCompany()
    const doc = buildAktiebok(a, ctx)
    const table = doc.blocks.find((b) => b.kind === 'table')
    expect(table && table.kind === 'table' && table.rows.map((r) => [r[0], r[1], r[2], r[4], r[5], r[6]])).toEqual([
      ['1-250', 'Test Testsson', '19500118-2046', '250', '2026-11-21', 'Teckning vid bildandet'],
      ['251-500', 'Holding AB', '559538-6219', '250', '2026-11-21', 'Teckning vid bildandet'],
    ])
    const ranges = shareRanges(a)
    expect(ranges.reduce((s, r) => s + (r.to - r.from + 1), 0)).toBe(a.capital.shares)
    expect(ranges.at(-1)?.to).toBe(a.capital.shares)
    expect(fieldValue(doc, 'Organisationsnummer')).toBe('Under bildande')
    expect(fieldValue(doc, 'Kvotvärde')).toBe('50 kr')
    expect(doc.footer).toContain('tio år')
  })

  it('carries the organisation number after registration', () => {
    expect(fieldValue(buildAktiebok(solo(), registered), 'Organisationsnummer')).toBe('559538-6219')
  })
})

describe('buildSkatteverket', () => {
  it('asks for VAT registration above 120 000 kr and not below', () => {
    expect(fieldValue(buildSkatteverket(solo(), registered), 'Registrera för moms')).toBe('Ja')
    const low = solo()
    low.tax = { ...low.tax, expectedTurnover: 100_000 }
    expect(fieldValue(buildSkatteverket(low, registered), 'Registrera för moms')).toContain('Inte nödvändigt')
    const none = solo()
    none.tax = { ...none.tax, expectedTurnover: null }
    expect(fieldValue(buildSkatteverket(none, ctx), 'Registrera för moms')).toBe('____________')
  })

  it('maps the owner salary choice to the employer answer', () => {
    const a = solo()
    a.tax = { ...a.tax, ownerSalary: 'now' }
    expect(fieldValue(buildSkatteverket(a, registered), 'Registrera som arbetsgivare')).toBe('Ja, registrera nu')
    a.tax = { ...a.tax, ownerSalary: 'no' }
    expect(fieldValue(buildSkatteverket(a, registered), 'Registrera som arbetsgivare')).toBe('Inte nu')
  })

  it('warns when the chosen VAT period does not fit the turnover', () => {
    const a = solo()
    a.tax = { ...a.tax, expectedTurnover: 2_000_000, vatPeriod: 'year' }
    expect(all(buildSkatteverket(a, registered))).toContain('Helår går bara med en omsättning upp till 1 miljon kr')
  })

  it('never invents an SNI code', () => {
    expect(fieldValue(buildSkatteverket(solo(), registered), 'SNI-kod')).toBe('Välj i e-tjänsten utifrån verksamheten')
  })
})

describe('buildBankChecklist', () => {
  it('adds bank facts for SEB and only the generic list for Handelsbanken', () => {
    const seb = { ...solo(), bank: 'seb' as const }
    expect(all(buildBankChecklist(seb, ctx))).toContain('2 500 kr')
    const hb = buildBankChecklist({ ...solo(), bank: 'handelsbanken' }, ctx)
    expect(headings(hb)).toEqual(['Det här gör ni', 'Ha det här redo'])
    expect(BANK_NOTES.handelsbanken).toBeUndefined()
    expect(all(buildBankChecklist(solo(), ctx))).toContain('Öppna ett konto för Testbolaget Nord AB under bildande.')
  })
})

describe('buildBolagetMarkdown', () => {
  it('masks every personnummer the repository way: birth date shown, last four hidden', () => {
    for (const a of [solo(), duo(), withCompany()]) {
      const md = buildBolagetMarkdown(a, ctx)
      expect(md).not.toContain(PNR_A)
      expect(md).not.toContain(PNR_B)
      expect(md).not.toContain('-2046')
      expect(md).not.toContain('-1212')
    }
    const md = buildBolagetMarkdown(solo(), ctx)
    expect(md).toContain('19500118-XXXX')
    expect(md).toContain('20121212-XXXX')
  })

  it('carries the planned facts and the next steps', () => {
    const md = buildBolagetMarkdown(withCompany(), ctx)
    expect(md.startsWith('# bolaget.md')).toBe(true)
    expect(md).toContain('Aktiebolaget ska bedriva konsultverksamhet')
    expect(md).toContain('| Holding AB | 559538-6219 | 250 | 50 procent |')
    expect(md).toContain('Bolagets firma tecknas av styrelsen.')
    expect(md).toContain('## Nästa steg')
    expect(md).toContain('2 400 kr')
    expect(md).not.toMatch(/[\u2013\u2014]/)
  })
})

describe('helpers', () => {
  it('formats kronor with plain spaces and öre when needed', () => {
    expect(kr(25_000)).toBe('25 000 kr')
    expect(kr(100 / 3)).toBe('33,33 kr')
    expect(kr(-1500)).toBe('-1 500 kr')
  })

  it('extends the first fiscal year only within 18 months', () => {
    const a = { ...solo(), extendFirstYear: true }
    expect(firstFiscalYear(a, '2026-12-03')).toMatchObject({ to: '2027-12-31', extended: true })
    expect(firstFiscalYear(a, '2026-03-01')).toMatchObject({ to: '2026-12-31', extended: false, extensionRefused: true })
    expect(firstFiscalYear({ ...a, fiscalYearStartMonth: 7, extendFirstYear: false }, '2026-12-03').to).toBe('2027-06-30')
  })
})
