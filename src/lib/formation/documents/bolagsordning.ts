/**
 * The bolagsordning, mirroring the structure and wording of Bolagsverket's
 * templates "Bolagsordning för aktiebolag med revisor" and "... utan
 * revisor" (the latter replaces section 7 with a sentence that the company
 * has no auditor). Capital and share counts are written as min and max:
 * the founding values as the floor and four times them as the ceiling.
 */

import type { FormationAnswers } from '../answers'
import type { DocBlock, FormationDocument } from '../document-model'
import type { DocumentContext } from './context'
import { boardLimits, capitalLimits, fiscalYearText } from './facts'
import { businessSentence, companyName, count, kronor, orBlank, subtitleFor } from './format'

export const ANNUAL_MEETING_ITEMS = [
  'öppnas av den som ska göra det',
  'välja ordförande för stämman',
  'godkänna den upprättade röstlängden',
  'välja minst en justerare (när det krävs)',
  'pröva om stämman blivit kallad i rätt tid och på rätt sätt',
  'godkänna dagordningen',
  'besluta, när årsredovisningen och eventuell revisionsberättelse presenterats, a) att fastställa resultaträkningen och balansräkningen, b) hur aktiebolagets vinst eller förlust enligt den fastställda balansräkningen ska disponeras, c) om ansvarsfrihet ska ges till var och en av dem som tjänstgjort som styrelseledamot eller verkställande direktör',
  'besluta om arvode till styrelsen och eventuell revisor',
  'besluta hur många styrelseledamöter och eventuella styrelsesuppleanter som styrelsen ska ha',
  'välja styrelse (om mandattiden gått ut)',
  'välja revisor (när det krävs eller om mandattiden gått ut)',
  'ta upp andra ärenden som står i aktiebolagslagen (2005:551) eller i bolagsordningen',
]

export function noticeSentence(a: FormationAnswers): string {
  return a.noticeByEmail ? 'Kallelse sker genom e-post eller brev med posten.' : 'Kallelse sker genom brev med posten.'
}

export function auditorClause(a: FormationAnswers): string {
  if (!a.auditor.has) return 'Aktiebolaget ska inte ha någon revisor.'
  return (
    'Aktiebolaget ska ha lägst 1 och högst 2 revisorer med lägst 0 och högst 2 revisorssuppleanter. ' +
    'Revisorn ska granska aktiebolagets årsredovisning och räkenskaper samt styrelsens och eventuell verkställande direktörs förvaltning.'
  )
}

export function buildBolagsordning(a: FormationAnswers, ctx: DocumentContext): FormationDocument {
  const name = companyName(a, ctx)
  const board = boardLimits(a)
  const capital = capitalLimits(a)

  const blocks: DocBlock[] = [
    { kind: 'heading', text: '1. Företagsnamn' },
    { kind: 'paragraph', text: `Aktiebolagets företagsnamn är ${name}.` },

    { kind: 'heading', text: '2. Styrelsens säte' },
    { kind: 'paragraph', text: `Styrelsen har sitt säte i ${orBlank(a.seat)}.` },

    { kind: 'heading', text: '3. Verksamhet' },
    { kind: 'paragraph', text: businessSentence(a) },

    { kind: 'heading', text: '4. Aktiekapital' },
    {
      kind: 'paragraph',
      text: `Aktiekapitalet ska vara lägst ${kronor(capital.capitalMin)} kronor och högst ${kronor(capital.capitalMax)} kronor.`,
    },

    { kind: 'heading', text: '5. Antal aktier' },
    { kind: 'paragraph', text: `Antalet aktier ska vara lägst ${count(capital.sharesMin)} och högst ${count(capital.sharesMax)}.` },

    { kind: 'heading', text: '6. Styrelse' },
    {
      kind: 'paragraph',
      text: `Styrelsen ska ha lägst ${board.membersMin} och högst ${board.membersMax} styrelseledamöter med lägst ${board.deputiesMin} och högst ${board.deputiesMax} styrelsesuppleanter.`,
    },

    { kind: 'heading', text: '7. Revisor' },
    { kind: 'paragraph', text: auditorClause(a) },

    { kind: 'heading', text: '8. Räkenskapsår' },
    { kind: 'paragraph', text: `Aktiebolagets räkenskapsår är ${fiscalYearText(a.fiscalYearStartMonth)}.` },

    { kind: 'heading', text: '9. Ärenden på årsstämman' },
    { kind: 'paragraph', text: 'Årsstämman ska:' },
    { kind: 'list', items: ANNUAL_MEETING_ITEMS, ordered: true },

    { kind: 'heading', text: '10. Kallelse till bolagsstämma' },
    { kind: 'paragraph', text: noticeSentence(a) },
  ]

  return {
    slug: 'bolagsordning',
    title: `Bolagsordning för ${name}`,
    subtitle: subtitleFor(a, ctx),
    blocks,
  }
}
