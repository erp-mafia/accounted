/**
 * K2 AB årsredovisning → iXBRL 1.1 XHTML document (entry point risbs).
 *
 * Layout and tagging follow the official example
 * dev_docs/bokslut/exempel/k2/faststalld-arsredovisning-exempel-1-*.xhtml and
 * TILLAMPNINGSANVISNING v1.8:
 *   - XHTML + UTF-8, no scripts/external refs, inline CSS gathered in <head>
 *   - contexts period0/period1/…, balans0/balans1/…; unit SEK
 *   - vallistor hidden in ix:hidden; räkenskapsårets dagar hidden
 *   - fastställelseintyg wrapped in id="id-innehall-faststallelseintyg"
 *     (kontrollsumma exclusion, TA §4.5.3) with the signing-date element
 *     carrying id="ID_DATUM_UNDERTECKNANDE_FASTSTALLELSEINTYG" (TA §4.4.2)
 *   - per-signer dates via UnderskriftArsredovisningForetradareTuple
 *     (TA §2.9.1)
 *   - presentational minus for cost rows lives OUTSIDE the fact element;
 *     `sign="-"` is reserved for values deviating from the concept's nature
 */

import { getEntryPoint } from '../taxonomy/entry-points'
import { getRegistry, getConcept } from '../taxonomy/registry'
import type { IxbrlArsredovisningInput, ConceptAmount } from '../types'
import { FactWriter } from './ix'
import { el, selfClosing, escapeText, escapeAttr, paragraphs, formatSekAbs } from './xml'

const CSS = `
body { font-family: 'Times New Roman', Times, serif; margin: 0 auto; max-width: 46em; color: #000; }
.ar-page { padding: 2em 2.5em; margin: 1em 0; border: 1px solid #eee; page-break-after: always; }
.ar-page-hdr { display: flex; justify-content: space-between; font-size: 80%; color: #333; border-bottom: 1px solid #999; margin-bottom: 1.5em; padding-bottom: 0.25em; }
h1 { font-size: 160%; margin: 0 0 0.5em; }
h2 { font-size: 125%; margin: 1.5em 0 0.5em; }
h3 { font-size: 105%; margin: 1.2em 0 0.4em; }
h4 { font-size: 100%; font-style: italic; font-weight: normal; margin: 1em 0 0.3em; }
p { margin: 0 0 0.8em; line-height: 1.35; }
table { width: 100%; border-collapse: collapse; margin: 0 0 1.2em; }
th, td { text-align: left; vertical-align: bottom; padding: 0.15em 0.4em 0.15em 0; font-size: 95%; }
th.num, td.num { text-align: right; white-space: nowrap; }
tr.subtotal th, tr.subtotal td { border-top: 1px solid #000; font-weight: bold; }
tr.total th, tr.total td { border-top: 1px solid #000; border-bottom: 3px double #000; font-weight: bold; }
tr.section th { font-weight: bold; padding-top: 0.8em; }
tr.subsection th { font-style: italic; }
.ar-cert { border: 1px solid #000; padding: 1em 1.25em; margin: 1.5em 0; }
.ar-sign-name { margin-top: 2.2em; }
.ar-sign-name .sig { font-style: italic; }
@media print { .ar-page { border: none; margin: 0; } }
`.trim()

interface Ctx {
  period0: string
  period1: string | null
  balans0: string
  balans1: string | null
}

function fmtRange(start: string, end: string): string {
  return `${start} till ${end}`
}

/** Two-amount row where the concept is tagged in both year columns. */
function moneyRow(
  writer: FactWriter,
  label: string,
  concept: string,
  amount: ConceptAmount | undefined,
  ctx: { current: string; previous: string | null },
  opts: { displayMinus?: boolean; rowClass?: string; indent?: boolean; alwaysShow?: boolean } = {},
): string {
  const current = amount?.current ?? 0
  const previous = amount?.previous ?? null
  if (!opts.alwaysShow && current === 0 && (previous === null || previous === 0)) return ''
  const cells = [
    el('th', { scope: 'row', style: opts.indent ? 'padding-left:1.2em' : null }, escapeText(label)),
    el(
      'td',
      { class: 'num' },
      writer.money(concept, ctx.current, current, { displayMinus: opts.displayMinus }),
    ),
    el(
      'td',
      { class: 'num' },
      previous === null || ctx.previous === null
        ? ''
        : writer.money(concept, ctx.previous, previous, { displayMinus: opts.displayMinus }),
    ),
  ]
  return el('tr', { class: opts.rowClass ?? null }, cells.join(''))
}

function sectionRow(label: string, cls: 'section' | 'subsection' = 'section'): string {
  return el('tr', { class: cls }, el('th', { colspan: '3' }, escapeText(label)))
}

function pageHeader(input: IxbrlArsredovisningInput, page: number, total: number): string {
  // el() treats its content argument as raw markup: build it exclusively
  // from escapeText() output joined with builder-emitted tags so no user
  // value can ever reach the string unescaped.
  const identity = [
    escapeText(input.company.name),
    selfClosing('br', {}),
    escapeText(input.company.orgNumber),
  ].join('')
  return el(
    'div',
    { class: 'ar-page-hdr' },
    el('span', {}, identity) + el('span', {}, `${page} (${total})`),
  )
}

export interface GeneratedIxbrl {
  xhtml: string
  warnings: string[]
}

export function generateK2IxbrlDocument(input: IxbrlArsredovisningInput): GeneratedIxbrl {
  const entryPoint = getEntryPoint(input.entryPointId)
  const registry = getRegistry(entryPoint.registryId)
  const writer = new FactWriter(entryPoint, registry, input.company.orgNumber)
  const warnings: string[] = [...input.warnings]

  // ---- contexts -----------------------------------------------------------
  writer.addDurationContext('period0', input.period.start, input.period.end)
  writer.addInstantContext('balans0', input.period.end)
  if (input.previousPeriod) {
    writer.addDurationContext('period1', input.previousPeriod.start, input.previousPeriod.end)
    writer.addInstantContext('balans1', input.previousPeriod.end)
  }
  // Flerårsöversikt reaches further back: register period2/3 + balans2/3 from
  // the explicit ranges build-input aligned with the rows (never derived from
  // row count: broken fiscal years would corrupt the contexts).
  input.forvaltningsberattelse.flerarsPerioder.forEach((range, index) => {
    if (index < 2) return // period0/period1 already registered
    writer.addDurationContext(`period${index}`, range.start, range.end)
    writer.addInstantContext(`balans${index}`, range.end)
  })
  const ctx: Ctx = {
    period0: 'period0',
    period1: input.previousPeriod ? 'period1' : null,
    balans0: 'balans0',
    balans1: input.previousPeriod ? 'balans1' : null,
  }
  const yearCtx = { current: ctx.period0, previous: ctx.period1 }
  const balCtx = { current: ctx.balans0, previous: ctx.balans1 }

  // ---- hidden allmän-information facts (TA §2.15, §3.9.3) ------------------
  writer.hiddenEnum('SprakHandlingUpprattadList', 'period0', 'se-mem-base:SprakSvenskaMember')
  writer.hiddenEnum('LandForetagetsSateList', 'period0', 'se-mem-base:LandSverigeMember')
  writer.hiddenEnum(
    'RedovisningsvalutaHandlingList',
    'period0',
    'se-mem-base:ValutaSvenskaKronorMember',
  )
  writer.hiddenEnum('BeloppsformatList', 'period0', 'se-mem-base:BeloppsformatNormalformMember')
  writer.hiddenEnum(
    'FinansiellRapportList',
    'period0',
    input.underskrifter.harVd
      ? 'se-mem-base:FinansiellRapportStyrelsenVerkstallandeDirektorenAvgerArsredovisningMember'
      : 'se-mem-base:FinansiellRapportStyrelsenAvgerArsredovisningMember',
  )
  writer.hiddenDate('RakenskapsarForstaDag', 'period0', input.period.start)
  writer.hiddenDate('RakenskapsarSistaDag', 'period0', input.period.end)
  // Note on TA §2.22 (status för taggning): the 2024-09-12 K2 AB taxonomy has
  // no tagging-status concept (verified against the generated registry and
  // the official example filings), so nothing is emitted even though note
  // bodies beyond Not 1/medelantal are rendered untagged.

  const totalPages = 6
  const pages: string[] = []

  // ====== Page 1: titel + innehåll + fastställelseintyg ======
  {
    const fb = input.faststallelseintyg
    // A missing AGM date renders as a visible placeholder: never today's
    // date. Preflight 1103 blocks the submission path until the date exists.
    const arsstammaFact =
      fb.arsstammaDatum !== null
        ? writer.date('Arsstamma', 'balans0', fb.arsstammaDatum)
        : escapeText('[datum för årsstämma saknas]')
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
              '.<br/>' +
              writer.textPlain(
                'ArsstammaResultatDispositionGodkannaStyrelsensForslag',
                'balans0',
                'Årsstämman beslöt att godkänna styrelsens förslag till resultatdisposition.',
              ),
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
              fb.signerRole,
            ) +
            '<br/>' +
            writer.date('UnderskriftFastallelseintygDatum', 'balans0', fb.genereratDatum, {
              id: 'ID_DATUM_UNDERTECKNANDE_FASTSTALLELSEINTYG',
            }),
        ),
      ].join('\n'),
    )

    pages.push(
      el(
        'div',
        { class: 'ar-page', id: 'ar-page-1' },
        [
          pageHeader(input, 1, totalPages),
          el(
            'p',
            {},
            writer.textPlain('ForetagetsNamn', 'period0', input.company.name) +
              '<br/><abbr>Org.nr</abbr> ' +
              writer.textPlain('Organisationsnummer', 'period0', input.company.orgNumber),
          ),
          el('h1', {}, `Årsredovisning för räkenskapsåret ${escapeText(fmtRange(input.period.start, input.period.end))}`),
          el(
            'p',
            {},
            input.underskrifter.harVd
              ? 'Styrelsen och verkställande direktören avger följande årsredovisning.'
              : 'Styrelsen avger följande årsredovisning.',
          ),
          el(
            'p',
            {},
            'Om inte annat särskilt anges, redovisas alla belopp i hela kronor (sek). Uppgifter inom parentes avser föregående år.',
          ),
          fi,
        ].join('\n'),
      ),
    )
  }

  // ====== Page 2: förvaltningsberättelse ======
  {
    const fb = input.forvaltningsberattelse
    const parts: string[] = [
      pageHeader(input, 2, totalPages),
      el('h2', {}, 'Förvaltningsberättelse'),
      el('h3', {}, 'Verksamheten'),
      el('h4', {}, 'Allmänt om verksamheten'),
      writer.textHtml('AllmantVerksamheten', 'period0', paragraphs(fb.allmantOmVerksamheten)),
      el('h4', {}, 'Väsentliga händelser under räkenskapsåret'),
      writer.textHtml(
        'VasentligaHandelserRakenskapsaret',
        'period0',
        paragraphs(fb.vasentligaHandelser),
      ),
    ]

    // Flerårsöversikt: column per year; whole SEK everywhere keeps repeated
    // facts trivially consistent across scales (TA §2.7.3).
    if (fb.flerarsoversikt.length > 0) {
      const header = el(
        'tr',
        {},
        el('th', {}, 'Flerårsöversikt (kr)') +
          fb.flerarsoversikt.map((row) => el('th', { class: 'num' }, escapeText(row.year))).join(''),
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
            fb.flerarsoversikt
              .map((_, index) => {
                const ctxId = factCtx(index, kind)
                return el('td', { class: 'num' }, ctxId ? emit(ctxId, index) : '')
              })
              .join(''),
        )
      parts.push(
        el(
          'table',
          {},
          header +
            rowFor(
              'Nettoomsättning',
              (ctxId, index) =>
                writer.money('Nettoomsattning', ctxId, fb.flerarsoversikt[index].nettoomsattning),
              'period',
            ) +
            rowFor(
              'Resultat efter finansiella poster',
              (ctxId, index) =>
                writer.money(
                  'ResultatEfterFinansiellaPoster',
                  ctxId,
                  fb.flerarsoversikt[index].resultatEfterFinansiellaPoster,
                ),
              'period',
            ) +
            rowFor(
              'Soliditet (%)',
              (ctxId, index) => {
                const value = fb.flerarsoversikt[index].soliditetPct
                return value === null ? '' : writer.percent('Soliditet', ctxId, value)
              },
              'balans',
            ),
        ),
      )
    }

    // Förändringar i eget kapital
    const ek = fb.egetKapital
    const hasOvriga = ek.ovrigaPoster.ib !== 0 || ek.ovrigaPoster.ub !== 0
    if (hasOvriga) {
      warnings.push(
        'Eget kapital innehåller poster utöver aktiekapital/balanserat resultat/årets resultat (t.ex. reservfond eller överkursfond). Kolumnen "Övriga poster" i förändringstabellen är inte XBRL-taggad: granska innan inlämning.',
      )
    }
    const ekHead = el(
      'tr',
      {},
      el('th', {}, 'Förändringar i eget kapital') +
        el('th', { class: 'num' }, 'Aktiekapital') +
        (hasOvriga ? el('th', { class: 'num' }, 'Övriga poster') : '') +
        el('th', { class: 'num' }, 'Balanserat resultat') +
        el('th', { class: 'num' }, 'Årets resultat') +
        el('th', { class: 'num' }, 'Totalt'),
    )
    const ekRows: string[] = [ekHead]
    const td = (content: string): string => el('td', { class: 'num' }, content)
    // Untagged residual cells: plain text, but with the same sign handling as
    // the other untagged rows (negative renders with a minus).
    const signedSek = (value: number): string =>
      escapeText(`${value < 0 ? '−' : ''}${formatSekAbs(value)}`)
    const ibCells = [
      writer.money('Aktiekapital', ctx.balans1 ?? ctx.balans0, ek.aktiekapital.ib),
      ...(hasOvriga ? [signedSek(ek.ovrigaPoster.ib)] : []),
      writer.money('BalanseratResultat', ctx.balans1 ?? ctx.balans0, ek.balanseratResultat.ib),
      writer.money('AretsResultatEgetKapital', ctx.balans1 ?? ctx.balans0, ek.aretsResultat.ib),
      writer.money('EgetKapital', ctx.balans1 ?? ctx.balans0, ek.totalt.ib),
    ]
    if (ctx.balans1) {
      ekRows.push(
        el('tr', {}, el('th', {}, 'Belopp vid årets ingång') + ibCells.map(td).join('')),
      )
    }
    if (ek.balanserasINyRakning !== 0) {
      ekRows.push(
        el(
          'tr',
          {},
          el('th', {}, 'Balanseras i ny räkning') +
            td('') +
            (hasOvriga ? td('') : '') +
            td(
              writer.money(
                'ForandringEgetKapitalBalanseratResultatBalanserasNyRakning',
                'period0',
                ek.balanserasINyRakning,
              ),
            ) +
            td(
              writer.money(
                'ForandringEgetKapitalAretsResultatBalanserasNyRakning',
                'period0',
                ek.balanserasINyRakning,
                { displayMinus: true },
              ),
            ) +
            td(''),
        ),
      )
    }
    if (ek.utdelning !== 0) {
      ekRows.push(
        el(
          'tr',
          {},
          el('th', {}, 'Utdelning') +
            td('') +
            (hasOvriga ? td('') : '') +
            td(
              writer.money('ForandringEgetKapitalBalanseratResultatUtdelning', 'period0', ek.utdelning, {
                displayMinus: true,
              }),
            ) +
            td('') +
            td(
              writer.money('ForandringEgetKapitalTotaltUtdelning', 'period0', ek.utdelning, {
                displayMinus: true,
              }),
            ),
        ),
      )
    }
    if (ek.forandringAktiekapital !== 0) {
      ekRows.push(
        el(
          'tr',
          {},
          el('th', {}, 'Nyemission') +
            td(
              writer.money(
                'ForandringEgetKapitalAktiekapitalNyemission',
                'period0',
                ek.forandringAktiekapital,
              ),
            ) +
            (hasOvriga ? td('') : '') +
            td('') +
            td('') +
            td(
              writer.money(
                'ForandringEgetKapitalTotaltNyemission',
                'period0',
                ek.forandringAktiekapital,
              ),
            ),
        ),
      )
    }
    if (ek.ovrigForandringBalanserat !== 0) {
      warnings.push(
        `Förändringen av balanserat resultat innehåller en post om ${ek.ovrigForandringBalanserat} kr som inte kan härledas till utdelning eller balansering: raden "Övrig förändring" är otaggad, granska den.`,
      )
      ekRows.push(
        el(
          'tr',
          {},
          el('th', {}, 'Övrig förändring') +
            td('') +
            (hasOvriga ? td('') : '') +
            td(signedSek(ek.ovrigForandringBalanserat)) +
            td('') +
            td(signedSek(ek.ovrigForandringBalanserat)),
        ),
      )
    }
    if (hasOvriga && ek.ovrigaPoster.ib !== ek.ovrigaPoster.ub) {
      ekRows.push(
        el(
          'tr',
          {},
          el('th', {}, 'Förändring övriga poster') +
            td('') +
            td(signedSek(ek.ovrigaPoster.ub - ek.ovrigaPoster.ib)) +
            td('') +
            td('') +
            td(''),
        ),
      )
    }
    ekRows.push(
      el(
        'tr',
        {},
        el('th', {}, 'Årets resultat') +
          td('') +
          (hasOvriga ? td('') : '') +
          td('') +
          td(
            writer.money(
              'ForandringEgetKapitalAretsResultatAretsResultat',
              'period0',
              ek.aretsResultatRorelse,
            ),
          ) +
          td(
            writer.money('ForandringEgetKapitalTotaltAretsResultat', 'period0', ek.aretsResultatRorelse),
          ),
      ),
    )
    const ubCells = [
      writer.money('Aktiekapital', 'balans0', ek.aktiekapital.ub),
      ...(hasOvriga ? [signedSek(ek.ovrigaPoster.ub)] : []),
      writer.money('BalanseratResultat', 'balans0', ek.balanseratResultat.ub),
      writer.money('AretsResultatEgetKapital', 'balans0', ek.aretsResultat.ub),
      writer.money('EgetKapital', 'balans0', ek.totalt.ub),
    ]
    ekRows.push(
      el(
        'tr',
        { class: 'subtotal' },
        el('th', {}, 'Belopp vid årets utgång') + ubCells.map(td).join(''),
      ),
    )
    parts.push(el('table', {}, ekRows.join('')))

    // Resultatdisposition. BalanseratResultat/AretsResultatEgetKapital/
    // Overkursfond are repeated from the BR in the same balans0 context, so
    // the values MUST be byte-identical (TA §2.7.3): fri överkursfond gets
    // its own row tagged with its own concept instead of being folded into
    // balanserat resultat.
    const rd = fb.resultatdisposition
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
    parts.push(el('h3', {}, 'Resultatdisposition'), el('table', {}, rdRows.join('')))
    if (rd.kommentar && rd.kommentar.trim().length > 0) {
      parts.push(
        writer.textHtml('DispositionerVinstForlustKommentar', 'balans0', paragraphs(rd.kommentar)),
      )
    }

    pages.push(el('div', { class: 'ar-page', id: 'ar-page-2' }, parts.join('\n')))
  }

  // ====== Page 3: resultaträkning ======
  {
    const rr = input.rr
    const totals = input.totals
    const head = el(
      'tr',
      {},
      el('th', {}, 'Resultaträkning (kr)') +
        el('th', { class: 'num' }, escapeText(fmtRange(input.period.start, input.period.end))) +
        el(
          'th',
          { class: 'num' },
          input.previousPeriod
            ? escapeText(fmtRange(input.previousPeriod.start, input.previousPeriod.end))
            : '',
        ),
    )
    const rows: string[] = [head]
    rows.push(sectionRow('Rörelseintäkter, lagerförändringar m.m.'))
    rows.push(
      moneyRow(writer, 'Nettoomsättning', 'Nettoomsattning', rr['Nettoomsattning'], yearCtx, {
        indent: true,
        alwaysShow: true,
      }),
      moneyRow(
        writer,
        'Förändring av lager av produkter i arbete, färdiga varor och pågående arbete för annans räkning',
        'ForandringLagerProdukterIArbeteFardigaVarorPagaendeArbetenAnnansRakning',
        rr['ForandringLagerProdukterIArbeteFardigaVarorPagaendeArbetenAnnansRakning'],
        yearCtx,
        { indent: true },
      ),
      moneyRow(
        writer,
        'Aktiverat arbete för egen räkning',
        'AktiveratArbeteEgenRakning',
        rr['AktiveratArbeteEgenRakning'],
        yearCtx,
        { indent: true },
      ),
      moneyRow(
        writer,
        'Övriga rörelseintäkter',
        'OvrigaRorelseintakter',
        rr['OvrigaRorelseintakter'],
        yearCtx,
        { indent: true },
      ),
      moneyRow(
        writer,
        'Summa rörelseintäkter, lagerförändringar m.m.',
        'RorelseintakterLagerforandringarMm',
        totals.rorelseintakter,
        yearCtx,
        { rowClass: 'subtotal', alwaysShow: true },
      ),
    )
    rows.push(sectionRow('Rörelsekostnader'))
    const costRow = (label: string, concept: string): string =>
      moneyRow(writer, label, concept, rr[concept], yearCtx, { indent: true, displayMinus: true })
    rows.push(
      costRow('Råvaror och förnödenheter', 'RavarorFornodenheterKostnader'),
      costRow('Handelsvaror', 'HandelsvarorKostnader'),
      costRow('Övriga externa kostnader', 'OvrigaExternaKostnader'),
      costRow('Personalkostnader', 'Personalkostnader'),
      costRow(
        'Av- och nedskrivningar av materiella och immateriella anläggningstillgångar',
        'AvskrivningarNedskrivningarMateriellaImmateriellaAnlaggningstillgangar',
      ),
      costRow(
        'Nedskrivningar av omsättningstillgångar utöver normala nedskrivningar',
        'NedskrivningarOmsattningstillgangarUtoverNormalaNedskrivningar',
      ),
      costRow('Övriga rörelsekostnader', 'OvrigaRorelsekostnader'),
      moneyRow(writer, 'Summa rörelsekostnader', 'Rorelsekostnader', totals.rorelsekostnader, yearCtx, {
        rowClass: 'subtotal',
        displayMinus: true,
        alwaysShow: true,
      }),
      moneyRow(writer, 'Rörelseresultat', 'Rorelseresultat', totals.rorelseresultat, yearCtx, {
        rowClass: 'subtotal',
        alwaysShow: true,
      }),
    )
    rows.push(sectionRow('Finansiella poster'))
    rows.push(
      moneyRow(
        writer,
        'Resultat från andelar i koncernföretag',
        'ResultatAndelarKoncernforetag',
        rr['ResultatAndelarKoncernforetag'],
        yearCtx,
        { indent: true },
      ),
      moneyRow(
        writer,
        'Resultat från andelar i intresseföretag och gemensamt styrda företag',
        'ResultatAndelarIntresseforetagGemensamtStyrda',
        rr['ResultatAndelarIntresseforetagGemensamtStyrda'],
        yearCtx,
        { indent: true },
      ),
      moneyRow(
        writer,
        'Resultat från övriga företag som det finns ett ägarintresse i',
        'ResultatOvrigaforetagAgarintresse',
        rr['ResultatOvrigaforetagAgarintresse'],
        yearCtx,
        { indent: true },
      ),
      moneyRow(
        writer,
        'Resultat från övriga finansiella anläggningstillgångar',
        'ResultatOvrigaFinansiellaAnlaggningstillgangar',
        rr['ResultatOvrigaFinansiellaAnlaggningstillgangar'],
        yearCtx,
        { indent: true },
      ),
      moneyRow(
        writer,
        'Övriga ränteintäkter och liknande resultatposter',
        'OvrigaRanteintakterLiknandeResultatposter',
        rr['OvrigaRanteintakterLiknandeResultatposter'],
        yearCtx,
        { indent: true },
      ),
      moneyRow(
        writer,
        'Nedskrivningar av finansiella anläggningstillgångar och kortfristiga placeringar',
        'NedskrivningarFinansiellaAnlaggningstillgangarKortfristigaPlaceringar',
        rr['NedskrivningarFinansiellaAnlaggningstillgangarKortfristigaPlaceringar'],
        yearCtx,
        { indent: true, displayMinus: true },
      ),
      moneyRow(
        writer,
        'Räntekostnader och liknande resultatposter',
        'RantekostnaderLiknandeResultatposter',
        rr['RantekostnaderLiknandeResultatposter'],
        yearCtx,
        { indent: true, displayMinus: true },
      ),
      moneyRow(
        writer,
        'Summa finansiella poster',
        'FinansiellaPoster',
        totals.finansiellaPoster,
        yearCtx,
        { rowClass: 'subtotal', alwaysShow: true },
      ),
      moneyRow(
        writer,
        'Resultat efter finansiella poster',
        'ResultatEfterFinansiellaPoster',
        totals.resultatEfterFinansiellaPoster,
        yearCtx,
        { rowClass: 'subtotal', alwaysShow: true },
      ),
    )
    const hasDispositioner =
      totals.bokslutsdispositioner.current !== 0 ||
      (totals.bokslutsdispositioner.previous ?? 0) !== 0
    if (hasDispositioner) {
      rows.push(sectionRow('Bokslutsdispositioner'))
      rows.push(
        moneyRow(
          writer,
          'Erhållna koncernbidrag',
          'ErhallnaKoncernbidrag',
          rr['ErhallnaKoncernbidrag'],
          yearCtx,
          { indent: true },
        ),
        moneyRow(
          writer,
          'Lämnade koncernbidrag',
          'LamnadeKoncernbidrag',
          rr['LamnadeKoncernbidrag'],
          yearCtx,
          { indent: true, displayMinus: true },
        ),
        moneyRow(
          writer,
          'Förändring av periodiseringsfonder',
          'ForandringPeriodiseringsfond',
          rr['ForandringPeriodiseringsfond'],
          yearCtx,
          { indent: true },
        ),
        moneyRow(
          writer,
          'Förändring av överavskrivningar',
          'ForandringOveravskrivningar',
          rr['ForandringOveravskrivningar'],
          yearCtx,
          { indent: true },
        ),
        moneyRow(
          writer,
          'Övriga bokslutsdispositioner',
          'OvrigaBokslutsdispositioner',
          rr['OvrigaBokslutsdispositioner'],
          yearCtx,
          { indent: true },
        ),
        moneyRow(
          writer,
          'Summa bokslutsdispositioner',
          'Bokslutsdispositioner',
          totals.bokslutsdispositioner,
          yearCtx,
          { rowClass: 'subtotal', alwaysShow: true },
        ),
      )
    }
    rows.push(
      moneyRow(writer, 'Resultat före skatt', 'ResultatForeSkatt', totals.resultatForeSkatt, yearCtx, {
        rowClass: 'subtotal',
        alwaysShow: true,
      }),
    )
    rows.push(sectionRow('Skatter'))
    rows.push(
      moneyRow(writer, 'Skatt på årets resultat', 'SkattAretsResultat', rr['SkattAretsResultat'], yearCtx, {
        indent: true,
        displayMinus: true,
      }),
      moneyRow(writer, 'Övriga skatter', 'OvrigaSkatter', rr['OvrigaSkatter'], yearCtx, {
        indent: true,
        displayMinus: true,
      }),
      moneyRow(writer, 'Årets resultat', 'AretsResultat', totals.aretsResultat, yearCtx, {
        rowClass: 'total',
        alwaysShow: true,
      }),
    )
    pages.push(
      el(
        'div',
        { class: 'ar-page', id: 'ar-page-3' },
        pageHeader(input, 3, totalPages) +
          el('h2', {}, 'Resultaträkning') +
          el('table', {}, rows.filter(Boolean).join('')),
      ),
    )
  }

  // ====== Page 4: balansräkning ======
  {
    const br = input.br
    const totals = input.totals
    const head = (title: string): string =>
      el(
        'tr',
        {},
        el('th', {}, escapeText(title)) +
          el('th', { class: 'num' }, escapeText(input.period.end)) +
          el('th', { class: 'num' }, input.previousPeriod ? escapeText(input.previousPeriod.end) : ''),
      )
    const post = (label: string, concept: string, opts: { alwaysShow?: boolean } = {}): string =>
      moneyRow(writer, label, concept, br[concept], balCtx, { indent: true, ...opts })
    const subtotal = (label: string, concept: string, amountValue: ConceptAmount): string =>
      moneyRow(writer, label, concept, amountValue, balCtx, { rowClass: 'subtotal', alwaysShow: true })

    const assetRows: string[] = [head('Balansräkning: Tillgångar (kr)')]
    assetRows.push(
      moneyRow(writer, 'Tecknat men ej inbetalt kapital', 'TecknatEjInbetaltKapital', br['TecknatEjInbetaltKapital'], balCtx, {}),
    )
    assetRows.push(sectionRow('Anläggningstillgångar'))
    if (totals.immateriellaAnlaggningstillgangar.current !== 0 || (totals.immateriellaAnlaggningstillgangar.previous ?? 0) !== 0) {
      assetRows.push(sectionRow('Immateriella anläggningstillgångar', 'subsection'))
      assetRows.push(
        post('Koncessioner, patent, licenser, varumärken samt liknande rättigheter', 'KoncessionerPatentLicenserVarumarkenLiknandeRattigheter'),
        post('Hyresrätter och liknande rättigheter', 'HyresratterLiknandeRattigheter'),
        post('Goodwill', 'Goodwill'),
        post('Förskott avseende immateriella anläggningstillgångar', 'ForskottImmateriellaAnlaggningstillgangar'),
        subtotal('Summa immateriella anläggningstillgångar', 'ImmateriellaAnlaggningstillgangar', totals.immateriellaAnlaggningstillgangar),
      )
    }
    if (totals.materiellaAnlaggningstillgangar.current !== 0 || (totals.materiellaAnlaggningstillgangar.previous ?? 0) !== 0) {
      assetRows.push(sectionRow('Materiella anläggningstillgångar', 'subsection'))
      assetRows.push(
        post('Byggnader och mark', 'ByggnaderMark'),
        post('Maskiner och andra tekniska anläggningar', 'MaskinerAndraTekniskaAnlaggningar'),
        post('Inventarier, verktyg och installationer', 'InventarierVerktygInstallationer'),
        post('Förbättringsutgifter på annans fastighet', 'ForbattringsutgifterAnnansFastighet'),
        post('Övriga materiella anläggningstillgångar', 'OvrigaMateriellaAnlaggningstillgangar'),
        post('Pågående nyanläggningar och förskott avseende materiella anläggningstillgångar', 'PagaendeNyanlaggningarForskottMateriellaAnlaggningstillgangar'),
        subtotal('Summa materiella anläggningstillgångar', 'MateriellaAnlaggningstillgangar', totals.materiellaAnlaggningstillgangar),
      )
    }
    if (totals.finansiellaAnlaggningstillgangar.current !== 0 || (totals.finansiellaAnlaggningstillgangar.previous ?? 0) !== 0) {
      assetRows.push(sectionRow('Finansiella anläggningstillgångar', 'subsection'))
      assetRows.push(
        post('Andelar i koncernföretag', 'AndelarKoncernforetag'),
        post('Fordringar hos koncernföretag', 'FordringarKoncernforetagLangfristiga'),
        post('Andelar i intresseföretag och gemensamt styrda företag', 'AndelarIntresseforetagGemensamtStyrdaForetag'),
        post('Fordringar hos intresseföretag och gemensamt styrda företag', 'FordringarIntresseforetagGemensamtStyrdaForetagLangfristiga'),
        post('Ägarintressen i övriga företag', 'AgarintressenOvrigaForetag'),
        post('Fordringar hos övriga företag som det finns ett ägarintresse i', 'FordringarOvrigaForetagAgarintresseLangfristiga'),
        post('Andra långfristiga värdepappersinnehav', 'AndraLangfristigaVardepappersinnehav'),
        post('Lån till delägare eller närstående', 'LanDelagareNarstaende'),
        post('Andra långfristiga fordringar', 'AndraLangfristigaFordringar'),
        subtotal('Summa finansiella anläggningstillgångar', 'FinansiellaAnlaggningstillgangar', totals.finansiellaAnlaggningstillgangar),
      )
    }
    assetRows.push(subtotal('Summa anläggningstillgångar', 'Anlaggningstillgangar', totals.anlaggningstillgangar))
    assetRows.push(sectionRow('Omsättningstillgångar'))
    if (totals.varulager.current !== 0 || (totals.varulager.previous ?? 0) !== 0) {
      assetRows.push(sectionRow('Varulager m.m.', 'subsection'))
      assetRows.push(
        post('Råvaror och förnödenheter', 'LagerRavarorFornodenheter'),
        post('Varor under tillverkning', 'LagerVarorUnderTillverkning'),
        post('Färdiga varor och handelsvaror', 'LagerFardigaVarorHandelsvaror'),
        post('Pågående arbete för annans räkning', 'PagaendeArbetenAnnansRakningOmsattningstillgangar'),
        post('Förskott till leverantörer', 'ForskottTillLeverantorer'),
        post('Övriga lagertillgångar', 'OvrigaLagertillgangar'),
        subtotal('Summa varulager m.m.', 'VarulagerMm', totals.varulager),
      )
    }
    assetRows.push(sectionRow('Kortfristiga fordringar', 'subsection'))
    assetRows.push(
      post('Kundfordringar', 'Kundfordringar'),
      post('Fordringar hos koncernföretag', 'FordringarKoncernforetagKortfristiga'),
      post('Fordringar hos intresseföretag och gemensamt styrda företag', 'FordringarIntresseforetagGemensamtStyrdaForetagKortfristiga'),
      post('Fordringar hos övriga företag som det finns ett ägarintresse i', 'FordringarOvrigaforetagAgarintresseKortfristiga'),
      post('Övriga fordringar', 'OvrigaFordringarKortfristiga', { alwaysShow: true }),
      post('Upparbetad men ej fakturerad intäkt', 'UpparbetadEjFaktureradIntakt'),
      post('Förutbetalda kostnader och upplupna intäkter', 'ForutbetaldaKostnaderUpplupnaIntakter'),
      subtotal('Summa kortfristiga fordringar', 'KortfristigaFordringar', totals.kortfristigaFordringar),
    )
    if (totals.kortfristigaPlaceringar.current !== 0 || (totals.kortfristigaPlaceringar.previous ?? 0) !== 0) {
      assetRows.push(sectionRow('Kortfristiga placeringar', 'subsection'))
      assetRows.push(
        post('Andelar i koncernföretag', 'AndelarKoncernforetagKortfristiga'),
        post('Övriga kortfristiga placeringar', 'OvrigaKortfristigaPlaceringar'),
        subtotal('Summa kortfristiga placeringar', 'KortfristigaPlaceringar', totals.kortfristigaPlaceringar),
      )
    }
    assetRows.push(sectionRow('Kassa och bank', 'subsection'))
    assetRows.push(
      post('Kassa och bank', 'KassaBankExklRedovisningsmedel', { alwaysShow: true }),
      post('Redovisningsmedel', 'Redovisningsmedel'),
      subtotal('Summa kassa och bank', 'KassaBank', totals.kassaBank),
      subtotal('Summa omsättningstillgångar', 'Omsattningstillgangar', totals.omsattningstillgangar),
      moneyRow(writer, 'Summa tillgångar', 'Tillgangar', totals.tillgangar, balCtx, {
        rowClass: 'total',
        alwaysShow: true,
      }),
    )

    const eqRows: string[] = [head('Balansräkning: Eget kapital och skulder (kr)')]
    eqRows.push(sectionRow('Eget kapital'))
    eqRows.push(sectionRow('Bundet eget kapital', 'subsection'))
    eqRows.push(
      post('Aktiekapital', 'Aktiekapital', { alwaysShow: true }),
      post('Ej registrerat aktiekapital', 'EjRegistreratAktiekapital'),
      post('Bunden överkursfond', 'OverkursfondBunden'),
      post('Uppskrivningsfond', 'Uppskrivningsfond'),
      post('Reservfond', 'Reservfond'),
      subtotal('Summa bundet eget kapital', 'BundetEgetKapital', totals.bundetEgetKapital),
    )
    eqRows.push(sectionRow('Fritt eget kapital', 'subsection'))
    eqRows.push(
      post('Överkursfond', 'Overkursfond'),
      post('Balanserat resultat', 'BalanseratResultat', { alwaysShow: true }),
      post('Årets resultat', 'AretsResultatEgetKapital', { alwaysShow: true }),
      subtotal('Summa fritt eget kapital', 'FrittEgetKapital', totals.frittEgetKapital),
      subtotal('Summa eget kapital', 'EgetKapital', totals.egetKapital),
    )
    if (totals.obeskattadeReserver.current !== 0 || (totals.obeskattadeReserver.previous ?? 0) !== 0) {
      eqRows.push(sectionRow('Obeskattade reserver'))
      eqRows.push(
        post('Periodiseringsfonder', 'Periodiseringsfonder'),
        post('Ackumulerade överavskrivningar', 'AckumuleradeOveravskrivningar'),
        post('Övriga obeskattade reserver', 'OvrigaObeskattadeReserver'),
        subtotal('Summa obeskattade reserver', 'ObeskattadeReserver', totals.obeskattadeReserver),
      )
    }
    if (totals.avsattningar.current !== 0 || (totals.avsattningar.previous ?? 0) !== 0) {
      eqRows.push(sectionRow('Avsättningar'))
      eqRows.push(
        post('Avsättningar för pensioner och liknande förpliktelser enligt lag', 'AvsattningarPensionerLiknandeForpliktelserEnligtLag'),
        post('Övriga avsättningar för pensioner och liknande förpliktelser', 'OvrigaAvsattningarPensionerLiknandeForpliktelser'),
        post('Övriga avsättningar', 'OvrigaAvsattningar'),
        subtotal('Summa avsättningar', 'Avsattningar', totals.avsattningar),
      )
    }
    if (totals.langfristigaSkulder.current !== 0 || (totals.langfristigaSkulder.previous ?? 0) !== 0) {
      eqRows.push(sectionRow('Långfristiga skulder'))
      eqRows.push(
        post('Obligationslån', 'Obligationslan'),
        post('Checkräkningskredit', 'CheckrakningskreditLangfristig'),
        post('Övriga skulder till kreditinstitut', 'OvrigaLangfristigaSkulderKreditinstitut'),
        post('Skulder till koncernföretag', 'SkulderKoncernforetagLangfristiga'),
        post('Skulder till intresseföretag och gemensamt styrda företag', 'SkulderIntresseforetagGemensamtStyrdaForetagLangfristiga'),
        post('Skulder till övriga företag som det finns ett ägarintresse i', 'SkulderOvrigaForetagAgarintresseLangfristiga'),
        post('Övriga skulder', 'OvrigaLangfristigaSkulder'),
        subtotal('Summa långfristiga skulder', 'LangfristigaSkulder', totals.langfristigaSkulder),
      )
    }
    eqRows.push(sectionRow('Kortfristiga skulder'))
    eqRows.push(
      post('Förskott från kunder', 'ForskottFranKunder'),
      post('Checkräkningskredit', 'CheckrakningskreditKortfristig'),
      post('Övriga skulder till kreditinstitut', 'OvrigaKortfristigaSkulderKreditinstitut'),
      post('Pågående arbete för annans räkning', 'PagaendeArbetenAnnansRakningKortfristigaSkulder'),
      post('Fakturerad men ej upparbetad intäkt', 'FaktureradEjUpparbetadIntakt'),
      post('Leverantörsskulder', 'Leverantorsskulder', { alwaysShow: true }),
      post('Växelskulder', 'Vaxelskulder'),
      post('Skulder till koncernföretag', 'SkulderKoncernforetagKortfristiga'),
      post('Skulder till intresseföretag och gemensamt styrda företag', 'SkulderIntresseforetagGemensamtStyrdaForetagKortfristiga'),
      post('Skulder till övriga företag som det finns ett ägarintresse i', 'SkulderOvrigaForetagAgarintresseKortfristiga'),
      post('Skatteskulder', 'Skatteskulder'),
      post('Övriga skulder', 'OvrigaKortfristigaSkulder', { alwaysShow: true }),
      post('Upplupna kostnader och förutbetalda intäkter', 'UpplupnaKostnaderForutbetaldaIntakter'),
      subtotal('Summa kortfristiga skulder', 'KortfristigaSkulder', totals.kortfristigaSkulder),
      moneyRow(writer, 'Summa eget kapital och skulder', 'EgetKapitalSkulder', totals.egetKapitalSkulder, balCtx, {
        rowClass: 'total',
        alwaysShow: true,
      }),
    )

    pages.push(
      el(
        'div',
        { class: 'ar-page', id: 'ar-page-4' },
        pageHeader(input, 4, totalPages) +
          el('h2', {}, 'Balansräkning') +
          el('table', {}, assetRows.filter(Boolean).join('')) +
          el('table', {}, eqRows.filter(Boolean).join('')),
      ),
    )
  }

  // ====== Page 5: noter ======
  {
    const parts: string[] = [pageHeader(input, 5, totalPages), el('h2', {}, 'Noter')]
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
      if (isPrinciples) {
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
                el('th', { class: 'num' }, escapeText(input.period.end.slice(0, 4))) +
                el(
                  'th',
                  { class: 'num' },
                  input.previousPeriod ? escapeText(input.previousPeriod.end.slice(0, 4)) : '',
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
      } else {
        parts.push(paragraphs(note.body))
      }
    }
    pages.push(el('div', { class: 'ar-page', id: 'ar-page-5' }, parts.join('\n')))
  }

  // ====== Page 6: underskrifter ======
  {
    const u = input.underskrifter
    const parts: string[] = [pageHeader(input, 6, totalPages), el('h2', {}, 'Underskrifter')]
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
    pages.push(el('div', { class: 'ar-page', id: 'ar-page-6' }, parts.join('\n')))
  }

  // ---- assemble -------------------------------------------------------------
  const xmlnsAttrs = Object.entries(entryPoint.namespaces)
    .map(([prefix, uri]) => `xmlns:${prefix}="${escapeAttr(uri)}"`)
    .join('\n      ')
  const title = `Årsredovisning ${input.company.name} ${input.company.orgNumber} räkenskapsåret ${input.period.start}-${input.period.end}`

  const head = el(
    'head',
    {},
    [
      el('title', {}, escapeText(title)),
      '<meta http-equiv="Content-Type" content="text/html; charset=utf-8"/>',
      `<meta name="programvara" content="${escapeAttr(input.programvara.namn)}"/>`,
      `<meta name="programversion" content="${escapeAttr(input.programvara.version)}"/>`,
      el('style', { type: 'text/css' }, '\n' + CSS + '\n'),
    ].join('\n'),
  )

  const body = el('body', {}, [writer.renderHeader(), el('div', { id: 'wrapper' }, pages.join('\n'))].join('\n'))

  const xhtml =
    '<?xml version="1.0" encoding="utf-8"?>\n' +
    `<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="sv"\n      ${xmlnsAttrs}>\n` +
    head +
    '\n' +
    body +
    '\n</html>\n'

  return { xhtml, warnings }
}

/**
 * Insert the Bolagsverket-computed kontrollsumma meta tags into a generated
 * document (TA §4.5.2). Run AFTER skapa-kontrollsumma since the checksum is
 * computed over the file content excluding fastställelseintyg/underskrifts-
 * datum/meta tags: adding the meta tags does not invalidate it.
 */
export function embedKontrollsumma(xhtml: string, kontrollsumma: string, algoritm: string): string {
  const meta =
    `<meta name="ixbrl.innehall.kontrollsumman" content="${escapeAttr(kontrollsumma)}"/>\n` +
    `<meta name="ixbrl.innehall.kontrollsumman.algoritm" content="${escapeAttr(algoritm)}"/>\n`
  return xhtml.replace('</head>', meta + '</head>')
}
