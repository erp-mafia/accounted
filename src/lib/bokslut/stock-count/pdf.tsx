import { Document, Page, Text, View, StyleSheet, renderToBuffer } from '@react-pdf/renderer'
import { pdfNumberText, pdfAmount } from '@/lib/pdf/number-text'
import { STOCK_CATEGORY_ACCOUNTS, type CategoryTotal, type StockCategory } from './valuation'

/**
 * The inventeringslista (LIV 1955:257 1-2 §): every counted item valued at
 * the lower of cost and net realisable value, the totals per kind of stock,
 * and the statement the bokföringsskyldig signs "på heder och samvete".
 *
 * Swedish-only on purpose, like every underlag (räkenskapsinformation). The
 * same PDF is archived and sent for BankID signing, or printed and signed by
 * hand.
 */

export interface StockCountPdfInput {
  companyName: string | null
  orgNumber: string | null
  periodStart: string
  periodEnd: string
  balanceDate: string
  countDate: string
  rollForwardNote: string | null
  note: string | null
  rows: Array<{
    position: number
    description: string
    category: StockCategory
    unit: string | null
    quantity: number
    unit_cost: number
    write_down_percent: number
    value: number
  }>
  totals: CategoryTotal[]
  totalValue: number
  /** Set once the count is signed (by hand or with BankID). */
  signedBy: string | null
  signedOn: string | null
  generatedAt: string
}

/** The statement the signer makes (LIV 2 §). */
export const STOCK_COUNT_HONOUR_STATEMENT =
  'Jag intygar på heder och samvete att varulagret har inventerats och att uppgifterna i denna inventeringslista är riktiga.'

function quantity(n: number): string {
  return pdfNumberText(new Intl.NumberFormat('sv-SE', { minimumFractionDigits: 0, maximumFractionDigits: 3 }).format(n))
}

function percent(n: number): string {
  return n === 0 ? '' : pdfNumberText(new Intl.NumberFormat('sv-SE', { maximumFractionDigits: 2 }).format(n))
}

export function stockCountPdfFilename(balanceDate: string): string {
  return `Inventeringslista_${balanceDate}.pdf`
}

const styles = StyleSheet.create({
  page: { paddingTop: 40, paddingHorizontal: 36, paddingBottom: 56, fontSize: 8.5, fontFamily: 'Helvetica' },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: 14,
    paddingBottom: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#d4d4d4',
  },
  title: { fontSize: 17, fontWeight: 'bold', color: '#1a1a1a', marginBottom: 3 },
  meta: { fontSize: 9, color: '#555' },
  companyInfo: { textAlign: 'right' },
  companyName: { fontSize: 10.5, fontWeight: 'bold', marginBottom: 2 },
  sectionHeading: {
    fontSize: 10,
    fontWeight: 'bold',
    color: '#1a1a1a',
    marginTop: 12,
    marginBottom: 4,
    paddingBottom: 2,
    borderBottomWidth: 1,
    borderBottomColor: '#1a1a1a',
  },
  paragraph: { fontSize: 9, color: '#333', marginBottom: 3 },
  tableHeader: { flexDirection: 'row', paddingVertical: 3, borderBottomWidth: 0.8, borderBottomColor: '#999' },
  headerCell: { fontSize: 6.5, fontWeight: 'bold', color: '#555', textTransform: 'uppercase' },
  row: { flexDirection: 'row', paddingVertical: 2.5, borderBottomWidth: 0.4, borderBottomColor: '#e4e4e4' },
  totalRow: { flexDirection: 'row', paddingVertical: 3.5, marginTop: 1, borderTopWidth: 1, borderTopColor: '#1a1a1a' },
  colNo: { width: 24, color: '#555' },
  colName: { flex: 1, paddingRight: 6, color: '#1a1a1a' },
  colKind: { width: 78, paddingRight: 6, color: '#1a1a1a' },
  colUnit: { width: 32, paddingRight: 4, color: '#1a1a1a' },
  colNum: { width: 56, textAlign: 'right', fontFamily: 'Courier', color: '#1a1a1a' },
  colPct: { width: 40, textAlign: 'right', fontFamily: 'Courier', color: '#1a1a1a' },
  colAmount: { width: 72, textAlign: 'right', fontFamily: 'Courier', color: '#1a1a1a' },
  bold: { fontWeight: 'bold' },
  signatureBox: { marginTop: 18, padding: 10, borderWidth: 0.8, borderColor: '#1a1a1a' },
  signatureRow: { flexDirection: 'row', marginTop: 22 },
  signatureField: { flex: 1, marginRight: 14, borderTopWidth: 0.6, borderTopColor: '#1a1a1a', paddingTop: 2 },
  signatureLabel: { fontSize: 7, color: '#555' },
  footer: { position: 'absolute', bottom: 20, left: 36, right: 36, flexDirection: 'row', paddingTop: 5, borderTopWidth: 0.5, borderTopColor: '#d4d4d4' },
  // The page counter is measured after layout: a fixed width keeps the note clear of it.
  footerText: { fontSize: 7, color: '#888', flex: 1, marginRight: 16 },
  footerPage: { fontSize: 7, color: '#888', width: 80, textAlign: 'right' },
})

export function StockCountPDF({ input }: { input: StockCountPdfInput }) {
  const label = (category: StockCategory) => STOCK_CATEGORY_ACCOUNTS[category].label_sv
  return (
    <Document>
      <Page size="A4" style={styles.page}>
        <View style={styles.header}>
          <View>
            <Text style={styles.title}>Inventeringslista</Text>
            <Text style={styles.meta}>Varulager per balansdagen {input.balanceDate}</Text>
            <Text style={styles.meta}>
              Räkenskapsår {input.periodStart} till {input.periodEnd} · Inventeringsdag {input.countDate}
            </Text>
          </View>
          <View style={styles.companyInfo}>
            {input.companyName ? <Text style={styles.companyName}>{input.companyName}</Text> : null}
            {input.orgNumber ? <Text style={styles.meta}>Org.nr: {input.orgNumber}</Text> : null}
          </View>
        </View>

        {input.rollForwardNote ? (
          <View>
            <Text style={styles.sectionHeading}>Framräkning till balansdagen</Text>
            <Text style={styles.paragraph}>
              Lagret inventerades {input.countDate} och har räknats fram till balansdagen {input.balanceDate}:
            </Text>
            <Text style={styles.paragraph}>{input.rollForwardNote}</Text>
          </View>
        ) : null}

        <Text style={styles.sectionHeading}>Inventerade varor (SEK)</Text>
        <View style={styles.tableHeader} fixed>
          <Text style={[styles.colNo, styles.headerCell]}>Nr</Text>
          <Text style={[styles.colName, styles.headerCell]}>Benämning</Text>
          <Text style={[styles.colKind, styles.headerCell]}>Slag</Text>
          <Text style={[styles.colUnit, styles.headerCell]}>Enhet</Text>
          <Text style={[styles.colNum, styles.headerCell]}>Antal</Text>
          <Text style={[styles.colNum, styles.headerCell]}>À-pris</Text>
          <Text style={[styles.colPct, styles.headerCell]}>Nedskr. %</Text>
          <Text style={[styles.colAmount, styles.headerCell]}>Värde</Text>
        </View>
        {input.rows.map((row) => (
          <View key={row.position} style={styles.row} wrap={false}>
            <Text style={styles.colNo}>{row.position}</Text>
            <Text style={styles.colName}>{row.description}</Text>
            <Text style={styles.colKind}>{label(row.category)}</Text>
            <Text style={styles.colUnit}>{row.unit ?? ''}</Text>
            <Text style={styles.colNum}>{quantity(row.quantity)}</Text>
            <Text style={styles.colNum}>{pdfAmount(row.unit_cost)}</Text>
            <Text style={styles.colPct}>{percent(row.write_down_percent)}</Text>
            <Text style={styles.colAmount}>{pdfAmount(row.value)}</Text>
          </View>
        ))}

        <Text style={styles.sectionHeading}>Sammanställning per slag</Text>
        <View style={styles.tableHeader}>
          <Text style={[styles.colName, styles.headerCell]}>Slag</Text>
          <Text style={[styles.colAmount, styles.headerCell]}>Anskaffningsvärde</Text>
          <Text style={[styles.colAmount, styles.headerCell]}>Nedskrivning</Text>
          <Text style={[styles.colAmount, styles.headerCell]}>Värde</Text>
        </View>
        {input.totals.map((t) => (
          <View key={t.category} style={styles.row} wrap={false}>
            <Text style={styles.colName}>{label(t.category)}</Text>
            <Text style={styles.colAmount}>{pdfAmount(t.cost)}</Text>
            <Text style={styles.colAmount}>{pdfAmount(t.write_down)}</Text>
            <Text style={styles.colAmount}>{pdfAmount(t.value)}</Text>
          </View>
        ))}
        <View style={styles.totalRow} wrap={false}>
          <Text style={[styles.colName, styles.bold]}>Varulager totalt</Text>
          <Text style={styles.colAmount}></Text>
          <Text style={styles.colAmount}></Text>
          <Text style={[styles.colAmount, styles.bold]}>{pdfAmount(input.totalValue)}</Text>
        </View>
        <Text style={styles.paragraph}>
          Varulagret är värderat till det lägsta av anskaffningsvärdet och nettoförsäljningsvärdet på balansdagen.
        </Text>
        {input.note ? <Text style={styles.paragraph}>{input.note}</Text> : null}

        <View style={styles.signatureBox} wrap={false}>
          <Text style={styles.paragraph}>{STOCK_COUNT_HONOUR_STATEMENT}</Text>
          {input.signedBy ? (
            <Text style={[styles.paragraph, styles.bold]}>
              Undertecknad av {input.signedBy}
              {input.signedOn ? ` ${input.signedOn}` : ''}
            </Text>
          ) : (
            <View style={styles.signatureRow}>
              <View style={styles.signatureField}>
                <Text style={styles.signatureLabel}>Ort och datum</Text>
              </View>
              <View style={styles.signatureField}>
                <Text style={styles.signatureLabel}>Namnteckning</Text>
              </View>
              <View style={styles.signatureField}>
                <Text style={styles.signatureLabel}>Namnförtydligande</Text>
              </View>
            </View>
          )}
        </View>

        <View style={styles.footer} fixed>
          <Text style={styles.footerText}>
            Inventeringslista enligt lag (1955:257) om inventering av varulager för inkomsttaxeringen. Genererad {input.generatedAt}.
          </Text>
          <Text style={styles.footerPage} render={({ pageNumber, totalPages }) => `Sida ${pageNumber} av ${totalPages}`} />
        </View>
      </Page>
    </Document>
  )
}

export async function renderStockCountPdf(input: StockCountPdfInput): Promise<Buffer> {
  return renderToBuffer(StockCountPDF({ input }))
}
