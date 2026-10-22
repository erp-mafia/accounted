import { Document, Image, Page, Text, View, StyleSheet } from '@react-pdf/renderer'
import { pdfNumberText } from '@/lib/pdf/number-text'
import { normalizeVatRateToFraction } from '@/lib/vat/vat-rate-unit'
import { roundOre } from '@/lib/money'
import type { SelfBillingParty, SelfBillingSnapshot } from './snapshot'
import { DEFAULT_SELF_BILLING_BRANDING, type SelfBillingBranding } from './branding'

/**
 * The self-billing invoice (självfaktura) a buyer issues in its supplier's
 * name (crm#1367). Its own template, not InvoicePDF: that one hard-wires the
 * company as the seller (seller block, F-skatt footer, payment area and QR
 * from the company), and here the company is the buyer and the issuer.
 *
 * What it prints follows ML 2023:200 17 kap 24 §: the date (p.1), the number
 * from the issuer's series (p.2), the seller's momsregistreringsnummer (p.3),
 * both parties' names and addresses (p.5-6), the lines (p.7), the delivery
 * date when there is one (p.8), the base per VAT rate and the unit prices
 * excluding VAT (p.9), the rate (p.10), the VAT amount (p.11) and the
 * notation "Självfakturering" (p.12). Plus the prior agreement and the
 * acceptance clause of 17 kap 15 §. A credit note names the invoice it
 * credits (17 kap 22 §) and shows its amounts as negative.
 *
 * Swedish only: suppliers carry no language, and an underlag is
 * räkenskapsinformation. Everything printed comes from the stored row and its
 * snapshot, so the document renders the same every time.
 */

export interface SelfBillingPdfInvoice {
  supplier_invoice_number: string | null
  invoice_date: string
  due_date: string
  delivery_date: string | null
  currency: string
  subtotal: number
  vat_amount: number
  total: number
  is_credit_note: boolean
}

export interface SelfBillingPdfItem {
  sort_order: number
  description: string
  quantity: number
  unit: string | null
  unit_price: number
  line_total: number
  vat_rate: number
  vat_amount: number
}

export interface SelfBillingPdfProps {
  invoice: SelfBillingPdfInvoice
  items: SelfBillingPdfItem[]
  snapshot: SelfBillingSnapshot
  branding?: SelfBillingBranding
}

/** Base and VAT per rate, from the stored lines (what the verifikat booked). */
export function selfBillingVatSummary(items: SelfBillingPdfItem[]): Array<{ ratePercent: number; base: number; vat: number }> {
  const byRate = new Map<number, { base: number; vat: number }>()
  for (const item of items) {
    const ratePercent = roundOre(normalizeVatRateToFraction(item.vat_rate) * 100)
    const group = byRate.get(ratePercent) ?? { base: 0, vat: 0 }
    group.base = roundOre(group.base + item.line_total)
    group.vat = roundOre(group.vat + item.vat_amount)
    byRate.set(ratePercent, group)
  }
  return [...byRate.entries()]
    .sort(([a], [b]) => b - a)
    .map(([ratePercent, group]) => ({ ratePercent, ...group }))
}

/** "18 563,00": the Swedish amount, safe for a standard PDF font. */
const amount = (value: number, sign: 1 | -1): string =>
  pdfNumberText(
    new Intl.NumberFormat('sv-SE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(roundOre(value * sign)),
  )

/** The date as stored, YYYY-MM-DD. */
const pdfDate = (date: string): string => date.slice(0, 10)

function quantityText(quantity: number): string {
  return pdfNumberText(new Intl.NumberFormat('sv-SE', { maximumFractionDigits: 4 }).format(quantity))
}

function ratePercentText(ratePercent: number): string {
  return `${pdfNumberText(new Intl.NumberFormat('sv-SE', { maximumFractionDigits: 2 }).format(ratePercent))} %`
}

function addressLines(p: SelfBillingParty): string[] {
  const cityLine = [p.postal_code, p.city].filter(Boolean).join(' ')
  return [p.address_line1, p.address_line2, cityLine, p.country && p.country !== 'SE' ? p.country : null].filter(
    (line): line is string => Boolean(line),
  )
}

/** Where the seller is paid, as text: the giros, IBAN/BIC and a Swedish account. */
export function selfBillingPayToLines(payTo: SelfBillingSnapshot['pay_to']): string[] {
  const lines: string[] = []
  if (payTo.bankgiro) lines.push(`Bankgiro ${payTo.bankgiro}`)
  if (payTo.plusgiro) lines.push(`Plusgiro ${payTo.plusgiro}`)
  if (payTo.clearing_number && payTo.account_number) lines.push(`Bankkonto ${payTo.clearing_number}-${payTo.account_number}`)
  if (payTo.iban) lines.push(payTo.bic ? `IBAN ${payTo.iban}, BIC ${payTo.bic}` : `IBAN ${payTo.iban}`)
  return lines
}

function createSelfBillingStyles(branding?: SelfBillingBranding) {
  const b = branding ?? DEFAULT_SELF_BILLING_BRANDING
  return StyleSheet.create({
    page: { paddingTop: 40, paddingHorizontal: 40, paddingBottom: 64, fontSize: 9, fontFamily: 'Helvetica', color: '#1a1a1a' },
    header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16 },
    title: { fontSize: 20, fontFamily: 'Helvetica-Bold', color: b.primaryColor },
    notation: { fontSize: 12, fontFamily: 'Helvetica-Bold', color: b.primaryColor, marginTop: 4, letterSpacing: 0.5 },
    issuer: { textAlign: 'right', maxWidth: 240 },
    // The issuer's logo, contained in a fixed slot like on its own invoices.
    logo: { maxWidth: 180, maxHeight: 48, objectFit: 'contain', alignSelf: 'flex-end', marginBottom: 6 },
    issuerName: { fontSize: 11, fontFamily: 'Helvetica-Bold', marginBottom: 2 },
    muted: { color: b.accentColor },
    metaGrid: { flexDirection: 'row', flexWrap: 'wrap', marginBottom: 14, borderTopWidth: 0.6, borderBottomWidth: 0.6, borderColor: '#d6d6d2', paddingVertical: 6 },
    metaCell: { width: '33%', paddingVertical: 3, paddingRight: 8 },
    metaLabel: { fontSize: 7.5, color: b.accentColor, textTransform: 'uppercase', marginBottom: 1 },
    metaValue: { fontSize: 9.5 },
    parties: { flexDirection: 'row', marginBottom: 16 },
    partyBox: { flex: 1, paddingRight: 16 },
    partyHeading: { fontSize: 7.5, color: b.accentColor, textTransform: 'uppercase', marginBottom: 3 },
    partyName: { fontSize: 10, fontFamily: 'Helvetica-Bold', marginBottom: 2 },
    tableHeader: { flexDirection: 'row', paddingVertical: 4, borderBottomWidth: 0.8, borderBottomColor: '#999' },
    headerCell: { fontSize: 7.5, color: b.accentColor, textTransform: 'uppercase' },
    row: { flexDirection: 'row', paddingVertical: 4, borderBottomWidth: 0.4, borderBottomColor: '#e2e2df' },
    colDescription: { flex: 1, paddingRight: 6 },
    colQuantity: { width: 52, textAlign: 'right', paddingRight: 6 },
    colUnit: { width: 36, paddingRight: 6 },
    colPrice: { width: 70, textAlign: 'right', paddingRight: 6 },
    colRate: { width: 40, textAlign: 'right', paddingRight: 6 },
    colAmount: { width: 76, textAlign: 'right' },
    summary: { flexDirection: 'row', justifyContent: 'flex-end', marginTop: 12 },
    summaryTable: { width: 260 },
    summaryRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 2 },
    totalRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 4, marginTop: 3, borderTopWidth: 1, borderTopColor: '#1a1a1a' },
    totalText: { fontSize: 11, fontFamily: 'Helvetica-Bold' },
    box: { marginTop: 14, padding: 10, backgroundColor: '#f5f5f2' },
    boxHeading: { fontSize: 8, fontFamily: 'Helvetica-Bold', marginBottom: 3 },
    footer: {
      position: 'absolute',
      bottom: 24,
      left: 40,
      right: 40,
      borderTopWidth: 0.5,
      borderTopColor: '#d6d6d2',
      paddingTop: 5,
      flexDirection: 'row',
      justifyContent: 'space-between',
    },
    footerText: { fontSize: 7, color: '#888', flex: 1, marginRight: 16 },
    footerPage: { fontSize: 7, color: '#888', width: 80, textAlign: 'right' },
  })
}

function PartyBlock({ heading, party, styles }: { heading: string; party: SelfBillingParty; styles: ReturnType<typeof createSelfBillingStyles> }) {
  return (
    <View style={styles.partyBox}>
      <Text style={styles.partyHeading}>{heading}</Text>
      <Text style={styles.partyName}>{party.name}</Text>
      {addressLines(party).map((line) => (
        <Text key={line}>{line}</Text>
      ))}
      {party.org_number ? <Text>Org.nr {party.org_number}</Text> : null}
      {party.vat_number ? <Text>Momsreg.nr {party.vat_number}</Text> : null}
    </View>
  )
}

export function SelfBillingPDF({ invoice, items, snapshot, branding }: SelfBillingPdfProps) {
  const styles = createSelfBillingStyles(branding)
  const isCredit = invoice.is_credit_note
  // Stored in magnitudes beside is_credit_note: a kreditfaktura prints them negative.
  const sign: 1 | -1 = isCredit ? -1 : 1
  const sortedItems = [...items].sort((a, b) => a.sort_order - b.sort_order)
  const vatSummary = selfBillingVatSummary(sortedItems)
  const payToLines = selfBillingPayToLines(snapshot.pay_to)
  const number = invoice.supplier_invoice_number ?? ''

  const meta: Array<[string, string]> = [
    ['Fakturanummer', number],
    ['Fakturadatum', pdfDate(invoice.invoice_date)],
    ...(isCredit ? [] : [['Förfallodatum', pdfDate(invoice.due_date)] as [string, string]]),
    ...(invoice.delivery_date ? [['Leveransdatum', pdfDate(invoice.delivery_date)] as [string, string]] : []),
    ['Självfaktureringsavtal', snapshot.agreement_ref],
    ...(snapshot.credits
      ? [['Avser faktura', `${snapshot.credits.number} (${pdfDate(snapshot.credits.invoice_date)})`] as [string, string]]
      : []),
  ]

  return (
    <Document title={`${isCredit ? 'Kreditfaktura' : 'Faktura'} ${number}`}>
      <Page size="A4" style={styles.page}>
        <View style={styles.header}>
          <View>
            <Text style={styles.title}>{isCredit ? 'Kreditfaktura' : 'Faktura'}</Text>
            <Text style={styles.notation}>Självfakturering</Text>
          </View>
          <View style={styles.issuer}>
            {branding?.logoUrl ? <Image src={branding.logoUrl} style={styles.logo} /> : null}
            <Text style={styles.muted}>Utfärdad av köparen</Text>
            <Text style={styles.issuerName}>{snapshot.buyer.name}</Text>
            {snapshot.buyer.org_number ? <Text>Org.nr {snapshot.buyer.org_number}</Text> : null}
          </View>
        </View>

        <View style={styles.metaGrid}>
          {meta.map(([label, value]) => (
            <View key={label} style={styles.metaCell}>
              <Text style={styles.metaLabel}>{label}</Text>
              <Text style={styles.metaValue}>{value}</Text>
            </View>
          ))}
        </View>

        <View style={styles.parties}>
          <PartyBlock heading="Säljare" party={snapshot.seller} styles={styles} />
          <PartyBlock heading="Köpare och utfärdare" party={snapshot.buyer} styles={styles} />
        </View>

        <View style={styles.tableHeader} fixed>
          <Text style={[styles.colDescription, styles.headerCell]}>Beskrivning</Text>
          <Text style={[styles.colQuantity, styles.headerCell]}>Antal</Text>
          <Text style={[styles.colUnit, styles.headerCell]}>Enhet</Text>
          <Text style={[styles.colPrice, styles.headerCell]}>À-pris exkl. moms</Text>
          <Text style={[styles.colRate, styles.headerCell]}>Moms</Text>
          <Text style={[styles.colAmount, styles.headerCell]}>Belopp exkl. moms</Text>
        </View>
        {sortedItems.map((item, index) => (
          <View key={`${item.sort_order}-${index}`} style={styles.row} wrap={false}>
            <Text style={styles.colDescription}>{item.description}</Text>
            <Text style={styles.colQuantity}>{quantityText(item.quantity)}</Text>
            <Text style={styles.colUnit}>{item.unit ?? ''}</Text>
            <Text style={styles.colPrice}>{amount(item.unit_price, sign)}</Text>
            <Text style={styles.colRate}>{ratePercentText(roundOre(normalizeVatRateToFraction(item.vat_rate) * 100))}</Text>
            <Text style={styles.colAmount}>{amount(item.line_total, sign)}</Text>
          </View>
        ))}

        <View style={styles.summary} wrap={false}>
          <View style={styles.summaryTable}>
            {vatSummary.map((group) => (
              <View key={group.ratePercent} style={styles.summaryRow}>
                <Text>Underlag moms {ratePercentText(group.ratePercent)}</Text>
                <Text>{amount(group.base, sign)}</Text>
              </View>
            ))}
            {vatSummary.map((group) => (
              <View key={`vat-${group.ratePercent}`} style={styles.summaryRow}>
                <Text>Moms {ratePercentText(group.ratePercent)}</Text>
                <Text>{amount(group.vat, sign)}</Text>
              </View>
            ))}
            <View style={styles.summaryRow}>
              <Text>Summa exkl. moms</Text>
              <Text>{amount(invoice.subtotal, sign)}</Text>
            </View>
            <View style={styles.summaryRow}>
              <Text>Summa moms</Text>
              <Text>{amount(invoice.vat_amount, sign)}</Text>
            </View>
            <View style={styles.totalRow}>
              <Text style={styles.totalText}>{isCredit ? 'Er tillgodo' : 'Att betala'}</Text>
              <Text style={styles.totalText}>
                {amount(invoice.total, sign)} {invoice.currency}
              </Text>
            </View>
          </View>
        </View>

        {!isCredit && payToLines.length > 0 ? (
          <View style={styles.box} wrap={false}>
            <Text style={styles.boxHeading}>Köparen betalar till säljaren</Text>
            {payToLines.map((line) => (
              <Text key={line}>{line}</Text>
            ))}
            <Text>Referens: {number}</Text>
          </View>
        ) : null}

        <View style={styles.box} wrap={false}>
          <Text style={styles.boxHeading}>Självfakturering</Text>
          <Text>{snapshot.acceptance_text}</Text>
        </View>

        <View style={styles.footer} fixed>
          <Text style={styles.footerText}>
            Självfaktura utfärdad av köparen {snapshot.buyer.name} i säljarens namn enligt självfaktureringsavtal{' '}
            {snapshot.agreement_ref}. Säljaren ansvarar för redovisningen av utgående moms.
          </Text>
          <Text style={styles.footerPage} render={({ pageNumber, totalPages }) => `Sida ${pageNumber} av ${totalPages}`} />
        </View>
      </Page>
    </Document>
  )
}
