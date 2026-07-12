import {
  Document,
  Page,
  Text,
  View,
  StyleSheet,
} from '@react-pdf/renderer'
import type { CompanySettings } from '@/types'

const styles = StyleSheet.create({
  page: {
    paddingTop: 40,
    paddingHorizontal: 40,
    // Leave room for the fixed disclaimer + footer at the bottom of every page.
    paddingBottom: 120,
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
  group: {
    marginBottom: 18,
  },
  groupHeading: {
    fontSize: 12,
    fontWeight: 'bold',
    color: '#1a1a1a',
    marginBottom: 8,
    paddingBottom: 4,
    borderBottomWidth: 1,
    borderBottomColor: '#1a1a1a',
  },
  section: {
    marginBottom: 8,
  },
  sectionTitle: {
    fontSize: 10,
    fontWeight: 'bold',
    color: '#444',
    marginBottom: 4,
    marginTop: 6,
  },
  row: {
    flexDirection: 'row',
    paddingVertical: 2,
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
    width: 110,
    textAlign: 'right',
    fontFamily: 'Courier',
    color: '#1a1a1a',
  },
  sectionSubtotalRow: {
    flexDirection: 'row',
    paddingVertical: 3,
    marginTop: 2,
    borderTopWidth: 0.5,
    borderTopColor: '#d4d4d4',
  },
  sectionSubtotalLabel: {
    flex: 1,
    fontStyle: 'italic',
    color: '#444',
    paddingLeft: 48,
  },
  sectionSubtotalAmount: {
    width: 110,
    textAlign: 'right',
    fontFamily: 'Courier',
    fontStyle: 'italic',
    color: '#444',
  },
  groupTotalRow: {
    flexDirection: 'row',
    paddingVertical: 6,
    marginTop: 6,
    borderTopWidth: 1,
    borderTopColor: '#1a1a1a',
  },
  groupTotalLabel: {
    flex: 1,
    fontWeight: 'bold',
    fontSize: 11,
  },
  groupTotalAmount: {
    width: 110,
    textAlign: 'right',
    fontFamily: 'Courier',
    fontWeight: 'bold',
    fontSize: 11,
  },
  summaryBlock: {
    marginTop: 20,
    paddingTop: 10,
    borderTopWidth: 2,
    borderTopColor: '#1a1a1a',
  },
  summaryRow: {
    flexDirection: 'row',
    paddingVertical: 4,
  },
  summaryLabel: {
    flex: 1,
    color: '#1a1a1a',
  },
  summaryAmount: {
    width: 110,
    textAlign: 'right',
    fontFamily: 'Courier',
  },
  summaryEmphasisLabel: {
    flex: 1,
    fontWeight: 'bold',
    fontSize: 12,
  },
  summaryEmphasisAmount: {
    width: 110,
    textAlign: 'right',
    fontFamily: 'Courier',
    fontWeight: 'bold',
    fontSize: 12,
  },
  disclaimer: {
    position: 'absolute',
    bottom: 52,
    left: 40,
    right: 40,
    paddingTop: 6,
    paddingBottom: 6,
    paddingHorizontal: 10,
    borderWidth: 0.8,
    borderColor: '#b45309',
    backgroundColor: '#fef3c7',
    borderRadius: 3,
  },
  disclaimerTitle: {
    fontSize: 8,
    fontWeight: 'bold',
    color: '#78350f',
    marginBottom: 2,
  },
  disclaimerText: {
    fontSize: 7.5,
    color: '#78350f',
    lineHeight: 1.3,
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
  return new Intl.NumberFormat('sv-SE', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount)
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

export interface FinancialStatementSection {
  title: string
  rows: { account_number: string; account_name: string; amount: number }[]
  subtotal: number
}

export interface FinancialStatementGroup {
  heading: string
  sections: FinancialStatementSection[]
  totalLabel: string
  total: number
  negate?: boolean
}

export interface FinancialStatementSummaryRow {
  label: string
  amount: number
  emphasis?: boolean
}

interface FinancialStatementPDFProps {
  title: string
  groups: FinancialStatementGroup[]
  summary?: FinancialStatementSummaryRow[]
  period: { start: string; end: string }
  company: CompanySettings
  generatedAt: string
}

export function FinancialStatementPDF({
  title,
  groups,
  summary,
  period,
  company,
  generatedAt,
}: FinancialStatementPDFProps) {
  const companyDisplayName = company.company_name || ''
  const periodLabel = period.start && period.end
    ? `${formatDateSv(period.start)}: ${formatDateSv(period.end)}`
    : ''

  return (
    <Document>
      <Page size="A4" style={styles.page}>
        <View style={styles.header} fixed>
          <View style={styles.titleBlock}>
            <Text style={styles.title}>{title}</Text>
            {companyDisplayName && (
              <Text style={styles.subtitle}>{companyDisplayName}</Text>
            )}
            {periodLabel && (
              <Text style={styles.period}>Period: {periodLabel}</Text>
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

        {groups.map((group, gi) => (
          <View key={gi} style={styles.group} wrap>
            <Text style={styles.groupHeading}>{group.heading}</Text>

            {group.sections.length === 0 ? (
              <Text style={{ fontSize: 9, color: '#888', fontStyle: 'italic' }}>
                Inga poster i perioden.
              </Text>
            ) : (
              group.sections.map((section, si) => (
                <View key={si} style={styles.section} wrap={false}>
                  <Text style={styles.sectionTitle}>{section.title}</Text>
                  {section.rows.map((row, ri) => {
                    const displayAmount = group.negate ? -row.amount : row.amount
                    return (
                      <View key={ri} style={styles.row}>
                        <Text style={styles.colAccount}>{row.account_number}</Text>
                        <Text style={styles.colName}>{row.account_name}</Text>
                        <Text style={styles.colAmount}>{formatAmount(displayAmount)}</Text>
                      </View>
                    )
                  })}
                  {section.rows.length > 1 && (
                    <View style={styles.sectionSubtotalRow}>
                      <Text style={styles.sectionSubtotalLabel}>Summa {section.title.toLowerCase()}</Text>
                      <Text style={styles.sectionSubtotalAmount}>
                        {formatAmount(group.negate ? -section.subtotal : section.subtotal)}
                      </Text>
                    </View>
                  )}
                </View>
              ))
            )}

            <View style={styles.groupTotalRow}>
              <Text style={styles.groupTotalLabel}>{group.totalLabel}</Text>
              <Text style={styles.groupTotalAmount}>
                {formatAmount(group.negate ? -group.total : group.total)}
              </Text>
            </View>
          </View>
        ))}

        {summary && summary.length > 0 && (
          <View style={styles.summaryBlock} wrap={false}>
            {summary.map((row, i) => (
              <View key={i} style={styles.summaryRow}>
                <Text style={row.emphasis ? styles.summaryEmphasisLabel : styles.summaryLabel}>
                  {row.label}
                </Text>
                <Text style={row.emphasis ? styles.summaryEmphasisAmount : styles.summaryAmount}>
                  {formatAmount(row.amount)}
                </Text>
              </View>
            ))}
          </View>
        )}

        <View style={styles.disclaimer} fixed>
          <Text style={styles.disclaimerTitle}>Arbetsutkast: ej undertecknat</Text>
          <Text style={styles.disclaimerText}>
            Detta dokument är ett internt arbetsutkast och utgör inte en godkänd
            årsredovisning enligt ÅRL 2 kap 7 §. Den formella årsredovisningen ska
            undertecknas av samtliga styrelseledamöter och, i förekommande fall, VD
            innan den lämnas in till Bolagsverket.
          </Text>
        </View>

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
      </Page>
    </Document>
  )
}
