/**
 * Page geometry of the invoice PDF: the zones every page is built from.
 *
 *   A  identity band            page 1, top, in the flow (pulled up into the
 *                                space the running header has on later pages)
 *   B  running header           pages 2+, fixed at the top
 *   C  flow                     rows, text rows, the note
 *   D  totals block             totals, deduction underlag, one notice slot,
 *                                fine print, and a spacer as tall as zone E
 *   E  payment area             fixed height, bottom of the LAST page only
 *   F  footer                   every page, fixed at the bottom
 *   overlays                    UTKAST watermark, BETALD / MAKULERAD /
 *                                KREDITERAD stamp
 *
 * Every height here is a reservation: the page padding keeps the flow out of
 * the running header and the footer, and the spacer at the end of the totals
 * block keeps it out of the payment area. Nothing in a zone depends on the
 * invoice's status or the company's settings, so a paid re-render paginates
 * exactly like the original and a long invoice never puts the payment area
 * on a page without its totals.
 */

export const A4_HEIGHT_PT = 841.89

/** Side margins, and the top edge of the identity band (page 1) and the running header (pages 2+). */
export const PAGE_MARGIN_PT = 40

/**
 * Zone B: one 8pt line, its hairline and the gap to the flow. Reserved on
 * every page; the identity band on page 1 is pulled up into it with a
 * negative margin, so page 1 does not lose the space.
 */
export const RUNNING_HEADER_HEIGHT_PT = 28

export const PAGE_PADDING_TOP_PT = PAGE_MARGIN_PT + RUNNING_HEADER_HEIGHT_PT

/** Zone F sits this far above the page's bottom edge. */
export const FOOTER_BOTTOM_PT = 24

/**
 * Zone F at its tallest: the hairline and padding (8.5pt), one line of
 * footer text (7.5pt at a line pitch up to 1.4, plus 2pt) and two lines of
 * statutory text. A statutory line long enough for a third line grows into
 * FOOTER_GAP_PT, never into the flow.
 */
export const FOOTER_HEIGHT_PT = 42

/** Air between the end of the flow (or the payment area) and the footer. */
export const FOOTER_GAP_PT = 12

export const PAGE_PADDING_BOTTOM_PT = FOOTER_BOTTOM_PT + FOOTER_HEIGHT_PT + FOOTER_GAP_PT

/**
 * Zone E: the same height for every document that has one (faktura, partly
 * paid, paid, cancelled, credited, kreditfaktura, offert), whatever its
 * status, rows or QR code: a 96pt code with a two-line caption, or up to
 * seven payment rows, inside 14pt of padding. Proforma and följesedel have
 * no payment area and reserve nothing.
 */
export const PAYMENT_AREA_HEIGHT_PT = 150

/** Air between the end of the totals block and the payment area. */
export const PAYMENT_AREA_GAP_PT = 16

/** The table header row as it repeats on a continuation page. */
export const TABLE_HEADER_HEIGHT_PT = 20

/**
 * The height a block kept together can count on when it moves to a fresh
 * page: A4 minus the page padding (running header and footer reserved) and a
 * repeated table header.
 */
export const USABLE_PAGE_HEIGHT_PT =
  A4_HEIGHT_PT - PAGE_PADDING_TOP_PT - PAGE_PADDING_BOTTOM_PT - TABLE_HEADER_HEIGHT_PT

/** Logo slot in the identity band: fixed, the image contained inside it. */
export const LOGO_SLOT_HEIGHT_PT = 60
export const LOGO_SLOT_WIDTH_PT = 220

/** The one payment QR code: 96pt square (UsingQR asks for at least that, quiet zone included). */
export const PAYMENT_QR_PT = 96
