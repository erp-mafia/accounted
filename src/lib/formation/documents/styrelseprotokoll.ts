/**
 * Minutes of the board's first decisions, or the sole member's written
 * decision. No statute requires a constituent board meeting, but the
 * registration application assures Bolagsverket that the reported chair,
 * signatory rule and VD match the company's decisions (ABF 4 §), so the
 * minutes record those decisions for the founding archive (research
 * notes 2026-11-19). The aktiebok is opened as soon as all founders have
 * signed the deed (ABL 5 kap. 8 §).
 */

import { type FormationAnswers, type FormationPerson, boardMembers, deputies, persons } from '../answers'
import type { DocBlock, FormationDocument } from '../document-model'
import type { DocumentContext } from './context'
import { bankLabel, fiscalYearText, firstFiscalYear, firstFiscalYearSentence } from './facts'
import { BLANK, companyNameWithStatus, companyOrgNumber, joinNames, kr, orBlank, partyName } from './format'
import { signatoryRuleText } from './signatory'

function memberCaption(p: FormationPerson): string {
  return p.roles.includes('ordforande') ? 'Styrelseordförande' : 'Styrelseledamot'
}

export function buildStyrelseprotokoll(a: FormationAnswers, ctx: DocumentContext): FormationDocument {
  const members = boardMembers(a)
  const multi = members.length >= 2
  const chair = members.find((p) => p.roles.includes('ordforande')) ?? null
  const vd = persons(a).find((p) => p.roles.includes('vd')) ?? null
  const deps = deputies(a)
  const memberNames = members.map(partyName)
  const sole = members[0] ?? null

  const sections: Array<{ title: string; body: DocBlock[] }> = []
  const say = (text: string): DocBlock => ({ kind: 'paragraph', text })

  sections.push({
    title: 'Öppnande',
    body: multi
      ? [say(`${chair ? partyName(chair) : memberNames[0]} öppnade mötet. Närvarande styrelseledamöter: ${joinNames(memberNames)}.`)]
      : [say(`${sole ? partyName(sole) : BLANK} är bolagets enda styrelseledamot och fattar följande beslut.`)],
  })

  if (multi) {
    sections.push({
      title: 'Val av ordförande',
      body: [say(`Styrelsen valde ${chair ? partyName(chair) : BLANK} till styrelsens ordförande.`)],
    })
  }

  sections.push({
    title: 'Firmateckning',
    body: [say(`${multi ? 'Styrelsen beslutade' : 'Jag beslutar'} att firman ska tecknas så här: ${signatoryRuleText(a.signatoryRule)}`)],
  })

  if (vd) {
    sections.push({
      title: 'Verkställande direktör',
      body: [say(`${multi ? 'Styrelsen utsåg' : 'Jag utser'} ${partyName(vd)} till verkställande direktör.`)],
    })
  }

  sections.push({
    title: 'Aktiebok',
    body: [
      say(
        'Aktieboken upprättas och de tecknade aktierna förs in i den (aktiebolagslagen 5 kap.). Styrelsen ser till att aktieboken förs, bevaras och hålls tillgänglig.',
      ),
    ],
  })

  const bank = bankLabel(a)
  sections.push({
    title: 'Bankkonto och bankintyg',
    body: [
      say(
        `Aktiekapitalet, ${kr(a.capital.amount)}, sätts in på ett särskilt konto för bolaget under bildande hos ${bank && a.bank !== 'other' ? bank : BLANK}. Banken utfärdar ett elektroniskt bankintyg till registreringsärendet på verksamt.se.`,
      ),
    ],
  })

  const first = ctx.registration ? firstFiscalYear(a, ctx.registration.date) : null
  sections.push({
    title: 'Räkenskapsår',
    body: [
      say(`Bolagets räkenskapsår är ${fiscalYearText(a.fiscalYearStartMonth)}, enligt bolagsordningen.`),
      say(first ? `Det första räkenskapsåret är ${first.from} till ${first.to}.` : firstFiscalYearSentence(a)),
    ],
  })

  sections.push({
    title: 'Avslutning',
    body: [say(multi ? 'Inga fler frågor togs upp och mötet avslutades.' : 'Inga fler beslut fattades.')],
  })

  const blocks: DocBlock[] = [
    {
      kind: 'paragraph',
      text: 'Ingen lag kräver ett konstituerande styrelsemöte. I registreringsansökan försäkrar ni att uppgifterna om ordförande, firmateckning och VD stämmer med bolagets beslut. Det här protokollet visar de besluten. Spara det med stiftelsehandlingarna.',
      muted: true,
    },
    {
      kind: 'fields',
      rows: [
        { label: 'Bolag', value: companyNameWithStatus(a, ctx) },
        { label: 'Organisationsnummer', value: companyOrgNumber(ctx) },
        { label: 'Datum', value: orBlank(ctx.deedDate) },
        { label: 'Plats', value: BLANK },
        ...(multi ? [{ label: 'Närvarande', value: joinNames(memberNames) }] : [{ label: 'Styrelseledamot', value: sole ? partyName(sole) : BLANK }]),
        ...(deps.length > 0 ? [{ label: 'Styrelsesuppleant', value: joinNames(deps.map(partyName)) }] : []),
      ],
    },
  ]
  sections.forEach((s, i) => {
    blocks.push({ kind: 'heading', text: `§ ${i + 1} ${s.title}` })
    blocks.push(...s.body)
  })

  if (multi) {
    // The member who keeps the minutes signs first; the chair and the rest justify them.
    const keeper = members.find((p) => p !== chair) ?? members[0]
    const others = members.filter((p) => p !== keeper)
    blocks.push(
      { kind: 'heading', text: 'Underskrifter' },
      { kind: 'paragraph', text: 'Vid protokollet', bold: true },
      { kind: 'signatures', people: [{ name: partyName(keeper), caption: memberCaption(keeper) }] },
      { kind: 'paragraph', text: 'Justeras', bold: true },
      { kind: 'signatures', people: others.map((p) => ({ name: partyName(p), caption: memberCaption(p) })) },
    )
  } else {
    blocks.push(
      { kind: 'heading', text: 'Underskrift' },
      { kind: 'signatures', people: [{ name: sole ? partyName(sole) : BLANK, caption: 'Ensam styrelseledamot' }] },
    )
  }

  return {
    slug: 'styrelseprotokoll',
    title: multi ? 'Protokoll från konstituerande styrelsemöte' : 'Beslut av ensam styrelseledamot',
    subtitle: companyNameWithStatus(a, ctx),
    blocks,
  }
}
