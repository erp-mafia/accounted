/**
 * A reference copy of the stiftelseurkund. In the verksamt.se e-service
 * the founders enter the deed's data and the service creates and submits
 * an electronic transcript that they sign; this copy carries the same
 * values for the company's own archive.
 *
 * Sections and wording follow Bolagsverket's own template "Stiftelseurkund
 * när aktierna betalas med pengar" (for electronic signing, 2023-07-10):
 * Bildande av aktiebolaget, Aktieteckning with the amount per share,
 * Företrädare och revisor, Stiftare, the electronic signatures. Like the
 * template it has no formation-costs clause: ABL 2 kap. 8 § asks for one
 * only when the company pays more than the public fees and the customary
 * cost of drafting the deed.
 */

import {
  type FormationAnswers,
  type FormationParty,
  MIN_SHARE_CAPITAL,
  boardMembers,
  deputies,
  founders,
  quotaValue,
} from '../answers'
import type { DocBlock, FormationDocument } from '../document-model'
import type { DocumentContext } from './context'
import {
  BLANK,
  companyName,
  count,
  displayPersonnummer,
  kr,
  nameProposals,
  orBlank,
  partyIdNumber,
  partyName,
} from './format'

/** The people who sign for a founder: the person, or a company's signatories. */
export function founderSignatures(a: FormationAnswers): Array<{ name: string; caption?: string }> {
  const out: Array<{ name: string; caption?: string }> = []
  for (const f of founders(a)) out.push(...signaturesFor(f))
  return out
}

function signaturesFor(f: FormationParty): Array<{ name: string; caption?: string }> {
  if (f.type === 'person') return [{ name: partyName(f), caption: 'Stiftare' }]
  const names = f.signatories.map((s) => s.trim()).filter(Boolean)
  const caption = `För ${partyName(f)}, stiftare`
  if (names.length === 0) return [{ name: BLANK, caption }]
  return names.map((name) => ({ name, caption }))
}

function personTable(people: Array<{ name: string; personnummer: string }>): DocBlock {
  return {
    kind: 'table',
    head: ['Namn', 'Personnummer', 'Postadress'],
    rows: people.map((p) => [orBlank(p.name), displayPersonnummer(p.personnummer), BLANK]),
    widths: [3, 2, 4],
  }
}

export function buildStiftelseurkund(a: FormationAnswers, ctx: DocumentContext): FormationDocument {
  const proposals = nameProposals(a)
  const firstName = proposals[0] ?? companyName(a, ctx)
  const price = quotaValue(a)
  const fs = founders(a)
  const subscribed = fs.reduce((s, f) => s + f.shares, 0)
  const members = boardMembers(a)
  const deps = deputies(a)

  const blocks: DocBlock[] = [
    { kind: 'heading', text: 'Bildande av aktiebolaget' },
    {
      kind: 'paragraph',
      text: `Undertecknade stiftare är överens om att bilda ett aktiebolag med företagsnamnet ${firstName}. Företagets bestämmelser står i den bifogade bolagsordningen.`,
    },
    ...(proposals.length > 1
      ? ([{ kind: 'paragraph', text: `Övriga namnförslag i turordning: ${proposals.slice(1).join(', ')}.`, muted: true }] as DocBlock[])
      : []),

    { kind: 'heading', text: 'Aktieteckning' },
    { kind: 'paragraph', text: 'När stiftarna skriver under stiftelseurkunden tecknar de även följande aktier:' },
    {
      kind: 'table',
      head: ['Namn', 'Person-/organisationsnummer', 'Antal aktier', 'Belopp'],
      rows: [
        ...fs.map((f) => [partyName(f), partyIdNumber(f), count(f.shares), kr(f.shares * price)]),
        ['Summa', '', count(subscribed), kr(subscribed * price)],
      ],
      widths: [3, 3, 2, 2],
    },
    {
      kind: 'paragraph',
      text: `De som tecknar aktier ska betala ${kr(price)} för varje aktie. Aktierna betalas med pengar till ett särskilt konto i banken, totalt ${kr(subscribed * price)}. Aktiekapitalet är ${kr(a.capital.amount)} (minst ${kr(MIN_SHARE_CAPITAL)}).`,
    },

    { kind: 'heading', text: 'Företrädare och revisor' },
    { kind: 'paragraph', text: members.length === 1 ? 'Styrelseledamot' : 'Styrelseledamöter', bold: true },
    personTable(members.length > 0 ? members : [{ name: '', personnummer: '' }]),
    ...(deps.length > 0
      ? ([{ kind: 'paragraph', text: deps.length === 1 ? 'Styrelsesuppleant' : 'Styrelsesuppleanter', bold: true }, personTable(deps)] as DocBlock[])
      : []),
    { kind: 'paragraph', text: 'Revisor', bold: true },
    ...(a.auditor.has
      ? ([
          {
            kind: 'fields',
            rows: [
              { label: 'Namn', value: orBlank(a.auditor.name) },
              { label: 'Personnummer eller organisationsnummer', value: BLANK },
              { label: 'Postadress', value: BLANK },
            ],
          },
        ] as DocBlock[])
      : ([{ kind: 'paragraph', text: 'Bolaget ska inte ha någon revisor.' }] as DocBlock[])),

    { kind: 'heading', text: 'Stiftare' },
    {
      kind: 'table',
      head: ['Namn', 'Person-/organisationsnummer'],
      rows: fs.map((f) => [partyName(f), partyIdNumber(f)]),
      widths: [3, 2],
    },
    ...(fs.some((f) => f.type === 'company')
      ? ([{ kind: 'paragraph', text: 'Om stiftaren är en juridisk person står organisationsnumret och namnet.', muted: true }] as DocBlock[])
      : []),

    { kind: 'heading', text: 'Elektronisk underskrift av stiftarna' },
    {
      kind: 'paragraph',
      text: 'Om stiftaren är en juridisk person skriver den eller de som är firmatecknare under. Aktiebolaget är bildat när alla stiftare har skrivit under stiftelseurkunden.',
    },
    { kind: 'fields', rows: [{ label: 'Datum', value: orBlank(ctx.deedDate) }] },
    { kind: 'signatures', people: founderSignatures(a).length > 0 ? founderSignatures(a) : [{ name: BLANK, caption: 'Stiftare' }] },
  ]

  return {
    slug: 'stiftelseurkund',
    title: 'Stiftelseurkund',
    subtitle: `Referenskopia för ${firstName} under bildande. verksamt.se skapar den elektroniska stiftelseurkunden som ni skriver under, från samma uppgifter.`,
    blocks,
  }
}
