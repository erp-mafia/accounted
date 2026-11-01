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
 *
 * The parts the K3 document shares (layout, title page, flerårsöversikt,
 * resultatdisposition, statements, notes, signatures) live in layout.ts,
 * sections.ts and statements.ts; what is K2's own is the förvaltnings-
 * berättelse's concepts and its equity table.
 */

import { formatOrgNumberDisplay } from '@/lib/invariants/org-number'
import { getEntryPoint } from '../taxonomy/entry-points'
import { getRegistry } from '../taxonomy/registry'
import type { IxbrlArsredovisningInput } from '../types'
import { FactWriter } from './ix'
import { assembleXhtml, fmtRange, registerContexts, type GeneratedIxbrl } from './layout'
import {
  emitAllmanInformation,
  renderCoverPage,
  renderFlerarsoversikt,
  renderNotes,
  renderResultatdisposition,
  renderSignatures,
} from './sections'
import {
  K2_BALANSRAKNING_EGET_KAPITAL_SKULDER,
  K2_BALANSRAKNING_TILLGANGAR,
  K2_RESULTATRAKNING,
  renderStatementRows,
  statementHead,
} from './statements'
import { el, escapeText, formatSekAbs, paragraphs } from './xml'

export { embedKontrollsumma, type GeneratedIxbrl } from './layout'

export function generateK2IxbrlDocument(input: IxbrlArsredovisningInput): GeneratedIxbrl {
  const entryPoint = getEntryPoint(input.entryPointId)
  const registry = getRegistry(entryPoint.registryId)
  // One spelling of the org number wherever it appears (context identifier,
  // Organisationsnummer fact, page headers, title): NNNNNN-NNNN as in
  // Bolagsverket's examples, whichever format the company settings hold.
  const orgNumber = formatOrgNumberDisplay(input.company.orgNumber)
  const writer = new FactWriter(entryPoint, registry, orgNumber)
  const warnings: string[] = [...input.warnings]

  const ctx = registerContexts(writer, input)
  const yearCtx = { current: ctx.period0, previous: ctx.period1 }
  const balCtx = { current: ctx.balans0, previous: ctx.balans1 }

  emitAllmanInformation(writer, input, { beloppsformat: true })
  // Note on TA §2.22 (status för taggning): the 2024-09-12 K2 AB taxonomy has
  // no tagging-status concept (verified against the generated registry and
  // the official example filings), so nothing is emitted even though note
  // bodies beyond Not 1/medelantal are rendered untagged.

  // Page bodies in print order; each gets its header (with the final page
  // count) when the document is assembled.
  const pages: string[] = []

  // ====== Titel + innehåll + fastställelseintyg ======
  pages.push(renderCoverPage(writer, input, orgNumber))

  // ====== Förvaltningsberättelse ======
  {
    const fb = input.forvaltningsberattelse
    const parts: string[] = [
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
    // Same statement the PDF prints (ABL 25 kap.); the K2 taxonomy has no
    // concept for it, so it stays untagged text.
    if (fb.kontrollbalansrakningUpprattad) {
      parts.push(
        el('h4', {}, 'Kontrollbalansräkning'),
        el('p', {}, 'Kontrollbalansräkning har upprättats under räkenskapsåret enligt ABL 25 kap.'),
      )
    }

    const flerars = renderFlerarsoversikt(writer, fb.flerarsoversikt)
    if (flerars) parts.push(flerars)

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
            // "Ökning (minskning) av periodens resultat vid balansering i ny
            // räkning": the column DECREASES by what is carried to balanserat
            // resultat, so the fact is negative (sign="-"). The utdelning
            // concepts below are defined as "Minskning …" instead and stay
            // positive with a presentational minus.
            td(
              writer.money(
                'ForandringEgetKapitalAretsResultatBalanserasNyRakning',
                'period0',
                -ek.balanserasINyRakning,
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

    parts.push(...renderResultatdisposition(writer, fb.resultatdisposition))

    pages.push(parts.join('\n'))
  }

  // ====== Resultaträkning ======
  {
    const head = statementHead(
      'Resultaträkning (kr)',
      fmtRange(input.period.start, input.period.end),
      input.previousPeriod ? fmtRange(input.previousPeriod.start, input.previousPeriod.end) : '',
    )
    const rows = [head, ...renderStatementRows(writer, K2_RESULTATRAKNING, input.rr, input.totals, yearCtx)]
    pages.push(el('h2', {}, 'Resultaträkning') + el('table', {}, rows.filter(Boolean).join('')))
  }

  // ====== Balansräkning ======
  {
    const head = (title: string): string =>
      statementHead(title, input.period.end, input.previousPeriod ? input.previousPeriod.end : '')
    const assetRows = [
      head('Balansräkning: Tillgångar (kr)'),
      ...renderStatementRows(writer, K2_BALANSRAKNING_TILLGANGAR, input.br, input.totals, balCtx),
    ]
    const eqRows = [
      head('Balansräkning: Eget kapital och skulder (kr)'),
      ...renderStatementRows(writer, K2_BALANSRAKNING_EGET_KAPITAL_SKULDER, input.br, input.totals, balCtx),
    ]
    // Assets and equity/liabilities each get their own sheet: together they
    // overflow one A4 page and the tail would print without a page header.
    pages.push(
      el('h2', {}, 'Balansräkning') + el('table', {}, assetRows.filter(Boolean).join('')),
      el('h2', {}, 'Balansräkning') + el('table', {}, eqRows.filter(Boolean).join('')),
    )
  }

  // ====== Noter ======
  pages.push(renderNotes(writer, registry, input, ctx, warnings))

  // ====== Underskrifter ======
  pages.push(renderSignatures(writer, registry, input))

  return { xhtml: assembleXhtml(input, entryPoint, writer, pages, orgNumber), warnings }
}
