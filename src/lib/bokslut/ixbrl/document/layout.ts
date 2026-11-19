/**
 * Layout shared by the K2 and K3 iXBRL documents: print CSS, contexts, the
 * table row primitives, page headers and the XHTML envelope. Both documents
 * follow Bolagsverket's official examples and TILLAMPNINGSANVISNING v1.8:
 *   - XHTML + UTF-8, no scripts/external refs, inline CSS gathered in <head>
 *   - contexts period0/period1/…, balans0/balans1/…; unit SEK
 *   - presentational minus for cost rows lives OUTSIDE the fact element;
 *     `sign="-"` is reserved for values deviating from the concept's nature
 */

import type { TaxonomyEntryPoint } from '../taxonomy/entry-points'
import type { IxbrlArsredovisningInput, ConceptAmount } from '../types'
import type { FactWriter } from './ix'
import { el, selfClosing, escapeText, escapeAttr } from './xml'

// Print layout (Bolagsverket asks for a clean printout with page breaks):
// every .ar-page starts on a new sheet, rows never split across sheets, and
// no inline styles or flexbox (TA §3.7.4-3.7.5) so their PDF converter reads
// the structure from plain block elements.
export const CSS = `
body { font-family: 'Times New Roman', Times, serif; margin: 0 auto; max-width: 46em; color: #000; }
.ar-page { padding: 2em 2.5em; margin: 1em 0; border: 1px solid #eee; page-break-after: always; }
.ar-page-hdr { font-size: 80%; color: #333; border-bottom: 1px solid #999; margin-bottom: 1.5em; padding-bottom: 0.25em; overflow: hidden; }
.ar-page-hdr .ar-page-id { float: left; }
.ar-page-hdr .ar-page-no { float: right; }
h1 { font-size: 160%; margin: 0 0 0.5em; }
h2 { font-size: 125%; margin: 1.5em 0 0.5em; }
h3 { font-size: 105%; margin: 1.2em 0 0.4em; }
h4 { font-size: 100%; font-style: italic; font-weight: normal; margin: 1em 0 0.3em; }
p { margin: 0 0 0.8em; line-height: 1.35; }
table { width: 100%; border-collapse: collapse; margin: 0 0 1.2em; }
tr { page-break-inside: avoid; }
th, td { text-align: left; vertical-align: bottom; padding: 0.15em 0.4em 0.15em 0; font-size: 95%; }
th.indent { padding-left: 1.2em; }
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

export interface Ctx {
  period0: string
  period1: string | null
  balans0: string
  balans1: string | null
}

export interface GeneratedIxbrl {
  xhtml: string
  warnings: string[]
}

export function fmtRange(start: string, end: string): string {
  return `${start} till ${end}`
}

/** "2025" for a calendar year, the full range for any other fiscal year. */
export function periodColumnLabel(period: { start: string; end: string }): string {
  const calendarYear =
    period.start.endsWith('-01-01') &&
    period.end.endsWith('-12-31') &&
    period.start.slice(0, 4) === period.end.slice(0, 4)
  return calendarYear ? period.end.slice(0, 4) : fmtRange(period.start, period.end)
}

/**
 * Declare the year and balance contexts: period0/balans0 for the year,
 * period1/balans1 for the jämförelseår, and period2/3 + balans2/3 for the
 * older flerårsöversikt columns from the explicit ranges build-input aligned
 * with the rows (never derived from row count: broken fiscal years would
 * corrupt the contexts).
 */
export function registerContexts(writer: FactWriter, input: IxbrlArsredovisningInput): Ctx {
  writer.addDurationContext('period0', input.period.start, input.period.end)
  writer.addInstantContext('balans0', input.period.end)
  if (input.previousPeriod) {
    writer.addDurationContext('period1', input.previousPeriod.start, input.previousPeriod.end)
    writer.addInstantContext('balans1', input.previousPeriod.end)
  }
  input.forvaltningsberattelse.flerarsPerioder.forEach((range, index) => {
    if (index < 2) return // period0/period1 already registered
    writer.addDurationContext(`period${index}`, range.start, range.end)
    writer.addInstantContext(`balans${index}`, range.end)
  })
  return {
    period0: 'period0',
    period1: input.previousPeriod ? 'period1' : null,
    balans0: 'balans0',
    balans1: input.previousPeriod ? 'balans1' : null,
  }
}

/** Two-amount row where the concept is tagged in both year columns. */
export function moneyRow(
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
    el('th', { scope: 'row', class: opts.indent ? 'indent' : null }, escapeText(label)),
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

export function sectionRow(label: string, cls: 'section' | 'subsection' = 'section'): string {
  return el('tr', { class: cls }, el('th', { colspan: '3' }, escapeText(label)))
}

function pageHeader(
  input: IxbrlArsredovisningInput,
  orgNumber: string,
  page: number,
  total: number,
): string {
  // el() treats its content argument as raw markup: build it exclusively
  // from escapeText() output joined with builder-emitted tags so no user
  // value can ever reach the string unescaped.
  const identity = [
    escapeText(input.company.name),
    selfClosing('br', {}),
    escapeText(orgNumber),
  ].join('')
  return el(
    'div',
    { class: 'ar-page-hdr' },
    el('span', { class: 'ar-page-id' }, identity) +
      el('span', { class: 'ar-page-no' }, `${page} (${total})`),
  )
}

/**
 * The XHTML envelope: each page gets its header (with the final page
 * count), the ix:header carries only the contexts and units the body used,
 * and <head> the TA §4.3 programvara metadata.
 */
export function assembleXhtml(
  input: IxbrlArsredovisningInput,
  entryPoint: TaxonomyEntryPoint,
  writer: FactWriter,
  pages: string[],
  orgNumber: string,
): string {
  const pageDivs = pages.map((content, index) =>
    el(
      'div',
      { class: 'ar-page', id: `ar-page-${index + 1}` },
      pageHeader(input, orgNumber, index + 1, pages.length) + '\n' + content,
    ),
  )
  const xmlnsAttrs = Object.entries(entryPoint.namespaces)
    .map(([prefix, uri]) => `xmlns:${prefix}="${escapeAttr(uri)}"`)
    .join('\n      ')
  const title = `Årsredovisning ${input.company.name} ${orgNumber} räkenskapsåret ${input.period.start}-${input.period.end}`

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

  const body = el('body', {}, [writer.renderHeader(), el('div', { id: 'wrapper' }, pageDivs.join('\n'))].join('\n'))

  return (
    '<?xml version="1.0" encoding="utf-8"?>\n' +
    `<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="sv"\n      ${xmlnsAttrs}>\n` +
    head +
    '\n' +
    body +
    '\n</html>\n'
  )
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
