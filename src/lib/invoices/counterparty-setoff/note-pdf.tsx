import { Document, Page, Text, View, StyleSheet, renderToBuffer } from '@react-pdf/renderer'
import { pdfNumberText } from '@/lib/pdf/number-text'

/**
 * Kvittningsavräkning: the underlag of a set-off verifikat.
 *
 * The verifikat refers to both invoices (BFL 5 kap 7 §); this note states the
 * set-off itself as an egen verifikation: who the two parties are, which
 * invoices were settled against each other, for how much, what each is left
 * with and who pays the net. It doubles as the set-off notice to send to the
 * counterparty.
 *
 * Swedish-only on purpose, like every underlag (räkenskapsinformation).
 */
export interface SetoffNoteInput {
  companyName: string | null
  companyOrgNumber: string | null
  counterpartyName: string | null
  counterpartyOrgNumber: string | null
  setoffDate: string
  /** e.g. "A123" once booked. */
  voucherLabel: string | null
  amount: number
  invoice: { number: string | null; invoiceDate: string; total: number; remainingBefore: number; remainingAfter: number }
  supplierInvoice: {
    number: string | null
    arrivalNumber: number | null
    invoiceDate: string
    total: number
    remainingBefore: number
    remainingAfter: number
  }
  net: { direction: 'we_pay' | 'they_pay' | 'settled'; amount: number }
  receivableAccount: string | null
  payableAccount: string | null
  note: string | null
  generatedAt: string
}

export function formatNoteAmount(amount: number): string {
  return pdfNumberText(new Intl.NumberFormat('sv-SE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(amount))
}

export function setoffNoteFilename(setoffDate: string, invoiceNumber: string | null): string {
  const number = (invoiceNumber ?? '').replace(/[^\p{L}\p{N}]+/gu, '_').replace(/^_+|_+$/g, '').slice(0, 40)
  return `Kvittningsavrakning_${setoffDate}${number ? `_${number}` : ''}.pdf`
}

/** The supplier invoice as the note names it: its printed number, else its löpnummer. */
export function supplierInvoiceLabel(supplierInvoice: { number: string | null; arrivalNumber: number | null }): string {
  if (supplierInvoice.number) return supplierInvoice.number
  return supplierInvoice.arrivalNumber != null ? `ankomstnr ${supplierInvoice.arrivalNumber}` : ''
}

const styles = StyleSheet.create({
  page: { paddingTop: 40, paddingHorizontal: 40, paddingBottom: 56, fontSize: 9, fontFamily: 'Helvetica' },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: 16,
    paddingBottom: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#d4d4d4',
  },
  title: { fontSize: 17, fontWeight: 'bold', color: '#1a1a1a', marginBottom: 3 },
  meta: { fontSize: 9, color: '#666' },
  companyInfo: { textAlign: 'right' },
  companyName: { fontSize: 10.5, fontWeight: 'bold', marginBottom: 2 },
  sectionHeading: {
    fontSize: 10.5,
    fontWeight: 'bold',
    color: '#1a1a1a',
    marginTop: 12,
    marginBottom: 4,
    paddingBottom: 2,
    borderBottomWidth: 1,
    borderBottomColor: '#1a1a1a',
  },
  partyRow: { flexDirection: 'row', marginBottom: 2 },
  partyLabel: { width: 110, color: '#555' },
  partyValue: { flex: 1, color: '#1a1a1a' },
  tableHeader: { flexDirection: 'row', paddingVertical: 3, borderBottomWidth: 0.8, borderBottomColor: '#999' },
  headerCell: { fontSize: 7, fontWeight: 'bold', color: '#555', textTransform: 'uppercase' },
  row: { flexDirection: 'row', paddingVertical: 3, borderBottomWidth: 0.4, borderBottomColor: '#e4e4e4' },
  totalRow: { flexDirection: 'row', paddingVertical: 3.5, marginTop: 1, borderTopWidth: 1, borderTopColor: '#1a1a1a' },
  colName: { flex: 1, paddingRight: 6, color: '#1a1a1a' },
  colShort: { width: 60, paddingRight: 6, color: '#1a1a1a' },
  colDate: { width: 66, paddingRight: 6, color: '#1a1a1a' },
  colAmount: { width: 74, textAlign: 'right', fontFamily: 'Courier', color: '#1a1a1a' },
  bold: { fontWeight: 'bold' },
  note: { fontSize: 9, color: '#333', marginTop: 4 },
  footer: {
    position: 'absolute',
    bottom: 20,
    left: 40,
    right: 40,
    borderTopWidth: 0.5,
    borderTopColor: '#d4d4d4',
    paddingTop: 5,
  },
  footerText: { fontSize: 7, color: '#888' },
})

function netSentence(input: SetoffNoteInput): string {
  const amount = `${formatNoteAmount(input.net.amount)} kr`
  const us = input.companyName ?? 'Vi'
  const them = input.counterpartyName ?? 'motparten'
  if (input.net.direction === 'we_pay') return `Efter kvittningen återstår ${amount} som ${us} betalar till ${them}.`
  if (input.net.direction === 'they_pay') return `Efter kvittningen återstår ${amount} som ${them} betalar till ${us}.`
  return 'Efter kvittningen återstår inget att betala mellan fakturorna.'
}

export function SetoffNotePDF({ input }: { input: SetoffNoteInput }) {
  const supplierLabel = supplierInvoiceLabel(input.supplierInvoice)
  return (
    <Document>
      <Page size="A4" style={styles.page}>
        <View style={styles.header}>
          <View>
            <Text style={styles.title}>Kvittningsavräkning</Text>
            <Text style={styles.meta}>
              Kvittningsdag {input.setoffDate}
              {input.voucherLabel ? ` · Verifikat ${input.voucherLabel}` : ''}
            </Text>
          </View>
          <View style={styles.companyInfo}>
            {input.companyName ? <Text style={styles.companyName}>{input.companyName}</Text> : null}
            {input.companyOrgNumber ? <Text style={styles.meta}>Org.nr: {input.companyOrgNumber}</Text> : null}
          </View>
        </View>

        <Text style={styles.sectionHeading}>Parter</Text>
        <View style={styles.partyRow}>
          <Text style={styles.partyLabel}>Vi</Text>
          <Text style={styles.partyValue}>
            {input.companyName ?? ''}
            {input.companyOrgNumber ? `, org.nr ${input.companyOrgNumber}` : ''}
          </Text>
        </View>
        <View style={styles.partyRow}>
          <Text style={styles.partyLabel}>Motpart</Text>
          <Text style={styles.partyValue}>
            {input.counterpartyName ?? ''}
            {input.counterpartyOrgNumber ? `, org.nr ${input.counterpartyOrgNumber}` : ''}
          </Text>
        </View>

        <Text style={styles.sectionHeading}>Kvittade fakturor (SEK)</Text>
        <View style={styles.tableHeader}>
          <Text style={[styles.colName, styles.headerCell]}>Faktura</Text>
          <Text style={[styles.colDate, styles.headerCell]}>Datum</Text>
          <Text style={[styles.colAmount, styles.headerCell]}>Belopp</Text>
          <Text style={[styles.colAmount, styles.headerCell]}>Kvar före</Text>
          <Text style={[styles.colAmount, styles.headerCell]}>Kvittat</Text>
          <Text style={[styles.colAmount, styles.headerCell]}>Kvar efter</Text>
        </View>
        <View style={styles.row} wrap={false}>
          <Text style={styles.colName}>Kundfaktura {input.invoice.number ?? ''} (vår fordran)</Text>
          <Text style={styles.colDate}>{input.invoice.invoiceDate}</Text>
          <Text style={styles.colAmount}>{formatNoteAmount(input.invoice.total)}</Text>
          <Text style={styles.colAmount}>{formatNoteAmount(input.invoice.remainingBefore)}</Text>
          <Text style={styles.colAmount}>{formatNoteAmount(input.amount)}</Text>
          <Text style={styles.colAmount}>{formatNoteAmount(input.invoice.remainingAfter)}</Text>
        </View>
        <View style={styles.row} wrap={false}>
          <Text style={styles.colName}>Leverantörsfaktura {supplierLabel} (vår skuld)</Text>
          <Text style={styles.colDate}>{input.supplierInvoice.invoiceDate}</Text>
          <Text style={styles.colAmount}>{formatNoteAmount(input.supplierInvoice.total)}</Text>
          <Text style={styles.colAmount}>{formatNoteAmount(input.supplierInvoice.remainingBefore)}</Text>
          <Text style={styles.colAmount}>{formatNoteAmount(input.amount)}</Text>
          <Text style={styles.colAmount}>{formatNoteAmount(input.supplierInvoice.remainingAfter)}</Text>
        </View>
        <Text style={styles.note}>{netSentence(input)}</Text>

        {input.receivableAccount && input.payableAccount ? (
          <View>
            <Text style={styles.sectionHeading}>{input.voucherLabel ? `Kontering, verifikat ${input.voucherLabel}` : 'Kontering'}</Text>
            <View style={styles.tableHeader}>
              <Text style={[styles.colShort, styles.headerCell]}>Konto</Text>
              <Text style={[styles.colName, styles.headerCell]}>Text</Text>
              <Text style={[styles.colAmount, styles.headerCell]}>Debet</Text>
              <Text style={[styles.colAmount, styles.headerCell]}>Kredit</Text>
            </View>
            <View style={styles.row} wrap={false}>
              <Text style={styles.colShort}>{input.payableAccount}</Text>
              <Text style={styles.colName}>Leverantörsfaktura {supplierLabel}</Text>
              <Text style={styles.colAmount}>{formatNoteAmount(input.amount)}</Text>
              <Text style={styles.colAmount}></Text>
            </View>
            <View style={styles.row} wrap={false}>
              <Text style={styles.colShort}>{input.receivableAccount}</Text>
              <Text style={styles.colName}>Kundfaktura {input.invoice.number ?? ''}</Text>
              <Text style={styles.colAmount}></Text>
              <Text style={styles.colAmount}>{formatNoteAmount(input.amount)}</Text>
            </View>
            <View style={styles.totalRow}>
              <Text style={styles.colShort}></Text>
              <Text style={[styles.colName, styles.bold]}>Summa</Text>
              <Text style={[styles.colAmount, styles.bold]}>{formatNoteAmount(input.amount)}</Text>
              <Text style={[styles.colAmount, styles.bold]}>{formatNoteAmount(input.amount)}</Text>
            </View>
            <Text style={styles.note}>Momsen påverkas inte: den bokfördes när fakturorna registrerades.</Text>
          </View>
        ) : null}

        {input.note ? (
          <View>
            <Text style={styles.sectionHeading}>Grund för kvittningen</Text>
            <Text style={styles.note}>{input.note}</Text>
          </View>
        ) : null}

        <View style={styles.footer} fixed>
          <Text style={styles.footerText}>
            Kvittning av ömsesidiga fordringar mellan parterna. Fakturorna och deras verifikat finns i bokföringen. Genererad{' '}
            {input.generatedAt}.
          </Text>
        </View>
      </Page>
    </Document>
  )
}

export async function renderSetoffNote(input: SetoffNoteInput): Promise<Buffer> {
  return renderToBuffer(SetoffNotePDF({ input }))
}
