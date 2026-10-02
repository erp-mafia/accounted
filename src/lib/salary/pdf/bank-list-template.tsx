import { Document, Page, Text, View, StyleSheet } from '@react-pdf/renderer'
import { pdfAmount, pdfText } from '@/lib/pdf/number-text'
import { getBranding } from '@/lib/branding/service'
import type { SalaryBankList } from '@/lib/salary/payment/bank-list'

/**
 * Banklista: the payments a salary payment file carries, for checking the
 * file against before it is uploaded to the bank. Same look as the
 * Lönesammanställning (run-underlag-template.tsx); Swedish in both locales,
 * like the payslip. Accounts are masked (clearing and the last four digits):
 * a personkonto number is the holder's personnummer.
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
  colNo: { flex: 0.4 },
  colName: { flex: 3 },
  colAccount: { flex: 1.8 },
  colReference: { flex: 2.4 },
  colAmount: { flex: 1.6, textAlign: 'right' as const },
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

/**
 * A builder warning made drawable in Helvetica (WinAnsi): the settings path
 * arrow has no glyph there and would print as nothing.
 */
function warningText(text: string): string {
  return pdfText(text).replaceAll('\u2192', '>')
}

const FORMAT_LABEL: Record<SalaryBankList['format'], string> = {
  pain001: 'ISO 20022 pain.001',
  bg_lb: 'Bankgirot LB',
}

const REFERENCE_LABEL: Record<SalaryBankList['format'], string> = {
  pain001: 'Referens (EndToEndId)',
  bg_lb: 'Utbetalningsnummer',
}

const PAYER_ACCOUNT_LABEL: Record<SalaryBankList['format'], string> = {
  pain001: 'Från konto (IBAN)',
  bg_lb: 'Från bankgiro',
}

export function SalaryBankListPDF({ list, generatedAt }: { list: SalaryBankList; generatedAt: string }) {
  return (
    <Document>
      <Page size="A4" style={styles.page}>
        <View style={styles.header}>
          <View>
            <Text style={styles.title}>Banklista</Text>
            <Text style={styles.subtitle}>
              Lön {list.periodLabel} · Utbetalning {list.paymentDate}
            </Text>
            <Text style={styles.companyInfo}>
              Betalfil: {list.filename} ({FORMAT_LABEL[list.format]})
            </Text>
            <Text style={styles.companyInfo}>
              {PAYER_ACCOUNT_LABEL[list.format]}: {list.payer.account}
            </Text>
          </View>
          <View style={{ alignItems: 'flex-end' as const }}>
            <Text style={styles.companyName}>{list.payer.name}</Text>
            {list.payer.orgNumber ? <Text style={styles.companyInfo}>Org.nr {list.payer.orgNumber}</Text> : null}
          </View>
        </View>

        {list.warnings.map((warning, i) => (
          <Text key={i} style={styles.notice}>
            {warningText(warning)}
          </Text>
        ))}

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Betalningar i filen</Text>
          <View style={styles.headerRow}>
            <Text style={[styles.headerText, styles.colNo]}>Nr</Text>
            <Text style={[styles.headerText, styles.colName]}>Mottagare</Text>
            <Text style={[styles.headerText, styles.colAccount]}>Konto</Text>
            <Text style={[styles.headerText, styles.colReference]}>{REFERENCE_LABEL[list.format]}</Text>
            <Text style={[styles.headerText, styles.colAmount]}>Belopp</Text>
          </View>
          {list.payees.map((payee, i) => (
            <View key={`${payee.employeeId}-${i}`} style={i % 2 === 1 ? styles.rowAlt : styles.row} wrap={false}>
              <Text style={styles.colNo}>{i + 1}</Text>
              <Text style={styles.colName}>{payee.name}</Text>
              <Text style={styles.colAccount}>{payee.maskedAccount}</Text>
              <Text style={styles.colReference}>{payee.reference}</Text>
              <Text style={styles.colAmount}>{pdfAmount(payee.amount)}</Text>
            </View>
          ))}
          <View style={styles.totalRow} wrap={false}>
            <Text style={styles.colNo}></Text>
            <Text style={styles.colName}>Summa ({list.employeeCount} betalningar)</Text>
            <Text style={styles.colAccount}></Text>
            <Text style={styles.colReference}></Text>
            <Text style={styles.colAmount}>{pdfAmount(list.totalAmount)} kr</Text>
          </View>
        </View>

        <Text style={styles.companyInfo}>
          Antal betalningar och summa ska stämma med det banken visar när filen läses in. Kontonumren visas med
          clearingnummer och de fyra sista siffrorna.
        </Text>

        <View style={styles.footer} fixed>
          <Text>
            {list.payer.name} · Banklista lön {list.periodLabel} · Upprättad {generatedAt.slice(0, 10)} av{' '}
            {getBranding().appName.toLowerCase()}
          </Text>
          <Text render={({ pageNumber, totalPages }) => `Sida ${pageNumber} av ${totalPages}`} />
        </View>
      </Page>
    </Document>
  )
}
