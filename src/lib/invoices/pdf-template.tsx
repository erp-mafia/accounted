import { formatOrgNumber } from '@/lib/utils'
import { roundOre } from '@/lib/money'
import {
  Document,
  Page,
  Text,
  View,
  Image,
  Link,
  Svg,
  Path,
  Rect,
} from '@react-pdf/renderer'
import type { ReactNode } from 'react'
import type { Invoice, InvoiceItem, Customer, CompanySettings, InvoiceDocumentType } from '@/types'
import type { InvoicePdfPaymentQr } from '@/lib/invoices/payment-qr'
import { getAmountToPay } from '@/lib/invoices/rounding'
import { isTextLikeLine } from '@/lib/invoices/display'
import { maskedDeductionPersonnummer } from '@/lib/invoices/deduction-personnummer'
import { GRON_TEKNIK_WORK_TYPES, workTypeLabel } from '@/lib/invoices/rot-rut-rules'
import { getCountryName } from '@/lib/vat/country-codes'
import { unitLabel } from '@/lib/invoices/unit-labels'
import {
  PAYMENT_AREA_GAP_PT,
  PAYMENT_AREA_HEIGHT_PT,
  PAYMENT_QR_PT,
} from '@/lib/invoices/pdf/geometry'
import { bareLabel, formatPdfAmount, formatPdfCurrency, formatPdfDate, type PdfLang } from '@/lib/invoices/pdf/format'
import {
  DEDUCTION_LABOR_ONLY_NOTICE,
  GRON_TEKNIK_BASE_NOTICE,
  PDF_LABELS as LABELS,
  localizeVatNotice,
} from '@/lib/invoices/pdf/labels'
import {
  createStyles,
  resolveBranding,
  type InvoiceBranding,
  type PdfStyles,
} from '@/lib/invoices/pdf/styles'
import {
  DESCRIPTION_COLUMN_PT,
  FULL_WIDTH_BOX_PT,
  HEADING_MIN_PRESENCE_AHEAD,
  MAX_KEEP_TOGETHER_LINES,
  NOTICE_BOX_CHROME_PT,
  NOTICE_FONT_SIZE_PT,
  TABLE_ROW_CHROME_PT,
  TABLE_ROW_FONT_SIZE_PT,
  fitsOnOnePage,
  keepTogetherLineCap,
  splitParagraphs,
  wrapDescriptionWords,
  wrapFullWidthWords,
} from '@/lib/invoices/pdf/text-fit'
import {
  buildPdfPaymentArea,
  documentHasPaymentArea,
  resolvePdfPaidState,
  type PdfPaymentArea,
} from '@/lib/invoices/pdf/payment-area'

// The template's public surface: the render entry point, the routes, the
// editor and the tests import these from here.
export { formatPdfCurrency } from '@/lib/invoices/pdf/format'
export { resolvePdfPaidState, type PdfPaidState } from '@/lib/invoices/pdf/payment-area'
export { GRON_TEKNIK_BASE_NOTICE, localizeVatNotice } from '@/lib/invoices/pdf/labels'
export {
  DRAFT_WATERMARK_COLOR,
  DRAFT_WATERMARK_FONT_SIZE_PT,
  DRAFT_WATERMARK_OPACITY,
  DRAFT_WATERMARK_ROTATION_DEG,
  STATUS_STAMP_ROTATION_DEG,
  brandingFromCompanySettings,
  type InvoiceBranding,
} from '@/lib/invoices/pdf/styles'
export * from '@/lib/invoices/pdf/text-fit'
export {
  FOOTER_BOTTOM_PT,
  PAGE_MARGIN_PT,
  PAGE_PADDING_BOTTOM_PT,
  PAGE_PADDING_TOP_PT,
  PAYMENT_AREA_GAP_PT,
  PAYMENT_AREA_HEIGHT_PT,
  PAYMENT_QR_PT,
  RUNNING_HEADER_HEIGHT_PT,
  USABLE_PAGE_HEIGHT_PT,
} from '@/lib/invoices/pdf/geometry'


export function buildPdfVatBreakdown(items: InvoiceItem[]): Map<number, { base: number; vat: number }> {
  const vatByRate = new Map<number, { base: number; vat: number }>()
  for (const item of items) {
    if (isTextLikeLine(item)) continue
    const rate = item.vat_rate ?? 0
    const group = vatByRate.get(rate) || { base: 0, vat: 0 }
    group.base += item.line_total
    group.vat += item.vat_amount || 0
    vatByRate.set(rate, group)
  }
  return vatByRate
}

function documentNames(invoice: Invoice, lang: PdfLang): { title: string; name: string } {
  const L = LABELS[lang]
  if (invoice.credited_invoice_id) return { title: L.titleCreditNote, name: L.nameCreditNote }
  const docType = (invoice as Invoice & { document_type?: InvoiceDocumentType }).document_type || 'invoice'
  if (docType === 'proforma') return { title: L.titleProforma, name: L.nameProforma }
  if (docType === 'quote') return { title: L.titleQuote, name: L.nameQuote }
  if (docType === 'delivery_note') return { title: L.titleDeliveryNote, name: L.nameDeliveryNote }
  return { title: L.titleInvoice, name: L.nameInvoice }
}

/** What react-pdf passes a `render` prop; totalPages is only known in the final pass. */
interface PdfPageContext {
  pageNumber: number
  totalPages?: number
}

/**
 * The bank-app code's module path (one unit per module, quiet zone included)
 * scaled to the 96pt slot. The payment area is drawn by a `render` callback,
 * and react-pdf lays out what a callback returns without parsing an Svg's
 * viewBox, so a viewBox would be ignored and the code drawn one point per
 * module. The path holds only M, h, v and z, whose every number is a
 * coordinate or a length, so scaling all of them scales the drawing.
 */
export function qrPathInPoints(vector: { path: string; size: number }): string {
  const scale = PAYMENT_QR_PT / vector.size
  return vector.path.replace(/-?\d+(?:\.\d+)?/g, (n) => String(Math.round(Number(n) * scale * 1000) / 1000))
}

/** The payment area's three columns: amount, rows (or a status), and the QR slot. */
function renderPaymentArea(area: PdfPaymentArea, styles: PdfStyles, lang: PdfLang): ReactNode {
  return (
    <View style={styles.paymentArea}>
      <View style={styles.areaLeft}>
        <Text style={styles.areaKicker}>{area.kicker}</Text>
        <Text style={styles.areaLabel}>{area.amountLabel}</Text>
        <Text style={styles.areaAmount}>{formatPdfAmount(area.amount, lang)}</Text>
        <Text style={styles.areaQuiet}>{area.currency}</Text>
        {area.amountNote && <Text style={styles.areaQuiet}>{area.amountNote}</Text>}
        {area.detail && (
          <View style={styles.areaDetail}>
            <Text style={styles.areaLabel}>{area.detail.label}</Text>
            <Text style={styles.areaDetailValue}>{area.detail.value}</Text>
          </View>
        )}
      </View>
      <View style={styles.areaMiddle}>
        {area.status ? (
          <>
            <Text style={styles.areaStatusHeadline} hyphenationCallback={wrapDescriptionWords}>{area.status.headline}</Text>
            {area.status.text && (
              <Text style={styles.areaStatusText} hyphenationCallback={wrapDescriptionWords}>
                {area.status.text}
              </Text>
            )}
          </>
        ) : (
          area.rows.map((row) => (
            <View key={row.key} style={styles.areaRow}>
              <Text style={styles.areaRowLabel} hyphenationCallback={wrapDescriptionWords}>{row.label}</Text>
              {row.href ? (
                <Link src={row.href} style={styles.areaRowValue}>
                  {row.value}
                </Link>
              ) : (
                <Text
                  style={row.emphasis ? styles.areaRowValueStrong : styles.areaRowValue}
                  hyphenationCallback={wrapDescriptionWords}
                >
                  {row.value}
                </Text>
              )}
            </View>
          ))
        )}
      </View>
      <View style={styles.areaSlot}>
        {area.slot?.kind === 'qr' && (
          <>
            {/* The one payment QR code. The bank-app code is a vector path on
                a white square that includes its quiet zone, as the format
                asks; nothing is drawn over it. */}
            <View style={styles.qrBox}>
              {area.slot.qr.vector ? (
                <Svg width={PAYMENT_QR_PT} height={PAYMENT_QR_PT} style={styles.qrBox}>
                  <Rect x={0} y={0} width={PAYMENT_QR_PT} height={PAYMENT_QR_PT} fill="#ffffff" />
                  <Path d={qrPathInPoints(area.slot.qr.vector)} fill="#000000" />
                </Svg>
              ) : area.slot.qr.imageDataUrl ? (
                <Image src={area.slot.qr.imageDataUrl} style={styles.qrBox} />
              ) : null}
            </View>
            <Text style={styles.qrCaption} hyphenationCallback={wrapDescriptionWords}>
              {area.slot.qr.caption}
            </Text>
          </>
        )}
        {area.slot?.kind === 'paid' && (
          <View style={styles.paidMarker}>
            <Text style={styles.paidMarkerTitle}>{area.slot.title}</Text>
            {area.slot.date && <Text style={styles.paidMarkerDate}>{area.slot.date}</Text>}
            <Text style={styles.paidMarkerAmount}>{area.slot.amount}</Text>
          </View>
        )}
      </View>
    </View>
  )
}

/**
 * The invoice row as the template reads it. `deduction_personnummer_masked`
 * is the display form of the ROT/RUT personnummer (`YYYYMMDD-XXXX`, see
 * maskedDeductionPersonnummer). Callers that hold a plaintext value (the
 * preview route) pass it in; callers that pass the stored row can leave it
 * out and the template derives it from the ciphertext, so no render path
 * silently loses the personnummer.
 */
export type InvoicePdfInvoice = Invoice & { deduction_personnummer_masked?: string | null }

interface InvoicePDFProps {
  invoice: InvoicePdfInvoice
  customer: Customer
  items: InvoiceItem[]
  company: CompanySettings
  originalInvoiceNumber?: string
  isPreview?: boolean
  language?: PdfLang
  /**
   * Per-company branding overrides. Omit to render with the default
   * stylesheet (Helvetica, the default ink and accent).
   */
  branding?: InvoiceBranding
  /**
   * The invoice's one payment QR code, resolved and drawn by the render entry
   * point (lib/invoices/render-invoice-pdf.ts): a PNG (Swish, payment link)
   * or a vector path (bank app), with its caption. null/omitted prints none.
   */
  paymentQr?: InvoicePdfPaymentQr | null
}

/**
 * The invoice PDF, built from fixed zones (lib/invoices/pdf/geometry.ts):
 * identity band, running header, rows, totals block, payment area, footer,
 * and the overlays. Each zone has one place and a known height, so the page
 * breaks depend only on the rows and the note, never on the status, the
 * payment settings or the QR code.
 */
export function InvoicePDF({ invoice, customer, items, company, originalInvoiceNumber, isPreview, language, branding, paymentQr }: InvoicePDFProps) {
  const lang: PdfLang = language ?? customer.language ?? 'sv'
  const L = LABELS[lang]
  // Build the stylesheet per-render so each invoice picks up its company's
  // current branding.
  const styles = createStyles(branding)
  // How many estimated lines of free text a table row or the note may hold
  // and still be kept on one page, in this render's font.
  const fontFamily = resolveBranding(branding).fontFamily
  const rowLineCap = keepTogetherLineCap(fontFamily, TABLE_ROW_FONT_SIZE_PT, TABLE_ROW_CHROME_PT)
  const noteLineCap = keepTogetherLineCap(fontFamily, NOTICE_FONT_SIZE_PT, NOTICE_BOX_CHROME_PT)
  const isCreditNote = !!invoice.credited_invoice_id
  const names = documentNames(invoice, lang)
  // ROT/RUT personnummer as printed in the deduction box: YYYYMMDD-XXXX.
  // Derived from the stored ciphertext unless the caller already masked a
  // plaintext value (preview). Null when nothing is stored or it cannot be
  // decrypted, and the row is then simply omitted.
  const deductionPersonnummerMasked =
    (invoice.deduction_total ?? 0) > 0
      ? (invoice.deduction_personnummer_masked ?? maskedDeductionPersonnummer(invoice))
      : null

  // Free-text / blank rows carry no amounts: exclude them from every VAT
  // calculation. They still render as their own row in the line-items table.
  // Amount-less product rows count as text too (isTextLikeLine), so they
  // neither print zeros nor seed an empty per-rate VAT group.
  const billableItems = items.filter((item) => !isTextLikeLine(item))

  // Skattereduktion för grön teknik. It never shares an invoice with ROT/RUT
  // (refused at creation), so its presence decides the whole deduction
  // block: the reduction row, the total incl. moms, the property, what the
  // installation cost apart from övriga kostnader, and the notice.
  const hasGronTeknik = items.some((item) => item.deduction_type === 'gron_teknik')
  const lineInclVat = (item: InvoiceItem): number => roundOre((item.line_total ?? 0) + (item.vat_amount ?? 0))
  const gronTeknikEligibleCost = hasGronTeknik
    ? roundOre(billableItems.filter((item) => item.deduction_type === 'gron_teknik').reduce((sum, item) => sum + lineInclVat(item), 0))
    : 0
  // Several installation types on one invoice: Skatteverket asks for their
  // costs apart ("ska du särskilja kostnader för de olika
  // installationstyperna"), one row per type in its list order.
  const gronTeknikCostByType = hasGronTeknik
    ? GRON_TEKNIK_WORK_TYPES.map((type) => ({
        label: type.label,
        amount: roundOre(
          billableItems
            .filter((item) => item.deduction_type === 'gron_teknik' && item.work_type?.trim() === type.code)
            .reduce((sum, item) => sum + lineInclVat(item), 0),
        ),
        present: billableItems.some(
          (item) => item.deduction_type === 'gron_teknik' && item.work_type?.trim() === type.code,
        ),
      })).filter((type) => type.present)
    : []
  const gronTeknikOtherCost = hasGronTeknik
    ? roundOre(billableItems.filter((item) => !item.deduction_type).reduce((sum, item) => sum + lineInclVat(item), 0))
    : 0

  // Moms column only when the rows carry more than one rate.
  const hasPerLineVat = billableItems.some((item) => item.vat_rate !== undefined && item.vat_rate !== null)
  const uniqueRates = hasPerLineVat
    ? new Set(billableItems.map((item) => item.vat_rate))
    : new Set<number>()
  const showVatColumn = hasPerLineVat && uniqueRates.size > 1

  const vatByRate = hasPerLineVat
    ? buildPdfVatBreakdown(billableItems)
    : new Map<number, { base: number; vat: number }>()
  const docType = (invoice as Invoice & { document_type?: InvoiceDocumentType }).document_type || 'invoice'
  const isDeliveryNote = docType === 'delivery_note'
  const isProforma = docType === 'proforma'
  // A quote (offert) is never a payment request: no payment rows, no OCR,
  // no QR code (lib/invoices/payment-qr resolves none for anything but a
  // payable faktura), no payment link. Its expiry replaces the due date.
  const isQuote = docType === 'quote'

  // Shared with the invoice email (lib/email/invoice-templates.ts) so the
  // mail and the PDF always state the same "Att betala".
  const amountToPay = getAmountToPay(invoice, company)

  // Payment state (#1693). Only a real faktura carries it: credit notes are
  // settled against their original, proformas are not a payment request. It
  // changes the payment area's words and the stamp, never the flow.
  const paidState = resolvePdfPaidState(invoice, docType, isCreditNote, amountToPay.toPay)
  const paymentArea = buildPdfPaymentArea({
    invoice,
    company,
    lang,
    docType,
    isCreditNote,
    amountToPay: amountToPay.toPay,
    paidState,
    originalInvoiceNumber,
    paymentQr,
  })
  const hasPaymentArea = documentHasPaymentArea(docType, isCreditNote)

  // Draft watermark (#2437): genuine drafts, plus the corrupt-state case of a
  // non-cancelled invoice that somehow lacks a number. Cancelled wins (the
  // MAKULERAD stamp), and the interactive preview has its own title.
  const isDraftMarked =
    invoice.status !== 'cancelled' && !isPreview && (invoice.status === 'draft' || !invoice.invoice_number)

  // Status stamp: cancelled on any document; paid (with its date) and
  // credited only on a real faktura. Never on a preview or a draft.
  const stamp: { text: string; tone: 'paid' | 'void' } | null =
    invoice.status === 'cancelled'
      ? { text: L.stampCancelled, tone: 'void' }
      : isPreview || isDraftMarked || isCreditNote || docType !== 'invoice'
        ? null
        : paidState?.kind === 'paid'
          ? { text: paidState.paidDate ? `${L.stampPaid} ${paidState.paidDate}` : L.stampPaid, tone: 'paid' }
          : invoice.status === 'credited'
            ? { text: L.stampCredited, tone: 'void' }
            : null

  const headerText = branding?.headerText?.trim() || null
  const footerText = branding?.footerText?.trim() || null

  const logoUrl = (company.invoice_show_logo ?? true) ? company.logo_url : null
  const numberLine = invoice.invoice_number ? `${L.numberPrefix} ${invoice.invoice_number}` : L.titlePreview

  // Seller and buyer blocks (ML 17 kap 24 § p.4-5): name and address.
  const sellerCountry = customer.country && customer.country !== (company.country || 'SE')
    ? getCountryName(company.country || 'SE', lang)
    : null
  const postalLine = (postal: string | null | undefined, city: string | null | undefined) =>
    postal || city ? `${postal ?? ''} ${city ?? ''}`.trim() : null

  // The one notice slot: the statutory VAT notice, then the proforma or quote
  // notice. "Not VAT-registered" trumps the others ONLY when the invoice
  // actually carries no VAT: a non-registered seller who chose to state VAT
  // (warned at create time per ML 16 kap. 23 §) gets the normal reverse-charge
  // / exempt notices instead, since the "ej momsregistrerad" line would
  // contradict the VAT shown in the totals block.
  const vatNotice =
    company.vat_registered === false && invoice.vat_amount === 0
      ? L.notVatRegisteredNotice
      : invoice.reverse_charge_text
        ? localizeVatNotice(invoice.reverse_charge_text, lang)
        : invoice.vat_treatment === 'exempt'
          ? L.exemptNotice
          : null
  const notices = [vatNotice, isProforma ? L.proformaNotice : isQuote ? L.quoteNotice : null].filter(
    (n): n is string => !!n,
  )

  // Fine print: the company's payment terms (Betalningsvillkor, Dröjsmålsränta).
  // Part of the totals block, so it can never be stranded alone on a page
  // (crm#242). Payment terms, so only on a document that asks for a payment:
  // never on a quote, a kreditfaktura or a följesedel.
  const finePrint = isQuote || isDeliveryNote || isCreditNote
    ? []
    : [company.invoice_late_fee_text, company.invoice_credit_terms_text].filter((t): t is string => !!t?.trim())

  const hasDeductionBox = !isDeliveryNote && !isCreditNote && (invoice.deduction_total ?? 0) > 0
  // The totals block moves to the next page as one unit, unless a long
  // ROT/RUT breakdown makes it taller than a page could hold: then it may
  // split, each of its parts still kept whole (MAX_KEEP_TOGETHER_LINES).
  const deductionFits = !hasDeductionBox || fitsOnOnePage(
    items
      .filter((i) => i.deduction_type)
      .map((i) => i.description)
      .join('\n'),
    FULL_WIDTH_BOX_PT,
    MAX_KEEP_TOGETHER_LINES,
  )

  const metaItem = (key: string, label: string, value: string) => (
    <View key={key} style={styles.metaItem}>
      <Text style={styles.metaLabel}>{bareLabel(label)}</Text>
      <Text style={styles.metaValue}>{value}</Text>
    </View>
  )

  const statutoryLine = [
    company.company_name,
    company.address_line1,
    company.address_line2,
    postalLine(company.postal_code, company.city),
    company.org_number ? `${bareLabel(L.orgNoLong)} ${formatOrgNumber(company.org_number)}` : null,
    // Momsreg.nr only for a VAT-registered seller (ML 17 kap 24 § p.3);
    // F-skatt only when the company holds it.
    company.vat_registered !== false && company.vat_number ? `${bareLabel(L.vatRegNo)} ${company.vat_number}` : null,
    company.f_skatt ? L.fSkatt : null,
  ]
    .filter((part): part is string => !!part)
    // Each part stays whole: a line that has to wrap breaks between the
    // parts, never inside "Godkänd för F-skatt" or an address.
    .map((part) => part.replace(/ /g, '\u00a0'))
    .join(' · ')

  const descriptionCellBudget = (item: InvoiceItem) =>
    (item.discount_percent ?? 0) > 0 ? `${item.description ?? ''}\n${L.discountLine(item.discount_percent ?? 0)}` : item.description

  return (
    <Document>
      <Page size="A4" style={styles.page}>
        {/* Zone B: running header on pages 2 and later. Page 1 has the
            identity band in the same place. */}
        <View
          fixed
          style={styles.runningHeaderFrame}
          render={(context) => {
            const { pageNumber, totalPages } = context as PdfPageContext
            if (pageNumber <= 1) return null
            return (
              <View style={styles.runningHeader}>
                <Text style={styles.runningHeaderText} hyphenationCallback={wrapDescriptionWords}>
                  {[company.company_name, [names.name, invoice.invoice_number].filter(Boolean).join(' '), customer.name]
                    .filter(Boolean)
                    .join(' · ')}
                </Text>
                <Text style={styles.runningHeaderPage}>{L.pageOf(pageNumber, totalPages ?? pageNumber)}</Text>
              </View>
            )
          }}
        />

        {/* Zone A: identity band (page 1). Fixed shape: logo slot and title
            row, at most one line of header text, three meta columns. */}
        <View style={styles.band} wrap={false}>
          <View style={styles.bandTop}>
            <View style={styles.logoSlot}>
              {logoUrl ? (
                <Image src={logoUrl} style={styles.logo} />
              ) : (company.invoice_show_company_name ?? true) ? (
                <Text style={styles.slotName} hyphenationCallback={wrapDescriptionWords}>{company.company_name}</Text>
              ) : null}
            </View>
            <View style={styles.titleBlock}>
              <Text style={styles.title}>{names.title}</Text>
              <Text style={styles.titleNumber}>{numberLine}</Text>
            </View>
          </View>
          {headerText && <Text style={styles.headerText} hyphenationCallback={wrapDescriptionWords}>{headerText}</Text>}

          <View style={styles.meta}>
            {/* Document facts */}
            <View style={styles.metaColumn}>
              {isQuote ? (
                <>
                  {metaItem('date', L.quoteDate, formatPdfDate(invoice.invoice_date))}
                  {metaItem('valid', L.validUntil, formatPdfDate(invoice.valid_until || invoice.due_date))}
                </>
              ) : (
                <>
                  {metaItem('date', isDeliveryNote ? L.documentDate : L.invoiceDate, formatPdfDate(invoice.invoice_date))}
                  {!isCreditNote && !isDeliveryNote && metaItem('due', L.dueDate, formatPdfDate(invoice.due_date))}
                </>
              )}
              {invoice.delivery_date && invoice.delivery_date !== invoice.invoice_date &&
                metaItem('delivery', L.deliveryDate, formatPdfDate(invoice.delivery_date))}
              {isCreditNote && originalInvoiceNumber && (
                <Text style={[styles.metaLine, styles.metaSmall]} hyphenationCallback={wrapDescriptionWords}>{L.creditNoteRef(originalInvoiceNumber)}</Text>
              )}
            </View>

            {/* Seller */}
            <View style={styles.metaColumn}>
              <Text style={styles.metaLabel}>{L.fromHeading}</Text>
              <Text style={styles.metaName} hyphenationCallback={wrapDescriptionWords}>{company.company_name}</Text>
              {company.address_line1 && <Text style={styles.metaLine} hyphenationCallback={wrapDescriptionWords}>{company.address_line1}</Text>}
              {company.address_line2 && <Text style={styles.metaLine} hyphenationCallback={wrapDescriptionWords}>{company.address_line2}</Text>}
              {postalLine(company.postal_code, company.city) && (
                <Text style={styles.metaLine} hyphenationCallback={wrapDescriptionWords}>{postalLine(company.postal_code, company.city)}</Text>
              )}
              {sellerCountry && <Text style={styles.metaLine} hyphenationCallback={wrapDescriptionWords}>{sellerCountry}</Text>}
              {company.email && <Text style={styles.metaLine} hyphenationCallback={wrapDescriptionWords}>{company.email}</Text>}
              {invoice.our_reference && (
                <Text style={styles.metaReference} hyphenationCallback={wrapDescriptionWords}>
                  <Text style={styles.metaMuted}>{L.ourReference}</Text> {invoice.our_reference}
                </Text>
              )}
            </View>

            {/* Buyer */}
            <View style={styles.metaColumnLast}>
              <Text style={styles.metaLabel}>{L.toHeading}</Text>
              <Text style={styles.metaName} hyphenationCallback={wrapDescriptionWords}>{customer.name}</Text>
              {customer.address_line1 && <Text style={styles.metaLine} hyphenationCallback={wrapDescriptionWords}>{customer.address_line1}</Text>}
              {customer.address_line2 && <Text style={styles.metaLine} hyphenationCallback={wrapDescriptionWords}>{customer.address_line2}</Text>}
              {postalLine(customer.postal_code, customer.city) && (
                <Text style={styles.metaLine} hyphenationCallback={wrapDescriptionWords}>{postalLine(customer.postal_code, customer.city)}</Text>
              )}
              {customer.country && customer.country !== 'SE' && (
                <Text style={styles.metaLine} hyphenationCallback={wrapDescriptionWords}>{getCountryName(customer.country, lang)}</Text>
              )}
              {/* No identifier rows for a private customer: their personnummer
                  is not required on a B2C invoice (ML 17 kap 24§ asks for name
                  + address only) and printing it is a GDPR data-minimisation
                  regression; the ROT/RUT underlag carries the masked one when
                  Skatteverket needs it. A VAT number of a private person works
                  as a personal tax identifier in some EU jurisdictions. */}
              {customer.customer_type !== 'individual' && customer.org_number && (
                <Text style={styles.metaLine} hyphenationCallback={wrapDescriptionWords}>{bareLabel(L.orgNo)} {customer.org_number}</Text>
              )}
              {customer.customer_type !== 'individual' && customer.vat_number && (
                <Text style={styles.metaLine} hyphenationCallback={wrapDescriptionWords}>{bareLabel(L.vat)} {customer.vat_number}</Text>
              )}
              {/* Seller-assigned kundnummer: identifies the customer in the
                  seller's own register and carries no personal data. */}
              {customer.customer_number && (
                <Text style={styles.metaLine} hyphenationCallback={wrapDescriptionWords}>{bareLabel(L.custNo)} {customer.customer_number}</Text>
              )}
              {invoice.your_reference && (
                <Text style={styles.metaReference} hyphenationCallback={wrapDescriptionWords}>
                  <Text style={styles.metaMuted}>{L.yourReference}</Text> {invoice.your_reference}
                </Text>
              )}
              {/* Fakturamärkning: one buyer-required marking string. */}
              {invoice.invoice_marking && (
                <Text style={styles.metaLine} hyphenationCallback={wrapDescriptionWords}>
                  <Text style={styles.metaMuted}>{L.invoiceMarking}</Text> {invoice.invoice_marking.trim()}
                </Text>
              )}
            </View>
          </View>

          {/* Status stamp: out of the flow, page 1, under the title. Painted
              after the band's own content. */}
          {stamp && (
            <View style={styles.stampFrame}>
              <View style={stamp.tone === 'paid' ? styles.stampPaid : styles.stampVoid}>
                <Text style={stamp.tone === 'paid' ? styles.stampPaidText : styles.stampVoidText}>{stamp.text}</Text>
              </View>
            </View>
          )}
        </View>

        {/* Zone C: the rows. The header row is `fixed` inside the table, so
            it repeats on every page the table continues to. */}
        <View>
          <View style={styles.tableHeader} fixed minPresenceAhead={HEADING_MIN_PRESENCE_AHEAD}>
            <Text style={[styles.colDescription, styles.tableHeaderText]}>{L.colDescription}</Text>
            <Text style={[styles.colQty, styles.tableHeaderText]}>{L.colQty}</Text>
            {!isDeliveryNote && (
              <Text style={[styles.colPrice, styles.tableHeaderText]}>{L.colUnitPrice}</Text>
            )}
            {!isDeliveryNote && showVatColumn && (
              <Text style={[styles.colVat, styles.tableHeaderText]}>{L.colVat}</Text>
            )}
            {!isDeliveryNote && (
              <Text style={[styles.colTotal, styles.tableHeaderText]}>{L.colTotal}</Text>
            )}
          </View>

          {items.map((item, index) =>
            isTextLikeLine(item) ? (
              // Free-text / blank row: description spans the full width, no
              // numeric columns. An empty description renders as a spacer.
              <View
                key={index}
                style={styles.tableRow}
                wrap={!fitsOnOnePage(item.description, FULL_WIDTH_BOX_PT, rowLineCap)}
              >
                <Text style={[styles.colDescription, styles.textRow, { width: '100%' }]} hyphenationCallback={wrapFullWidthWords}>
                  {item.description || ' '}
                </Text>
              </View>
            ) : (
              <View
                key={index}
                style={styles.tableRow}
                wrap={!fitsOnOnePage(descriptionCellBudget(item), DESCRIPTION_COLUMN_PT, rowLineCap)}
              >
                <View style={styles.colDescription}>
                  <Text hyphenationCallback={wrapDescriptionWords}>{item.description}</Text>
                  {/* A discount is stated on the row (ML 17 kap 24 § p.10:
                      prisnedsättning ska framgå); line_total is already net. */}
                  {!isDeliveryNote && (item.discount_percent ?? 0) > 0 && (
                    <Text style={styles.rowSubline} hyphenationCallback={wrapDescriptionWords}>{L.discountLine(item.discount_percent ?? 0)}</Text>
                  )}
                </View>
                <Text style={styles.colQty}>{item.quantity} {unitLabel(item.unit, lang)}</Text>
                {!isDeliveryNote && (
                  <Text style={styles.colPrice}>{formatPdfAmount(item.unit_price, lang)}</Text>
                )}
                {!isDeliveryNote && showVatColumn && (
                  <Text style={styles.colVat}>{item.vat_rate ?? 0}%</Text>
                )}
                {!isDeliveryNote && (
                  <Text style={styles.colTotal}>{formatPdfAmount(item.line_total, lang)}</Text>
                )}
              </View>
            )
          )}
        </View>

        {/* The note: directly under the rows it annotates. Moves to the next
            page whole whenever it fits on one; a note too long for any page
            splits between its paragraphs, each kept together when it fits. */}
        {invoice.notes && (
          <View style={styles.noteBox} wrap={!fitsOnOnePage(invoice.notes, FULL_WIDTH_BOX_PT, noteLineCap)}>
            {splitParagraphs(invoice.notes).map((paragraph, index) => (
              <Text
                key={index}
                style={styles.noteText}
                hyphenationCallback={wrapFullWidthWords}
                wrap={!fitsOnOnePage(paragraph, FULL_WIDTH_BOX_PT, noteLineCap)}
              >
                {paragraph}
              </Text>
            ))}
          </View>
        )}

        {/* Zone D: the totals block. Totals, the deduction underlag, the one
            notice slot, the fine print and a spacer as tall as the payment
            area, together: it moves to the next page as a unit, and the page
            it lands on is the last one, where the payment area is drawn over
            the spacer. */}
        <View style={styles.totalsBlock} wrap={!deductionFits}>
          {!isDeliveryNote && (
            <View style={styles.totals} wrap={false}>
              <View style={styles.totalRow}>
                <Text style={styles.totalLabel}>{bareLabel(L.subtotal)}</Text>
                <Text style={styles.totalValue}>{formatPdfAmount(invoice.subtotal, lang)}</Text>
              </View>
              {vatByRate.size > 1 ? (
                Array.from(vatByRate.entries())
                  .sort(([a], [b]) => b - a)
                  .map(([rate, group]) => (
                    <View key={rate}>
                      <View style={styles.totalRow}>
                        <Text style={styles.totalLabel}>{bareLabel(L.net(rate))}</Text>
                        <Text style={styles.totalValue}>{formatPdfAmount(group.base, lang)}</Text>
                      </View>
                      {group.vat !== 0 && (
                        <View style={styles.totalRow}>
                          <Text style={styles.totalLabel}>{bareLabel(L.vatRow(rate))}</Text>
                          <Text style={styles.totalValue}>{formatPdfAmount(group.vat, lang)}</Text>
                        </View>
                      )}
                    </View>
                  ))
              ) : (
                // Suppress the "Moms 0%" row only when the seller is not
                // VAT-registered AND the invoice actually carries no VAT.
                // A non-registered seller who states VAT (warned at create time
                // per ML 16 kap. 23 §) still gets the totals row so the printed
                // invoice matches what the customer is being asked to pay.
                !(company.vat_registered === false && invoice.vat_amount === 0) && (
                  <View style={styles.totalRow}>
                    <Text style={styles.totalLabel}>{bareLabel(L.vatRow(invoice.vat_rate ?? (vatByRate.size === 1 ? (vatByRate.keys().next().value ?? 0) : 0)))}</Text>
                    <Text style={styles.totalValue}>{formatPdfAmount(invoice.vat_amount, lang)}</Text>
                  </View>
                )
              )}
              {amountToPay.rounding.applies && (
                <View style={styles.totalRow}>
                  <Text style={styles.totalLabel}>{bareLabel(L.rounding)}</Text>
                  <Text style={styles.totalValue}>{formatPdfAmount(amountToPay.rounding.roundingDelta, lang)}</Text>
                </View>
              )}
              {amountToPay.deductionApplies && hasGronTeknik && (
                // Grön teknik: "Fakturans totala belopp och
                // skattereduktionens storlek", both incl. moms.
                <View style={styles.totalRow}>
                  <Text style={styles.totalLabel}>{bareLabel(L.totalInclVat)}</Text>
                  <Text style={styles.totalValue}>{formatPdfAmount(amountToPay.rounding.displayed, lang)}</Text>
                </View>
              )}
              {amountToPay.deductionApplies && (
                <View style={styles.totalRow}>
                  <Text style={styles.totalLabel}>{bareLabel(hasGronTeknik ? L.deductionRowGronTeknik : L.deductionRow)}</Text>
                  <Text style={styles.totalValue}>
                    {/* deduction_total is stored as a positive magnitude;
                        -Math.abs() keeps the row a reduction even if the
                        stored sign convention ever changes. */}
                    {formatPdfAmount(-Math.abs(invoice.deduction_total ?? 0), lang)}
                  </Text>
                </View>
              )}
              {/* The document as issued: the same rows paid or unpaid, so a
                  re-render paginates like the original. What is still due
                  lives in the payment area. */}
              <View style={styles.grandTotal}>
                <Text style={styles.grandTotalLabel}>{bareLabel(isCreditNote ? L.toCredit : isQuote ? L.totalQuote : L.toPay)}</Text>
                <Text style={styles.grandTotalValue}>{formatPdfCurrency(amountToPay.toPay, invoice.currency, lang)}</Text>
              </View>
              {/* ML 17 kap 29 §: VAT in SEK on a foreign-currency invoice. */}
              {invoice.currency !== 'SEK' && invoice.total_sek && (
                <View style={styles.sekRows}>
                  {invoice.vat_amount_sek != null && invoice.vat_amount_sek !== 0 && (
                    <View style={styles.totalRow}>
                      <Text style={[styles.totalLabel, styles.totalSmall]}>{bareLabel(L.vatInSek(invoice.exchange_rate ?? ''))}</Text>
                      <Text style={[styles.totalValue, styles.totalSmall]}>{formatPdfCurrency(invoice.vat_amount_sek, 'SEK', lang)}</Text>
                    </View>
                  )}
                  <View style={styles.totalRow}>
                    <Text style={[styles.totalLabel, styles.totalSmall]}>{bareLabel(L.totalInSek)}</Text>
                    <Text style={[styles.totalValue, styles.totalSmall]}>{formatPdfCurrency(invoice.total_sek, 'SEK', lang)}</Text>
                  </View>
                </View>
              )}
            </View>
          )}

          {hasDeductionBox && (
            // Kept on one page while the per-line breakdown (which carries the
            // line descriptions, possibly multi-line) is short enough; past
            // that it may split rather than be clipped. Fixed cap: the estimate
            // does not see the rest of the box (MAX_KEEP_TOGETHER_LINES).
            <View style={styles.deductionBox} wrap={!deductionFits}>
              <Text style={styles.deductionTitle}>{L.deductionInfoHeading}</Text>
              {deductionPersonnummerMasked && (
                <View style={styles.deductionRow}>
                  <Text style={styles.deductionLabel}>{bareLabel(L.deductionPersonnummer)}</Text>
                  <Text style={styles.deductionValue} hyphenationCallback={wrapDescriptionWords}>{deductionPersonnummerMasked}</Text>
                </View>
              )}
              {(() => {
                // The first item-level housing_designation (typical: a single
                // property). RUT-only invoices have none.
                const housing = items.find((i) => i.housing_designation)?.housing_designation
                const apartment = items.find((i) => i.apartment_number)?.apartment_number
                // Grön teknik in a bostadsrätt: the förening's orgnr goes with
                // the lägenhetsnummer.
                const brf = hasGronTeknik ? items.find((i) => i.brf_org_number)?.brf_org_number : null
                return (
                  <>
                    {housing && (
                      <View style={styles.deductionRow}>
                        <Text style={styles.deductionLabel}>{bareLabel(L.deductionHousingDesignation)}</Text>
                        <Text style={styles.deductionValue} hyphenationCallback={wrapDescriptionWords}>{housing}</Text>
                      </View>
                    )}
                    {apartment && (
                      <View style={styles.deductionRow}>
                        <Text style={styles.deductionLabel}>{bareLabel(L.deductionApartmentNumber)}</Text>
                        <Text style={styles.deductionValue} hyphenationCallback={wrapDescriptionWords}>{apartment}</Text>
                      </View>
                    )}
                    {brf && (
                      <View style={styles.deductionRow}>
                        <Text style={styles.deductionLabel}>{bareLabel(L.deductionBrfOrgNumber)}</Text>
                        <Text style={styles.deductionValue} hyphenationCallback={wrapDescriptionWords}>{brf}</Text>
                      </View>
                    )}
                  </>
                )
              })()}
              {hasGronTeknik && (
                <>
                  {gronTeknikCostByType.length > 1 ? (
                    gronTeknikCostByType.map((type, idx) => (
                      <View key={type.label} style={styles.deductionRow}>
                        <Text style={styles.deductionLabel}>{idx === 0 ? bareLabel(L.gronTeknikEligibleCost) : ''}</Text>
                        <Text style={styles.deductionValue} hyphenationCallback={wrapDescriptionWords}>
                          {`${type.label}: ${formatPdfCurrency(type.amount, invoice.currency, lang)} ${L.inclVatSuffix}`}
                        </Text>
                      </View>
                    ))
                  ) : (
                    <View style={styles.deductionRow}>
                      <Text style={styles.deductionLabel}>{bareLabel(L.gronTeknikEligibleCost)}</Text>
                      <Text style={styles.deductionValue} hyphenationCallback={wrapDescriptionWords}>
                        {`${formatPdfCurrency(gronTeknikEligibleCost, invoice.currency, lang)} ${L.inclVatSuffix}`}
                      </Text>
                    </View>
                  )}
                  <View style={styles.deductionRow}>
                    <Text style={styles.deductionLabel}>{bareLabel(L.gronTeknikOtherCost)}</Text>
                    <Text style={styles.deductionValue} hyphenationCallback={wrapDescriptionWords}>
                      {`${formatPdfCurrency(gronTeknikOtherCost, invoice.currency, lang)} ${L.inclVatSuffix}`}
                    </Text>
                  </View>
                </>
              )}
              {/* What the base covers (Skatteverket fakturamodellen): labor
                  only for ROT/RUT, material invoiced separately. Grön teknik
                  prints its base once, after the breakdown (below). */}
              {!hasGronTeknik && (
                <Text style={styles.deductionNotice}>{DEDUCTION_LABOR_ONLY_NOTICE}</Text>
              )}
              {/* Per-line breakdown: one row per eligible item with kind,
                  work type if present and the deducted amount. */}
              {items
                .filter((i) => i.deduction_type)
                .map((i, idx) => {
                  // Grön teknik rows name the installation type (Skatteverket:
                  // "vilken typ av arbete"); ROT/RUT rows keep printing the code.
                  const isGronTeknik = i.deduction_type === 'gron_teknik'
                  const kind = isGronTeknik ? L.gronTeknikKind : i.deduction_type === 'rot' ? 'ROT' : 'RUT'
                  const workText = isGronTeknik ? (workTypeLabel(i.work_type) ?? i.work_type) : i.work_type
                  const work = workText ? `, ${workText}` : ''
                  return (
                    <Text key={idx} style={styles.deductionLineItem} hyphenationCallback={wrapFullWidthWords}>
                      {`${kind}${work}: ${i.description}, ${formatPdfCurrency(i.deduction_amount ?? 0, invoice.currency, lang)}`}
                    </Text>
                  )
                })}
              {/* Grön teknik: labor and material, övriga kostnader excluded,
                  and the seller requests the payout: one notice. ROT/RUT keep
                  their own notice as it was. */}
              <Text style={styles.deductionNotice}>
                {hasGronTeknik ? `${GRON_TEKNIK_BASE_NOTICE} ${L.gronTeknikPayoutNotice}` : L.deductionNotice}
              </Text>
            </View>
          )}

          {notices.length > 0 && (
            <View style={styles.noticeSlot} wrap={false}>
              {notices.map((notice, index) => (
                <Text
                  key={index}
                  style={index === 0 ? styles.noticeText : styles.noticeTextNext}
                  hyphenationCallback={wrapFullWidthWords}
                >
                  {notice}
                </Text>
              ))}
            </View>
          )}

          {/* Fine print and the payment area's reservation, kept together so
              the last page always has room for the payment area. */}
          {(finePrint.length > 0 || hasPaymentArea) && (
            <View wrap={false}>
              {finePrint.length > 0 && (
                <View style={styles.finePrint}>
                  {finePrint.map((text, index) => (
                    <Text key={index} style={styles.finePrintText} hyphenationCallback={wrapFullWidthWords}>
                      {text}
                    </Text>
                  ))}
                </View>
              )}
              {hasPaymentArea && <View style={{ height: PAYMENT_AREA_HEIGHT_PT + PAYMENT_AREA_GAP_PT }} />}
            </View>
          )}
        </View>

        {/* Zone E: the payment area, drawn over the spacer at the bottom of
            the last page. Fixed height for every status (R8). */}
        {paymentArea && (
          <View
            fixed
            style={styles.paymentAreaFrame}
            render={(context) => {
              const { pageNumber, totalPages } = context as PdfPageContext
              return pageNumber === totalPages ? renderPaymentArea(paymentArea, styles, lang) : null
            }}
          />
        )}

        {/* Zone F: footer on every page. The company's statutory details
            (ML 17 kap 24 §), at most one line of the company's own footer
            text above them, and the page number. */}
        <View style={styles.footer} fixed>
          {footerText && <Text style={styles.footerNote} hyphenationCallback={wrapDescriptionWords}>{footerText}</Text>}
          <View style={styles.footerRow}>
            <Text style={styles.footerText} hyphenationCallback={wrapFullWidthWords}>
              {statutoryLine}
            </Text>
            <Text
              style={styles.footerPage}
              render={({ pageNumber, totalPages }) => L.pageOf(pageNumber, totalPages ?? pageNumber)}
            />
          </View>
        </View>

        {/* Draft watermark (#2437), deliberately the LAST child of the page:
            react-pdf paints children in document order and `fixed` does not
            hoist, so anything emitted after it with a backgroundColor (the
            note, the payment area) would paint over the word. Absolute +
            fixed keeps it out of the flow on every page. */}
        {isDraftMarked && (
          <View style={styles.draftWatermark} fixed>
            <View style={styles.draftWatermarkWord}>
              <Text style={styles.draftWatermarkText}>{L.draftWatermark}</Text>
            </View>
          </View>
        )}
      </Page>
    </Document>
  )
}
