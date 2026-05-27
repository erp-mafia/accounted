import {
  Document,
  Page,
  Text,
  View,
  StyleSheet,
} from '@react-pdf/renderer'
import type { KassaflodesanalysReport } from './kassaflodesanalys'
import type { CompanySettings } from '@/types'

// Single-file PDF template — the kassaflödesanalys layout is distinct enough
// from the BR/RR template (no per-account rows, three labelled sections, a
// reconciliation footer) that a dedicated template keeps things readable.
// Typography mirrors CLAUDE.md design system: Times-Roman as the serif
// (closest stock @react-pdf font to Hedvig Letters Serif, which @react-pdf
// can't ship by default), Helvetica for body, Courier for tabular numbers
// so columns align without us shipping a custom font.

const styles = StyleSheet.create({
  page: {
    paddingTop: 40,
    paddingHorizontal: 40,
    paddingBottom: 110,
    fontSize: 10,
    fontFamily: 'Helvetica',
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: 24,
    paddingBottom: 14,
    borderBottomWidth: 1,
    borderBottomColor: '#d4d4d4',
  },
  titleBlock: { flex: 1 },
  title: {
    fontSize: 22,
    fontFamily: 'Times-Roman',
    color: '#1a1a1a',
    marginBottom: 4,
  },
  subtitle: { fontSize: 11, color: '#333', marginBottom: 2 },
  period: { fontSize: 10, color: '#666' },
  companyInfo: { textAlign: 'right' },
  companyName: { fontSize: 11, fontWeight: 'bold', marginBottom: 2 },
  companyMeta: { fontSize: 9, color: '#666' },
  section: { marginBottom: 18 },
  sectionHeading: {
    fontSize: 12,
    fontFamily: 'Times-Roman',
    color: '#1a1a1a',
    marginBottom: 8,
    paddingBottom: 4,
    borderBottomWidth: 1,
    borderBottomColor: '#1a1a1a',
  },
  row: {
    flexDirection: 'row',
    paddingVertical: 3,
  },
  label: {
    flex: 1,
    color: '#1a1a1a',
  },
  amount: {
    width: 130,
    textAlign: 'right',
    fontFamily: 'Courier',
    color: '#1a1a1a',
  },
  subtotalRow: {
    flexDirection: 'row',
    paddingVertical: 5,
    marginTop: 4,
    borderTopWidth: 1,
    borderTopColor: '#1a1a1a',
  },
  subtotalLabel: {
    flex: 1,
    fontWeight: 'bold',
    fontSize: 11,
  },
  subtotalAmount: {
    width: 130,
    textAlign: 'right',
    fontFamily: 'Courier',
    fontWeight: 'bold',
    fontSize: 11,
  },
  totalBlock: {
    marginTop: 20,
    paddingTop: 12,
    borderTopWidth: 2,
    borderTopColor: '#1a1a1a',
  },
  totalLabel: {
    flex: 1,
    fontWeight: 'bold',
    fontFamily: 'Times-Roman',
    fontSize: 13,
  },
  totalAmount: {
    width: 130,
    textAlign: 'right',
    fontFamily: 'Courier',
    fontWeight: 'bold',
    fontSize: 13,
  },
  reconciliationBlock: {
    marginTop: 24,
    padding: 12,
    borderWidth: 1,
    borderColor: '#d4d4d4',
    borderRadius: 4,
    backgroundColor: '#fafafa',
  },
  reconciliationOk: {
    borderColor: '#16a34a',
    backgroundColor: '#f0fdf4',
  },
  reconciliationBad: {
    // Terracotta destructive-color analogue for PDFs (since CSS vars
    // aren't available). Surfaces a clear "mismatch" signal without
    // depending on the chrome design tokens.
    borderColor: '#b91c1c',
    backgroundColor: '#fef2f2',
  },
  reconciliationTitle: {
    fontSize: 11,
    fontWeight: 'bold',
    color: '#1a1a1a',
    marginBottom: 6,
  },
  reconciliationRow: {
    flexDirection: 'row',
    paddingVertical: 2,
  },
  reconciliationLabel: { flex: 1, color: '#444' },
  reconciliationAmount: {
    width: 130,
    textAlign: 'right',
    fontFamily: 'Courier',
    color: '#1a1a1a',
  },
  reconciliationMismatch: {
    color: '#b91c1c',
    fontWeight: 'bold',
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

function formatAmount(n: number): string {
  return new Intl.NumberFormat('sv-SE', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(n)
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

interface KassaflodePDFProps {
  report: KassaflodesanalysReport
  company: CompanySettings
  generatedAt: string
}

export function KassaflodesanalysPDF({
  report,
  company,
  generatedAt,
}: KassaflodePDFProps) {
  const companyName = company.company_name || ''
  const periodLabel = `${formatDateSv(report.period_start)} – ${formatDateSv(report.period_end)}`
  const recon = report.reconciliation
  const reconStyles = [
    styles.reconciliationBlock,
    recon.is_reconciled ? styles.reconciliationOk : styles.reconciliationBad,
  ]

  return (
    <Document>
      <Page size="A4" style={styles.page}>
        <View style={styles.header} fixed>
          <View style={styles.titleBlock}>
            <Text style={styles.title}>Kassaflödesanalys</Text>
            {companyName && <Text style={styles.subtitle}>{companyName}</Text>}
            <Text style={styles.period}>Period: {periodLabel}</Text>
            <Text style={styles.period}>Indirekt metod enligt BFNAR 2012:1 kap 7</Text>
          </View>
          <View style={styles.companyInfo}>
            {company.company_name && (
              <Text style={styles.companyName}>{company.company_name}</Text>
            )}
            {company.org_number && (
              <Text style={styles.companyMeta}>
                Org.nr: {formatOrgNumber(company.org_number)}
              </Text>
            )}
            {company.vat_number && (
              <Text style={styles.companyMeta}>VAT: {company.vat_number}</Text>
            )}
          </View>
        </View>

        {/* Section 1: Löpande verksamhet */}
        <View style={styles.section}>
          <Text style={styles.sectionHeading}>Den löpande verksamheten</Text>
          <View style={styles.row}>
            <Text style={styles.label}>Resultat efter finansiella poster</Text>
            <Text style={styles.amount}>
              {formatAmount(report.lopande.resultat_efter_finansiella_poster)}
            </Text>
          </View>
          <View style={styles.row}>
            <Text style={styles.label}>Justeringar för avskrivningar</Text>
            <Text style={styles.amount}>{formatAmount(report.lopande.avskrivningar)}</Text>
          </View>
          <View style={styles.row}>
            <Text style={styles.label}>Övriga ej-kassaflödespåverkande poster</Text>
            <Text style={styles.amount}>
              {formatAmount(report.lopande.ovriga_ej_kassaflodesposter)}
            </Text>
          </View>
          <View style={styles.row}>
            <Text style={styles.label}>Förändring av kortfristiga fordringar</Text>
            <Text style={styles.amount}>
              {formatAmount(report.lopande.delta_kortfristiga_fordringar)}
            </Text>
          </View>
          <View style={styles.row}>
            <Text style={styles.label}>Förändring av varulager</Text>
            <Text style={styles.amount}>{formatAmount(report.lopande.delta_varulager)}</Text>
          </View>
          <View style={styles.row}>
            <Text style={styles.label}>Förändring av kortfristiga skulder</Text>
            <Text style={styles.amount}>
              {formatAmount(report.lopande.delta_kortfristiga_skulder)}
            </Text>
          </View>
          <View style={styles.row}>
            <Text style={styles.label}>Betald inkomstskatt</Text>
            <Text style={styles.amount}>{formatAmount(report.lopande.skatt_betald)}</Text>
          </View>
          <View style={styles.subtotalRow}>
            <Text style={styles.subtotalLabel}>
              Kassaflöde från den löpande verksamheten
            </Text>
            <Text style={styles.subtotalAmount}>{formatAmount(report.lopande.total)}</Text>
          </View>
        </View>

        {/* Section 2: Investeringsverksamhet */}
        <View style={styles.section}>
          <Text style={styles.sectionHeading}>Investeringsverksamheten</Text>
          <View style={styles.row}>
            <Text style={styles.label}>Förvärv av anläggningstillgångar</Text>
            <Text style={styles.amount}>
              {formatAmount(report.investerings.forvarv_anlaggningar)}
            </Text>
          </View>
          <View style={styles.row}>
            <Text style={styles.label}>Avyttring av anläggningstillgångar</Text>
            <Text style={styles.amount}>
              {formatAmount(report.investerings.avyttring_anlaggningar)}
            </Text>
          </View>
          <View style={styles.subtotalRow}>
            <Text style={styles.subtotalLabel}>
              Kassaflöde från investeringsverksamheten
            </Text>
            <Text style={styles.subtotalAmount}>
              {formatAmount(report.investerings.total)}
            </Text>
          </View>
        </View>

        {/* Section 3: Finansieringsverksamhet */}
        <View style={styles.section}>
          <Text style={styles.sectionHeading}>Finansieringsverksamheten</Text>
          <View style={styles.row}>
            <Text style={styles.label}>Förändring av lån (långfristiga skulder)</Text>
            <Text style={styles.amount}>{formatAmount(report.finansierings.delta_lan)}</Text>
          </View>
          <View style={styles.row}>
            <Text style={styles.label}>Utdelningar till ägare</Text>
            <Text style={styles.amount}>
              {formatAmount(report.finansierings.utdelningar)}
            </Text>
          </View>
          <View style={styles.row}>
            <Text style={styles.label}>Nyemission</Text>
            <Text style={styles.amount}>{formatAmount(report.finansierings.nyemission)}</Text>
          </View>
          <View style={styles.subtotalRow}>
            <Text style={styles.subtotalLabel}>
              Kassaflöde från finansieringsverksamheten
            </Text>
            <Text style={styles.subtotalAmount}>
              {formatAmount(report.finansierings.total)}
            </Text>
          </View>
        </View>

        {/* Total */}
        <View style={[styles.totalBlock, styles.row]}>
          <Text style={styles.totalLabel}>Årets kassaflöde</Text>
          <Text style={styles.totalAmount}>{formatAmount(report.total_cash_flow)}</Text>
        </View>

        {/* Reconciliation */}
        <View style={reconStyles}>
          <Text style={styles.reconciliationTitle}>
            Avstämning mot likvida medel (19xx)
          </Text>
          <View style={styles.reconciliationRow}>
            <Text style={styles.reconciliationLabel}>Ingående saldo</Text>
            <Text style={styles.reconciliationAmount}>
              {formatAmount(recon.opening_cash_1xxx)}
            </Text>
          </View>
          <View style={styles.reconciliationRow}>
            <Text style={styles.reconciliationLabel}>Utgående saldo</Text>
            <Text style={styles.reconciliationAmount}>
              {formatAmount(recon.closing_cash_1xxx)}
            </Text>
          </View>
          <View style={styles.reconciliationRow}>
            <Text style={styles.reconciliationLabel}>Faktisk förändring</Text>
            <Text style={styles.reconciliationAmount}>
              {formatAmount(recon.delta_actual)}
            </Text>
          </View>
          <View style={styles.reconciliationRow}>
            <Text style={styles.reconciliationLabel}>Beräknad förändring</Text>
            <Text style={styles.reconciliationAmount}>
              {formatAmount(recon.delta_calculated)}
            </Text>
          </View>
          {!recon.is_reconciled && (
            <View style={styles.reconciliationRow}>
              <Text
                style={[styles.reconciliationLabel, styles.reconciliationMismatch]}
              >
                Avvikelse — kontrollera bokföringen
              </Text>
              <Text
                style={[styles.reconciliationAmount, styles.reconciliationMismatch]}
              >
                {formatAmount(recon.mismatch_amount)}
              </Text>
            </View>
          )}
        </View>

        <View style={styles.footer} fixed>
          <Text style={styles.footerText}>
            {companyName}
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
