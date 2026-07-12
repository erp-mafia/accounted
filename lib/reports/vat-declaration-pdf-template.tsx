import {
  Document,
  Page,
  Text,
  View,
  StyleSheet,
} from '@react-pdf/renderer'
import type { CompanySettings } from '@/types'
import type { ManualFilingRow } from '@/lib/reports/vat-manual-filing'

const styles = StyleSheet.create({
  page: {
    paddingTop: 40,
    paddingHorizontal: 40,
    paddingBottom: 90,
    fontSize: 10,
    fontFamily: 'Helvetica',
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: 16,
    paddingBottom: 14,
    borderBottomWidth: 1,
    borderBottomColor: '#d4d4d4',
  },
  titleBlock: { flex: 1 },
  title: {
    fontSize: 20,
    fontWeight: 'bold',
    color: '#1a1a1a',
    marginBottom: 4,
  },
  subtitle: { fontSize: 11, color: '#333', marginBottom: 2 },
  period: { fontSize: 10, color: '#666' },
  companyInfo: { textAlign: 'right' },
  companyName: { fontSize: 11, fontWeight: 'bold', marginBottom: 2 },
  companyMeta: { fontSize: 9, color: '#666' },
  note: {
    marginBottom: 18,
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderWidth: 0.8,
    borderColor: '#b45309',
    backgroundColor: '#fef3c7',
    borderRadius: 3,
  },
  noteText: { fontSize: 8, color: '#78350f', lineHeight: 1.3 },
  tableHeadRow: {
    flexDirection: 'row',
    paddingBottom: 4,
    marginBottom: 2,
    borderBottomWidth: 1,
    borderBottomColor: '#1a1a1a',
  },
  headRuta: { width: 44, fontSize: 8, fontWeight: 'bold', color: '#444' },
  headLabel: { flex: 1, fontSize: 8, fontWeight: 'bold', color: '#444', paddingRight: 12 },
  headAmount: { width: 110, fontSize: 8, fontWeight: 'bold', color: '#444', textAlign: 'right' },
  row: { flexDirection: 'row', paddingVertical: 3 },
  colRuta: { width: 44, fontFamily: 'Courier', color: '#666' },
  colLabel: { flex: 1, color: '#1a1a1a', paddingRight: 12 },
  colAmount: { width: 110, textAlign: 'right', fontFamily: 'Courier', color: '#1a1a1a' },
  netRow: {
    flexDirection: 'row',
    paddingVertical: 6,
    marginTop: 6,
    borderTopWidth: 1,
    borderTopColor: '#1a1a1a',
  },
  netLabel: { flex: 1, fontWeight: 'bold', fontSize: 11, paddingLeft: 44 },
  netAmount: {
    width: 110,
    textAlign: 'right',
    fontFamily: 'Courier',
    fontWeight: 'bold',
    fontSize: 11,
  },
  footer: {
    position: 'absolute',
    bottom: 24,
    left: 40,
    right: 40,
    borderTopWidth: 0.5,
    borderTopColor: '#d4d4d4',
    paddingTop: 6,
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  footerText: { fontSize: 8, color: '#888' },
})

// Hela kronor: the momsdeklaration is filed in whole kronor, and the rows are
// already truncated to whole kronor (öretal faller bort, see
// buildManualFilingRows), so format with no decimals.
function formatKr(amount: number): string {
  return new Intl.NumberFormat('sv-SE', { maximumFractionDigits: 0 }).format(amount)
}

function formatOrgNumber(orgNumber: string): string {
  const cleaned = orgNumber.replace(/\D/g, '')
  if (cleaned.length === 10) {
    return `${cleaned.slice(0, 6)}-${cleaned.slice(6)}`
  }
  return orgNumber
}

function formatDateSv(iso: string): string {
  if (!iso) return ''
  return new Date(iso).toLocaleDateString('sv-SE')
}

interface VatDeclarationPDFProps {
  rows: ManualFilingRow[]
  period: { start: string; end: string }
  periodLabel: string
  company: CompanySettings
  generatedAt: string
}

/**
 * A momsdeklaration document (SKV 4700 layout) for manual filing at
 * skatteverket.se. Amounts are in hela kronor, matching what the user types
 * into the form. This is a reading/record copy, NOT a file that is uploaded to
 * Skatteverket, moms has no file-submission format; the machine channel is the
 * Skatteverket API. The disclaimer says so explicitly.
 *
 * Swedish-only: momsdeklaration ruta labels are Skatteverket form labels.
 */
export function VatDeclarationPDF({
  rows,
  period,
  periodLabel,
  company,
  generatedAt,
}: VatDeclarationPDFProps) {
  const companyDisplayName = company.company_name || ''

  return (
    <Document>
      <Page size="A4" style={styles.page}>
        <View style={styles.header} fixed>
          <View style={styles.titleBlock}>
            <Text style={styles.title}>Momsdeklaration</Text>
            {periodLabel && <Text style={styles.subtitle}>{periodLabel}</Text>}
            {period.start && period.end && (
              <Text style={styles.period}>
                Period: {formatDateSv(period.start)}: {formatDateSv(period.end)}
              </Text>
            )}
          </View>
          <View style={styles.companyInfo}>
            {companyDisplayName && (
              <Text style={styles.companyName}>{companyDisplayName}</Text>
            )}
            {company.org_number && (
              <Text style={styles.companyMeta}>Org.nr: {formatOrgNumber(company.org_number)}</Text>
            )}
            {company.vat_number && (
              <Text style={styles.companyMeta}>Moms-nr: {company.vat_number}</Text>
            )}
          </View>
        </View>

        <View style={styles.note}>
          <Text style={styles.noteText}>
            Underlag för manuell inlämning. Detta är inte en inlämnad deklaration.
            Logga in på skatteverket.se med BankID, öppna Moms- och
            arbetsgivardeklarationer och skriv in beloppen nedan. Belopp i hela kronor.
          </Text>
        </View>

        <View style={styles.tableHeadRow} fixed>
          <Text style={styles.headRuta}>Ruta</Text>
          <Text style={styles.headLabel}>Beskrivning</Text>
          <Text style={styles.headAmount}>Belopp (kr)</Text>
        </View>

        {rows
          .filter((r) => !r.isNet)
          .map((r) => (
            <View key={r.ruta} style={styles.row} wrap={false}>
              <Text style={styles.colRuta}>{r.ruta}</Text>
              <Text style={styles.colLabel}>{r.label}</Text>
              <Text style={styles.colAmount}>{formatKr(r.amount)}</Text>
            </View>
          ))}

        {rows
          .filter((r) => r.isNet)
          .map((r) => (
            <View key={r.ruta} style={styles.netRow} wrap={false}>
              <Text style={styles.netLabel}>
                {r.ruta} {r.label}
              </Text>
              <Text style={styles.netAmount}>{formatKr(r.amount)}</Text>
            </View>
          ))}

        <View style={styles.footer} fixed>
          <Text style={styles.footerText}>
            {companyDisplayName}
            {company.org_number ? ` · ${formatOrgNumber(company.org_number)}` : ''}
          </Text>
          <Text
            style={styles.footerText}
            render={({ pageNumber, totalPages }) =>
              `Genererad ${formatDateSv(generatedAt)} · Sida ${pageNumber} av ${totalPages}`
            }
          />
        </View>
      </Page>
    </Document>
  )
}
