import {
  Document,
  Page,
  Text,
  View,
  StyleSheet,
} from '@react-pdf/renderer'
import { formatDateSv, pdfAmount } from '@/lib/pdf/number-text'
import { formatOrgNumber } from '@/lib/utils'
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
  // Four amount columns (Balansräkning: Ingående balans / Ingående saldo /
  // Period / Utgående balans, Resultaträkning: Ingående saldo / Period /
  // Ackumulerat) have to fit A4 portrait next to the account number and name,
  // which 110pt at fontSize 10 cannot do. Courier at 9pt is 5.4pt per
  // character, so 82pt holds the 15 of "-123 456 789,00". Wrapping is not a
  // fallback: sv-SE groups with U+00A0, so an amount that does not fit
  // overflows into the neighbouring column instead of breaking.
  colAmount: {
    width: 82,
    textAlign: 'right',
    fontFamily: 'Courier',
    fontSize: 9,
    color: '#1a1a1a',
  },
  colAmountMuted: {
    width: 82,
    textAlign: 'right',
    fontFamily: 'Courier',
    fontSize: 9,
    color: '#666',
  },
  tableHeader: {
    flexDirection: 'row',
    paddingVertical: 4,
    borderBottomWidth: 0.5,
    borderBottomColor: '#1a1a1a',
    marginBottom: 4,
  },
  tableHeaderText: {
    fontSize: 9,
    fontWeight: 'bold',
    color: '#444',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
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
    width: 82,
    textAlign: 'right',
    fontFamily: 'Courier',
    fontSize: 9,
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
  // 82pt at 9pt like the table cells: at 11pt Courier the widest sv-SE amount
  // is 99pt and overflows into the neighbouring column.
  groupTotalAmount: {
    width: 82,
    textAlign: 'right',
    fontFamily: 'Courier',
    fontWeight: 'bold',
    fontSize: 9,
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
  // Same 82pt cell as the table columns, so the same 9pt: at the page's 10pt
  // the widest sv-SE amount is 90pt and overflows the cell.
  summaryAmount: {
    width: 82,
    textAlign: 'right',
    fontFamily: 'Courier',
    fontSize: 9,
  },
  summaryAmountMuted: {
    width: 82,
    textAlign: 'right',
    fontFamily: 'Courier',
    fontSize: 9,
    color: '#666',
  },
  summaryEmphasisLabel: {
    flex: 1,
    fontWeight: 'bold',
    fontSize: 12,
  },
  summaryEmphasisAmount: {
    width: 82,
    textAlign: 'right',
    fontFamily: 'Courier',
    fontWeight: 'bold',
    fontSize: 9,
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

/**
 * One amount column of the statement. `muted` greys the column so the
 * emphasised one (Utgående balans / Period) reads first.
 */
export interface FinancialStatementColumn {
  label: string
  muted?: boolean
}

/**
 * Every row, subtotal, group total and summary row carries one figure per
 * declared column, in the same order as `columns`. A shorter list renders
 * blank cells rather than throwing: a PDF is a read-only artefact and a
 * missing figure must not take the document down.
 */
export interface FinancialStatementSection {
  title: string
  rows: { account_number: string; account_name: string; amounts: number[] }[]
  subtotals: number[]
}

export interface FinancialStatementGroup {
  heading: string
  sections: FinancialStatementSection[]
  totalLabel: string
  totals: number[]
  negate?: boolean
}

export interface FinancialStatementSummaryRow {
  label: string
  amounts: number[]
  emphasis?: boolean
}

interface FinancialStatementPDFProps {
  title: string
  columns: FinancialStatementColumn[]
  groups: FinancialStatementGroup[]
  summary?: FinancialStatementSummaryRow[]
  period: { start: string; end: string }
  /**
   * The fiscal period's own bounds. Printed next to Period so a narrowed
   * window discloses which räkenskapsår the Ingående columns refer to.
   */
  fiscalYear?: { start: string; end: string }
  company: CompanySettings
  generatedAt: string
}

export function FinancialStatementPDF({
  title,
  columns,
  groups,
  summary,
  period,
  fiscalYear,
  company,
  generatedAt,
}: FinancialStatementPDFProps) {
  const companyDisplayName = company.company_name || ''
  const periodLabel = period.start && period.end
    ? `${formatDateSv(period.start)}: ${formatDateSv(period.end)}`
    : ''
  const fiscalYearLabel = fiscalYear?.start && fiscalYear?.end
    ? `${formatDateSv(fiscalYear.start)} till ${formatDateSv(fiscalYear.end)}`
    : ''

  // One cell per declared column, in order. `negate` flips the sign of an
  // expense group so the PDF prints costs as positive figures under a
  // "Rörelsekostnader" heading, exactly as before.
  const amountCells = (
    values: number[],
    style: 'row' | 'subtotal' | 'total' | 'summary' | 'summaryEmphasis',
    negate?: boolean,
  ) =>
    columns.map((column, ci) => {
      const value = values[ci]
      const text = value === undefined ? '' : pdfAmount(negate ? -value : value)
      const cellStyle =
        style === 'subtotal'
          ? styles.sectionSubtotalAmount
          : style === 'total'
            ? styles.groupTotalAmount
            : style === 'summaryEmphasis'
              ? styles.summaryEmphasisAmount
              : style === 'summary'
                ? (column.muted ? styles.summaryAmountMuted : styles.summaryAmount)
                : (column.muted ? styles.colAmountMuted : styles.colAmount)
      return (
        <Text key={ci} style={cellStyle}>
          {text}
        </Text>
      )
    })

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
            {fiscalYearLabel && (
              <Text style={styles.period}>Räkenskapsår: {fiscalYearLabel}</Text>
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

        <View style={styles.tableHeader}>
          <Text style={[styles.tableHeaderText, styles.colAccount]}>Konto</Text>
          <Text style={[styles.tableHeaderText, styles.colName]}>Kontonamn</Text>
          {columns.map((column, ci) => (
            <Text
              key={ci}
              style={[
                styles.tableHeaderText,
                column.muted ? styles.colAmountMuted : styles.colAmount,
              ]}
            >
              {column.label}
            </Text>
          ))}
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
                  {section.rows.map((row, ri) => (
                    <View key={ri} style={styles.row}>
                      <Text style={styles.colAccount}>{row.account_number}</Text>
                      <Text style={styles.colName}>{row.account_name}</Text>
                      {amountCells(row.amounts, 'row', group.negate)}
                    </View>
                  ))}
                  {section.rows.length > 1 && (
                    <View style={styles.sectionSubtotalRow}>
                      <Text style={styles.sectionSubtotalLabel}>Summa {section.title.toLowerCase()}</Text>
                      {amountCells(section.subtotals, 'subtotal', group.negate)}
                    </View>
                  )}
                </View>
              ))
            )}

            <View style={styles.groupTotalRow}>
              <Text style={styles.groupTotalLabel}>{group.totalLabel}</Text>
              {amountCells(group.totals, 'total', group.negate)}
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
                {amountCells(row.amounts, row.emphasis ? 'summaryEmphasis' : 'summary')}
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
