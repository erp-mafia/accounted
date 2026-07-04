import {
  Document,
  Page,
  Text,
  View,
  StyleSheet,
} from '@react-pdf/renderer'
import type {
  CompanySettings,
  ResultatrapportReport,
  BalansrapportReport,
} from '@/types'

// Operational reports (Resultatrapport / Balansrapport) are löpande
// bookkeeping documents, not draft årsredovisning per ÅRL 2:7 §, so this
// template intentionally omits the yellow "Arbetsutkast" disclaimer that
// FinancialStatementPDF carries.
const styles = StyleSheet.create({
  page: {
    paddingTop: 40,
    paddingHorizontal: 40,
    paddingBottom: 60,
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
  titleBlock: {
    flex: 1,
  },
  title: {
    fontSize: 20,
    fontWeight: 'bold',
    color: '#1a1a1a',
    marginBottom: 4,
  },
  subtitle: {
    fontSize: 11,
    color: '#333',
    marginBottom: 2,
  },
  period: {
    fontSize: 10,
    color: '#666',
  },
  companyInfo: {
    textAlign: 'right',
  },
  companyName: {
    fontSize: 11,
    fontWeight: 'bold',
    marginBottom: 2,
  },
  companyMeta: {
    fontSize: 9,
    color: '#666',
  },
  tableHeader: {
    flexDirection: 'row',
    paddingVertical: 4,
    borderBottomWidth: 0.5,
    borderBottomColor: '#1a1a1a',
    marginBottom: 2,
  },
  tableHeaderText: {
    fontSize: 9,
    fontWeight: 'bold',
    color: '#444',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  groupHeading: {
    fontSize: 11,
    fontWeight: 'bold',
    color: '#1a1a1a',
    marginTop: 12,
    marginBottom: 4,
    paddingBottom: 3,
    borderBottomWidth: 0.5,
    borderBottomColor: '#888',
  },
  row: {
    flexDirection: 'row',
    paddingVertical: 2,
  },
  subtotalRow: {
    flexDirection: 'row',
    paddingVertical: 4,
    marginTop: 2,
    borderTopWidth: 0.5,
    borderTopColor: '#888',
    marginBottom: 4,
  },
  colAccount: {
    width: 48,
    color: '#666',
    fontFamily: 'Courier',
  },
  colName: {
    flex: 1,
    color: '#1a1a1a',
    paddingRight: 12,
  },
  colAmount: {
    width: 90,
    textAlign: 'right',
    fontFamily: 'Courier',
    color: '#1a1a1a',
  },
  colAmountMuted: {
    width: 90,
    textAlign: 'right',
    fontFamily: 'Courier',
    color: '#666',
  },
  subtotalLabel: {
    flex: 1,
    fontStyle: 'italic',
    color: '#444',
    paddingLeft: 48,
  },
  subtotalAmount: {
    width: 90,
    textAlign: 'right',
    fontFamily: 'Courier',
    fontStyle: 'italic',
    color: '#444',
  },
  summary: {
    marginTop: 18,
    paddingTop: 10,
    borderTopWidth: 1,
    borderTopColor: '#1a1a1a',
  },
  summaryRow: {
    flexDirection: 'row',
    paddingVertical: 3,
  },
  summaryLabel: {
    flex: 1,
    color: '#1a1a1a',
  },
  summaryEmphasis: {
    flex: 1,
    fontWeight: 'bold',
    fontSize: 11,
    color: '#1a1a1a',
  },
  summaryAmount: {
    width: 90,
    textAlign: 'right',
    fontFamily: 'Courier',
    color: '#1a1a1a',
  },
  summaryAmountMuted: {
    width: 90,
    textAlign: 'right',
    fontFamily: 'Courier',
    color: '#666',
  },
  summaryAmountEmphasis: {
    width: 90,
    textAlign: 'right',
    fontFamily: 'Courier',
    fontWeight: 'bold',
    fontSize: 11,
  },
  balanceVerdict: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 6,
    paddingHorizontal: 10,
    marginTop: 8,
    borderRadius: 3,
  },
  balanceVerdictOk: {
    backgroundColor: '#ecfdf5',
    borderWidth: 0.5,
    borderColor: '#059669',
  },
  balanceVerdictBad: {
    backgroundColor: '#fef2f2',
    borderWidth: 0.5,
    borderColor: '#dc2626',
  },
  balanceVerdictLabel: {
    fontWeight: 'bold',
    fontSize: 11,
    color: '#1a1a1a',
  },
  balanceVerdictOkBadge: {
    fontWeight: 'bold',
    fontSize: 10,
    color: '#065f46',
  },
  balanceVerdictBadBadge: {
    fontWeight: 'bold',
    fontSize: 10,
    color: '#991b1b',
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
  footerText: {
    fontSize: 8,
    color: '#888',
  },
})

function formatAmount(amount: number): string {
  // Intl emits U+2212 (true minus). The bundled @react-pdf/renderer
  // Helvetica/Courier fonts lack that glyph and silently drop it, so
  // negatives would render as positives. Map to ASCII hyphen.
  return new Intl.NumberFormat('sv-SE', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
    .format(amount)
    .replace(/\u2212/g, '-')
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

interface CommonHeaderProps {
  title: string
  company: CompanySettings
  period: { start: string; end: string }
  /** Partial-view disclosure (dimension-filtered exports, BFNAR 2013:2). */
  filterNote?: string
}

function HeaderBlock({ title, company, period, filterNote }: CommonHeaderProps) {
  const companyDisplayName = company.company_name || ''
  const periodLabel = period.start && period.end
    ? `${formatDateSv(period.start)}: ${formatDateSv(period.end)}`
    : ''
  return (
    <View style={styles.header} fixed>
      <View style={styles.titleBlock}>
        <Text style={styles.title}>{title}</Text>
        {companyDisplayName && (
          <Text style={styles.subtitle}>{companyDisplayName}</Text>
        )}
        {periodLabel && (
          <Text style={styles.period}>Period: {periodLabel}</Text>
        )}
        {filterNote && (
          <Text style={styles.period}>{filterNote}</Text>
        )}
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
  )
}

function FooterBlock({ company, generatedAt }: { company: CompanySettings; generatedAt: string }) {
  const companyDisplayName = company.company_name || ''
  return (
    <View style={styles.footer} fixed>
      <Text style={styles.footerText}>
        {companyDisplayName}
        {company.org_number ? ` · ${formatOrgNumber(company.org_number)}` : ''}
      </Text>
      <Text
        style={styles.footerText}
        render={({ pageNumber, totalPages }) => `Genererad ${formatDateSv(generatedAt)} · Sida ${pageNumber} av ${totalPages}`}
      />
    </View>
  )
}

interface ResultatrapportPDFProps {
  report: ResultatrapportReport
  company: CompanySettings
  generatedAt: string
  /** Partial-view disclosure line (dimension-filtered exports). */
  filterNote?: string
}

export function ResultatrapportPDF({ report, company, generatedAt, filterNote }: ResultatrapportPDFProps) {
  const hasPrior = report.prior_period !== null

  return (
    <Document>
      <Page size="A4" style={styles.page}>
        <HeaderBlock title="Resultatrapport" company={company} period={report.period} filterNote={filterNote} />

        <View style={styles.tableHeader}>
          <Text style={[styles.tableHeaderText, styles.colAccount]}>Konto</Text>
          <Text style={[styles.tableHeaderText, styles.colName]}>Kontonamn</Text>
          <Text style={[styles.tableHeaderText, styles.colAmount]}>Innevarande</Text>
          {hasPrior && (
            <Text style={[styles.tableHeaderText, styles.colAmountMuted]}>Föregående</Text>
          )}
        </View>

        {report.groups.map((group) => (
          // No wrap={false} on the outer View: large account classes (80+
          // active accounts) would otherwise be silently clipped instead of
          // flowing onto the next page.
          <View key={group.class}>
            <Text style={styles.groupHeading}>{group.class_label}</Text>
            {group.rows.map((row) => (
              <View key={row.account_number} style={styles.row} wrap={false}>
                <Text style={styles.colAccount}>{row.account_number}</Text>
                <Text style={styles.colName}>{row.account_name}</Text>
                <Text style={styles.colAmount}>{formatAmount(row.current_period)}</Text>
                {hasPrior && (
                  <Text style={styles.colAmountMuted}>{formatAmount(row.prior_period)}</Text>
                )}
              </View>
            ))}
            <View style={styles.subtotalRow} wrap={false}>
              <Text style={styles.subtotalLabel}>Summa</Text>
              <Text style={styles.subtotalAmount}>{formatAmount(group.subtotal_current)}</Text>
              {hasPrior && (
                <Text style={[styles.subtotalAmount, { color: '#666' }]}>
                  {formatAmount(group.subtotal_prior)}
                </Text>
              )}
            </View>
          </View>
        ))}

        <View style={styles.summary} wrap={false}>
          <View style={styles.summaryRow}>
            <Text style={styles.summaryEmphasis}>Beräknat resultat</Text>
            <Text style={styles.summaryAmountEmphasis}>
              {formatAmount(report.net_result_current)}
            </Text>
            {hasPrior && (
              <Text style={[styles.summaryAmountEmphasis, { color: '#666' }]}>
                {formatAmount(report.net_result_prior)}
              </Text>
            )}
          </View>
        </View>

        <FooterBlock company={company} generatedAt={generatedAt} />
      </Page>
    </Document>
  )
}

interface BalansrapportPDFProps {
  report: BalansrapportReport
  company: CompanySettings
  generatedAt: string
}

export function BalansrapportPDF({ report, company, generatedAt }: BalansrapportPDFProps) {
  return (
    <Document>
      <Page size="A4" style={styles.page}>
        <HeaderBlock title="Balansrapport" company={company} period={report.period} />

        <View style={styles.tableHeader}>
          <Text style={[styles.tableHeaderText, styles.colAccount]}>Konto</Text>
          <Text style={[styles.tableHeaderText, styles.colName]}>Kontonamn</Text>
          <Text style={[styles.tableHeaderText, styles.colAmountMuted]}>Ingående</Text>
          <Text style={[styles.tableHeaderText, styles.colAmountMuted]}>Förändring</Text>
          <Text style={[styles.tableHeaderText, styles.colAmount]}>Utgående</Text>
        </View>

        {report.groups.map((group) => (
          // See ResultatrapportPDF: outer View must wrap so large classes
          // flow across pages instead of being clipped.
          <View key={group.class}>
            <Text style={styles.groupHeading}>{group.class_label}</Text>
            {group.rows.map((row) => (
              <View key={row.account_number} style={styles.row} wrap={false}>
                <Text style={styles.colAccount}>{row.account_number}</Text>
                <Text style={styles.colName}>{row.account_name}</Text>
                <Text style={styles.colAmountMuted}>{formatAmount(row.ib)}</Text>
                <Text style={styles.colAmountMuted}>{formatAmount(row.period_change)}</Text>
                <Text style={styles.colAmount}>{formatAmount(row.ub)}</Text>
              </View>
            ))}
            <View style={styles.subtotalRow} wrap={false}>
              <Text style={styles.subtotalLabel}>Summa</Text>
              <Text style={[styles.subtotalAmount, { color: '#666' }]}>{formatAmount(group.subtotal_ib)}</Text>
              <Text style={[styles.subtotalAmount, { color: '#666' }]}>
                {formatAmount(group.subtotal_ub - group.subtotal_ib)}
              </Text>
              <Text style={styles.subtotalAmount}>{formatAmount(group.subtotal_ub)}</Text>
            </View>
          </View>
        ))}

        <View style={styles.summary} wrap={false}>
          <View style={styles.summaryRow}>
            <Text style={styles.summaryLabel}>Summa tillgångar</Text>
            <Text style={styles.summaryAmount}>{formatAmount(report.total_assets_ub)}</Text>
          </View>
          <View style={styles.summaryRow}>
            <Text style={styles.summaryLabel}>Summa eget kapital, reserver, avsättningar och skulder</Text>
            <Text style={styles.summaryAmount}>{formatAmount(report.total_equity_liabilities_ub)}</Text>
          </View>
          <View style={styles.summaryRow}>
            <Text style={styles.summaryLabel}>Beräknat resultat (ej bokslutsjusterat)</Text>
            <Text style={styles.summaryAmount}>{formatAmount(report.beraknat_resultat)}</Text>
          </View>
          <View
            style={[
              styles.balanceVerdict,
              report.is_balanced ? styles.balanceVerdictOk : styles.balanceVerdictBad,
            ]}
          >
            <Text style={styles.balanceVerdictLabel}>Balanscheck</Text>
            <Text
              style={
                report.is_balanced
                  ? styles.balanceVerdictOkBadge
                  : styles.balanceVerdictBadBadge
              }
            >
              {report.is_balanced ? 'Balanserar' : 'Balanserar ej'}
            </Text>
          </View>
        </View>

        <FooterBlock company={company} generatedAt={generatedAt} />
      </Page>
    </Document>
  )
}
