/**
 * How the document prints, sheet by sheet.
 *
 * Bolagsverket turns the filed document into the PDF it stores and shows.
 * Its converter lays the XHTML out on A4 sheets and knows nothing of the
 * page headers, which are ordinary elements at the top of every .ar-page: a
 * page taller than a sheet runs on to a sheet without a header, and every
 * header after it counts one sheet too few. A section that grows with the
 * company (the notes) is therefore divided into pages that each fit a sheet,
 * by measuring its markup the way the converter lays it out.
 *
 * What cannot be divided is a single piece taller than a sheet (a tagged
 * text is one fact). It keeps a page of its own, still runs on to sheets
 * without a header, and its page counts the sheets it is likely to fill:
 * an estimate, since how the converter fills the sheets of one long piece
 * is not exact.
 *
 * The measures are the converter's own, read off the PDFs Bolagsverket's
 * testbänk made of this document on 2026-11-24 (wkhtmltopdf 0.12.6 on A4
 * with 10 mm margins and the print style sheet): the body's 1em is 12 pt, a
 * table row 16.5 pt, a paragraph line 16.2 pt, and a line is 478 pt wide.
 * Every height below follows from the CSS in layout.ts (a test holds the two
 * together); where a text wraps follows from the widths of its letters.
 */

/** A printed box: its height and the margins that collapse with its neighbours', in points. */
export interface PrintBox {
  top: number
  height: number
  bottom: number
}

/** A piece of a page that is never divided between two sheets. */
export interface PrintBlock {
  html: string
  boxes: PrintBox[]
}

/** One .ar-page and the number of sheets it prints on (1 unless a single block is taller than a sheet). */
export interface PrintPage {
  html: string
  sheets: number
}

/** The body's 16 px prints as 12 pt. */
const EM = 12
/** One CSS pixel, the width of every border in the style sheet. */
const PX = 0.75
/** `line-height: normal` of Times New Roman, as a share of the font size. */
const NORMAL_LINE = 1.149
/** A4 is 842 pt high; the converter leaves 10 mm (28.35 pt) at the top and the bottom. */
export const SHEET_HEIGHT = 842 - 2 * 28.35
/** `.ar-page { padding: 2em 2.5em }` above the header; in print there is none under the last element. */
const PAGE_PADDING = 2 * EM
/**
 * Kept free at the foot of every sheet a page is filled to: about one row.
 * The row and line heights are the converter's to within a point per sheet;
 * what is estimated is where a long text wraps, and that is counted on the
 * careful side already. (The margin under a page's last element needs no
 * room: the converter drops it at the foot of a sheet.)
 */
const SPARE = 16

/** Font sizes of the style sheet, as a share of the body's. */
const FONT = { header: 0.8, h1: 1.6, h2: 1.25, h3: 1.05, h4: 1, cell: 0.95 }

/** The width text has on a page: the sheet (595 pt) less the converter's margins and the page's 2.5em on each side. */
const TEXT_WIDTH = 595 - 2 * 28.35 - 2 * 2.5 * EM
/**
 * The width a line is counted to hold when a page is filled: a fiftieth is
 * left unused, so a line is counted full a little early and never late.
 */
const CAREFUL_WIDTH = TEXT_WIDTH * 0.98
/** A bold letter is up to a tenth wider than the regular one. */
const BOLD = 1.1

/**
 * Advance widths of Times New Roman in thousandths of the font size: the
 * metrics of Times every engine prints the same. Against 491 lines of the
 * testbänk's PDFs the sum of these widths was within 0.6 % of the line.
 */
const LETTER_WIDTHS: Record<string, number> = {
  a: 444, b: 500, c: 444, d: 500, e: 444, f: 333, g: 500, h: 500, i: 278, j: 278, k: 500, l: 278, m: 778,
  n: 500, o: 500, p: 500, q: 500, r: 333, s: 389, t: 278, u: 500, v: 500, w: 722, x: 500, y: 500, z: 444,
  A: 722, B: 667, C: 667, D: 722, E: 611, F: 556, G: 722, H: 722, I: 333, J: 389, K: 722, L: 611, M: 889,
  N: 722, O: 722, P: 556, Q: 722, R: 667, S: 556, T: 611, U: 722, V: 722, W: 944, X: 722, Y: 722, Z: 611,
  ' ': 250, '\u00a0': 250, '!': 333, '"': 408, '#': 500, $: 500, '%': 833, '&': 778, "'": 180,
  '(': 333, ')': 333, '*': 500, '+': 564, ',': 250, '-': 333, '.': 250, '/': 278, ':': 278, ';': 278,
  '<': 564, '=': 564, '>': 564, '?': 444, '@': 921, '[': 333, '\\': 278, ']': 333, _: 500,
  '−': 564, '§': 500, '°': 400, '’': 333, '‘': 333, '”': 444, '“': 444, '•': 350,
  '€': 500, '£': 500, '×': 564, '±': 564, '½': 750, '…': 1000,
  // The en dash and the em dash.
  '\u2013': 500, '\u2014': 1000,
}
/** Letters with a mark print as wide as the letter under it. */
const UNMARKED: Record<string, string> = {
  å: 'a', ä: 'a', á: 'a', à: 'a', â: 'a', ö: 'o', ó: 'o', ò: 'o', ô: 'o', ø: 'o', é: 'e', è: 'e', ê: 'e',
  ë: 'e', ü: 'u', ú: 'u', í: 'i', ï: 'i', ç: 'c', ñ: 'n',
  Å: 'A', Ä: 'A', Á: 'A', À: 'A', Ö: 'O', Ó: 'O', Ø: 'O', É: 'E', È: 'E', Ü: 'U', Ç: 'C', Ñ: 'N',
}

/** Width of a text in points at a font size; a character the table lacks counts as the widest letter. */
function textWidth(text: string, fontSize: number): number {
  let thousandths = 0
  for (const character of text.normalize('NFC')) {
    const plain = UNMARKED[character] ?? character
    thousandths += plain >= '0' && plain <= '9' ? 500 : (LETTER_WIDTHS[plain] ?? 1000)
  }
  return (thousandths / 1000) * fontSize
}

/** The header of every page: two lines (name, organisation number), a rule, the space under it. */
const PAGE_HEADER: PrintBox = {
  top: 0,
  height: 2 * FONT.header * EM * NORMAL_LINE + 0.25 * FONT.header * EM + PX,
  bottom: 1.5 * FONT.header * EM,
}

const HEADINGS = new Map<string, { font: number; top: number; bottom: number }>([
  ['h1', { font: FONT.h1, top: 0, bottom: 0.5 }],
  ['h2', { font: FONT.h2, top: 1.5, bottom: 0.5 }],
  ['h3', { font: FONT.h3, top: 1.2, bottom: 0.4 }],
  ['h4', { font: FONT.h4, top: 1, bottom: 0.3 }],
])

// ---- reading the generated markup -------------------------------------------

interface Element {
  tag: string
  attrs: string
  children: Node[]
}
type Node = Element | string

const isElement = (node: Node): node is Element => typeof node !== 'string'

/**
 * The generator's own markup as a tree. It is well-formed by construction
 * (xml.ts): every attribute is double-quoted and `<`, `>` and `"` never
 * appear unescaped inside one, so tags can be read with one expression.
 */
function parse(markup: string): Node[] {
  const root: Element = { tag: '', attrs: '', children: [] }
  const open: Element[] = [root]
  const token = /<\/([\w:.-]+)\s*>|<([\w:.-]+)((?:\s+[\w:.-]+="[^"]*")*)\s*(\/?)>|([^<]+)/g
  for (const match of markup.matchAll(token)) {
    const [, closing, opening, attrs, selfClosed, text] = match
    const parent = open[open.length - 1]
    if (text !== undefined) {
      parent.children.push(text)
    } else if (opening !== undefined) {
      const element: Element = { tag: opening, attrs: attrs ?? '', children: [] }
      parent.children.push(element)
      if (!selfClosed) open.push(element)
    } else if (closing !== undefined && open.length > 1) {
      open.pop()
    }
  }
  return root.children
}

const BLOCK_TAGS = new Set(['h1', 'h2', 'h3', 'h4', 'p', 'table', 'div'])

const holdsBlock = (node: Node): boolean =>
  isElement(node) && (BLOCK_TAGS.has(node.tag) || node.children.some(holdsBlock))

const hasClass = (element: Element, name: string): boolean =>
  new RegExp(`\\sclass="(?:[^"]*\\s)?${name}(?:\\s[^"]*)?"`).test(element.attrs)

const unescaped = (text: string): string =>
  text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&')

/** The text of inline content as the lines it is forced into: one per <br/>. */
function forcedLines(nodes: readonly Node[]): string[] {
  const lines = ['']
  const walk = (node: Node): void => {
    if (!isElement(node)) lines[lines.length - 1] += unescaped(node)
    else if (node.tag === 'br') lines.push('')
    else node.children.forEach(walk)
  }
  nodes.forEach(walk)
  // Ordinary white space only: a no-break space is part of its word.
  return lines.map((line) => line.replace(/[ \t\r\n]+/g, ' ').replace(/^ | $/g, ''))
}

/**
 * Printed lines of inline content in a column `width` points wide: words
 * are set until the next one does not fit, as the converter sets them. A
 * line is divided at spaces only, so a text the converter also divides at a
 * hyphen is counted a line too long sooner than a line too short; a word
 * wider than the column counts the lines it would fill.
 */
function wrappedLines(nodes: readonly Node[], width: number, fontSize: number): number {
  const space = textWidth(' ', fontSize)
  let lines = 0
  for (const line of forcedLines(nodes)) {
    lines += 1
    let used = 0
    for (const word of line.split(' ')) {
      const wordWidth = textWidth(word, fontSize)
      if (used > 0 && used + space + wordWidth > width) {
        lines += 1
        used = 0
      }
      if (used > 0) {
        used += space + wordWidth
        continue
      }
      // The word begins a line; one wider than the column fills several.
      const further = Math.max(0, Math.ceil(wordWidth / width) - 1)
      lines += further
      used = wordWidth - further * width
    }
  }
  return lines
}

function tableBox(table: Element, lineWidth: number): PrintBox {
  const rows: Element[] = []
  const collect = (node: Node): void => {
    if (!isElement(node)) return
    if (node.tag === 'tr') rows.push(node)
    else node.children.forEach(collect)
  }
  table.children.forEach(collect)

  const cellsOf = (row: Element): Element[] =>
    row.children.filter((cell): cell is Element => isElement(cell) && (cell.tag === 'th' || cell.tag === 'td'))
  const font = FONT.cell * EM
  // Figures never wrap (td.num is nowrap): each figure column is as wide as
  // its widest figure, counted bold, and the padding to its right. A label
  // wraps in what the figure columns leave of the table's width.
  const figureColumns: number[] = []
  for (const row of rows) {
    cellsOf(row)
      .filter((cell) => hasClass(cell, 'num'))
      .forEach((cell, column) => {
        const widest = Math.max(...forcedLines(cell.children).map((line) => textWidth(line, font) * BOLD))
        figureColumns[column] = Math.max(figureColumns[column] ?? 0, widest + 0.4 * font)
      })
  }
  const labelWidth = Math.max(
    lineWidth / 4,
    lineWidth - figureColumns.reduce((sum, width) => sum + width, 0) - 0.4 * font,
  )
  let height = 0
  for (const row of rows) {
    const lines = Math.max(
      1,
      ...cellsOf(row)
        .filter((cell) => !hasClass(cell, 'num'))
        .map((cell) => wrappedLines(cell.children, labelWidth / BOLD, font)),
    )
    height += lines * font * NORMAL_LINE + 2 * 0.15 * font
    if (hasClass(row, 'subtotal')) height += PX
    if (hasClass(row, 'total')) height += 4 * PX
    if (hasClass(row, 'section')) height += 0.8 * font
  }
  return { top: 0, height, bottom: 1.2 * EM }
}

/**
 * The boxes the converter stacks for a piece of the generator's markup: one
 * per heading, paragraph and table, and one per run of text that sits in no
 * block of its own. An inline element around blocks (a fact holding
 * paragraphs) is seen through. `lineWidth` is the width a line is counted
 * to hold: the careful one unless the caller wants the likeliest height.
 */
export function measureMarkup(markup: string, lineWidth: number = CAREFUL_WIDTH): PrintBox[] {
  const boxes: PrintBox[] = []
  let inline: Node[] = []
  const closeInline = (): void => {
    if (forcedLines(inline).some((line) => line.length > 0)) {
      boxes.push({ top: 0, height: wrappedLines(inline, lineWidth, EM) * EM * NORMAL_LINE, bottom: 0 })
    }
    inline = []
  }
  const visit = (nodes: readonly Node[]): void => {
    for (const node of nodes) {
      if (!holdsBlock(node)) {
        inline.push(node)
        continue
      }
      closeInline()
      const element = node as Element
      const heading = HEADINGS.get(element.tag)
      if (heading) {
        const font = heading.font * EM
        const lines = wrappedLines(element.children, lineWidth / BOLD, font)
        boxes.push({ top: heading.top * font, height: lines * font * NORMAL_LINE, bottom: heading.bottom * font })
      } else if (element.tag === 'p') {
        boxes.push({ top: 0, height: wrappedLines(element.children, lineWidth, EM) * 1.35 * EM, bottom: 0.8 * EM })
      } else if (element.tag === 'table') {
        boxes.push(tableBox(element, lineWidth))
      } else {
        visit(element.children)
        closeInline()
      }
    }
  }
  visit(parse(markup))
  closeInline()
  return boxes
}

// ---- dividing a section into pages ------------------------------------------

/** Height of boxes stacked the CSS way: adjoining margins collapse into the larger one. */
function stackedHeight(boxes: readonly PrintBox[]): number {
  return boxes.reduce(
    (sum, box, index) => sum + box.height + (index > 0 ? Math.max(boxes[index - 1].bottom, box.top) : 0),
    0,
  )
}

/** What a page takes of its first sheet, down to the foot of its last element: padding, header, content. */
export function pageHeight(blocks: readonly PrintBlock[]): number {
  return PAGE_PADDING + stackedHeight([PAGE_HEADER, ...blocks.flatMap((block) => block.boxes)])
}

/**
 * Pages for a run of blocks, each filled until the next block would pass
 * the foot of the sheet. A block is never divided: one that is taller than
 * a sheet gets a page of its own, and that page counts the sheets it is
 * likely to fill, so that the pages after it carry their own sheet's
 * number. That count is taken from the block's likeliest height (lines at
 * their full width), not from the careful one a page is filled by.
 */
export function paginate(blocks: readonly PrintBlock[]): PrintPage[] {
  const pages: PrintPage[] = []
  let current: PrintBlock[] = []
  const close = (): void => {
    if (current.length === 0) return
    const html = current.map((block) => block.html).join('\n')
    let sheets = 1
    if (pageHeight(current) > SHEET_HEIGHT) {
      const likely = PAGE_PADDING + stackedHeight([PAGE_HEADER, ...measureMarkup(html, TEXT_WIDTH)])
      sheets = Math.max(1, Math.ceil(likely / SHEET_HEIGHT))
    }
    pages.push({ html, sheets })
    current = []
  }
  for (const block of blocks) {
    if (current.length > 0 && pageHeight([...current, block]) > SHEET_HEIGHT - SPARE) close()
    current.push(block)
  }
  close()
  return pages
}

/** A block from markup, measured. */
export function printBlock(html: string): PrintBlock {
  return { html, boxes: measureMarkup(html) }
}
