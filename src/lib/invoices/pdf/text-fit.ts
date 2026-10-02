/**
 * Fitting free text on the invoice PDF: whole-word wrapping, and how much
 * text a table row or the note may hold and still be kept on one page.
 */
import { CUSTOM_INVOICE_FONT_RENDER_PREFIX } from '@/lib/invoices/pdf-fonts'
import { HELVETICA_WIDTHS } from '@/lib/invoices/pdf-glyph-widths'
import { USABLE_PAGE_HEIGHT_PT } from '@/lib/invoices/pdf/geometry'

/**
 * react-pdf hyphenates long words with English patterns by default, which
 * split Swedish words at English syllable boundaries ("Septem-ber"). The
 * callbacks below keep every word whole that can fit its column, judged by a
 * rough ink-width estimate. Only a token that cannot fit (a URL, an e-mail
 * address, an order reference) gets break opportunities, first after its
 * natural separators and then wherever the estimate says the column is
 * full: react-pdf cannot break inside a word it was not given parts for, so a
 * token wider than its column would otherwise overprint the next column or
 * be dropped from the page entirely.
 *
 * Widths are the real Helvetica advances at 10pt (HELVETICA_WIDTHS) with a
 * 10% margin for the bundled fonts (Source Sans 3, Source Serif 4). Those
 * are narrower than Helvetica on most letters but up to 20% wider on the
 * narrow ones (i, l, I, r); ordinary words come out at or under the
 * estimate, and only a token of some 40 consecutive narrow glyphs could
 * get past it. A glyph Helvetica does not carry (Cyrillic, Greek, symbols)
 * is counted at the widest Latin advance so it can only be over-estimated.
 * Ordinary Swedish compounds up to about 28 characters come out under
 * 160pt and are never split in the narrowest column. The text itself is set
 * at 9pt, so the 10pt estimate errs on the safe side.
 */
const FONT_SIZE_PT = 10
const WIDTH_SAFETY_FACTOR = 1.1
const UNKNOWN_GLYPH_WIDTH = 1100

export function approxWidthPt(word: string): number {
  let units = 0
  for (const ch of word) {
    units += HELVETICA_WIDTHS.get(ch.codePointAt(0) ?? 0) ?? UNKNOWN_GLYPH_WIDTH
  }
  return (units / 1000) * FONT_SIZE_PT * WIDTH_SAFETY_FACTOR
}

/**
 * The narrowest description column (the VAT column shown) is about 220pt; a
 * full-width box is about 495pt. The budgets sit well under those so an
 * estimate error still lands inside the column.
 */
export const DESCRIPTION_COLUMN_PT = 160
export const FULL_WIDTH_BOX_PT = 440

export function wrapWholeWordsWithin(budgetPt: number): (word: string) => string[] {
  return (word: string): string[] => {
    if (approxWidthPt(word) <= budgetPt) return [word]
    const parts: string[] = []
    for (const piece of word.split(/(?<=[/\-.@_?&=:])/)) {
      let chunk = ''
      let chunkWidth = 0
      for (const ch of piece) {
        const w = approxWidthPt(ch)
        if (chunk.length > 0 && chunkWidth + w > budgetPt) {
          parts.push(chunk)
          chunk = ''
          chunkWidth = 0
        }
        chunk += ch
        chunkWidth += w
      }
      if (chunk.length > 0) parts.push(chunk)
    }
    return parts
  }
}

export const wrapDescriptionWords = wrapWholeWordsWithin(DESCRIPTION_COLUMN_PT)
export const wrapFullWidthWords = wrapWholeWordsWithin(FULL_WIDTH_BOX_PT)

/**
 * Keeping free text together across a page break.
 *
 * `wrap={false}` keeps a block from splitting across pages: when it does not
 * fit below what is already on the page it moves to the next page whole. But
 * react-pdf places a non-splittable block that is taller than a whole page
 * anyway, and everything past the page edge is lost. The decision is made
 * before layout, so a block of free text (line descriptions, notes) is kept
 * together only when a line estimate says it fits on an empty page; past
 * that it may split, which is the lesser evil.
 *
 * The estimate counts rendered lines, not source lines: a token wider than
 * the column is chunked by the wrap callback and each chunk can take a line
 * of its own.
 *
 * How many estimated lines may be kept together is derived from the page:
 *
 *   lines * fontSize * linePitch * estimateError + chrome <= usable height
 *
 * - usable height: what a fresh page offers the flow (USABLE_PAGE_HEIGHT_PT,
 *   pdf/geometry.ts): A4 minus the running header and footer reservations
 *   and a repeated table header, about 676pt.
 * - chrome: the block's own margin, padding and border.
 * - line pitch: react-pdf sets a line at (ascent - descent + lineGap) of the
 *   font, per pt of font size. The built-in fonts measure 1.10 (Helvetica),
 *   1.12 (Times-Roman), 1.13 (Courier), 1.326 (Source Sans 3) and 1.371
 *   (Source Serif 4); 1.4 covers them all.
 * - estimate error: the estimate uses Helvetica widths at 10pt plus 10% and
 *   4pt per space. Text of narrow letters (i, l) is its worst case. In
 *   Times-Roman and the bundled fonts those glyphs are at most 1.14 times
 *   the estimated width (Times 'l' at 278 units against 222 * 1.1), and
 *   ordinary prose comes out under the estimate; 1.35 covers both. Courier is
 *   fixed-width, every glyph and space 600 units: ordinary prose renders up
 *   to 1.31 times the estimated lines in the narrowest description column, a
 *   run of narrow letters up to 600 / (222 * 1.1) = 2.46 times. Courier gets
 *   2.5.
 *
 * Notes (9pt, 32pt of box chrome) come to 37 lines and a line description
 * (9pt, 10.5pt of row chrome) to 39 (Courier: 20 and 21): some 330pt in
 * Helvetica, about half the usable height, and still on the page in the
 * worst built-in case.
 *
 * An uploaded font can have any metrics, so it keeps the policy the earlier
 * fixed cap of 12 came from: an assumed pitch of 2 and no more than a third
 * of the page, an error factor of 3. That comes to 11 or 12 lines.
 */
export const BUILT_IN_FONT_LINE_PITCH = 1.4
export const BUILT_IN_FONT_ESTIMATE_ERROR = 1.35
export const COURIER_ESTIMATE_ERROR = 2.5
const UPLOADED_FONT_LINE_PITCH = 2
const UPLOADED_FONT_ESTIMATE_ERROR = 3

/** styles.noteText and styles.noteBox: 9pt text; marginTop 12, padding 10, no border. */
export const NOTICE_FONT_SIZE_PT = 9
export const NOTE_BOX_MARGIN_TOP_PT = 12
export const NOTE_BOX_PADDING_PT = 10
export const NOTICE_BOX_CHROME_PT = NOTE_BOX_MARGIN_TOP_PT + 2 * NOTE_BOX_PADDING_PT
/** styles.tableRow: 9pt text (the page's, inherited); paddingVertical 5, a 0.5pt rule below. */
export const TABLE_ROW_FONT_SIZE_PT = 9
export const TABLE_ROW_PADDING_PT = 5
export const TABLE_ROW_RULE_PT = 0.5
export const TABLE_ROW_CHROME_PT = 2 * TABLE_ROW_PADDING_PT + TABLE_ROW_RULE_PT

export function keepTogetherLineCap(fontFamily: string, fontSizePt: number, chromePt: number): number {
  const uploaded = fontFamily.startsWith(CUSTOM_INVOICE_FONT_RENDER_PREFIX)
  const pitch = uploaded ? UPLOADED_FONT_LINE_PITCH : BUILT_IN_FONT_LINE_PITCH
  const error = uploaded
    ? UPLOADED_FONT_ESTIMATE_ERROR
    : fontFamily === 'Courier'
      ? COURIER_ESTIMATE_ERROR
      : BUILT_IN_FONT_ESTIMATE_ERROR
  return Math.floor((USABLE_PAGE_HEIGHT_PT - chromePt) / (fontSizePt * pitch * error))
}

/**
 * The fixed cap for the ROT/RUT box. Its estimate only sees the line
 * descriptions, not the title, rows and notices or the kind and amount
 * printed around each description, so the derivation above does not hold
 * for it. 12 lines at 20pt stay under a third of the page, which leaves the
 * other two thirds for what the estimate does not count.
 */
export const MAX_KEEP_TOGETHER_LINES = 12

export function estimateLines(text: string, budgetPt: number): number {
  let lines = 0
  for (const line of text.split('\n')) {
    let chunkLines = 0
    let flowingWidth = 0
    for (const word of line.split(/\s+/)) {
      if (word.length === 0) continue
      const width = approxWidthPt(word)
      if (width > budgetPt) chunkLines += Math.ceil(width / budgetPt)
      else flowingWidth += width + 4
    }
    const flowingLines = Math.ceil(flowingWidth / budgetPt)
    lines += chunkLines + Math.max(chunkLines === 0 ? 1 : 0, flowingLines)
  }
  return lines
}

export function fitsOnOnePage(text: string | null | undefined, budgetPt: number, maxLines: number): boolean {
  if (!text) return true
  return estimateLines(text, budgetPt) <= maxLines
}

/**
 * Free text split into paragraphs at blank lines, for a block that may have
 * to split: each paragraph is then kept together on its own, so the break
 * falls between paragraphs instead of inside one. A paragraph carries the
 * blank lines that follow it, so the pieces rendered one after another lay
 * out line for line like the whole text: react-pdf drops a single trailing
 * newline and renders each further one as an empty line.
 */
export function splitParagraphs(text: string): string[] {
  return text.split(/(?<=\n[^\S\n]*\n)(?=[^\n]*\S)/)
}

/**
 * How much content (in pt) must fit below the table header on the same page
 * before react-pdf may leave the header there; otherwise the header moves to
 * the next page together with what follows it. Roughly two table rows.
 */
export const HEADING_MIN_PRESENCE_AHEAD = 40
