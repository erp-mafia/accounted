import { formatOrgNumber } from '@/lib/utils'
import { Document, Page, StyleSheet, Text, View } from '@react-pdf/renderer'
import type { VacationLiabilityCheck, VacationLiabilityReport } from '@/lib/reports/vacation-liability'

/**
 * Semesterskuld per employee (BFNAR 2016:10) as of a date, with the booked
 * 2920/2940 balances beside the totals. Same layout rules as the other
 * report PDFs: bundled Helvetica/Courier, header and footer `fixed`, every
 * row `wrap={false}`, no `break` props.
 */

const INK = '#1a1a1a'
const MUTED = '#666'
const HAIRLINE = '#d4d4d4'

const styles = StyleSheet.create({
  page: { paddingTop: 36, paddingHorizontal: 40, paddingBottom: 54, fontSize: 8.5, fontFamily: 'Helvetica', color: INK },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: 10,
    paddingBottom: 10,
    borderBottomWidth: 1,
    borderBottomColor: HAIRLINE,
  },
  titleBlock: { flex: 1 },
  title: { fontSize: 18, fontWeight: 'bold', marginBottom: 3 },
  subtitle: { fontSize: 9.5, color: '#333', marginBottom: 2 },
  legal: { fontSize: 8, color: MUTED },
  companyInfo: { textAlign: 'right' },
  companyName: { fontSize: 10, fontWeight: 'bold', marginBottom: 2 },
  companyMeta: { fontSize: 8.5, color: MUTED },
  tableHeader: { flexDirection: 'row', paddingVertical: 3, borderBottomWidth: 0.5, borderBottomColor: INK, marginTop: 6 },
  th: { fontSize: 7, color: '#444', textTransform: 'uppercase', letterSpacing: 0.3 },
  row: { flexDirection: 'row', paddingVertical: 2.5, borderBottomWidth: 0.5, borderBottomColor: '#ececec' },
  totalRow: { flexDirection: 'row', paddingVertical: 3, borderTopWidth: 0.8, borderTopColor: INK, marginTop: 1 },
  name: { flex: 1, paddingRight: 6 },
  num: { width: 52, textAlign: 'right', fontFamily: 'Courier', fontSize: 8 },
  amount: { width: 80, textAlign: 'right', fontFamily: 'Courier', fontSize: 8 },
  bold: { fontWeight: 'bold' },
  sectionHeading: { fontSize: 10.5, fontWeight: 'bold', marginTop: 14, marginBottom: 4 },
  note: { fontSize: 8, color: MUTED, marginTop: 6 },
  empty: { fontSize: 8.5, color: MUTED, fontStyle: 'italic', paddingVertical: 6 },
  footer: { position: 'absolute', bottom: 22, left: 40, right: 40, borderTopWidth: 0.5, borderTopColor: HAIRLINE, paddingTop: 5, flexDirection: 'row', justifyContent: 'space-between' },
  footerText: { fontSize: 7.5, color: '#888' },
})

/** WinAnsi only: a true minus or narrow spaces would drop silently. */
function pdfText(value: string): string {
  return value.replace(/−/g, '-').replace(/[   ]/g, ' ')
}

const AMOUNT = new Intl.NumberFormat('sv-SE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const DAYS = new Intl.NumberFormat('sv-SE', { maximumFractionDigits: 2 })

const amount = (n: number) => pdfText(AMOUNT.format(n))
const days = (n: number) => pdfText(DAYS.format(n))

export interface SemesterskuldPDFProps {
  report: VacationLiabilityReport
  check: VacationLiabilityCheck | null
  company: { name: string; org_number: string | null }
}

export function SemesterskuldPDF({ report, check, company }: SemesterskuldPDFProps) {
  const { totals } = report
  return (
    <Document title={`Semesterskuld ${report.asOfDate}`} author={company.name} subject="Semesterlöneskuld per anställd">
      <Page size="A4" orientation="landscape" style={styles.page}>
        <View style={styles.header} fixed>
          <View style={styles.titleBlock}>
            <Text style={styles.title}>Semesterskuld</Text>
            <Text style={styles.subtitle}>
              Per {report.asOfDate} · Dagar för semesteråret som börjar {report.vacationYearStart}
            </Text>
            <Text style={styles.legal}>Semesterlöneskuld per anställd enligt BFNAR 2016:10 · Konto 2920 och 2940</Text>
          </View>
          <View style={styles.companyInfo}>
            {company.name ? <Text style={styles.companyName}>{pdfText(company.name)}</Text> : null}
            {company.org_number ? <Text style={styles.companyMeta}>Org.nr: {formatOrgNumber(company.org_number)}</Text> : null}
          </View>
        </View>

        <View style={styles.tableHeader} fixed>
          <Text style={[styles.th, styles.name]}>Anställd</Text>
          <Text style={[styles.th, styles.num]}>Dagar</Text>
          <Text style={[styles.th, styles.num]}>Uttagna</Text>
          <Text style={[styles.th, styles.num]}>Kvar</Text>
          <Text style={[styles.th, styles.num]}>Sparade</Text>
          <Text style={[styles.th, styles.amount]}>Semesterlön 2920</Text>
          <Text style={[styles.th, styles.amount]}>Avgifter 2940</Text>
          <Text style={[styles.th, styles.amount]}>Summa</Text>
        </View>
        {report.rows.length === 0 ? (
          <Text style={styles.empty}>Inga anställda med semesterskuld.</Text>
        ) : (
          report.rows.map((row) => (
            <View key={row.employeeId} style={styles.row} wrap={false}>
              <Text style={styles.name}>{pdfText(row.employeeName)}</Text>
              <Text style={styles.num}>{days(row.vacationDaysEntitled)}</Text>
              <Text style={styles.num}>{days(row.vacationDaysTaken)}</Text>
              <Text style={styles.num}>{days(row.vacationDaysRemaining)}</Text>
              <Text style={styles.num}>{days(row.vacationDaysSaved)}</Text>
              <Text style={styles.amount}>{amount(row.accruedAmount)}</Text>
              <Text style={styles.amount}>{amount(row.accruedAvgifter)}</Text>
              <Text style={styles.amount}>{amount(row.totalLiability)}</Text>
            </View>
          ))
        )}
        <View style={styles.totalRow} wrap={false}>
          <Text style={[styles.name, styles.bold]}>Summa</Text>
          {/* Under the four day columns. */}
          <View style={{ width: 208 }} />
          <Text style={[styles.amount, styles.bold]}>{amount(totals.accruedAmount)}</Text>
          <Text style={[styles.amount, styles.bold]}>{amount(totals.accruedAvgifter)}</Text>
          <Text style={[styles.amount, styles.bold]}>{amount(totals.totalLiability)}</Text>
        </View>

        {check && (
          <View wrap={false}>
            <Text style={styles.sectionHeading}>Avstämning mot bokföringen</Text>
            <View style={styles.tableHeader}>
              <Text style={[styles.th, styles.name]} />
              <Text style={[styles.th, styles.amount]}>2920</Text>
              <Text style={[styles.th, styles.amount]}>2940</Text>
            </View>
            <View style={styles.row}>
              <Text style={styles.name}>Enligt rapporten</Text>
              <Text style={styles.amount}>{amount(totals.accruedAmount)}</Text>
              <Text style={styles.amount}>{amount(totals.accruedAvgifter)}</Text>
            </View>
            <View style={styles.row}>
              <Text style={styles.name}>Bokfört per {report.asOfDate}</Text>
              <Text style={styles.amount}>{amount(check.booked2920)}</Text>
              <Text style={styles.amount}>{amount(check.booked2940)}</Text>
            </View>
            <View style={styles.row}>
              <Text style={[styles.name, styles.bold]}>Differens</Text>
              <Text style={[styles.amount, styles.bold]}>{amount(check.difference2920)}</Text>
              <Text style={[styles.amount, styles.bold]}>{amount(check.difference2940)}</Text>
            </View>
          </View>
        )}

        {totals.advanceVacationDebt !== 0 && (
          <Text style={styles.note}>
            Förskottsskuld (fordran på anställda, ingår inte i 2920 och 2940): {amount(totals.advanceVacationDebt)}
          </Text>
        )}
        <Text style={styles.note}>
          {report.closedYear
            ? `Beloppen utgår från semesterårsavslutet per ${report.closedYear.end} och lägger till semesteravsättningar bokförda efter det.`
            : 'Beloppen är alla bokförda semesteravsättningar, plus ingående semesterskuld vid byte av system.'}
        </Text>

        <View style={styles.footer} fixed>
          <Text style={styles.footerText}>
            {pdfText(company.name)}
            {company.org_number ? ` · ${formatOrgNumber(company.org_number)}` : ''}
            {' · Semesterskuld per '}
            {report.asOfDate}
          </Text>
          <Text style={styles.footerText} render={({ pageNumber, totalPages }) => `Sida ${pageNumber} av ${totalPages}`} />
        </View>
      </Page>
    </Document>
  )
}
