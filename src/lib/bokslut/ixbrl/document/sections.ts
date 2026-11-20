/**
 * Sections the K2 and K3 iXBRL documents share: the hidden allmän
 * information, the title page with the fastställelseintyg, the
 * flerårsöversikt, the resultatdisposition, the notes and the signatures.
 * The concepts are the same in both taxonomies (se-gen-base, se-cd-base and
 * se-bol-base 2021-10-31/2020-12-01); where one is not in a registry, the
 * caller says so (a missing concept fails generation in the FactWriter).
 */

import { roundOre } from '@/lib/money'
import { certificateRole } from '../certificate-role'
import { getConcept, type TaxonomyRegistry } from '../taxonomy/registry'
import type { FlerarsRow, IxbrlArsredovisningInput, Resultatdisposition } from '../types'
import type { FactWriter } from './ix'
import { fmtRange, periodColumnLabel, type Ctx } from './layout'
import { renderRevisorspateckning } from './revisorspateckning-section'
import { el, escapeText, formatSekAbs, paragraphs } from './xml'

/**
 * Hidden allmän-information facts (TA §2.15, §3.9.3): språk, land, valuta,
 * the beloppsformat vallista where the taxonomy has it (K2; K3 dropped
 * BeloppsformatList), who presents the report, and the räkenskapsår's days.
 */
export function emitAllmanInformation(
  writer: FactWriter,
  input: IxbrlArsredovisningInput,
  opts: { beloppsformat: boolean },
): void {
  writer.hiddenEnum('SprakHandlingUpprattadList', 'period0', 'se-mem-base:SprakSvenskaMember')
  writer.hiddenEnum('LandForetagetsSateList', 'period0', 'se-mem-base:LandSverigeMember')
  writer.hiddenEnum(
    'RedovisningsvalutaHandlingList',
    'period0',
    'se-mem-base:ValutaSvenskaKronorMember',
  )
  if (opts.beloppsformat) {
    writer.hiddenEnum('BeloppsformatList', 'period0', 'se-mem-base:BeloppsformatNormalformMember')
  }
  writer.hiddenEnum(
    'FinansiellRapportList',
    'period0',
    input.underskrifter.harVd
      ? 'se-mem-base:FinansiellRapportStyrelsenVerkstallandeDirektorenAvgerArsredovisningMember'
      : 'se-mem-base:FinansiellRapportStyrelsenAvgerArsredovisningMember',
  )
  writer.hiddenDate('RakenskapsarForstaDag', 'period0', input.period.start)
  writer.hiddenDate('RakenskapsarSistaDag', 'period0', input.period.end)
}

const AMOUNTS_SENTENCE = 'Om inte annat särskilt anges, redovisas alla belopp i hela kronor (sek).'

/**
 * Title page: company identity, the report's title and the fastställelseintyg.
 * `matEnhet` tags the amounts sentence with se-cd-base:MatEnhet, the K3
 * allmän-information concept for the unit amounts are stated in (official
 * K3 example 3, 2021); K2 has no such concept and leaves it untagged.
 */
export function renderCoverPage(
  writer: FactWriter,
  input: IxbrlArsredovisningInput,
  orgNumber: string,
  opts: { matEnhet?: boolean } = {},
): string {
  const fb = input.faststallelseintyg
  // A missing AGM date renders as a visible placeholder: never today's
  // date. Preflight 1103 blocks the submission path until the date exists.
  const arsstammaFact =
    fb.arsstammaDatum !== null
      ? writer.date('Arsstamma', 'balans0', fb.arsstammaDatum)
      : escapeText('[datum för årsstämma saknas]')
  // The decision sentences are enumerations in the schema: the stämma
  // decides on a "vinstdisposition" when the free equity at its disposal is
  // positive and on the "behandling av ansamlad förlust" when it is negative.
  const dispositionObject =
    input.forvaltningsberattelse.resultatdisposition.summa < 0
      ? 'behandling av ansamlad förlust'
      : 'vinstdisposition'
  const dispositionFact =
    fb.resultatdispositionOutcome === 'proposal_approved'
      ? writer.textPlain(
          'ArsstammaResultatDispositionGodkannaStyrelsensForslag',
          'balans0',
          `Årsstämman beslöt att godkänna styrelsens förslag till ${dispositionObject}.`,
        )
      : fb.resultatdispositionOutcome === 'alternative_decision'
        ? writer.textPlain(
            'ArsstammaResultatDispositionInteGodkannaStyrelsensForslag',
            'balans0',
            `Årsstämman beslöt att inte godkänna styrelsens förslag till ${dispositionObject}.`,
          ) +
          '<br/>' +
          writer.textPlain(
            'ArsstammaResultatDispositionBeslutstext',
            'balans0',
            fb.resultatdispositionDecision ?? '[årsstämmans beslut saknas]',
          )
        : escapeText('[årsstämmans beslut om resultatdisposition saknas]')
  const fi = el(
    'div',
    { class: 'ar-cert', id: 'id-innehall-faststallelseintyg' },
    [
      el('h3', {}, 'Fastställelseintyg'),
      el(
        'p',
        {},
        writer.textHtml(
          'ArsstammaIntygande',
          'balans0',
          writer.textPlain(
            'FaststallelseResultatBalansrakning',
            'balans0',
            'Jag intygar att resultaträkningen och balansräkningen har fastställts på årsstämma',
          ) +
            ' ' +
            arsstammaFact +
            // The space keeps the two sentences apart in the XBRL value,
            // which drops the <br/> (the official example reads "… 2017-03-21.
            // Årsstämman beslöt …").
            '. <br/>' +
            dispositionFact,
          { continuedAt: 'intygande_forts' },
        ),
      ),
      // The space inside ix:continuation keeps the sentences separated in
      // the transformed XBRL value (same trick as the official example).
      el(
        'p',
        {},
        el(
          'ix:continuation',
          { id: 'intygande_forts' },
          ' ' +
            writer.textPlain(
              'IntygandeOriginalInnehall',
              'balans0',
              'Jag intygar att innehållet i dessa elektroniska handlingar överensstämmer med originalen och att originalen undertecknats av samtliga personer som enligt lag ska underteckna dessa.',
            ),
        ),
      ),
      el(
        'p',
        {},
        `<strong>${writer.textPlain(
          'UnderskriftFaststallelseintygElektroniskt',
          'balans0',
          'Elektroniskt underskriven av',
        )}:</strong><br/>` +
          writer.textPlain(
            'UnderskriftFaststallelseintygForetradareTilltalsnamn',
            'period0',
            fb.signerFirstName,
          ) +
          ' ' +
          writer.textPlain(
            'UnderskriftFaststallelseintygForetradareEfternamn',
            'period0',
            fb.signerLastName,
          ) +
          ', ' +
          writer.textPlain(
            'UnderskriftFaststallelseintygForetradareForetradarroll',
            'period0',
            certificateRole(fb.signerRole),
          ) +
          '<br/>' +
          writer.date('UnderskriftFastallelseintygDatum', 'balans0', fb.genereratDatum, {
            id: 'ID_DATUM_UNDERTECKNANDE_FASTSTALLELSEINTYG',
          }),
      ),
    ].join('\n'),
  )

  // Säte as on the PDF's cover ("Säte: X"), tagged: all of Allmän
  // information MUST be tagged (TA §2.9.2).
  const sate = input.company.registeredOffice?.trim()
  return [
    el(
      'p',
      {},
      writer.textPlain('ForetagetsNamn', 'period0', input.company.name) +
        '<br/><abbr>Org.nr</abbr> ' +
        writer.textPlain('Organisationsnummer', 'period0', orgNumber) +
        (sate ? '<br/>Säte: ' + writer.textPlain('ForetagetsSate', 'period0', sate) : ''),
    ),
    el('h1', {}, `Årsredovisning för räkenskapsåret ${escapeText(fmtRange(input.period.start, input.period.end))}`),
    el(
      'p',
      {},
      input.underskrifter.harVd
        ? 'Styrelsen och verkställande direktören avger följande årsredovisning.'
        : 'Styrelsen avger följande årsredovisning.',
    ),
    // Comparatives sit in their own column, never in parentheses, so
    // the example's "Uppgifter inom parentes avser föregående år" would
    // describe a layout this document does not have.
    el(
      'p',
      {},
      opts.matEnhet
        ? writer.textPlain('MatEnhet', 'period0', AMOUNTS_SENTENCE)
        : AMOUNTS_SENTENCE,
    ),
    fi,
  ].join('\n')
}

/**
 * Flerårsöversikt: column per year; whole SEK everywhere keeps repeated
 * facts trivially consistent across scales (TA §2.7.3). Empty when there
 * are no rows.
 */
export function renderFlerarsoversikt(writer: FactWriter, rows: FlerarsRow[]): string {
  if (rows.length === 0) return ''
  const header = el(
    'tr',
    {},
    el('th', {}, 'Flerårsöversikt (kr)') +
      rows.map((row) => el('th', { class: 'num' }, escapeText(row.year))).join(''),
  )
  const factCtx = (index: number, kind: 'period' | 'balans'): string | null => {
    const id = `${kind}${index}`
    return writer.hasContext(id) ? id : null
  }
  const rowFor = (
    label: string,
    emit: (ctxId: string, index: number) => string,
    kind: 'period' | 'balans',
  ): string =>
    el(
      'tr',
      {},
      el('th', {}, escapeText(label)) +
        rows
          .map((_, index) => {
            const ctxId = factCtx(index, kind)
            return el('td', { class: 'num' }, ctxId ? emit(ctxId, index) : '')
          })
          .join(''),
    )
  return el(
    'table',
    {},
    header +
      rowFor(
        'Nettoomsättning',
        (ctxId, index) => writer.money('Nettoomsattning', ctxId, rows[index].nettoomsattning),
        'period',
      ) +
      rowFor(
        'Resultat efter finansiella poster',
        (ctxId, index) =>
          writer.money('ResultatEfterFinansiellaPoster', ctxId, rows[index].resultatEfterFinansiellaPoster),
        'period',
      ) +
      rowFor(
        'Soliditet (%)',
        (ctxId, index) => {
          const value = rows[index].soliditetPct
          return value === null ? '' : writer.percent('Soliditet', ctxId, value)
        },
        'balans',
      ),
  )
}

/**
 * Resultatdisposition. BalanseratResultat/AretsResultatEgetKapital/
 * Overkursfond are repeated from the BR in the same balans0 context, so the
 * values MUST be byte-identical (TA §2.7.3): fri överkursfond gets its own
 * row tagged with its own concept instead of being folded into balanserat
 * resultat.
 */
export function renderResultatdisposition(writer: FactWriter, rd: Resultatdisposition): string[] {
  const rdRows: string[] = [
    el(
      'tr',
      {},
      el('th', {}, 'Till årsstämmans förfogande står följande medel (kr)') +
        el('th', { class: 'num' }, ''),
    ),
  ]
  if (rd.overkursfond !== 0) {
    rdRows.push(
      el(
        'tr',
        {},
        el('th', {}, 'Överkursfond') +
          el('td', { class: 'num' }, writer.money('Overkursfond', 'balans0', rd.overkursfond)),
      ),
    )
  }
  rdRows.push(
    el(
      'tr',
      {},
      el('th', {}, 'Balanserat resultat') +
        el('td', { class: 'num' }, writer.money('BalanseratResultat', 'balans0', rd.balanseratResultat)),
    ),
    el(
      'tr',
      {},
      el('th', {}, 'Årets resultat') +
        el('td', { class: 'num' }, writer.money('AretsResultatEgetKapital', 'balans0', rd.aretsResultat)),
    ),
    el(
      'tr',
      { class: 'subtotal' },
      el('th', {}, 'Summa') +
        el('td', { class: 'num' }, writer.money('FrittEgetKapital', 'balans0', rd.summa)),
    ),
    el(
      'tr',
      {},
      el('th', {}, 'Styrelsen föreslår att medlen disponeras så att') +
        el('th', { class: 'num' }, ''),
    ),
  )
  if (rd.utdelning !== 0) {
    rdRows.push(
      el(
        'tr',
        {},
        el('th', {}, 'till aktieägarna utdelas') +
          el(
            'td',
            { class: 'num' },
            writer.money('ForslagDispositionUtdelning', 'balans0', rd.utdelning),
          ),
      ),
    )
  }
  rdRows.push(
    el(
      'tr',
      {},
      el('th', {}, 'i ny räkning balanseras') +
        el(
          'td',
          { class: 'num' },
          writer.money('ForslagDispositionBalanserasINyRakning', 'balans0', rd.balanserasINyRakning),
        ),
    ),
    el(
      'tr',
      { class: 'subtotal' },
      el('th', {}, 'Summa') +
        el('td', { class: 'num' }, writer.money('ForslagDisposition', 'balans0', rd.summa)),
    ),
  )
  const parts = [el('h3', {}, 'Resultatdisposition'), el('table', {}, rdRows.join(''))]
  if (rd.kommentar && rd.kommentar.trim().length > 0) {
    parts.push(
      writer.textHtml('DispositionerVinstForlustKommentar', 'balans0', paragraphs(rd.kommentar)),
    )
  }
  return parts
}

/**
 * Notes. Only the facts the taxonomy defines are tagged (principles,
 * medelantal anställda, the ÅRL 5 kap. disclosures, aktiekapital); every
 * other note body is rendered untagged. A concept the registry does not
 * hold leaves its note untagged instead of failing the document.
 */
export function renderNotes(
  writer: FactWriter,
  registry: TaxonomyRegistry,
  input: IxbrlArsredovisningInput,
  ctx: Ctx,
  warnings: string[],
): string {
  const has = (concept: string) => getConcept(registry, concept) !== null
  const parts: string[] = [el('h2', {}, 'Noter')]
  for (const note of input.noter) {
    parts.push(
      el(
        'h3',
        { id: `not-${note.number}` },
        `Not ${note.number} ${escapeText(note.title)}`,
      ),
    )
    const isPrinciples = /redovisnings.*principer/i.test(note.title)
    const isMedelantal = /medelantal.*anst/i.test(note.title)
    const isLongTermDebt = /långfristiga skulder/i.test(note.title)
    const isSecurities = /ställda säkerheter/i.test(note.title)
    const isContingencies = /eventualförpliktelser/i.test(note.title)
    const isParentCompany = /koncernförhållanden/i.test(note.title)
    const isAktiekapital = /^aktiekapital$/i.test(note.title.trim())
    const aktiekapitalNot = input.disclosures.aktiekapitalNot ?? null
    if (isAktiekapital && aktiekapitalNot) {
      // Same sentence as the PDF note (build-data.ts), with the registered
      // amount tagged: it repeats the BR fact Aktiekapital@balans0, and
      // repeated data MUST be tagged everywhere it appears (TA §2.7.2) with
      // an identical value (TA §2.7.3). When the books disagree with the
      // registered amount the note stays untagged and the user is told.
      const { aktiekapital, antalAktier } = aktiekapitalNot
      const brAktiekapital = input.br['Aktiekapital']?.current ?? null
      const amount =
        brAktiekapital === aktiekapital
          ? writer.money('Aktiekapital', 'balans0', aktiekapital)
          : escapeText(formatSekAbs(aktiekapital))
      if (brAktiekapital !== aktiekapital) {
        warnings.push(
          `Aktiekapitalet i noten (${aktiekapital} kr) skiljer sig från aktiekapitalet i balansräkningen (${brAktiekapital ?? 0} kr): stäm av konto 2081 mot registrerat aktiekapital innan inlämning.`,
        )
      }
      parts.push(
        el(
          'p',
          {},
          `Aktiekapital: ${amount} kr. Antal aktier: ${escapeText(
            antalAktier.toLocaleString('sv-SE'),
          )}. Kvotvärde per aktie: ${escapeText(
            roundOre(aktiekapital / antalAktier).toLocaleString('sv-SE'),
          )} kr.`,
        ),
      )
    } else if (isPrinciples && has('RedovisningsVarderingsprinciper')) {
      parts.push(
        writer.textHtml('RedovisningsVarderingsprinciper', 'period0', paragraphs(note.body)),
      )
    } else if (isMedelantal) {
      // Render the FTE figure as tagged facts (TA §2.14) for both years.
      const medel = input.medelantalAnstallda
      parts.push(
        el(
          'table',
          {},
          el(
            'tr',
            {},
            el('th', {}, '') +
              el('th', { class: 'num' }, escapeText(periodColumnLabel(input.period))) +
              el(
                'th',
                { class: 'num' },
                input.previousPeriod ? escapeText(periodColumnLabel(input.previousPeriod)) : '',
              ),
          ) +
            el(
              'tr',
              {},
              el('th', {}, 'Medelantal anställda') +
                el(
                  'td',
                  { class: 'num' },
                  writer.antalAnstallda('MedelantaletAnstallda', 'period0', medel.current),
                ) +
                el(
                  'td',
                  { class: 'num' },
                  ctx.period1 && medel.previous !== null
                    ? writer.antalAnstallda('MedelantaletAnstallda', ctx.period1, medel.previous)
                    : '',
                ),
            ),
        ),
      )
    } else if (isLongTermDebt && has('LangfristigaSkulderForfallerSenare5Ar')) {
      parts.push(
        paragraphs(note.body) +
          el(
            'p',
            { class: 'note-fact' },
            'Belopp som förfaller senare än fem år efter balansdagen: ' +
              writer.money(
                'LangfristigaSkulderForfallerSenare5Ar',
                'balans0',
                input.disclosures.longTermDebtOverFiveYears,
              ) +
              ' kr.',
          ),
      )
    } else if (isSecurities && has('NotStalldaSakerheter')) {
      parts.push(
        writer.textPlain(
          'NotStalldaSakerheter',
          'balans0',
          input.disclosures.securitiesPledged,
        ),
      )
    } else if (isContingencies && has('NotEventualforpliktelser')) {
      parts.push(
        writer.textPlain(
          'NotEventualforpliktelser',
          'balans0',
          input.disclosures.contingentLiabilities,
        ),
      )
    } else if (isParentCompany && input.disclosures.parentCompany && has('NotUpplysningModerforetag')) {
      parts.push(
        writer.textPlain('NotUpplysningModerforetag', 'period0', input.disclosures.parentCompany),
      )
    } else {
      parts.push(paragraphs(note.body))
    }
  }
  return parts.join('\n')
}

/**
 * Underskrifter: ort and datering, one UnderskriftArsredovisningForetradareTuple
 * per board signer with their own date (TA §2.9.1), then the revisor's
 * påteckning.
 */
export function renderSignatures(
  writer: FactWriter,
  registry: TaxonomyRegistry,
  input: IxbrlArsredovisningInput,
): string {
  const u = input.underskrifter
  const parts: string[] = [el('h2', {}, 'Underskrifter')]
  const ortFact = getConcept(registry, 'UndertecknandeArsredovisningOrt')
    ? writer.textPlain('UndertecknandeArsredovisningOrt', 'period0', u.ort)
    : escapeText(u.ort)
  // Datering av årsredovisning is reinstated for fiscal years beginning
  // 2024-07-01 or later (element-list note on UndertecknandeArsredovisningDatum);
  // TA §2.9.3 forbade it for earlier years.
  const tagDatering = u.dateringsdatum !== null && input.period.start >= '2024-07-01'
  parts.push(
    el(
      'p',
      {},
      ortFact + (tagDatering && u.dateringsdatum
        ? ' den ' + writer.date('UndertecknandeArsredovisningDatum', 'period0', u.dateringsdatum)
        : ''),
    ),
  )
  const tupleMembers = registry.tuples['UnderskriftArsredovisningForetradareTuple']?.members ?? []
  const orderOf = (member: string): string => {
    const index = tupleMembers.findIndex((m) => m.name === member)
    return `${(index === -1 ? 0 : index) + 1}.0`
  }
  const tupleDecls: string[] = []
  const signerDivs: string[] = []
  input.underskrifter.signers.forEach((signer) => {
    const tupleId = writer.declareTupleId('UnderskriftArsredovisningForetradareTuple')
    tupleDecls.push(writer.tupleDeclaration('UnderskriftArsredovisningForetradareTuple', tupleId))
    const fullName = `${signer.firstName} ${signer.lastName}`.trim()
    const inner: string[] = [
      el('span', { class: 'sig' }, escapeText(fullName)),
      '<br/>',
      writer.textPlain('UnderskriftHandlingTilltalsnamn', 'period0', signer.firstName, {
        tupleRef: tupleId,
        order: orderOf('UnderskriftHandlingTilltalsnamn'),
      }),
      ' ',
      writer.textPlain('UnderskriftHandlingEfternamn', 'period0', signer.lastName, {
        tupleRef: tupleId,
        order: orderOf('UnderskriftHandlingEfternamn'),
      }),
    ]
    if (signer.role) {
      inner.push(
        '<br/>',
        writer.textPlain('UnderskriftHandlingRoll', 'period0', signer.role, {
          tupleRef: tupleId,
          order: orderOf('UnderskriftHandlingRoll'),
        }),
      )
    }
    // Per-signer date: mandatory for FY ending 2021-12-31+ (TA §2.9.1,
    // kontrollera 1107/1214). An unsigned request has signedDate null: the
    // fact is omitted (never fabricated) and preflight 1214 blocks filing.
    if (signer.signedDate !== null) {
      inner.push(
        '<br/>',
        writer.date('UndertecknandeDatum', 'period0', signer.signedDate, {
          tupleRef: tupleId,
          order: orderOf('UndertecknandeDatum'),
        }),
      )
    }
    signerDivs.push(el('div', { class: 'ar-sign-name' }, inner.join('')))
  })
  parts.push(tupleDecls.join('\n'), signerDivs.join('\n'))
  // The revisor's hänvisning to the revisionsberättelse (ABL 9 kap. 28 §).
  const pateckning = renderRevisorspateckning(writer, registry, input.revisorspateckning, 'period0')
  if (pateckning) parts.push(pateckning)
  return parts.join('\n')
}
