/**
 * "Så fyller du i verksamt.se": what to type in each of the 13 steps of
 * Bolagsverket's e-service "Registrera aktiebolag med pengar".
 *
 * Steps 1 to 4 use the field labels of the live e-service (2026-11-19).
 * Steps 5 to 13 use plain labels from the law and Bolagsverket's pages,
 * and the document says their names may differ.
 */

import {
  type FormationAnswers,
  type FormationCompanyFounder,
  type FormationPerson,
  founders,
  quotaValue,
} from '../answers'
import { beneficialOwners } from '../rules'
import type { DocBlock, FormationDocument } from '../document-model'
import type { DocumentContext } from './context'
import {
  BANK_LABEL,
  BENEFICIAL_OWNER_FEE,
  REGISTRATION_FEE,
  boardLimits,
  capitalLimits,
  firstFiscalYearShort,
  fiscalYearShort,
  roleLabels,
} from './facts'
import {
  BLANK,
  businessSentence,
  count,
  displayOrgNumber,
  displayPersonnummer,
  kr,
  nameProposals,
  orBlank,
  partyName,
  percentText,
  subtitleFor,
} from './format'
import { signatoryRuleText } from './signatory'

export const VERKSAMT_STEPS = [
  'Kontaktuppgifter i ärendet',
  'Företagets adress',
  'Namnförslag och verksamhet',
  'Personer i företaget',
  'Firmateckning',
  'Aktiekapital och aktier',
  'Revisorer',
  'Säte, kallelse och räkenskapsår',
  'Frivilliga bestämmelser',
  'Verkliga huvudmän',
  'Sammanställning',
  'Bankintyg',
  'Skriv under och skicka in',
] as const

type Row = { label: string; value: string }

function step(n: number): DocBlock {
  return { kind: 'heading', text: `${n}. ${VERKSAMT_STEPS[n - 1]}` }
}

function fields(rows: Row[]): DocBlock {
  return { kind: 'fields', rows }
}

/** People with a share or a role, in the order the founder entered them. */
function involvedPersons(a: FormationAnswers): FormationPerson[] {
  return a.parties.filter((p): p is FormationPerson => p.type === 'person' && (p.shares > 0 || p.roles.length > 0))
}

function companyFounders(a: FormationAnswers): FormationCompanyFounder[] {
  return a.parties.filter((p): p is FormationCompanyFounder => p.type === 'company' && p.shares > 0)
}

function signatoryNames(c: FormationCompanyFounder): string[] {
  return c.signatories.map((s) => s.trim()).filter(Boolean)
}

function stepPersons(a: FormationAnswers): DocBlock[] {
  const limits = boardLimits(a)
  const blocks: DocBlock[] = [
    step(4),
    { kind: 'paragraph', text: 'Gränserna för styrelsen hamnar i bolagsordningen. Fälten har ett förslag som du kan ändra.' },
    fields([
      { label: 'Styrelseledamöter, lägst', value: String(limits.membersMin) },
      { label: 'Styrelseledamöter, högst', value: String(limits.membersMax) },
      { label: 'Styrelsesuppleanter, lägst', value: String(limits.deputiesMin) },
      { label: 'Styrelsesuppleanter, högst', value: String(limits.deputiesMax) },
    ]),
    {
      kind: 'paragraph',
      text: 'Välj "Lägg till person" för var och en nedan och svara Ja på frågan om svenskt personnummer. Namn och adress hämtas från folkbokföringen.',
    },
  ]
  const people = involvedPersons(a)
  people.forEach((p, i) => {
    blocks.push({ kind: 'paragraph', text: `Person ${i + 1}: ${partyName(p)}`, bold: true })
    blocks.push(
      fields([
        { label: 'Personnummer (ååååmmdd-nnnn)', value: displayPersonnummer(p.personnummer) },
        { label: 'Roller att kryssa i', value: roleLabels(p).join(', ') || BLANK },
      ]),
    )
  })
  const companies = companyFounders(a)
  companies.forEach((c, i) => {
    blocks.push({ kind: 'paragraph', text: `Företag som är stiftare ${i + 1}: ${partyName(c)}`, bold: true })
    blocks.push(
      fields([
        { label: 'Organisationsnummer (nnnnnn-nnnn)', value: displayOrgNumber(c.orgNumber) },
        { label: 'Firmatecknare', value: signatoryNames(c).join(', ') || BLANK },
        { label: 'Roll', value: 'Stiftare' },
      ]),
    )
  })
  if (people.length === 0 && companies.length === 0) blocks.push(fields([{ label: 'Personer', value: BLANK }]))
  return blocks
}

function stepCapital(a: FormationAnswers): DocBlock[] {
  const limits = capitalLimits(a)
  const rows: Row[] = [
    { label: 'Aktiekapital', value: kr(a.capital.amount) },
    { label: 'Antal aktier', value: count(a.capital.shares) },
    { label: 'Aktiekapital, lägst', value: kr(limits.capitalMin) },
    { label: 'Aktiekapital, högst', value: kr(limits.capitalMax) },
    { label: 'Antal aktier, lägst', value: count(limits.sharesMin) },
    { label: 'Antal aktier, högst', value: count(limits.sharesMax) },
    { label: 'Belopp att betala per aktie', value: kr(quotaValue(a)) },
    { label: 'Aktierna betalas med', value: 'Pengar' },
  ]
  for (const f of founders(a)) {
    rows.push({ label: `Aktier som ${partyName(f)} tecknar`, value: `${count(f.shares)} (${kr(f.shares * quotaValue(a))})` })
  }
  return [step(6), fields(rows)]
}

function stepBeneficialOwners(a: FormationAnswers): DocBlock[] {
  const owners = beneficialOwners(a)
  const blocks: DocBlock[] = [step(10)]
  if (owners.length === 0) {
    blocks.push(fields([{ label: 'Verklig huvudman', value: 'Ingen person äger eller kontrollerar mer än 25 procent' }]))
  } else {
    owners.forEach((o, i) => {
      blocks.push({ kind: 'paragraph', text: `Verklig huvudman ${i + 1}: ${orBlank(o.name)}`, bold: true })
      blocks.push(
        fields([
          { label: 'Andel av rösterna', value: percentText(o.percent) },
          { label: 'Hur', value: o.via === 'direct' ? 'Genom egna aktier' : `Genom ${orBlank(o.throughCompany)}` },
          { label: 'Medborgarskap', value: BLANK },
          { label: 'Land där personen bor', value: BLANK },
        ]),
      )
    })
  }
  blocks.push({
    kind: 'paragraph',
    text: 'Aktier som nära familjemedlemmar äger räknas ihop. Lägg till en person här om familjens aktier tillsammans är mer än 25 procent.',
  })
  return blocks
}

function stepSign(a: FormationAnswers): DocBlock[] {
  const rows: Row[] = []
  for (const f of founders(a)) {
    if (f.type === 'person') rows.push({ label: partyName(f), value: 'Skriver under som stiftare med e-legitimation' })
    else {
      const names = signatoryNames(f)
      rows.push({
        label: partyName(f),
        value: `Skriver under som stiftare genom sin firmatecknare: ${names.length > 0 ? names.join(', ') : BLANK}`,
      })
    }
  }
  if (rows.length === 0) rows.push({ label: 'Stiftare', value: BLANK })
  rows.push(
    { label: 'Avgift för registreringen', value: kr(REGISTRATION_FEE) },
    { label: 'Avgift för anmälan av verklig huvudman', value: kr(BENEFICIAL_OWNER_FEE) },
    { label: 'Totalt att betala', value: kr(REGISTRATION_FEE + BENEFICIAL_OWNER_FEE) },
  )
  return [
    step(13),
    { kind: 'paragraph', text: 'Alla stiftare skriver under stiftelseurkunden. Den gäller när alla har skrivit under.' },
    fields(rows),
    {
      kind: 'paragraph',
      text: 'Betala i samma veva. Bolagsverkets handläggning börjar när både ansökan och betalningen har kommit in. Ansökan måste komma in inom sex månader från att stiftelseurkunden skrevs under.',
    },
  ]
}

export function buildAnswerSheet(a: FormationAnswers, ctx: DocumentContext): FormationDocument {
  const proposals = nameProposals(a)
  const limitsCapital = kr(a.capital.amount)
  const bank = a.bank ? BANK_LABEL[a.bank] : null

  const blocks: DocBlock[] = [
    { kind: 'paragraph', text: 'Fältnamnen i steg 5 till 13 kan heta lite annorlunda i e-tjänsten.', muted: true },
    {
      kind: 'paragraph',
      text: 'Logga in på verksamt.se och välj "Registrera aktiebolag med pengar". Utkastet sparas varje gång du klickar Nästa. Senare steg öppnas när de tidigare är klara.',
    },

    step(1),
    fields([
      { label: 'Förnamn och efternamn', value: orBlank(a.contact.name) },
      { label: 'E-postadress', value: orBlank(a.contact.email) },
      { label: 'Bekräfta e-postadress', value: orBlank(a.contact.email) },
      { label: 'Telefonnummer med landskod', value: orBlank(a.contact.phone) },
    ]),

    step(2),
    fields([
      { label: 'C/o (valfri)', value: a.address.co.trim() || 'Lämna tomt' },
      { label: 'Adress', value: orBlank(a.address.street) },
      { label: 'Postnummer', value: orBlank(a.address.postalCode) },
      { label: 'Postort', value: a.address.city.trim() ? `Fylls i automatiskt (${a.address.city.trim()})` : 'Fylls i automatiskt' },
      { label: 'E-postadress (valfri)', value: a.companyEmail.trim() || 'Lämna tomt' },
      ...(a.companyEmail.trim() ? [{ label: 'Bekräfta e-postadress', value: a.companyEmail.trim() }] : []),
    ]),

    step(3),
    {
      kind: 'paragraph',
      text: 'Skriv namnförslagen i den här ordningen. Bolagsverket granskar dem i tur och ordning. Fältet för verksamheten börjar redan med "Aktiebolaget ska bedriva": skriv resten av meningen.',
    },
    fields([
      ...(proposals.length > 0
        ? proposals.map((name, i) => ({ label: `Namnförslag ${i + 1}`, value: name }))
        : [{ label: 'Namnförslag 1', value: BLANK }]),
      { label: 'Verksamhetsbeskrivning', value: businessSentence(a) },
    ]),

    ...stepPersons(a),

    step(5),
    fields([{ label: 'Firmateckning', value: signatoryRuleText(a.signatoryRule) }]),

    ...stepCapital(a),

    step(7),
    fields(
      a.auditor.has
        ? [
            { label: 'Ska bolaget ha revisor?', value: 'Ja' },
            { label: 'Revisor', value: orBlank(a.auditor.name) },
          ]
        : [{ label: 'Ska bolaget ha revisor?', value: 'Nej' }],
    ),

    step(8),
    fields([
      { label: 'Säte (kommun)', value: orBlank(a.seat) },
      { label: 'Kallelse till bolagsstämma', value: a.noticeByEmail ? 'Genom e-post eller brev med posten' : 'Genom brev med posten' },
      { label: 'Räkenskapsår', value: fiscalYearShort(a.fiscalYearStartMonth) },
      {
        label: 'Första räkenskapsåret',
        value: firstFiscalYearShort(a),
      },
    ]),

    step(9),
    fields([{ label: 'Frivilliga bestämmelser', value: 'Inga' }]),

    ...stepBeneficialOwners(a),

    step(11),
    { kind: 'paragraph', text: 'Jämför sammanställningen med det här dokumentet innan du går vidare.' },
    fields([
      { label: 'Namnförslag 1', value: proposals[0] ?? BLANK },
      { label: 'Aktiekapital', value: limitsCapital },
      { label: 'Antal aktier', value: count(a.capital.shares) },
      { label: 'Firmateckning', value: signatoryRuleText(a.signatoryRule) },
    ]),

    step(12),
    fields([
      ...(bank && a.bank !== 'other' ? [{ label: 'Bank', value: bank }] : []),
      {
        label: 'E-postadress till kontaktpersonen på banken',
        value: a.bank === 'lunar' ? 'business@lunar.app (Lunars adress för bankintyg)' : BLANK,
      },
      { label: 'Insatt belopp', value: limitsCapital },
    ]),
    {
      kind: 'paragraph',
      text: 'Banken ger dig e-postadressen. Kontaktpersonen får en förfrågan från e-tjänsten och lägger in bankintyget i ärendet. Sedan kan du gå vidare.',
    },

    ...stepSign(a),
  ]

  return {
    slug: 'verksamt',
    title: 'Så fyller du i verksamt.se',
    subtitle: subtitleFor(a, ctx),
    blocks,
  }
}
