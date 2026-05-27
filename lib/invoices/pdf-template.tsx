import {
  Document,
  Page,
  Text,
  View,
  Image,
  StyleSheet,
} from '@react-pdf/renderer'
import type { Invoice, InvoiceItem, Customer, CompanySettings, InvoiceDocumentType } from '@/types'
import { generateOcrReference } from '@/lib/bankgiro/luhn'
import { getDisplayTotal } from '@/lib/invoices/rounding'

type PdfLang = 'sv' | 'en'

// Customer-facing labels. Statutory chapter references (ML 17 kap 24§, ML 3 kap.)
// stay intact in both locales — they identify the law, not the language.
const LABELS = {
  sv: {
    // Document titles
    titleInvoice: 'FAKTURA',
    titleCreditNote: 'KREDITFAKTURA',
    titleProforma: 'PROFORMAFAKTURA',
    titleDeliveryNote: 'FÖLJESEDEL',
    titlePreview: 'FÖRHANDSGRANSKNING',
    // Status banners
    cancelledTitle: 'MAKULERAD – inte en giltig faktura',
    cancelledWithNumber: (n: string) => `Faktura ${n} har makulerats. Numret behålls i serien för att hålla nummerföljden obruten enligt ML 17 kap 24§, men dokumentet är inte ett giltigt fakturaunderlag.`,
    cancelledNoNumber: 'Detta utkast har makulerats och är inte ett giltigt fakturaunderlag.',
    draftTitle: 'UTKAST – inte en giltig faktura',
    draftWithNumber: 'Detta är ett utkast. Markera fakturan som skickad eller skicka via systemet för att göra den giltig som fakturaunderlag.',
    draftNoNumber: 'Denna faktura saknar löpnummer och kan inte användas som fakturaunderlag enligt ML 17 kap 24§. Skicka fakturan via systemet för att tilldela ett nummer.',
    // Credit note reference
    creditNoteRef: (n: string) => `Denna kreditfaktura avser och krediterar faktura nr ${n}`,
    // Sections
    invoiceInfoHeading: 'Fakturainformation',
    billedToHeading: 'Faktureras till',
    itemsHeading: 'Specifikation',
    // Invoice details
    invoiceDate: 'Fakturadatum:',
    dueDate: 'Förfallodatum:',
    deliveryDate: 'Leveransdatum:',
    yourReference: 'Er referens:',
    ourReference: 'Vår referens:',
    // Customer box
    orgNo: 'Org.nr:',
    vat: 'VAT:',
    // Table columns
    colDescription: 'Beskrivning',
    colQty: 'Antal',
    colUnit: 'Enhet',
    colUnitPrice: 'à-pris',
    colVat: 'Moms',
    colTotal: 'Summa',
    // Totals
    subtotal: 'Delsumma:',
    net: (rate: number) => `Netto ${rate}%:`,
    vatRow: (rate: number) => `Moms ${rate}%:`,
    rounding: 'Öresavrundning:',
    deductionRow: 'Skattereduktion ROT/RUT:',
    deductionInfoHeading: 'Underlag för skattereduktion',
    deductionPersonnummer: 'Personnummer:',
    deductionHousingDesignation: 'Fastighetsbeteckning:',
    deductionApartmentNumber: 'Lägenhetsnummer:',
    deductionWorkType: 'Arbete:',
    deductionLaborHours: 'Arbetstimmar:',
    deductionNotice: 'Köparen ansöker om utbetalning hos Skatteverket via fakturamodellen. Säljaren begär utbetalning för den del köparen inte betalat.',
    toCredit: 'Att kreditera:',
    toPay: 'Att betala:',
    vatInSek: (rate: number | string) => `Moms i SEK (kurs ${rate}):`,
    totalInSek: 'Totalt i SEK:',
    // Proforma / exempt
    proformaNotice: 'Detta är en proformafaktura och utgör ingen betalningsanmodan.',
    exemptNotice: 'Undantag från skatteplikt, ML 3 kap.',
    notVatRegisteredNotice: 'Företaget är inte momsregistrerat. Mervärdesskatt redovisas ej.',
    // Payment
    paymentHeading: 'Betalningsinformation',
    bank: 'Bank:',
    account: 'Kontonummer:',
    bankgiro: 'Bankgiro:',
    plusgiro: 'Plusgiro:',
    swish: 'Swish:',
    iban: 'IBAN:',
    bic: 'BIC/SWIFT:',
    ocr: 'OCR/Referens:',
    paymentReference: 'Betalningsreferens:',
    // Footer
    orgNoLong: 'Org.nr:',
    vatRegNo: 'Momsreg.nr:',
    fSkatt: 'Godkänd för F-skatt',
  },
  en: {
    titleInvoice: 'INVOICE',
    titleCreditNote: 'CREDIT NOTE',
    titleProforma: 'PROFORMA INVOICE',
    titleDeliveryNote: 'DELIVERY NOTE',
    titlePreview: 'PREVIEW',
    cancelledTitle: 'VOID — not a valid invoice',
    cancelledWithNumber: (n: string) => `Invoice ${n} has been voided. The number is retained in the sequence to keep the numbering unbroken (ML 17 kap 24§ — Swedish VAT Act), but this document is not a valid invoice.`,
    cancelledNoNumber: 'This draft has been voided and is not a valid invoice.',
    draftTitle: 'DRAFT — not a valid invoice',
    draftWithNumber: 'This is a draft. Mark the invoice as sent, or send it via the system, to make it a valid invoice.',
    draftNoNumber: 'This invoice has no serial number and cannot be used as a valid invoice under ML 17 kap 24§ (Swedish VAT Act). Send the invoice via the system to assign a number.',
    creditNoteRef: (n: string) => `This credit note credits invoice no. ${n}`,
    invoiceInfoHeading: 'Invoice information',
    billedToHeading: 'Billed to',
    itemsHeading: 'Items',
    invoiceDate: 'Invoice date:',
    dueDate: 'Due date:',
    deliveryDate: 'Delivery date:',
    yourReference: 'Your reference:',
    ourReference: 'Our reference:',
    orgNo: 'Reg. no.:',
    vat: 'VAT:',
    colDescription: 'Description',
    colQty: 'Qty',
    colUnit: 'Unit',
    colUnitPrice: 'Unit price',
    colVat: 'VAT',
    colTotal: 'Amount',
    subtotal: 'Subtotal:',
    net: (rate: number) => `Net ${rate}%:`,
    vatRow: (rate: number) => `VAT ${rate}%:`,
    rounding: 'Rounding:',
    deductionRow: 'ROT/RUT tax reduction:',
    deductionInfoHeading: 'Tax reduction details',
    deductionPersonnummer: 'Personnummer:',
    deductionHousingDesignation: 'Property designation:',
    deductionApartmentNumber: 'Apartment number:',
    deductionWorkType: 'Service type:',
    deductionLaborHours: 'Labor hours:',
    deductionNotice: 'The customer claims the deduction via fakturamodellen at Skatteverket. The seller requests payment from the agency for the portion not paid by the customer.',
    toCredit: 'To credit:',
    toPay: 'Total due:',
    vatInSek: (rate: number | string) => `VAT in SEK (rate ${rate}):`,
    totalInSek: 'Total in SEK:',
    proformaNotice: 'This is a proforma invoice and is not a request for payment.',
    exemptNotice: 'Exempt from VAT (ML 3 kap. — Swedish VAT Act).',
    notVatRegisteredNotice: 'The seller is not VAT-registered. No VAT is charged on this invoice.',
    paymentHeading: 'Payment information',
    bank: 'Bank:',
    account: 'Account number:',
    bankgiro: 'Bankgiro:',
    plusgiro: 'Plusgiro:',
    swish: 'Swish:',
    iban: 'IBAN:',
    bic: 'BIC/SWIFT:',
    ocr: 'Reference:',
    paymentReference: 'Payment reference:',
    orgNoLong: 'Reg. no.:',
    vatRegNo: 'VAT reg. no.:',
    // Statutory Swedish phrase — kept verbatim in both locales. Peppol SE-R-005
    // and Skatteverket's F-skatt notation expect "Godkänd för F-skatt"; an
    // English translation has no legal standing.
    fSkatt: 'Godkänd för F-skatt',
  },
} as const

// Labor-only disclaimer for the ROT/RUT block. Kept Swedish-only in both
// locales — references Skatteverket's fakturamodell directly, which is a
// statutory Swedish concept and has no formal English equivalent.
const DEDUCTION_LABOR_ONLY_NOTICE =
  'Endast arbetskostnad har inkluderats i underlaget för ROT/RUT-avdrag enligt Skatteverkets fakturamodell.'

// Resolved branding values used by the stylesheet. Keeping the resolved shape
// distinct from the prop shape lets us validate the font allowlist in one
// place (createStyles below) and gives the rest of the component a fully
// non-null object to work with.
export interface InvoiceBranding {
  /** Primary color — used for the document title and other strong text.
   *  Default '#1a1a1a' (the existing hardcoded value). */
  primaryColor?: string
  /** Accent color — used for muted labels and section headings.
   *  Default '#666666' (the existing hardcoded value). */
  accentColor?: string
  /** Font family — must be one of react-pdf's built-in PostScript fonts.
   *  Default 'Helvetica'. */
  fontFamily?: string
  /** Optional banner text rendered above the document title. */
  headerText?: string | null
  /** Optional footer text rendered above the statutory company footer line. */
  footerText?: string | null
}

interface ResolvedBranding {
  primaryColor: string
  accentColor: string
  fontFamily: string
}

// react-pdf only ships these three PostScript fonts. Anything else would
// require registerFont() with a binary file — out of scope for AGPL-clean
// branding and a fingerprinting risk besides.
const ALLOWED_FONTS = new Set(['Helvetica', 'Times-Roman', 'Courier'])

/**
 * Extract the InvoicePDF branding shape from a CompanySettings row. Tolerates
 * legacy rows where the branding columns are still null/undefined — returns
 * undefined fields that resolveBranding() then maps to the legacy defaults.
 *
 * Use this at every InvoicePDF call site that has access to a CompanySettings
 * — keeping the extraction logic in one place means a future schema rename or
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

function resolveBranding(branding: InvoiceBranding | undefined): ResolvedBranding {
  if (!branding) return DEFAULT_BRANDING
  const fontFamily =
    branding.fontFamily && ALLOWED_FONTS.has(branding.fontFamily)
      ? branding.fontFamily
      : DEFAULT_BRANDING.fontFamily
  return {
    primaryColor: branding.primaryColor || DEFAULT_BRANDING.primaryColor,
    accentColor: branding.accentColor || DEFAULT_BRANDING.accentColor,
    fontFamily,
  }
}

// Create styles. Calling without args yields the original (pre-branding)
// stylesheet — required so the default code path is byte-equivalent to the
// previous hardcoded version.
function createStyles(branding?: InvoiceBranding) {
  const b = resolveBranding(branding)
  return StyleSheet.create({
    page: {
      padding: 40,
      fontSize: 10,
      fontFamily: b.fontFamily,
    },
    header: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      marginBottom: 30,
    },
    title: {
      fontSize: 24,
      fontWeight: 'bold',
      color: b.primaryColor,
    },
    companyInfo: {
      textAlign: 'left',
    },
    companyName: {
      fontSize: 14,
      fontWeight: 'bold',
      marginBottom: 4,
    },
    section: {
      marginBottom: 20,
    },
    sectionTitle: {
      fontSize: 11,
      fontWeight: 'bold',
      marginBottom: 8,
      color: b.accentColor,
      textTransform: 'uppercase',
      letterSpacing: 0.5,
    },
    row: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      marginBottom: 4,
    },
    label: {
      color: b.accentColor,
    },
    value: {
      fontWeight: 'bold',
    },
    customerBox: {
      backgroundColor: '#f5f5f5',
      padding: 15,
      borderRadius: 4,
      marginBottom: 20,
    },
    customerName: {
      fontSize: 12,
      fontWeight: 'bold',
      marginBottom: 4,
    },
    table: {
      marginTop: 10,
    },
    tableHeader: {
      flexDirection: 'row',
      borderBottomWidth: 1,
      borderBottomColor: '#ddd',
      paddingBottom: 8,
      marginBottom: 8,
    },
    tableRow: {
      flexDirection: 'row',
      paddingVertical: 6,
      borderBottomWidth: 1,
      borderBottomColor: '#eee',
    },
    colDescription: {
      flex: 3.5,
    },
    colQty: {
      flex: 1,
      textAlign: 'right',
    },
    colUnit: {
      flex: 1,
      textAlign: 'center',
    },
    colPrice: {
      flex: 1.5,
      textAlign: 'right',
    },
    colVat: {
      flex: 1,
      textAlign: 'right',
    },
    colTotal: {
      flex: 1.5,
      textAlign: 'right',
    },
    tableHeaderText: {
      fontWeight: 'bold',
      color: b.accentColor,
      fontSize: 9,
      textTransform: 'uppercase',
    },
    totalsSection: {
      marginTop: 20,
      paddingTop: 15,
      borderTopWidth: 2,
      borderTopColor: '#ddd',
    },
    totalRow: {
      flexDirection: 'row',
      justifyContent: 'flex-end',
      marginBottom: 4,
    },
    totalLabel: {
      width: 120,
      textAlign: 'right',
      paddingRight: 15,
      color: b.accentColor,
    },
    totalValue: {
      width: 100,
      textAlign: 'right',
    },
    grandTotal: {
      flexDirection: 'row',
      justifyContent: 'flex-end',
      marginTop: 10,
      paddingTop: 10,
      borderTopWidth: 1,
      borderTopColor: '#333',
    },
    grandTotalLabel: {
      width: 120,
      textAlign: 'right',
      paddingRight: 15,
      fontSize: 14,
      fontWeight: 'bold',
    },
    grandTotalValue: {
      width: 100,
      textAlign: 'right',
      fontSize: 14,
      fontWeight: 'bold',
    },
    paymentSection: {
      marginTop: 30,
      padding: 15,
      backgroundColor: '#f8f9fa',
      borderRadius: 4,
    },
    paymentTitle: {
      fontSize: 11,
      fontWeight: 'bold',
      marginBottom: 10,
      color: '#333',
    },
    paymentRow: {
      flexDirection: 'row',
      marginBottom: 4,
    },
    paymentLabel: {
      width: 100,
      color: b.accentColor,
    },
    paymentValue: {
      flex: 1,
    },
    reverseChargeBox: {
      marginTop: 20,
      padding: 12,
      backgroundColor: '#fff3cd',
      borderRadius: 4,
      borderWidth: 1,
      borderColor: '#ffc107',
    },
    reverseChargeText: {
      fontSize: 9,
      color: '#856404',
    },
    notesBox: {
      marginTop: 20,
      padding: 12,
      backgroundColor: '#e8f4fd',
      borderRadius: 4,
    },
    notesText: {
      fontSize: 9,
      color: '#0c5460',
    },
    creditNoteBox: {
      marginBottom: 20,
      padding: 12,
      backgroundColor: '#f8d7da',
      borderRadius: 4,
      borderWidth: 1,
      borderColor: '#f5c6cb',
    },
    creditNoteText: {
      fontSize: 10,
      color: '#721c24',
    },
    creditNoteTitle: {
      color: '#721c24',
    },
    draftBanner: {
      marginBottom: 16,
      padding: 10,
      backgroundColor: '#fff3cd',
      borderWidth: 2,
      borderColor: '#856404',
      borderRadius: 4,
    },
    draftBannerTitle: {
      fontSize: 14,
      fontWeight: 'bold',
      color: '#856404',
      textAlign: 'center',
      marginBottom: 2,
    },
    draftBannerText: {
      fontSize: 9,
      color: '#856404',
      textAlign: 'center',
    },
    cancelledBanner: {
      marginBottom: 16,
      padding: 10,
      backgroundColor: '#f8d7da',
      borderWidth: 2,
      borderColor: '#721c24',
      borderRadius: 4,
    },
    cancelledBannerTitle: {
      fontSize: 14,
      fontWeight: 'bold',
      color: '#721c24',
      textAlign: 'center',
      marginBottom: 2,
    },
    cancelledBannerText: {
      fontSize: 9,
      color: '#721c24',
      textAlign: 'center',
    },
    footer: {
      position: 'absolute',
      bottom: 30,
      left: 40,
      right: 40,
      borderTopWidth: 1,
      borderTopColor: '#ddd',
      paddingTop: 10,
    },
    footerText: {
      fontSize: 8,
      color: '#999',
      textAlign: 'center',
    },
    twoColumn: {
      flexDirection: 'row',
      justifyContent: 'space-between',
    },
    column: {
      width: '48%',
    },
    // New: optional branding banner above the document title.
    brandingHeader: {
      marginBottom: 12,
      paddingBottom: 8,
      borderBottomWidth: 1,
      borderBottomColor: '#eee',
    },
    brandingHeaderText: {
      fontSize: 9,
      color: b.accentColor,
      textAlign: 'left',
    },
    // ROT/RUT-avdrag info box (Skattereduktion ROT/RUT). Surfaces the
    // customer's personnummer last 4, fastighetsbeteckning, work type per
    // row and the statutory notice about fakturamodellen.
    deductionBox: {
      marginTop: 18,
      padding: 12,
      backgroundColor: '#f5f5f5',
      borderRadius: 4,
      borderWidth: 1,
      borderColor: '#ddd',
    },
    deductionTitle: {
      fontSize: 10,
      fontWeight: 'bold',
      marginBottom: 6,
      color: b.primaryColor,
      textTransform: 'uppercase',
      letterSpacing: 0.5,
    },
    deductionRow: {
      flexDirection: 'row',
      marginBottom: 3,
    },
    deductionLabel: {
      width: 130,
      fontSize: 9,
      color: b.accentColor,
    },
    deductionValue: {
      fontSize: 9,
      flex: 1,
    },
    deductionLineItem: {
      fontSize: 9,
      marginTop: 4,
      paddingLeft: 8,
      color: '#444',
    },
    deductionNotice: {
      fontSize: 8,
      marginTop: 8,
      color: b.accentColor,
      fontStyle: 'italic',
    },
    // New: optional branding footnote rendered above the statutory company
    // line in the footer block.
    brandingFooterText: {
      fontSize: 8,
      color: b.accentColor,
      textAlign: 'center',
      marginBottom: 4,
    },
  })
}

// Format currency with explicit ISO code so non-Swedish recipients see "1 234,56 SEK"
// instead of the Swedish symbol "kr". Decimal style + appended code works for any
// currency (SEK/EUR/USD) and avoids Intl's locale-specific symbol quirks.
function formatCurrency(amount: number, currency: string = 'SEK', language: PdfLang = 'sv'): string {
  const formatted = new Intl.NumberFormat(language === 'en' ? 'en-US' : 'sv-SE', {
    style: 'decimal',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount)
  return `${formatted} ${currency}`
}

// Format date as ISO yyyy-MM-dd in both locales — universally unambiguous and
// matches the project's formatDate() convention (lib/utils.ts).
// Input is already a YYYY-MM-DD string from the DB, so slice avoids the
// new Date() + local-getter timezone hazard.
function formatDate(date: string): string {
  return date.slice(0, 10)
}

// Format org number
function formatOrgNumber(orgNumber: string): string {
  const cleaned = orgNumber.replace(/\D/g, '')
  if (cleaned.length === 10) {
    return `${cleaned.slice(0, 6)}-${cleaned.slice(6)}`
  }
  return orgNumber
}

function getDocumentTitle(invoice: Invoice, lang: PdfLang): string {
  const L = LABELS[lang]
  if (invoice.credited_invoice_id) return L.titleCreditNote
  const docType = (invoice as Invoice & { document_type?: InvoiceDocumentType }).document_type || 'invoice'
  if (docType === 'proforma') return L.titleProforma
  if (docType === 'delivery_note') return L.titleDeliveryNote
  return L.titleInvoice
}

interface InvoicePDFProps {
  invoice: Invoice
  customer: Customer
  items: InvoiceItem[]
  company: CompanySettings
  originalInvoiceNumber?: string
  isPreview?: boolean
  language?: PdfLang
  /**
   * Per-company branding overrides. Omit to render with the original default
   * stylesheet — the rendered output is byte-equivalent to the pre-branding
   * version of this template, which makes the rollout safe for the snapshot
   * suite and for callers that haven't yet been migrated to forward branding.
   */
  branding?: InvoiceBranding
}

export function InvoicePDF({ invoice, customer, items, company, originalInvoiceNumber, isPreview, language, branding }: InvoicePDFProps) {
  const lang: PdfLang = language ?? customer.language ?? 'sv'
  const L = LABELS[lang]
  // Build the stylesheet per-render so each invoice picks up its company's
  // current branding. createStyles() with no argument returns the original
  // hardcoded stylesheet — the default code path is unchanged.
  const styles = createStyles(branding)
  const isCreditNote = !!invoice.credited_invoice_id

  // Check if items have mixed VAT rates
  const hasPerLineVat = items.some((item) => item.vat_rate !== undefined && item.vat_rate !== null)
  const uniqueRates = hasPerLineVat
    ? new Set(items.map((item) => item.vat_rate))
    : new Set<number>()
  const showVatColumn = hasPerLineVat && uniqueRates.size > 1

  // Calculate per-rate VAT breakdown for totals
  const vatByRate = new Map<number, { base: number; vat: number }>()
  if (hasPerLineVat) {
    for (const item of items) {
      const rate = item.vat_rate ?? 0
      const group = vatByRate.get(rate) || { base: 0, vat: 0 }
      group.base += Math.abs(item.line_total)
      group.vat += Math.abs(item.vat_amount || 0)
      vatByRate.set(rate, group)
    }
  }
  const docType = (invoice as Invoice & { document_type?: InvoiceDocumentType }).document_type || 'invoice'
  const isDeliveryNote = docType === 'delivery_note'
  const isProforma = docType === 'proforma'

  // Optional branding banner text. Rendered only when the company has set
  // invoice_header_text — invisible chrome by default, so the byte-equivalence
  // promise for un-branded callers holds.
  const headerText = branding?.headerText ?? null
  const footerText = branding?.footerText ?? null

  return (
    <Document>
      <Page size="A4" style={styles.page}>
        {/* Optional branded header — rendered above the status banners so it
            sits at the very top of the page. Non-statutory free-form text. */}
        {headerText && (
          <View style={styles.brandingHeader}>
            <Text style={styles.brandingHeaderText}>{headerText}</Text>
          </View>
        )}

        {/* Status banner — cancelled takes precedence over draft so a cancelled
            row that lacks a number (legacy un-numbered draft that was later
            cancelled) still surfaces as MAKULERAD rather than UTKAST. The draft
            banner only shows for genuine drafts and for the corrupt-state case
            of a non-cancelled invoice that somehow lacks a number. */}
        {invoice.status === 'cancelled' ? (
          <View style={styles.cancelledBanner}>
            <Text style={styles.cancelledBannerTitle}>{L.cancelledTitle}</Text>
            <Text style={styles.cancelledBannerText}>
              {invoice.invoice_number
                ? L.cancelledWithNumber(invoice.invoice_number)
                : L.cancelledNoNumber}
            </Text>
          </View>
        ) : isPreview ? null : (invoice.status === 'draft' || !invoice.invoice_number) && (
          <View style={styles.draftBanner}>
            <Text style={styles.draftBannerTitle}>{L.draftTitle}</Text>
            <Text style={styles.draftBannerText}>
              {invoice.invoice_number
                ? L.draftWithNumber
                : L.draftNoNumber}
            </Text>
          </View>
        )}

        {/* Header */}
        <View style={styles.header}>
          <View style={styles.companyInfo}>
            {company.logo_url && (company.invoice_show_logo ?? true) && (
              <Image src={company.logo_url} style={{ maxHeight: 40, maxWidth: 150, marginBottom: 6, alignSelf: 'flex-start' }} />
            )}
            {(company.invoice_show_company_name ?? true) &&
              (company.invoice_company_name_position ?? 'header') === 'header' && (
                <Text style={styles.companyName}>{company.company_name}</Text>
              )}
          </View>
          <View style={{ textAlign: 'right' }}>
            <Text style={[styles.title, isCreditNote ? styles.creditNoteTitle : {}]}>
              {getDocumentTitle(invoice, lang)}
            </Text>
            <Text style={{ marginTop: 5, color: '#666' }}>{invoice.invoice_number ?? L.titlePreview}</Text>
          </View>
        </View>

        {/* Credit note reference */}
        {isCreditNote && originalInvoiceNumber && (
          <View style={styles.creditNoteBox}>
            <Text style={styles.creditNoteText}>
              {L.creditNoteRef(originalInvoiceNumber)}
            </Text>
          </View>
        )}

        {/* Invoice details and Customer - two columns */}
        <View style={styles.twoColumn}>
          {/* Invoice details */}
          <View style={styles.column}>
            <Text style={styles.sectionTitle}>{L.invoiceInfoHeading}</Text>
            <View style={styles.row}>
              <Text style={styles.label}>{L.invoiceDate}</Text>
              <Text style={styles.value}>{formatDate(invoice.invoice_date)}</Text>
            </View>
            <View style={styles.row}>
              <Text style={styles.label}>{L.dueDate}</Text>
              <Text style={styles.value}>{formatDate(invoice.due_date)}</Text>
            </View>
            {invoice.delivery_date && invoice.delivery_date !== invoice.invoice_date && (
              <View style={styles.row}>
                <Text style={styles.label}>{L.deliveryDate}</Text>
                <Text style={styles.value}>{formatDate(invoice.delivery_date)}</Text>
              </View>
            )}
            {invoice.your_reference && (
              <View style={{ marginBottom: 4 }}>
                <Text style={styles.label}>{L.yourReference}</Text>
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 4, marginTop: 2 }}>
                  {invoice.your_reference.split(',').map((ref, i) => (
                    <Text key={i} style={{ backgroundColor: '#f0f0f0', borderRadius: 3, paddingHorizontal: 6, paddingVertical: 2, fontSize: 9, fontWeight: 'bold' }}>
                      {ref.trim()}
                    </Text>
                  ))}
                </View>
              </View>
            )}
            {invoice.our_reference && (
              <View style={{ marginBottom: 4 }}>
                <Text style={styles.label}>{L.ourReference}</Text>
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 4, marginTop: 2 }}>
                  {invoice.our_reference.split(',').map((ref, i) => (
                    <Text key={i} style={{ backgroundColor: '#f0f0f0', borderRadius: 3, paddingHorizontal: 6, paddingVertical: 2, fontSize: 9, fontWeight: 'bold' }}>
                      {ref.trim()}
                    </Text>
                  ))}
                </View>
              </View>
            )}
          </View>

          {/* Customer */}
          <View style={styles.column}>
            <Text style={styles.sectionTitle}>{L.billedToHeading}</Text>
            <View style={styles.customerBox}>
              <Text style={styles.customerName}>{customer.name}</Text>
              {customer.address_line1 && <Text>{customer.address_line1}</Text>}
              {customer.address_line2 && <Text>{customer.address_line2}</Text>}
              {(customer.postal_code || customer.city) && (
                <Text>{customer.postal_code} {customer.city}</Text>
              )}
              {customer.country && customer.country !== 'SE' && (
                <Text>{customer.country}</Text>
              )}
              {/* Suppress the identifier row for private customers — their
                  personnummer is not required on a B2C invoice (ML 17 kap 24§
                  asks for name + address only) and printing it is a GDPR
                  data-minimization regression. ROT/RUT-avdrag invoices surface
                  the masked personnummer in the dedicated deductionBox below
                  when Skatteverket needs it. */}
              {customer.customer_type !== 'individual' && customer.org_number && (
                <Text style={{ marginTop: 6 }}>{L.orgNo} {customer.org_number}</Text>
              )}
              {/* Same data-minimisation guard as org_number above — for a
                  private customer a VAT number functions as a personal tax
                  identifier in some EU jurisdictions and is not required by
                  ML 17 kap 24§ on a B2C invoice. */}
              {customer.customer_type !== 'individual' && customer.vat_number && (
                <Text>{L.vat} {customer.vat_number}</Text>
              )}
            </View>
          </View>
        </View>

        {/* Items table */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>{L.itemsHeading}</Text>
          <View style={styles.table}>
            {/* Table header */}
            <View style={styles.tableHeader}>
              <Text style={[styles.colDescription, styles.tableHeaderText]}>{L.colDescription}</Text>
              <Text style={[styles.colQty, styles.tableHeaderText]}>{L.colQty}</Text>
              <Text style={[styles.colUnit, styles.tableHeaderText]}>{L.colUnit}</Text>
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

            {/* Table rows */}
            {items.map((item, index) => (
              <View key={index} style={styles.tableRow}>
                <Text style={styles.colDescription}>{item.description}</Text>
                <Text style={styles.colQty}>{item.quantity}</Text>
                <Text style={styles.colUnit}>{item.unit}</Text>
                {!isDeliveryNote && (
                  <Text style={styles.colPrice}>{formatCurrency(item.unit_price, invoice.currency, lang)}</Text>
                )}
                {!isDeliveryNote && showVatColumn && (
                  <Text style={styles.colVat}>{item.vat_rate ?? 0}%</Text>
                )}
                {!isDeliveryNote && (
                  <Text style={styles.colTotal}>{formatCurrency(item.line_total, invoice.currency, lang)}</Text>
                )}
              </View>
            ))}
          </View>
        </View>

        {/* Totals - hidden for delivery notes */}
        {!isDeliveryNote && (
          <View style={styles.totalsSection}>
            <View style={styles.totalRow}>
              <Text style={styles.totalLabel}>{L.subtotal}</Text>
              <Text style={styles.totalValue}>{formatCurrency(invoice.subtotal, invoice.currency, lang)}</Text>
            </View>
            {vatByRate.size > 1 ? (
              Array.from(vatByRate.entries())
                .sort(([a], [b]) => b - a)
                .map(([rate, group]) => (
                  <View key={rate}>
                    <View style={styles.totalRow}>
                      <Text style={styles.totalLabel}>{L.net(rate)}</Text>
                      <Text style={styles.totalValue}>{formatCurrency(group.base, invoice.currency, lang)}</Text>
                    </View>
                    {group.vat > 0 && (
                      <View style={styles.totalRow}>
                        <Text style={styles.totalLabel}>{L.vatRow(rate)}</Text>
                        <Text style={styles.totalValue}>{formatCurrency(group.vat, invoice.currency, lang)}</Text>
                      </View>
                    )}
                  </View>
                ))
            ) : (
              // Suppress the "Moms 0%" row entirely when the seller is not
              // VAT-registered. ML 1 kap. 1§ — a non-skattskyldig may not
              // charge output VAT, so a "Moms 0%" line would imply VAT
              // accounting that doesn't exist. The notice block below the
              // payment section explains the absence of VAT.
              company.vat_registered !== false && (
                <View style={styles.totalRow}>
                  <Text style={styles.totalLabel}>{L.vatRow(invoice.vat_rate ?? (vatByRate.size === 1 ? (vatByRate.keys().next().value ?? 0) : 0))}</Text>
                  <Text style={styles.totalValue}>{formatCurrency(invoice.vat_amount, invoice.currency, lang)}</Text>
                </View>
              )
            )}
            {(() => {
              const rounding = getDisplayTotal(invoice, company)
              // ROT/RUT-avdrag reduces "Att betala" — the customer only owes
              // (total - deduction); the rest is reclaimed from Skatteverket
              // via fakturamodellen. The rule does not apply to credit notes.
              const showDeduction = !isCreditNote && (invoice.deduction_total ?? 0) > 0
              const grandTotal = showDeduction
                ? Math.round((rounding.displayed - (invoice.deduction_total ?? 0)) * 100) / 100
                : rounding.displayed
              return (
                <>
                  {rounding.applies && (
                    <View style={styles.totalRow}>
                      <Text style={[styles.totalLabel, { fontSize: 8 }]}>{L.rounding}</Text>
                      <Text style={[styles.totalValue, { fontSize: 8 }]}>{formatCurrency(rounding.roundingDelta, 'SEK', lang)}</Text>
                    </View>
                  )}
                  {showDeduction && (
                    <View style={styles.totalRow}>
                      <Text style={styles.totalLabel}>{L.deductionRow}</Text>
                      <Text style={styles.totalValue}>
                        −{formatCurrency(invoice.deduction_total ?? 0, invoice.currency, lang)}
                      </Text>
                    </View>
                  )}
                  <View style={styles.grandTotal}>
                    <Text style={styles.grandTotalLabel}>{isCreditNote ? L.toCredit : L.toPay}</Text>
                    <Text style={styles.grandTotalValue}>{formatCurrency(grandTotal, invoice.currency, lang)}</Text>
                  </View>
                </>
              )
            })()}
            {invoice.currency !== 'SEK' && invoice.total_sek && (
              <View style={{ marginTop: 8 }}>
                {invoice.vat_amount_sek != null && invoice.vat_amount_sek !== 0 && (
                  <View style={styles.totalRow}>
                    <Text style={[styles.totalLabel, { fontSize: 9 }]}>{L.vatInSek(invoice.exchange_rate ?? '')}</Text>
                    <Text style={[styles.totalValue, { fontSize: 9 }]}>{formatCurrency(invoice.vat_amount_sek, 'SEK', lang)}</Text>
                  </View>
                )}
                <View style={styles.totalRow}>
                  <Text style={[styles.totalLabel, { fontSize: 9 }]}>{L.totalInSek}</Text>
                  <Text style={[styles.totalValue, { fontSize: 9 }]}>{formatCurrency(invoice.total_sek, 'SEK', lang)}</Text>
                </View>
              </View>
            )}
          </View>
        )}

        {/* ROT/RUT-avdrag underlying details. Surfaces personnummer last 4,
            fastighetsbeteckning, lägenhetsnummer, the per-line breakdown
            and the statutory notice about fakturamodellen. Suppressed on
            delivery notes (no payment info at all). */}
        {!isDeliveryNote && !isCreditNote && (invoice.deduction_total ?? 0) > 0 && (
          <View style={styles.deductionBox} wrap={false}>
            <Text style={styles.deductionTitle}>{L.deductionInfoHeading}</Text>
            {invoice.deduction_personnummer_last4 && (
              <View style={styles.deductionRow}>
                <Text style={styles.deductionLabel}>{L.deductionPersonnummer}</Text>
                <Text style={styles.deductionValue}>XXXXXXXX-{invoice.deduction_personnummer_last4}</Text>
              </View>
            )}
            {(() => {
              // Show the first item-level housing_designation if any line
              // has one (typical case for a single property). Falls back to
              // null when only RUT lines exist (RUT doesn't require it).
              const housing = items.find((i) => i.housing_designation)?.housing_designation
              const apartment = items.find((i) => i.apartment_number)?.apartment_number
              return (
                <>
                  {housing && (
                    <View style={styles.deductionRow}>
                      <Text style={styles.deductionLabel}>{L.deductionHousingDesignation}</Text>
                      <Text style={styles.deductionValue}>{housing}</Text>
                    </View>
                  )}
                  {apartment && (
                    <View style={styles.deductionRow}>
                      <Text style={styles.deductionLabel}>{L.deductionApartmentNumber}</Text>
                      <Text style={styles.deductionValue}>{apartment}</Text>
                    </View>
                  )}
                </>
              )
            })()}
            {/* Labor-only disclaimer (Skatteverket fakturamodellen). Per ML
                17 kap, only the labor portion qualifies — material must be
                invoiced separately. */}
            <Text style={styles.deductionNotice}>{DEDUCTION_LABOR_ONLY_NOTICE}</Text>
            {/* Per-line breakdown — one row per eligible item with kind,
                work type if present and the deducted amount. */}
            {items
              .filter((i) => i.deduction_type)
              .map((i, idx) => {
                const kind = i.deduction_type === 'rot' ? 'ROT' : 'RUT'
                const work = i.work_type ? ` — ${i.work_type}` : ''
                return (
                  <Text key={idx} style={styles.deductionLineItem}>
                    {`${kind}${work}: ${i.description} — ${formatCurrency(i.deduction_amount ?? 0, invoice.currency, lang)}`}
                  </Text>
                )
              })}
            <Text style={styles.deductionNotice}>{L.deductionNotice}</Text>
          </View>
        )}

        {/* Proforma notice */}
        {isProforma && (
          <View style={[styles.reverseChargeBox, { backgroundColor: '#e8f4fd', borderColor: '#90cdf4' }]}>
            <Text style={[styles.reverseChargeText, { color: '#2b6cb0' }]}>
              {L.proformaNotice}
            </Text>
          </View>
        )}

        {/* Payment information - not shown for credit notes, proformas, or delivery notes */}
        {!isCreditNote && !isProforma && !isDeliveryNote && (
          <View style={styles.paymentSection}>
            <Text style={styles.paymentTitle}>{L.paymentHeading}</Text>
            {company.bank_name && (
              <View style={styles.paymentRow}>
                <Text style={styles.paymentLabel}>{L.bank}</Text>
                <Text style={styles.paymentValue}>{company.bank_name}</Text>
              </View>
            )}
            {(company.clearing_number || company.account_number) && (
              <View style={styles.paymentRow}>
                <Text style={styles.paymentLabel}>{L.account}</Text>
                <Text style={styles.paymentValue}>
                  {company.clearing_number}-{company.account_number}
                </Text>
              </View>
            )}
            {company.bankgiro && (company.invoice_show_bankgiro ?? true) && (
              <View style={styles.paymentRow}>
                <Text style={styles.paymentLabel}>{L.bankgiro}</Text>
                <Text style={styles.paymentValue}>{company.bankgiro}</Text>
              </View>
            )}
            {company.plusgiro && (company.invoice_show_plusgiro ?? true) && (
              <View style={styles.paymentRow}>
                <Text style={styles.paymentLabel}>{L.plusgiro}</Text>
                <Text style={styles.paymentValue}>{company.plusgiro}</Text>
              </View>
            )}
            {company.swish && (company.invoice_show_swish ?? false) && (
              <View style={styles.paymentRow}>
                <Text style={styles.paymentLabel}>{L.swish}</Text>
                <Text style={styles.paymentValue}>{company.swish}</Text>
              </View>
            )}
            {company.iban && (
              <View style={styles.paymentRow}>
                <Text style={styles.paymentLabel}>{L.iban}</Text>
                <Text style={styles.paymentValue}>{company.iban}</Text>
              </View>
            )}
            {company.bic && (
              <View style={styles.paymentRow}>
                <Text style={styles.paymentLabel}>{L.bic}</Text>
                <Text style={styles.paymentValue}>{company.bic}</Text>
              </View>
            )}
            <View style={[styles.paymentRow, { marginTop: 8 }]}>
              <Text style={styles.paymentLabel}>{L.dueDate}</Text>
              <Text style={[styles.paymentValue, { fontWeight: 'bold' }]}>{formatDate(invoice.due_date)}</Text>
            </View>
            {(company.invoice_show_ocr ?? true) && (company.bankgiro || company.plusgiro) && lang === 'sv' && (
              <View style={styles.paymentRow}>
                <Text style={styles.paymentLabel}>{L.ocr}</Text>
                <Text style={[styles.paymentValue, { fontWeight: 'bold' }]}>{invoice.invoice_number ? generateOcrReference(invoice.invoice_number) : '—'}</Text>
              </View>
            )}
            {lang !== 'sv' && invoice.invoice_number && (
              <View style={styles.paymentRow}>
                <Text style={styles.paymentLabel}>{L.paymentReference}</Text>
                <Text style={[styles.paymentValue, { fontWeight: 'bold' }]}>{invoice.invoice_number}</Text>
              </View>
            )}
          </View>
        )}

        {/* Reverse charge / export / exempt / not-registered notice.
            "Not VAT-registered" trumps the others — when the seller is
            outside the VAT system entirely (vat_registered=false in
            company_settings), reverse-charge and ML 3 kap. exempt notices
            don't apply, and a single dedicated notice is clearer for the
            customer than reusing the exempt notice (which implies the sale
            specifically is exempt while the seller is otherwise within the
            VAT system). Server-side enforcement (api/invoices/route.ts +
            preview-pdf/route.ts) coerces vat_amount to 0 for non-registered
            sellers, so this branch always lines up with what's in the
            totals block. */}
        {company.vat_registered === false ? (
          <View style={styles.reverseChargeBox}>
            <Text style={styles.reverseChargeText}>{L.notVatRegisteredNotice}</Text>
          </View>
        ) : (
          <>
            {invoice.reverse_charge_text && (
              <View style={styles.reverseChargeBox}>
                <Text style={styles.reverseChargeText}>{invoice.reverse_charge_text}</Text>
              </View>
            )}
            {invoice.vat_treatment === 'exempt' && !invoice.reverse_charge_text && (
              <View style={styles.reverseChargeBox}>
                <Text style={styles.reverseChargeText}>{L.exemptNotice}</Text>
              </View>
            )}
          </>
        )}

        {/* Notes */}
        {invoice.notes && (
          <View style={styles.notesBox}>
            <Text style={styles.notesText}>{invoice.notes}</Text>
          </View>
        )}

        {/* Late fee & credit terms */}
        {(company.invoice_late_fee_text || company.invoice_credit_terms_text) && (
          <View style={{ marginTop: 10, marginBottom: 10 }}>
            {company.invoice_late_fee_text && (
              <Text style={{ fontSize: 8, color: '#666', marginBottom: 2 }}>{company.invoice_late_fee_text}</Text>
            )}
            {company.invoice_credit_terms_text && (
              <Text style={{ fontSize: 8, color: '#666' }}>{company.invoice_credit_terms_text}</Text>
            )}
          </View>
        )}

        {/* Footer — collected legal info per ML 17 kap 24§. Optional branded
            footnote sits above the statutory line so it can never crowd out
            the compliance text (which is why the user-supplied string lives
            in its own Text node, not inside the join). */}
        <View style={styles.footer}>
          {footerText && (
            <Text style={styles.brandingFooterText}>{footerText}</Text>
          )}
          <Text style={styles.footerText}>
            {[
              (company.invoice_show_company_name ?? true) &&
              (company.invoice_company_name_position ?? 'header') === 'footer'
                ? company.company_name
                : null,
              company.address_line1,
              (company.postal_code || company.city) ? `${company.postal_code ?? ''} ${company.city ?? ''}`.trim() : null,
              company.org_number ? `${L.orgNoLong} ${formatOrgNumber(company.org_number)}` : null,
              company.vat_number ? `${L.vatRegNo} ${company.vat_number}` : null,
              company.f_skatt ? L.fSkatt : null,
            ].filter(Boolean).join(' · ')}
          </Text>
        </View>
      </Page>
    </Document>
  )
}
