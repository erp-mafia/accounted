/**
 * The invoice PDF's stylesheet: the company's branding resolved against the
 * font allowlist, one quiet palette, and every zone's styles
 * (lib/invoices/pdf/geometry.ts).
 */
import { StyleSheet } from '@react-pdf/renderer'
import type { CompanySettings } from '@/types'
import {
  BUNDLED_INVOICE_FONT_FAMILIES,
  STANDARD_PDF_FONT_FAMILIES,
} from '@/lib/invoices/branding-constants'
import { CUSTOM_INVOICE_FONT_RENDER_PREFIX } from '@/lib/invoices/pdf-fonts'
import {
  A4_WIDTH_PT,
  FOOTER_BOTTOM_PT,
  LOGO_SLOT_HEIGHT_PT,
  LOGO_SLOT_WIDTH_PT,
  PAGE_MARGIN_PT,
  PAGE_PADDING_BOTTOM_PT,
  PAGE_PADDING_TOP_PT,
  PAYMENT_AREA_HEIGHT_PT,
  PAYMENT_QR_PT,
  RUNNING_HEADER_HEIGHT_PT,
} from '@/lib/invoices/pdf/geometry'
import {
  NOTE_BOX_MARGIN_TOP_PT,
  NOTE_BOX_PADDING_PT,
  NOTICE_FONT_SIZE_PT,
  TABLE_ROW_FONT_SIZE_PT,
  TABLE_ROW_PADDING_PT,
  TABLE_ROW_RULE_PT,
} from '@/lib/invoices/pdf/text-fit'

/**
 * Draft watermark geometry (#2437). One word ("UTKAST" / "DRAFT"), bold,
 * diagonal and faint, centred on every page. The font size keeps the widest
 * word ("UTKAST", 6 glyphs with letter spacing) inside the 595pt A4 width
 * once rotated. The colour and opacity are a balance: the invoice underneath
 * must stay legible, and the word must survive a monochrome print or a
 * greyscale scan, because a numbered draft otherwise carries every field of
 * a real faktura (title, number, OCR). #4b5563 at 0.3 composites to about
 * 79% brightness on white: clearly grey on paper, still background.
 */
export const DRAFT_WATERMARK_FONT_SIZE_PT = 96
export const DRAFT_WATERMARK_OPACITY = 0.3
export const DRAFT_WATERMARK_COLOR = '#4b5563'
export const DRAFT_WATERMARK_ROTATION_DEG = -35

/**
 * Status stamps (BETALD, MAKULERAD, KREDITERAD): like the watermark, outside
 * the flow, so a paid or cancelled re-render paginates exactly like the
 * original. One stamp, on page 1, in the identity band between the logo slot
 * and the title.
 */
export const STATUS_STAMP_ROTATION_DEG = -4
/** Band-relative top of the stamp: under the title block, above the meta columns. */
const STAMP_TOP_PT = 44
/**
 * The band's right-hand strip the stamp may cover, measured from the right
 * margin. The widest stamp, "BETALD 2026-10-20" at 11.5pt bold with its
 * letter spacing, padding, border and tilt, is about 150pt wide; 200 leaves
 * air. The header text line, at the stamp's height, ends left of it.
 */
export const STATUS_STAMP_RESERVE_PT = 200
/** A4 width minus the side margins: the width of the band and the flow. */
export const CONTENT_WIDTH_PT = A4_WIDTH_PT - 2 * PAGE_MARGIN_PT
/**
 * The header text's width, the same for every status: a paid or cancelled
 * re-render truncates it exactly like the original, and the stamp never
 * strikes through it.
 */
export const HEADER_TEXT_MAX_WIDTH_PT = Math.floor(CONTENT_WIDTH_PT - STATUS_STAMP_RESERVE_PT)
const STAMP_PAID_COLOR = '#2e6b4f'
const STAMP_VOID_COLOR = '#a12a2a'

// Resolved branding values used by the stylesheet. Keeping the resolved shape
// distinct from the prop shape lets us validate the font allowlist in one
// place (createStyles below) and gives the rest of the component a fully
// non-null object to work with.
export interface InvoiceBranding {
  /** Primary color: used for the document title and other strong text.
   *  Default '#1a1a1a' (the existing hardcoded value). */
  primaryColor?: string
  /** Accent color: used for muted labels and section headings.
   *  Default '#666666' (the existing hardcoded value). */
  accentColor?: string
  /** Registered react-pdf font family. Default 'Helvetica'. */
  fontFamily?: string
  /** Optional header text: one line in the identity band, under the title row. */
  headerText?: string | null
  /** Optional footer text: one line in the footer, above the statutory line. */
  footerText?: string | null
}

export interface ResolvedBranding {
  primaryColor: string
  accentColor: string
  fontFamily: string
}

const ALLOWED_FONTS = new Set<string>([
  ...STANDARD_PDF_FONT_FAMILIES,
  ...BUNDLED_INVOICE_FONT_FAMILIES,
])

/**
 * Extract the InvoicePDF branding shape from a CompanySettings row. Tolerates
 * legacy rows where the branding columns are still null/undefined: returns
 * undefined fields that resolveBranding() then maps to the legacy defaults.
 *
 * Use this at every InvoicePDF call site that has access to a CompanySettings:
 * keeping the extraction logic in one place means a future schema rename or
 * new branding field only needs to land here.
 */
export function brandingFromCompanySettings(
  company: CompanySettings | (Partial<CompanySettings> & Record<string, unknown>),
): InvoiceBranding {
  return {
    primaryColor: (company as CompanySettings).invoice_primary_color ?? undefined,
    accentColor: (company as CompanySettings).invoice_accent_color ?? undefined,
    fontFamily: (company as CompanySettings).invoice_font_family ?? undefined,
    headerText: (company as CompanySettings).invoice_header_text ?? null,
    footerText: (company as CompanySettings).invoice_footer_text ?? null,
  }
}

const DEFAULT_BRANDING: ResolvedBranding = {
  primaryColor: '#1a1a1a',
  accentColor: '#666666',
  fontFamily: 'Helvetica',
}

export function resolveBranding(branding: InvoiceBranding | undefined): ResolvedBranding {
  if (!branding) return DEFAULT_BRANDING
  const fontFamily =
    branding.fontFamily &&
    (ALLOWED_FONTS.has(branding.fontFamily) ||
      branding.fontFamily.startsWith(CUSTOM_INVOICE_FONT_RENDER_PREFIX))
      ? branding.fontFamily
      : DEFAULT_BRANDING.fontFamily
  return {
    primaryColor: branding.primaryColor || DEFAULT_BRANDING.primaryColor,
    accentColor: branding.accentColor || DEFAULT_BRANDING.accentColor,
    fontFamily,
  }
}

/**
 * The palette: one ink, the brand's muted accent for labels, hairlines, and
 * one quiet surface (the note and the payment area). No colour carries
 * meaning except the status stamps.
 */
const INK = '#1a1a1a'
const HAIRLINE = '#e2e2df'
const OUTLINE = '#d6d6d2'
const SURFACE = '#f5f5f2'

export function createStyles(branding?: InvoiceBranding) {
  const b = resolveBranding(branding)
  return StyleSheet.create({
    page: {
      paddingTop: PAGE_PADDING_TOP_PT,
      paddingBottom: PAGE_PADDING_BOTTOM_PT,
      paddingHorizontal: PAGE_MARGIN_PT,
      fontSize: TABLE_ROW_FONT_SIZE_PT,
      fontFamily: b.fontFamily,
      color: INK,
    },

    // Zone A: identity band (page 1). Pulled up into the running header's
    // reservation, which page 1 does not use.
    band: {
      marginTop: -RUNNING_HEADER_HEIGHT_PT,
      marginBottom: 22,
    },
    bandTop: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'flex-start',
    },
    logoSlot: {
      height: LOGO_SLOT_HEIGHT_PT,
      width: LOGO_SLOT_WIDTH_PT,
    },
    logo: {
      // The image box IS the slot: the logo is scaled to fit inside it
      // (never cropped) and anchored top-left. With the default centring a
      // near-square logo would be indented by half the leftover width, while
      // a wide banner logo fills the slot; anchoring makes every aspect ratio
      // start at the margin.
      width: LOGO_SLOT_WIDTH_PT,
      height: LOGO_SLOT_HEIGHT_PT,
      objectFit: 'contain',
      objectPosition: 'left top',
    },
    slotName: {
      fontSize: 15,
      fontWeight: 'bold',
      maxLines: 2,
      textOverflow: 'ellipsis',
    },
    titleBlock: {
      alignItems: 'flex-end',
      maxWidth: 270,
    },
    title: {
      fontSize: 22,
      fontWeight: 'bold',
      color: b.primaryColor,
      letterSpacing: 0.3,
    },
    titleNumber: {
      marginTop: 4,
      fontSize: 9.5,
      color: b.accentColor,
    },
    headerText: {
      marginTop: 4,
      maxWidth: HEADER_TEXT_MAX_WIDTH_PT,
      fontSize: 8.5,
      color: b.accentColor,
      maxLines: 1,
      textOverflow: 'ellipsis',
    },
    meta: {
      flexDirection: 'row',
      marginTop: 16,
    },
    metaColumn: {
      flex: 1,
      paddingRight: 16,
    },
    metaColumnLast: {
      flex: 1,
    },
    metaItem: {
      marginBottom: 6,
    },
    metaLabel: {
      fontSize: 7.5,
      color: b.accentColor,
      marginBottom: 1.5,
    },
    metaValue: {
      fontWeight: 'bold',
    },
    // The statutory party details (ML 17 kap 24 § p.5-6: seller's and
    // buyer's full name and address) and the credit note's reference are
    // never capped: a long name wraps and the band grows.
    metaNameFull: {
      fontWeight: 'bold',
    },
    metaLineFull: {},
    // Everything else in the columns (e-mail, kundnummer, Märkning) is held
    // to two lines.
    metaLine: {
      maxLines: 2,
      textOverflow: 'ellipsis',
    },
    metaReference: {
      marginTop: 5,
      maxLines: 2,
      textOverflow: 'ellipsis',
    },
    metaMuted: {
      color: b.accentColor,
    },
    metaSmall: {
      fontSize: 8,
    },

    // Zone C: the rows.
    tableHeader: {
      flexDirection: 'row',
      borderBottomWidth: 0.75,
      borderBottomColor: INK,
      paddingBottom: 5,
      marginBottom: 1,
    },
    tableHeaderText: {
      fontSize: 7,
      color: b.accentColor,
      textTransform: 'uppercase',
      letterSpacing: 0.6,
    },
    tableRow: {
      flexDirection: 'row',
      paddingVertical: TABLE_ROW_PADDING_PT,
      borderBottomWidth: TABLE_ROW_RULE_PT,
      borderBottomColor: HAIRLINE,
    },
    colDescription: {
      flex: 4.6,
      paddingRight: 8,
    },
    colQty: {
      flex: 1.3,
      textAlign: 'right',
    },
    colPrice: {
      flex: 1.5,
      textAlign: 'right',
    },
    colVat: {
      flex: 0.9,
      textAlign: 'right',
    },
    colTotal: {
      flex: 1.6,
      textAlign: 'right',
    },
    rowSubline: {
      fontSize: 7.5,
      color: b.accentColor,
      marginTop: 1,
    },
    textRow: {
      fontStyle: 'italic',
    },
    noteBox: {
      marginTop: NOTE_BOX_MARGIN_TOP_PT,
      padding: NOTE_BOX_PADDING_PT,
      backgroundColor: SURFACE,
      borderRadius: 3,
    },
    noteText: {
      fontSize: NOTICE_FONT_SIZE_PT,
    },

    // Zone D: the totals block.
    totalsBlock: {
      marginTop: 16,
    },
    totals: {
      alignSelf: 'flex-end',
      width: 250,
    },
    // The totals, notice, fine print and spacer after a ROT/RUT breakdown
    // too long to keep whole (it then comes first in the block).
    totalsAfterDeduction: {
      marginTop: 14,
    },
    totalRow: {
      flexDirection: 'row',
      paddingVertical: 1.5,
    },
    totalLabel: {
      flex: 1,
      paddingRight: 12,
      color: b.accentColor,
    },
    totalValue: {
      textAlign: 'right',
    },
    totalSmall: {
      fontSize: 8,
      color: b.accentColor,
    },
    grandTotal: {
      flexDirection: 'row',
      marginTop: 5,
      paddingTop: 6,
      borderTopWidth: 0.75,
      borderTopColor: INK,
    },
    grandTotalLabel: {
      flex: 1,
      paddingRight: 12,
      fontSize: 11,
      fontWeight: 'bold',
    },
    grandTotalValue: {
      textAlign: 'right',
      fontSize: 11,
      fontWeight: 'bold',
    },
    sekRows: {
      marginTop: 4,
    },
    // The one statutory notice slot: an outline, so it reads as a statement
    // rather than as the seller's note (which sits on the quiet surface).
    noticeSlot: {
      marginTop: 14,
      paddingVertical: 8,
      paddingHorizontal: 10,
      borderWidth: 0.75,
      borderColor: OUTLINE,
      borderRadius: 3,
    },
    noticeText: {
      fontSize: 8.5,
    },
    noticeTextNext: {
      fontSize: 8.5,
      marginTop: 3,
    },
    // ROT/RUT / grön teknik underlag: the masked personnummer, the property,
    // the per-row breakdown and the statutory notice about fakturamodellen.
    deductionBox: {
      marginTop: 14,
      padding: 10,
      borderWidth: 0.75,
      borderColor: OUTLINE,
      borderRadius: 3,
    },
    deductionTitle: {
      fontSize: 7.5,
      fontWeight: 'bold',
      marginBottom: 6,
      textTransform: 'uppercase',
      letterSpacing: 0.6,
    },
    deductionRow: {
      flexDirection: 'row',
      marginBottom: 2,
    },
    deductionLabel: {
      width: 140,
      fontSize: 8.5,
      color: b.accentColor,
    },
    deductionValue: {
      fontSize: 8.5,
      flex: 1,
    },
    deductionLineItem: {
      fontSize: 8.5,
      marginTop: 3,
    },
    deductionNotice: {
      fontSize: 7.5,
      marginTop: 6,
      color: b.accentColor,
      fontStyle: 'italic',
    },
    finePrint: {
      marginTop: 12,
    },
    finePrintText: {
      fontSize: 8,
      color: b.accentColor,
      marginBottom: 2,
    },

    // Zone E: the payment area, at the bottom of the last page.
    paymentAreaFrame: {
      position: 'absolute',
      left: PAGE_MARGIN_PT,
      right: PAGE_MARGIN_PT,
      bottom: PAGE_PADDING_BOTTOM_PT,
      height: PAYMENT_AREA_HEIGHT_PT,
    },
    paymentArea: {
      flexDirection: 'row',
      height: PAYMENT_AREA_HEIGHT_PT,
      padding: 14,
      backgroundColor: SURFACE,
      borderRadius: 4,
    },
    areaLeft: {
      width: 132,
      paddingRight: 12,
    },
    areaKicker: {
      fontSize: 7,
      fontWeight: 'bold',
      textTransform: 'uppercase',
      letterSpacing: 0.8,
      marginBottom: 9,
    },
    areaLabel: {
      fontSize: 7.5,
      color: b.accentColor,
    },
    areaAmount: {
      fontSize: 17,
      fontWeight: 'bold',
      marginTop: 1,
    },
    areaQuiet: {
      fontSize: 7.5,
      color: b.accentColor,
      marginTop: 1,
    },
    areaDetail: {
      marginTop: 10,
    },
    areaDetailValue: {
      fontSize: 9.5,
      fontWeight: 'bold',
      marginTop: 1,
    },
    areaMiddle: {
      flex: 1,
      paddingTop: 8,
      paddingRight: 14,
    },
    areaRow: {
      flexDirection: 'row',
      paddingVertical: 2.5,
      borderBottomWidth: 0.5,
      borderBottomColor: OUTLINE,
    },
    areaRowLabel: {
      width: 72,
      paddingRight: 4,
      fontSize: 8.5,
      color: b.accentColor,
    },
    areaRowValue: {
      flex: 1,
      fontSize: 8.5,
      textAlign: 'right',
    },
    areaRowValueStrong: {
      flex: 1,
      fontSize: 8.5,
      textAlign: 'right',
      fontWeight: 'bold',
    },
    areaStatusHeadline: {
      fontSize: 10,
      fontWeight: 'bold',
    },
    areaStatusText: {
      fontSize: 8,
      color: b.accentColor,
      marginTop: 4,
    },
    areaSlot: {
      width: PAYMENT_QR_PT,
    },
    qrBox: {
      width: PAYMENT_QR_PT,
      height: PAYMENT_QR_PT,
    },
    qrCaption: {
      marginTop: 3,
      fontSize: 7,
      color: b.accentColor,
      textAlign: 'center',
      maxLines: 2,
    },
    paidMarker: {
      width: PAYMENT_QR_PT,
      height: PAYMENT_QR_PT,
      alignItems: 'center',
      justifyContent: 'center',
    },
    paidMarkerTitle: {
      fontSize: 11,
      fontWeight: 'bold',
      color: STAMP_PAID_COLOR,
    },
    paidMarkerDate: {
      fontSize: 9,
      color: STAMP_PAID_COLOR,
      marginTop: 2,
    },
    paidMarkerAmount: {
      fontSize: 7.5,
      color: b.accentColor,
      marginTop: 5,
    },

    // Zone B: running header (pages 2+).
    runningHeaderFrame: {
      position: 'absolute',
      top: PAGE_MARGIN_PT,
      left: PAGE_MARGIN_PT,
      right: PAGE_MARGIN_PT,
    },
    runningHeader: {
      flexDirection: 'row',
      paddingBottom: 5,
      borderBottomWidth: 0.5,
      borderBottomColor: HAIRLINE,
    },
    runningHeaderText: {
      flex: 1,
      paddingRight: 12,
      fontSize: 7.5,
      color: b.accentColor,
      maxLines: 1,
      textOverflow: 'ellipsis',
    },
    runningHeaderPage: {
      fontSize: 7.5,
      color: b.accentColor,
      textAlign: 'right',
    },

    // Zone F: footer (every page).
    footer: {
      position: 'absolute',
      left: PAGE_MARGIN_PT,
      right: PAGE_MARGIN_PT,
      bottom: FOOTER_BOTTOM_PT,
      paddingTop: 8,
      borderTopWidth: 0.5,
      borderTopColor: HAIRLINE,
    },
    footerNote: {
      fontSize: 7,
      color: b.accentColor,
      marginBottom: 2,
      maxLines: 1,
      textOverflow: 'ellipsis',
    },
    footerRow: {
      flexDirection: 'row',
      alignItems: 'flex-start',
    },
    footerText: {
      flex: 1,
      paddingRight: 12,
      fontSize: 7,
      color: b.accentColor,
    },
    footerPage: {
      width: 50,
      fontSize: 7,
      color: b.accentColor,
      textAlign: 'right',
    },

    // Overlays.
    // Under the title and number, right-aligned: the stamp belongs to the
    // document's identity and lands in the band's free space above the
    // buyer column, clear of any logo.
    stampFrame: {
      position: 'absolute',
      top: STAMP_TOP_PT,
      right: 2,
    },
    stampPaid: {
      transform: `rotate(${STATUS_STAMP_ROTATION_DEG}deg)`,
      borderWidth: 1.5,
      borderColor: STAMP_PAID_COLOR,
      borderRadius: 4,
      paddingVertical: 3,
      paddingHorizontal: 8,
      opacity: 0.9,
    },
    stampVoid: {
      transform: `rotate(${STATUS_STAMP_ROTATION_DEG}deg)`,
      borderWidth: 1.5,
      borderColor: STAMP_VOID_COLOR,
      borderRadius: 4,
      paddingVertical: 3,
      paddingHorizontal: 8,
      opacity: 0.9,
    },
    stampPaidText: {
      fontSize: 11.5,
      fontWeight: 'bold',
      letterSpacing: 1,
      color: STAMP_PAID_COLOR,
    },
    stampVoidText: {
      fontSize: 11.5,
      fontWeight: 'bold',
      letterSpacing: 1,
      color: STAMP_VOID_COLOR,
    },
    // Draft watermark (#2437): one word, diagonal and faint, across the whole
    // page, the way a stamp marks a paper document. The overlay is absolutely
    // positioned over the page box and taken out of the flow, so a draft
    // previews exactly as the final invoice will print; `fixed` repeats it
    // on every page.
    draftWatermark: {
      position: 'absolute',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      alignItems: 'center',
      justifyContent: 'center',
    },
    // Rotation and opacity sit on a padded wrapper so the word turns about
    // the centre of its own box and the Text keeps a plain type style.
    draftWatermarkWord: {
      transform: `rotate(${DRAFT_WATERMARK_ROTATION_DEG}deg)`,
      opacity: DRAFT_WATERMARK_OPACITY,
      paddingVertical: 24,
      paddingHorizontal: 24,
    },
    draftWatermarkText: {
      fontSize: DRAFT_WATERMARK_FONT_SIZE_PT,
      fontWeight: 'bold',
      color: DRAFT_WATERMARK_COLOR,
      letterSpacing: 6,
    },
  })
}

export type PdfStyles = ReturnType<typeof createStyles>
