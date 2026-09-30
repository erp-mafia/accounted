import { Document, Page, Text, View, StyleSheet } from '@react-pdf/renderer'
import { pdfNumberText } from '@/lib/pdf/number-text'
import { getBranding } from '@/lib/branding/service'
import type { SalaryRunUnderlagData } from '@/lib/salary/run-underlag'

/**
 * Lönesammanställning: the bokföringsunderlag for one salary run.
 *
 * Räkenskapsinformation filed with the run's verifikat (7-year retention per
 * BFL 7 kap). Swedish in both locales, like the payslip. Contents:
 * - Company, period, payment date, status (rättelse / korrigerad)
 * - Per employee: brutto, skatt, netto, arbetsgivaravgifter,
 *   semesterlöneskuld with its avgifter, total cost; totals row
 * - The posted verifikat with voucher number, account, account name,
 *   debit and credit, and per-verifikat sums
 */

const styles = StyleSheet.create({
  page: {
    fontFamily: 'Helvetica',
    fontSize: 8.5,
    paddingTop: 36,
    paddingBottom: 50,
    paddingHorizontal: 36,
    color: '#1a1a1a',
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 16,
  },
  title: {
    fontSize: 16,
    fontFamily: 'Helvetica-Bold',
    marginBottom: 4,
  },
  subtitle: {
    fontSize: 10,
    color: '#666',
  },
  companyName: {
    fontSize: 12,
    fontFamily: 'Helvetica-Bold',
  },
  companyInfo: {
    fontSize: 8,
    color: '#666',
    marginTop: 2,
  },
  notice: {
    fontSize: 8.5,
    marginBottom: 12,
    padding: 6,
    backgroundColor: '#f5f5f5',
  },
  section: {
    marginBottom: 16,
  },
  sectionTitle: {
    fontSize: 10,
    fontFamily: 'Helvetica-Bold',
    marginBottom: 6,
    paddingBottom: 3,
    borderBottomWidth: 1,
    borderBottomColor: '#e0e0e0',
  },
  entryTitle: {
    fontSize: 9,
    fontFamily: 'Helvetica-Bold',
    marginTop: 8,
    marginBottom: 3,
  },
  headerRow: {
    flexDirection: 'row',
    paddingVertical: 4,
    borderBottomWidth: 1,
    borderBottomColor: '#ccc',
  },
  row: {
    flexDirection: 'row',
    paddingVertical: 2.5,
  },
  rowAlt: {
    flexDirection: 'row',
    paddingVertical: 2.5,
    backgroundColor: '#f8f8f8',
  },
  totalRow: {
    flexDirection: 'row',
    paddingVertical: 4,
    borderTopWidth: 1.5,
    borderTopColor: '#1a1a1a',
    fontFamily: 'Helvetica-Bold',
  },
  headerText: {
    fontSize: 7.5,
    fontFamily: 'Helvetica-Bold',
    color: '#666',
  },
  colName: { flex: 3 },
  colPnr: { flex: 1 },
  colAmount: { flex: 1.6, textAlign: 'right' as const },
  colAccount: { flex: 0.8 },
  colAccountName: { flex: 3 },
  colLineDesc: { flex: 3.2 },
  footer: {
    position: 'absolute' as const,
    bottom: 24,
    left: 36,
    right: 36,
    borderTopWidth: 1,
    borderTopColor: '#e0e0e0',
    paddingTop: 5,
    fontSize: 7,
    color: '#999',
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
})

function fmt(amount: number): string {
  // pdfNumberText: Intl writes negatives with U+2212, which the bundled
  // Helvetica cannot draw (issue #1982).
  return pdfNumberText(
    new Intl.NumberFormat('sv-SE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(amount),
  )
}

/** Debit/credit cells stay blank for a zero, as on a printed verifikat. */
function fmtOrBlank(amount: number): string {
  return amount === 0 ? '' : fmt(amount)
}

const MONTH_NAMES = [
  'januari', 'februari', 'mars', 'april', 'maj', 'juni',
  'juli', 'augusti', 'september', 'oktober', 'november', 'december',
]

export function SalaryRunUnderlagPDF({ data }: { data: SalaryRunUnderlagData }) {
  const periodLabel = `${MONTH_NAMES[data.periodMonth - 1]} ${data.periodYear}`
  const generatedDate = data.generatedAt.slice(0, 10)
  const vouchers = data.entries.map((e) => e.voucher).filter((v): v is string => !!v)

  return (
    <Document>
      <Page size="A4" orientation="landscape" style={styles.page}>
        <View style={styles.header}>
          <View>
            <Text style={styles.title}>
              Lönesammanställning{data.isCorrection ? ' (rättelsekörning)' : ''}
            </Text>
            <Text style={styles.subtitle}>
              Bokföringsunderlag, lön {periodLabel} · Utbetalning {data.paymentDate}
            </Text>
            {vouchers.length > 0 && (
              <Text style={styles.companyInfo}>Verifikationer: {vouchers.join(', ')}</Text>
            )}
          </View>
          <View style={{ alignItems: 'flex-end' as const }}>
            <Text style={styles.companyName}>{data.companyName}</Text>
            <Text style={styles.companyInfo}>Org.nr {data.companyOrgNumber}</Text>
          </View>
        </View>

        {data.corrected && (
          <Text style={styles.notice}>
            Lönekörningen har korrigerats genom en rättelsekörning. Underlaget visar körningen som den bokfördes
            ursprungligen.
          </Text>
        )}

        {/* Per employee */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Per anställd</Text>
          <View style={styles.headerRow}>
            <Text style={[styles.headerText, styles.colName]}>Anställd</Text>
            <Text style={[styles.headerText, styles.colPnr]}>Pnr (4)</Text>
            <Text style={[styles.headerText, styles.colAmount]}>Bruttolön</Text>
            <Text style={[styles.headerText, styles.colAmount]}>Skatt</Text>
            <Text style={[styles.headerText, styles.colAmount]}>Nettolön</Text>
            <Text style={[styles.headerText, styles.colAmount]}>Arbetsgivaravg.</Text>
            <Text style={[styles.headerText, styles.colAmount]}>Semesterlöneskuld</Text>
            <Text style={[styles.headerText, styles.colAmount]}>Avg. semesterlön</Text>
            <Text style={[styles.headerText, styles.colAmount]}>Total kostnad</Text>
          </View>
          {data.rows.map((row, i) => (
            <View key={`${row.employeeId}-${i}`} style={i % 2 === 1 ? styles.rowAlt : styles.row} wrap={false}>
              <Text style={styles.colName}>{row.employeeName}</Text>
              <Text style={styles.colPnr}>{row.personnummerLast4}</Text>
              <Text style={styles.colAmount}>{fmt(row.grossSalary)}</Text>
              <Text style={styles.colAmount}>{fmt(row.taxWithheld)}</Text>
              <Text style={styles.colAmount}>{fmt(row.netSalary)}</Text>
              <Text style={styles.colAmount}>{fmt(row.avgifterAmount)}</Text>
              <Text style={styles.colAmount}>{fmt(row.vacationAccrual)}</Text>
              <Text style={styles.colAmount}>{fmt(row.vacationAccrualAvgifter)}</Text>
              <Text style={styles.colAmount}>{fmt(row.totalEmployerCost)}</Text>
            </View>
          ))}
          <View style={styles.totalRow} wrap={false}>
            <Text style={styles.colName}>Summa ({data.rows.length} anställda)</Text>
            <Text style={styles.colPnr}></Text>
            <Text style={styles.colAmount}>{fmt(data.totals.grossSalary)}</Text>
            <Text style={styles.colAmount}>{fmt(data.totals.taxWithheld)}</Text>
            <Text style={styles.colAmount}>{fmt(data.totals.netSalary)}</Text>
            <Text style={styles.colAmount}>{fmt(data.totals.avgifterAmount)}</Text>
            <Text style={styles.colAmount}>{fmt(data.totals.vacationAccrual)}</Text>
            <Text style={styles.colAmount}>{fmt(data.totals.vacationAccrualAvgifter)}</Text>
            <Text style={styles.colAmount}>{fmt(data.totals.totalEmployerCost)}</Text>
          </View>
        </View>

        {/* Posted verifikat */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Kontering</Text>
          {data.entries.length === 0 ? (
            <Text>Nollkörning: inga verifikationer bokfördes för den här körningen.</Text>
          ) : (
            data.entries.map((entry, ei) => (
              <View key={ei} wrap={false}>
                <Text style={styles.entryTitle}>
                  {entry.voucher ? `${entry.voucher} · ` : ''}
                  {entry.description}
                </Text>
                <View style={styles.headerRow}>
                  <Text style={[styles.headerText, styles.colAccount]}>Konto</Text>
                  <Text style={[styles.headerText, styles.colAccountName]}>Kontonamn</Text>
                  <Text style={[styles.headerText, styles.colLineDesc]}>Beskrivning</Text>
                  <Text style={[styles.headerText, styles.colAmount]}>Debet</Text>
                  <Text style={[styles.headerText, styles.colAmount]}>Kredit</Text>
                </View>
                {entry.lines.map((line, li) => (
                  <View key={li} style={li % 2 === 1 ? styles.rowAlt : styles.row}>
                    <Text style={styles.colAccount}>{line.account_number}</Text>
                    <Text style={styles.colAccountName}>{line.account_name ?? ''}</Text>
                    <Text style={styles.colLineDesc}>{line.line_description}</Text>
                    <Text style={styles.colAmount}>{fmtOrBlank(line.debit_amount)}</Text>
                    <Text style={styles.colAmount}>{fmtOrBlank(line.credit_amount)}</Text>
                  </View>
                ))}
                <View style={styles.totalRow}>
                  <Text style={styles.colAccount}></Text>
                  <Text style={styles.colAccountName}>Summa</Text>
                  <Text style={styles.colLineDesc}></Text>
                  <Text style={styles.colAmount}>{fmt(entry.totalDebit)}</Text>
                  <Text style={styles.colAmount}>{fmt(entry.totalCredit)}</Text>
                </View>
              </View>
            ))
          )}
        </View>

        <View style={styles.footer} fixed>
          <Text>
            {data.companyName} · Org.nr {data.companyOrgNumber} · Lönesammanställning {periodLabel} · Upprättad{' '}
            {generatedDate} av {getBranding().appName.toLowerCase()}
          </Text>
          <Text render={({ pageNumber, totalPages }) => `Sida ${pageNumber} av ${totalPages}`} />
        </View>
      </Page>
    </Document>
  )
}
