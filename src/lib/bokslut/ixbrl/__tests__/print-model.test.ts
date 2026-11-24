/**
 * The print model: what a piece of the document takes of a sheet in
 * Bolagsverket's PDF converter, and how a long section is divided into
 * pages. The expected figures are positions read off the PDFs the testbänk
 * made of a test company's document on 2026-11-24.
 */
import { describe, expect, it } from 'vitest'
import { CSS } from '../document/layout'
import {
  measureMarkup,
  pageHeight,
  paginate,
  printBlock,
  SHEET_HEIGHT,
  type PrintBlock,
} from '../document/print-model'
import { el } from '../document/xml'

const row = (label: string, amount: string, cls: string | null = null): string =>
  el('tr', { class: cls }, el('th', { scope: 'row' }, label) + el('td', { class: 'num' }, amount))
const table = (rows: string[]): string => el('table', {}, rows.join(''))
const total = (boxes: ReturnType<typeof measureMarkup>): number => boxes.reduce((sum, box) => sum + box.height, 0)

describe('the style sheet the model is measured against', () => {
  // The heights below are these rules in points. A change here without the
  // same change in print-model.ts moves every page break in the PDF.
  it.each([
    '.ar-page { padding: 2em 2.5em; margin: 1em 0; border: 1px solid #eee; page-break-after: always; }',
    '.ar-page-hdr { font-size: 80%; color: #333; border-bottom: 1px solid #999; margin-bottom: 1.5em; padding-bottom: 0.25em; overflow: hidden; }',
    "body { font-family: 'Times New Roman', Times, serif; margin: 0 auto; max-width: 46em; color: #000; }",
    'h2 { font-size: 125%; margin: 1.5em 0 0.5em; }',
    'h3 { font-size: 105%; margin: 1.2em 0 0.4em; }',
    'h4 { font-size: 100%; font-style: italic; font-weight: normal; margin: 1em 0 0.3em; }',
    'p { margin: 0 0 0.8em; line-height: 1.35; }',
    'table { width: 100%; border-collapse: collapse; margin: 0 0 1.2em; }',
    'th, td { text-align: left; vertical-align: bottom; padding: 0.15em 0.4em 0.15em 0; font-size: 95%; }',
    'tr { page-break-inside: avoid; }',
    'th.num, td.num { text-align: right; white-space: nowrap; }',
    'tr.subtotal th, tr.subtotal td { border-top: 1px solid #000; font-weight: bold; }',
    'tr.total th, tr.total td { border-top: 1px solid #000; border-bottom: 3px double #000; font-weight: bold; }',
    'tr.section th { font-weight: bold; padding-top: 0.8em; }',
    '.ar-page-hdr .ar-page-id { float: left; }',
    '.ar-page-hdr .ar-page-no { float: right; }',
    '@media print { .ar-page { border: none; margin: 0; padding-bottom: 0; } }',
  ])('holds %s', (rule) => {
    expect(CSS).toContain(rule)
  })
})

describe('measureMarkup', () => {
  it('measures a heading, a paragraph and a table as the converter prints them', () => {
    const [heading, paragraph, rows] = measureMarkup(
      [el('h3', { id: 'not-1' }, 'Not 1 Aktiekapital'), el('p', {}, 'Aktiekapital: 25 000 kr.'), table([row('Inköp', '150 000')])].join('\n'),
    )
    // h3: 12.6 pt type on one line, 1.2em above and 0.4em below.
    expect(heading.top).toBeCloseTo(15.12, 2)
    expect(heading.height).toBeCloseTo(14.48, 2)
    expect(heading.bottom).toBeCloseTo(5.04, 2)
    // p: one line of 1.35 x 12 pt and 0.8em below.
    expect(paragraph.top).toBe(0)
    expect(paragraph.height).toBeCloseTo(16.2, 2)
    expect(paragraph.bottom).toBeCloseTo(9.6, 2)
    // A table row measured 16.55 pt from row to row in the PDF.
    expect(rows.height).toBeCloseTo(16.52, 2)
    expect(rows.bottom).toBeCloseTo(14.4, 2)
  })

  it('adds the rule over a sum row and the double rule under a total', () => {
    const plain = total(measureMarkup(table([row('Inköp', '1')])))
    expect(total(measureMarkup(table([row('Utgående', '1', 'subtotal')]))) - plain).toBeCloseTo(0.75, 2)
    expect(total(measureMarkup(table([row('Redovisat värde', '1', 'total')]))) - plain).toBeCloseTo(3, 2)
  })

  it('sees through a fact that holds paragraphs', () => {
    const fact = el('ix:nonNumeric', { contextRef: 'period0', name: 'se-gen-base:X' }, el('p', {}, 'Ett.') + '\n' + el('p', {}, 'Två.'))
    expect(measureMarkup(fact)).toHaveLength(2)
  })

  it('counts text outside any block as lines of its own, and tuple declarations as nothing', () => {
    const declarations = '<ix:tuple name="se-gaap-ext:T" tupleID="T1"/><ix:tuple name="se-gaap-ext:T" tupleID="T2"/>'
    expect(measureMarkup(declarations + table([row('Maskiner', '5 år')]))).toHaveLength(1)
    const bare = measureMarkup(el('ix:nonNumeric', { contextRef: 'balans0', name: 'se-gen-base:Y' }, 'Inga.'))
    expect(bare).toHaveLength(1)
    expect(bare[0].height).toBeCloseTo(13.79, 2)
  })

  it('counts a forced line break and an empty line as lines', () => {
    expect(measureMarkup(el('p', {}, 'Ett<br/>Två<br/><br/>Fyra'))[0].height).toBeCloseTo(4 * 16.2, 2)
  })

  it('counts the lines the converter printed: two for the principles sentence, one for the aktiekapital sentence', () => {
    // In the PDF the first line of this note ended after "Bokföringsnämndens"
    // (88 letters) and the rest took a second line.
    const principles =
      'Årsredovisningen är upprättad i enlighet med Årsredovisningslagen och Bokföringsnämndens allmänna råd BFNAR 2016:10 Årsredovisning i mindre företag (K2).'
    expect(measureMarkup(el('p', {}, principles))[0].height).toBeCloseTo(2 * 16.2, 2)
    expect(measureMarkup(el('p', {}, 'Aktiekapital: 125 000 kr. Antal aktier: 1 250. Kvotvärde per aktie: 100 kr.'))[0].height).toBeCloseTo(16.2, 2)
  })

  it('wraps capitals sooner than small letters, and counts the lines of a word wider than the page', () => {
    const small = 'bolaget tillämpar samma principer som föregående år '.repeat(4)
    const lines = (text: string): number => Math.round(measureMarkup(el('p', {}, text))[0].height / 16.2)
    expect(lines(small.toUpperCase())).toBeGreaterThan(lines(small))
    expect(lines('M'.repeat(120))).toBe(3)
  })

  it('reads an escaped character as one character, and a letter written with a combining mark as the letter', () => {
    const lines = (text: string): number => Math.round(measureMarkup(el('p', {}, text))[0].height / 16.2)
    expect(lines('&amp;'.repeat(60))).toBe(lines('&'.repeat(60)))
    expect(lines('a\u030a'.repeat(100))).toBe(lines('å'.repeat(100)))
  })

  it('counts fewer or as many lines at the full width as at the careful one', () => {
    const prose = 'Bolaget tillämpar samma redovisningsprinciper som föregående räkenskapsår om inte annat anges. '.repeat(40)
    const careful = measureMarkup(el('p', {}, prose))[0].height
    const likely = measureMarkup(el('p', {}, prose), 478.3)[0].height
    expect(likely).toBeLessThanOrEqual(careful)
    expect(likely).toBeGreaterThan(careful * 0.8)
  })

  it('wraps a row label in what the figure columns leave', () => {
    const label = 'Återförda nedskrivningar på försäljningar respektive utrangeringar av maskiner och andra tekniska anläggningar'
    const one = total(measureMarkup(table([row('Inköp', '150 000')])))
    expect(total(measureMarkup(table([row(label, '150 000')])))).toBeGreaterThan(one * 1.5)
  })
})

describe('pageHeight', () => {
  it('measures the notes page the converter fitted on one sheet as it printed it', () => {
    // Not 1 to 4 of the test company: on the sheet the last row's text ended
    // 785.1 pt down, of which 28.35 pt are the converter's margin and the
    // rest of the row's box about 4 pt.
    const rows = [
      row('', '2025-12-31'),
      ...Array.from({ length: 7 }, () => row('Inköp', '150 000')),
      row('Utgående anskaffningsvärden', '828 000', 'subtotal'),
      ...Array.from({ length: 6 }, () => row('Fusion', '−48 000')),
      row('Utgående avskrivningar', '−190 382', 'subtotal'),
      ...Array.from({ length: 7 }, () => row('Fusion', '−11 000')),
      row('Utgående nedskrivningar', '−66 000', 'subtotal'),
      row('Redovisat värde', '571 618', 'total'),
    ]
    const page = [
      el('h2', {}, 'Noter'),
      el('h3', {}, 'Not 1 Redovisnings- och värderingsprinciper'),
      el('p', {}, 'Årsredovisningen är upprättad i enlighet med Årsredovisningslagen och Bokföringsnämndens allmänna råd BFNAR 2016:10 Årsredovisning i mindre företag (K2).'),
      el('h3', {}, 'Not 2 Aktiekapital'),
      el('p', {}, 'Aktiekapital: 125 000 kr. Antal aktier: 1 250. Kvotvärde per aktie: 100 kr.'),
      el('h3', {}, 'Not 3 Avskrivningar'),
      el('p', {}, 'Avskrivningar görs linjärt över bedömd nyttjandeperiod:'),
      table([el('tr', {}, el('td', {}, 'Maskiner') + el('td', { class: 'num' }, '3-10 år'))]),
      el('h3', {}, 'Not 4 Anläggningstillgångar'),
      el('h4', {}, 'Maskiner och andra tekniska anläggningar'),
      table(rows),
    ].join('\n')
    const height = pageHeight([printBlock(page)])
    expect(28.35 + height).toBeGreaterThan(785.1)
    expect(28.35 + height).toBeLessThan(785.1 + 6)
    expect(height).toBeLessThan(SHEET_HEIGHT)
  })
})

describe('paginate', () => {
  const lines = (count: number, name = 'p'): PrintBlock =>
    printBlock(el(name, {}, Array.from({ length: count }, (_, index) => `Rad ${index + 1}`).join('<br/>')))

  it('keeps everything on one page while it fits a sheet', () => {
    const blocks = [lines(10), lines(10), lines(10)]
    const pages = paginate(blocks)
    expect(pages).toHaveLength(1)
    expect(pages[0]).toEqual({ html: blocks.map((block) => block.html).join('\n'), sheets: 1 })
  })

  it('closes a page before the block that would pass the foot of the sheet', () => {
    // A sheet holds 785 pt; the header and the page's padding take 64 pt
    // and a block of 20 lines 324 pt and its margin.
    const blocks = [lines(20), lines(20), lines(20), lines(20), lines(20)]
    const pages = paginate(blocks)
    expect(pages.map((page) => page.html.split('</p>').length - 1)).toEqual([2, 2, 1])
    expect(pages.every((page) => page.sheets === 1)).toBe(true)
    for (const page of pages) {
      expect(pageHeight([printBlock(page.html)])).toBeLessThanOrEqual(SHEET_HEIGHT - 16)
    }
  })

  it('never divides a block: one taller than a sheet gets its own page and counts its sheets', () => {
    // 150 forced lines printed on four sheets in the converter.
    const pages = paginate([lines(5), lines(150), lines(5)])
    expect(pages.map((page) => page.sheets)).toEqual([1, 4, 1])
    expect(pages[1].html).toContain('Rad 150')
    expect(pages[1].html).not.toContain('</p>\n<p>')
  })

  it('counts the sheets of a tall block from its likeliest height, not from the careful one', () => {
    // A text whose careful height passes the foot of a sheet that its lines
    // at full width do not reach: the count is the likelier, lower one.
    const sentence = 'Bolaget tillämpar samma redovisningsprinciper som föregående räkenskapsår om inte annat anges i noten. '
    const sheetsAt = (height: number): number => Math.ceil((24 + 25.21 + 14.4 + height) / SHEET_HEIGHT)
    let found: { html: string; likely: number } | null = null
    for (let repeats = 60; repeats < 400 && !found; repeats += 1) {
      const html = el('p', {}, sentence.repeat(repeats))
      const careful = measureMarkup(html)[0].height
      const likely = measureMarkup(html, 478.3)[0].height
      if (sheetsAt(careful) > sheetsAt(likely)) found = { html, likely: sheetsAt(likely) }
    }
    expect(found).not.toBeNull()
    expect(paginate([printBlock(found!.html)])).toEqual([{ html: found!.html, sheets: found!.likely }])
  })

  it('counts one sheet for a single block that reaches the last 16 pt of the sheet', () => {
    // 44 lines alone on a page end 9 pt above the foot; the converter printed
    // them on one sheet and dropped the margin under the paragraph.
    expect(paginate([lines(44)])).toEqual([{ html: lines(44).html, sheets: 1 }])
  })

  it('gives no page for no blocks', () => {
    expect(paginate([])).toEqual([])
  })
})
