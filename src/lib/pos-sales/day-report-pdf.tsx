import { Document, Page, Text, View, StyleSheet, renderToBuffer } from '@react-pdf/renderer'
import type { PosDay, PosTenderKind } from '@accounted/connect-contract'
import { pdfNumberText } from '@/lib/pdf/number-text'
import type { CreateJournalEntryLineInput } from '@/types'

/**
 * Dagsrapport kassa: the underlag of a point-of-sale day's takings voucher.
 *
 * A gemensam verifikation for a day's sales (BFL 5 kap 6 §) must show the
 * split between cash and card in itself (BFNAR 2013:2 p. 6.10) and carry a
 * sammanställning of the card sales (p. 6.11). This report is that
 * sammanställning, built from the POS system's receipts for the business day:
 * sales per VAT rate, payment per way of paying, tips, refunds, the voucher's
 * lines and every receipt. The POS system's own Z-dagrapport stays in the POS
 * system; the provider's answer behind this report is archived verbatim, and
 * its SHA-256 is printed here so the two can be tied together.
 *
 * Swedish-only on purpose, like every underlag (räkenskapsinformation).
 */

export interface PosDayReportInput {
  day: PosDay
  venueName: string
  providerName: string
  companyName: string | null
  orgNumber: string | null
  fetchedAt: string
  rawSha256: string
  /** The voucher's lines: the booked ones, or the proposal before booking. */
  lines: CreateJournalEntryLineInput[] | null
  /** e.g. "F12" once booked; null on a preview. */
  voucherLabel: string | null
  generatedAt: string
}

const TENDER_LABELS: Record<PosTenderKind, string> = {
  card: 'Kort',
  swish: 'Swish',
  cash: 'Kontant',
  gift_card: 'Presentkort (inlöst)',
  invoice: 'Faktura',
  prepaid: 'Förbetalt',
  other: 'Annat',
}

export function formatReportAmount(amount: number): string {
  return pdfNumberText(
    new Intl.NumberFormat('sv-SE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(amount),
  )
}

function rateLabel(rate: number): string {
  return rate === 0 ? 'Utan moms' : `${rate} %`
}

/** "2026-09-30T11:57:00.789329" -> "11:57"; anything else as given. */
function timeOf(paidAt: string | null): string {
  if (!paidAt) return ''
  const match = /T(\d{2}:\d{2})/.exec(paidAt)
  return match ? match[1] : paidAt
}

export function posDayReportFilename(day: Pick<PosDay, 'businessDate'>, venueName: string): string {
  const venue = venueName.replace(/[^\p{L}\p{N}]+/gu, '_').replace(/^_+|_+$/g, '').slice(0, 60) || 'kassa'
  return `Dagsrapport_kassa_${venue}_${day.businessDate}.pdf`
}

const styles = StyleSheet.create({
  page: { paddingTop: 36, paddingHorizontal: 36, paddingBottom: 56, fontSize: 8.5, fontFamily: 'Helvetica' },
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
  subtitle: { fontSize: 10, color: '#333', marginBottom: 2 },
  meta: { fontSize: 8.5, color: '#666' },
  companyInfo: { textAlign: 'right' },
  companyName: { fontSize: 10.5, fontWeight: 'bold', marginBottom: 2 },
  sectionHeading: {
    fontSize: 10.5,
    fontWeight: 'bold',
    color: '#1a1a1a',
    marginTop: 10,
    marginBottom: 4,
    paddingBottom: 2,
    borderBottomWidth: 1,
    borderBottomColor: '#1a1a1a',
  },
  tableHeader: { flexDirection: 'row', paddingVertical: 3, borderBottomWidth: 0.8, borderBottomColor: '#999' },
  headerCell: { fontSize: 7, fontWeight: 'bold', color: '#555', textTransform: 'uppercase' },
  row: { flexDirection: 'row', paddingVertical: 2.5, borderBottomWidth: 0.4, borderBottomColor: '#e4e4e4' },
  totalRow: { flexDirection: 'row', paddingVertical: 3.5, marginTop: 1, borderTopWidth: 1, borderTopColor: '#1a1a1a' },
  colName: { flex: 1, paddingRight: 6, color: '#1a1a1a' },
  colShort: { width: 60, paddingRight: 6, color: '#1a1a1a' },
  colCount: { width: 48, textAlign: 'right', fontFamily: 'Courier' },
  colAmount: { width: 72, textAlign: 'right', fontFamily: 'Courier', color: '#1a1a1a' },
  bold: { fontWeight: 'bold' },
  note: { fontSize: 8.5, color: '#333', marginBottom: 2 },
  muted: { fontSize: 8.5, color: '#888', fontStyle: 'italic' },
  issue: { fontSize: 8.5, color: '#8a5a00', marginBottom: 2 },
  footer: {
    position: 'absolute',
    bottom: 20,
    left: 36,
    right: 36,
    borderTopWidth: 0.5,
    borderTopColor: '#d4d4d4',
    paddingTop: 5,
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  footerText: { fontSize: 7, color: '#888', maxWidth: 420 },
})

export function PosDayReportPDF({ input }: { input: PosDayReportInput }) {
  const { day, lines } = input
  const tendered = day.tenders.reduce((sum, t) => sum + t.amount, 0)
  const range =
    day.firstReceiptNumber && day.lastReceiptNumber
      ? day.firstReceiptNumber === day.lastReceiptNumber
        ? ` (nr ${day.firstReceiptNumber})`
        : ` (nr ${day.firstReceiptNumber}-${day.lastReceiptNumber})`
      : ''
  const totalDebit = (lines ?? []).reduce((sum, l) => sum + (l.debit_amount || 0), 0)
  const totalCredit = (lines ?? []).reduce((sum, l) => sum + (l.credit_amount || 0), 0)

  return (
    <Document>
      <Page size="A4" style={styles.page}>
        <View style={styles.header} fixed>
          <View>
            <Text style={styles.title}>Dagsrapport kassa</Text>
            <Text style={styles.subtitle}>
              {input.venueName} ({input.providerName})
            </Text>
            <Text style={styles.meta}>
              Affärsdag {day.businessDate} · {day.receiptCount} kvitton{range}
              {input.voucherLabel ? ` · Verifikat ${input.voucherLabel}` : ' · Ej bokförd'}
            </Text>
            {day.firstPaidAt || day.lastPaidAt ? (
              <Text style={styles.meta}>
                Första betalning {timeOf(day.firstPaidAt)} · sista {timeOf(day.lastPaidAt)}
              </Text>
            ) : null}
          </View>
          <View style={styles.companyInfo}>
            {input.companyName ? <Text style={styles.companyName}>{input.companyName}</Text> : null}
            {input.orgNumber ? <Text style={styles.meta}>Org.nr: {input.orgNumber}</Text> : null}
          </View>
        </View>

        <Text style={styles.sectionHeading}>Försäljning per momssats ({day.currency})</Text>
        <View style={styles.tableHeader}>
          <Text style={[styles.colName, styles.headerCell]}>Momssats</Text>
          <Text style={[styles.colAmount, styles.headerCell]}>Netto</Text>
          <Text style={[styles.colAmount, styles.headerCell]}>Moms</Text>
          <Text style={[styles.colAmount, styles.headerCell]}>Inkl. moms</Text>
        </View>
        {day.vatGroups.length === 0 ? (
          <Text style={styles.muted}>Ingen försäljning.</Text>
        ) : (
          day.vatGroups.map((g) => (
            <View key={g.ratePercent} style={styles.row} wrap={false}>
              <Text style={styles.colName}>{rateLabel(g.ratePercent)}</Text>
              <Text style={styles.colAmount}>{formatReportAmount(g.net)}</Text>
              <Text style={styles.colAmount}>{formatReportAmount(g.vat)}</Text>
              <Text style={styles.colAmount}>{formatReportAmount(g.gross)}</Text>
            </View>
          ))
        )}
        <View style={styles.totalRow}>
          <Text style={[styles.colName, styles.bold]}>Summa försäljning</Text>
          <Text style={[styles.colAmount, styles.bold]}>{formatReportAmount(day.sales.net)}</Text>
          <Text style={[styles.colAmount, styles.bold]}>{formatReportAmount(day.sales.vat)}</Text>
          <Text style={[styles.colAmount, styles.bold]}>{formatReportAmount(day.sales.gross)}</Text>
        </View>

        <Text style={styles.sectionHeading}>Betalningar ({day.currency})</Text>
        <View style={styles.tableHeader}>
          <Text style={[styles.colName, styles.headerCell]}>Betalsätt</Text>
          <Text style={[styles.colCount, styles.headerCell]}>Kvitton</Text>
          <Text style={[styles.colAmount, styles.headerCell]}>Varav dricks</Text>
          <Text style={[styles.colAmount, styles.headerCell]}>Belopp</Text>
        </View>
        {day.tenders.map((t) => (
          <View key={`${t.kind}:${t.method}`} style={styles.row} wrap={false}>
            <Text style={styles.colName}>
              {TENDER_LABELS[t.kind]}
              {t.kind === 'other' || t.method.toLowerCase() !== t.kind ? ` (${t.method})` : ''}
            </Text>
            <Text style={styles.colCount}>{t.receiptCount}</Text>
            <Text style={styles.colAmount}>{formatReportAmount(t.tips)}</Text>
            <Text style={styles.colAmount}>{formatReportAmount(t.amount)}</Text>
          </View>
        ))}
        <View style={styles.totalRow}>
          <Text style={[styles.colName, styles.bold]}>Summa betalningar</Text>
          <Text style={styles.colCount}></Text>
          <Text style={[styles.colAmount, styles.bold]}>{formatReportAmount(day.tips)}</Text>
          <Text style={[styles.colAmount, styles.bold]}>{formatReportAmount(tendered)}</Text>
        </View>
        <Text style={styles.note}>
          Rabatter {formatReportAmount(day.discounts)} kr · Returer {day.refunds.count} st, {formatReportAmount(day.refunds.gross)} kr
          (redan avdragna från försäljningen).
        </Text>

        {lines && lines.length > 0 ? (
          <View>
            <Text style={styles.sectionHeading}>{input.voucherLabel ? `Kontering, verifikat ${input.voucherLabel}` : 'Konteringsförslag'}</Text>
            <View style={styles.tableHeader}>
              <Text style={[styles.colShort, styles.headerCell]}>Konto</Text>
              <Text style={[styles.colName, styles.headerCell]}>Text</Text>
              <Text style={[styles.colAmount, styles.headerCell]}>Debet</Text>
              <Text style={[styles.colAmount, styles.headerCell]}>Kredit</Text>
            </View>
            {lines.map((l, i) => (
              <View key={i} style={styles.row} wrap={false}>
                <Text style={styles.colShort}>{l.account_number}</Text>
                <Text style={styles.colName}>{l.line_description ?? ''}</Text>
                <Text style={styles.colAmount}>{l.debit_amount ? formatReportAmount(l.debit_amount) : ''}</Text>
                <Text style={styles.colAmount}>{l.credit_amount ? formatReportAmount(l.credit_amount) : ''}</Text>
              </View>
            ))}
            <View style={styles.totalRow}>
              <Text style={styles.colShort}></Text>
              <Text style={[styles.colName, styles.bold]}>Summa</Text>
              <Text style={[styles.colAmount, styles.bold]}>{formatReportAmount(totalDebit)}</Text>
              <Text style={[styles.colAmount, styles.bold]}>{formatReportAmount(totalCredit)}</Text>
            </View>
          </View>
        ) : null}

        {day.issues.length > 0 ? (
          <View>
            <Text style={styles.sectionHeading}>Att granska</Text>
            {day.issues.map((issue) => (
              <Text key={issue.code} style={styles.issue}>
                {issue.message}
              </Text>
            ))}
          </View>
        ) : null}

        {day.categories.length > 0 ? (
          <View>
            <Text style={styles.sectionHeading}>Försäljning per varugrupp ({day.currency})</Text>
            <View style={styles.tableHeader}>
              <Text style={[styles.colName, styles.headerCell]}>Varugrupp</Text>
              <Text style={[styles.colCount, styles.headerCell]}>Antal</Text>
              <Text style={[styles.colAmount, styles.headerCell]}>Moms</Text>
              <Text style={[styles.colAmount, styles.headerCell]}>Inkl. moms</Text>
            </View>
            {day.categories.map((c) => (
              <View key={c.name} style={styles.row} wrap={false}>
                <Text style={styles.colName}>{c.name}</Text>
                <Text style={styles.colCount}>{pdfNumberText(String(c.quantity))}</Text>
                <Text style={styles.colAmount}>{formatReportAmount(c.vat)}</Text>
                <Text style={styles.colAmount}>{formatReportAmount(c.gross)}</Text>
              </View>
            ))}
          </View>
        ) : null}

        <Text style={styles.sectionHeading} break={day.receipts.length > 25}>
          Kvitton ({day.receipts.length})
        </Text>
        <View style={styles.tableHeader} fixed={false}>
          <Text style={[styles.colShort, styles.headerCell]}>Kvitto</Text>
          <Text style={[styles.colShort, styles.headerCell]}>Tid</Text>
          <Text style={[styles.colName, styles.headerCell]}>Betalsätt</Text>
          <Text style={[styles.colAmount, styles.headerCell]}>Dricks</Text>
          <Text style={[styles.colAmount, styles.headerCell]}>Belopp</Text>
        </View>
        {day.receipts.map((r) => (
          <View key={`${r.kind}:${r.number}`} style={styles.row} wrap={false}>
            <Text style={styles.colShort}>
              {r.number}
              {r.kind === 'refund' ? ' R' : ''}
            </Text>
            <Text style={styles.colShort}>{timeOf(r.paidAt)}</Text>
            <Text style={styles.colName}>{r.method}</Text>
            <Text style={styles.colAmount}>{r.tips ? formatReportAmount(r.tips) : ''}</Text>
            <Text style={styles.colAmount}>{formatReportAmount(r.gross)}</Text>
          </View>
        ))}

        <View style={styles.footer} fixed>
          <Text style={styles.footerText}>
            Sammanställning av kassasystemets kvitton för affärsdagen, hämtad {input.fetchedAt.slice(0, 16).replace('T', ' ')} UTC
            via Accounted Connect. Svaret arkiveras oförändrat, SHA-256 {input.rawSha256}. Kassasystemets Z-dagrapport
            finns kvar i kassasystemet.
          </Text>
          <Text
            style={styles.footerText}
            render={({ pageNumber, totalPages }) => `Genererad ${input.generatedAt} · Sida ${pageNumber} av ${totalPages}`}
          />
        </View>
      </Page>
    </Document>
  )
}

export async function renderPosDayReport(input: PosDayReportInput): Promise<Buffer> {
  return renderToBuffer(PosDayReportPDF({ input }))
}
