/**
 * The revisorspåteckning block of the iXBRL signature section, shared by the
 * K2 and K3 documents (both taxonomies define the same fsign concepts). What
 * it says and why: lib/bokslut/ixbrl/revisorspateckning.ts.
 *
 * Layout, after the board's signatures:
 *   Revisorspåteckning
 *   Min (Vår) revisionsberättelse har lämnats <datum>.     (tagged date)
 *   Jag (Vi) har i denna avstyrkt att … fastställs.        (vallista, hidden)
 *   <Revisionsbolag AB>                                     (ValtRevisionsbolagsnamn)
 *   <namn> / <titel>, one per revisor                       (UnderskriftRevisorspateckningTuple)
 */

import type { TaxonomyRegistry } from '../taxonomy/registry'
import {
  AUDITOR_OPINION_DEFINITIONS,
  pateckningDatum,
  pateckningLead,
  pateckningMening,
  type IxbrlRevisorspateckning,
} from '../revisorspateckning'
import type { FactWriter } from './ix'
import { el, escapeText } from './xml'

const TUPLE = 'UnderskriftRevisorspateckningTuple'

/**
 * Render the påteckning, or '' when there is none. `contextRef` is the
 * duration context of the räkenskapsår (period0): every fsign concept is a
 * duration concept.
 */
export function renderRevisorspateckning(
  writer: FactWriter,
  registry: TaxonomyRegistry,
  pateckning: IxbrlRevisorspateckning | null | undefined,
  contextRef: string,
): string {
  if (!pateckning || pateckning.revisorer.length === 0) return ''
  const revisorCount = pateckning.revisorer.length
  const datum = pateckningDatum(pateckning.revisorer)
  const definition = pateckning.opinion ? AUDITOR_OPINION_DEFINITIONS[pateckning.opinion] : null
  // Without an answered opinion nothing is tagged: guessing "utan
  // modifierade uttalanden" would file a statement the revisor never made.
  // Preflight ACC-REVISOR-OPINION blocks the submission until it is answered.
  const dateConcept = definition
    ? definition.modified
      ? 'RevisorspateckningRevisionsberattelseAvvikerStandardutformning'
      : 'RevisorspateckningRevisionsberattelseEnligtStandardutformning'
    : null
  const dateText =
    datum === null
      ? escapeText('[datum saknas]')
      : dateConcept
        ? writer.date(dateConcept, contextRef, datum)
        : escapeText(datum)

  const parts: string[] = [
    el('h3', {}, 'Revisorspåteckning'),
    el('p', {}, `${escapeText(pateckningLead(revisorCount, Boolean(pateckning.revisionsbolag)))} ${dateText}.`),
  ]
  const mening = pateckningMening(pateckning.opinion, revisorCount, Boolean(pateckning.revisionsbolag))
  if (mening && definition?.member) {
    writer.hiddenEnum(
      'RevisorspateckningRevisionsberattelseAvstyrktResultatrakningenBalansrakningenList',
      contextRef,
      `se-mem-base:${definition.member}`,
    )
    parts.push(el('p', {}, escapeText(mening)))
  }
  if (pateckning.revisionsbolag) {
    parts.push(el('p', {}, writer.textPlain('ValtRevisionsbolagsnamn', contextRef, pateckning.revisionsbolag)))
  }

  const members = registry.tuples[TUPLE]?.members ?? []
  const orderOf = (member: string): string => {
    const index = members.findIndex((m) => m.name === member)
    return `${(index === -1 ? 0 : index) + 1}.0`
  }
  const tupleDecls: string[] = []
  const revisorDivs: string[] = []
  for (const revisor of pateckning.revisorer) {
    const tupleId = writer.declareTupleId(TUPLE)
    tupleDecls.push(writer.tupleDeclaration(TUPLE, tupleId))
    const fullName = `${revisor.firstName} ${revisor.lastName}`.trim()
    const inner: string[] = [
      el('span', { class: 'sig' }, escapeText(fullName)),
      '<br/>',
      writer.textPlain('UnderskriftHandlingTilltalsnamn', contextRef, revisor.firstName, {
        tupleRef: tupleId,
        order: orderOf('UnderskriftHandlingTilltalsnamn'),
      }),
      ' ',
      writer.textPlain('UnderskriftHandlingEfternamn', contextRef, revisor.lastName, {
        tupleRef: tupleId,
        order: orderOf('UnderskriftHandlingEfternamn'),
      }),
      '<br/>',
      writer.textPlain('UnderskriftHandlingTitel', contextRef, revisor.titel, {
        tupleRef: tupleId,
        order: orderOf('UnderskriftHandlingTitel'),
      }),
    ]
    if (revisor.huvudansvarig !== null) {
      writer.hiddenBoolean('UnderskriftRevisorspateckningRevisorHuvudansvarig', contextRef, revisor.huvudansvarig, {
        tupleRef: tupleId,
        order: orderOf('UnderskriftRevisorspateckningRevisorHuvudansvarig'),
      })
    }
    revisorDivs.push(el('div', { class: 'ar-sign-name' }, inner.join('')))
  }
  parts.push(tupleDecls.join('\n'), revisorDivs.join('\n'))
  return parts.join('\n')
}
