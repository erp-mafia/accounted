import { formatOrgNumberDisplay } from '@/lib/invariants/org-number'
import {
  Document,
  Page,
  Text,
  View,
  StyleSheet,
} from '@react-pdf/renderer'
import { pdfNumberText, formatDateSv } from '@/lib/pdf/number-text'
import type {
  BudgetComparison,
  CompanySettings,
  DimensionCrossReport,
  LatestVoucherPerSeries,
  ResultatrapportReport,
  BalansrapportReport,
  BalansrapportSection,
} from '@/types'
import { formatLatestVouchers, LATEST_VOUCHERS_LABEL } from './latest-vouchers'

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
  // Balansrapport ÅRL headings: a heading (Anläggningstillgångar), its
  // sections (Materiella anläggningstillgångar) and their Summa lines.
  sectionHeading: {
    fontSize: 10,
    fontWeight: 'bold',
    color: '#1a1a1a',
    marginTop: 8,
    marginBottom: 2,
  },
  subsectionHeading: {
    fontSize: 10,
    fontWeight: 'bold',
    color: '#444',
    marginTop: 6,
    marginBottom: 2,
    paddingLeft: 12,
  },
  sectionNote: {
    fontSize: 8,
    color: '#666',
    marginBottom: 3,
  },
  sectionTotalRow: {
    flexDirection: 'row',
    paddingVertical: 2,
    marginBottom: 2,
    borderTopWidth: 0.5,
    borderTopColor: '#bbb',
  },
  classTotalLabel: {
    flex: 1,
    fontWeight: 'bold',
    color: '#1a1a1a',
    paddingLeft: 48,
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

/** A deviation in percent, one decimal: "12,5 %"; blank without a budget. */
function formatPercent(percent: number | null | undefined): string {
  if (percent === null || percent === undefined) return ''
  return pdfNumberText(
    `${new Intl.NumberFormat('sv-SE', { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(percent)} %`,
  )
}

/** The Budget, Avvikelse and Avvikelse % cells of one row. */
function BudgetCells({ figures, style }: { figures: BudgetComparison | undefined; style: (typeof styles)[keyof typeof styles] }) {
  return (
    <>
      <Text style={style}>{figures ? formatAmount(figures.budget) : ''}</Text>
      <Text style={style}>{figures ? formatAmount(figures.deviation) : ''}</Text>
      <Text style={[style, { width: 60 }]}>{formatPercent(figures?.deviation_percent)}</Text>
    </>
  )
}

function formatAmount(amount: number): string {
  // pdfNumberText: Intl emits U+2212 (true minus), which the bundled
  // Helvetica/Courier fonts lack, so negatives would render as positives.
  return pdfNumberText(
    new Intl.NumberFormat('sv-SE', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(amount),
  )
}

interface CommonHeaderProps {
  title: string
  company: CompanySettings
  period: { start: string; end: string }
  /** Partial-view disclosure (dimension-filtered exports, BFNAR 2013:2). */
  filterNote?: string
  /** Which budget the Budget columns read (accounted#134). */
  budgetNote?: string
  /** Highest posted voucher per series in the window. Reconciliation aid (#1267). */
  latestVouchers?: LatestVoucherPerSeries[]
}

function HeaderBlock({ title, company, period, filterNote, budgetNote, latestVouchers }: CommonHeaderProps) {
  const companyDisplayName = company.company_name || ''
  const periodLabel = period.start && period.end
    ? `${formatDateSv(period.start)}: ${formatDateSv(period.end)}`
    : ''
  const vouchersLabel = formatLatestVouchers(latestVouchers)
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
        {vouchersLabel && (
          <Text style={styles.period}>{LATEST_VOUCHERS_LABEL}: {vouchersLabel}</Text>
        )}
        {filterNote && (
          <Text style={styles.period}>{filterNote}</Text>
        )}
        {budgetNote && (
          <Text style={styles.period}>{budgetNote}</Text>
        )}
      </View>
      <View style={styles.companyInfo}>
        {company.company_name && (
          <Text style={styles.companyName}>{company.company_name}</Text>
        )}
        {company.org_number && (
          <Text style={styles.companyMeta}>
            Org.nr: {formatOrgNumberDisplay(company.org_number)}
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
        {company.org_number ? ` · ${formatOrgNumberDisplay(company.org_number)}` : ''}
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
  /** Which budget the Budget columns read, or why there are none. */
  budgetNote?: string
}

export function ResultatrapportPDF({ report, company, generatedAt, filterNote, budgetNote }: ResultatrapportPDFProps) {
  const hasPrior = report.prior_period !== null
  // Budget, Avvikelse and Avvikelse % need the width of a landscape page.
  const hasBudget = report.budget?.applied === true

  return (
    <Document>
      <Page size="A4" orientation={hasBudget ? 'landscape' : 'portrait'} style={styles.page}>
        <HeaderBlock
          title="Resultatrapport"
          company={company}
          period={report.period}
          filterNote={filterNote}
          budgetNote={budgetNote}
          latestVouchers={report.latest_vouchers}
        />

        <View style={styles.tableHeader}>
          <Text style={[styles.tableHeaderText, styles.colAccount]}>Konto</Text>
          <Text style={[styles.tableHeaderText, styles.colName]}>Kontonamn</Text>
          <Text style={[styles.tableHeaderText, styles.colAmount]}>Innevarande</Text>
          {hasBudget && (
            <>
              <Text style={[styles.tableHeaderText, styles.colAmount]}>Budget</Text>
              <Text style={[styles.tableHeaderText, styles.colAmount]}>Avvikelse</Text>
              <Text style={[styles.tableHeaderText, styles.colAmount, { width: 60 }]}>Avv. %</Text>
            </>
          )}
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
                {hasBudget && <BudgetCells figures={row.budget} style={styles.colAmount} />}
                {hasPrior && (
                  <Text style={styles.colAmountMuted}>{formatAmount(row.prior_period)}</Text>
                )}
              </View>
            ))}
            <View style={styles.subtotalRow} wrap={false}>
              <Text style={styles.subtotalLabel}>Summa</Text>
              <Text style={styles.subtotalAmount}>{formatAmount(group.subtotal_current)}</Text>
              {hasBudget && <BudgetCells figures={group.subtotal_budget} style={styles.subtotalAmount} />}
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
            {hasBudget && <BudgetCells figures={report.net_result_budget} style={styles.summaryAmountEmphasis} />}
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

/** Value columns per page of the cross report: the width of a landscape A4 page. */
const CROSS_COLUMNS_PER_PAGE = 7
const UNTAGGED_LABEL = '(Utan dimension)'

interface DimensionCrossPDFProps {
  report: DimensionCrossReport
  company: CompanySettings
  generatedAt: string
  /** What the cells sum: the result, or a range of accounts. */
  measureNote: string
}

/**
 * Resultat across two dimensions (accounted#133): dimension A down, B
 * across. Columns beyond a page's width continue on the next page with the
 * row labels repeated; Totalt is the last column, and the Totalt row closes
 * every page.
 */
export function DimensionCrossPDF({ report, company, generatedAt, measureNote }: DimensionCrossPDFProps) {
  const label = (v: { code: string | null; name: string | null }) =>
    v.code === null ? UNTAGGED_LABEL : v.name ? `${v.code} ${v.name}` : v.code
  const columns = [...report.columns.map(label), 'Totalt']
  const rows = report.rows.map((row, i) => ({ label: label(row), values: [...report.cells[i], report.row_totals[i]] }))
  const footer = [...report.column_totals, report.total]
  const chunks: number[][] = []
  for (let start = 0; start < columns.length; start += CROSS_COLUMNS_PER_PAGE) {
    chunks.push(columns.slice(start, start + CROSS_COLUMNS_PER_PAGE).map((_, k) => start + k))
  }

  return (
    <Document>
      {chunks.map((chunk, page) => (
        <Page key={page} size="A4" orientation="landscape" style={styles.page}>
          <HeaderBlock
            title={`Resultat per ${report.dim_a.name} och ${report.dim_b.name}`}
            company={company}
            period={report.period}
            filterNote={measureNote}
          />
          <View style={styles.tableHeader}>
            <Text style={[styles.tableHeaderText, styles.colName]}>
              {report.dim_a.name} / {report.dim_b.name}
            </Text>
            {chunk.map((j) => (
              <Text key={j} style={[styles.tableHeaderText, styles.colAmount]}>{columns[j]}</Text>
            ))}
          </View>
          {rows.map((row, i) => (
            <View key={i} style={styles.row} wrap={false}>
              <Text style={styles.colName}>{row.label}</Text>
              {chunk.map((j) => (
                <Text key={j} style={styles.colAmount}>{formatAmount(row.values[j])}</Text>
              ))}
            </View>
          ))}
          <View style={styles.subtotalRow} wrap={false}>
            <Text style={[styles.colName, { fontWeight: 'bold' }]}>Totalt</Text>
            {chunk.map((j) => (
              <Text key={j} style={[styles.colAmount, { fontWeight: 'bold' }]}>{formatAmount(footer[j])}</Text>
            ))}
          </View>
          <FooterBlock company={company} generatedAt={generatedAt} />
        </Page>
      ))}
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
        <HeaderBlock
          title="Balansrapport"
          company={company}
          period={report.period}
          latestVouchers={report.latest_vouchers}
        />

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
            {group.sections.map((section) => (
              <BalansrapportSectionPDF key={section.key} section={section} depth={0} />
            ))}
            <View style={styles.subtotalRow} wrap={false}>
              <Text style={styles.classTotalLabel}>Summa {group.class_label}</Text>
              <Text style={[styles.subtotalAmount, { color: '#666' }]}>{formatAmount(group.subtotal_ib)}</Text>
              <Text style={[styles.subtotalAmount, { color: '#666' }]}>{formatAmount(group.subtotal_change)}</Text>
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
          {report.differens !== 0 && (
            <View style={styles.summaryRow}>
              <Text style={styles.summaryLabel}>Differens</Text>
              <Text style={styles.summaryAmount}>{formatAmount(report.differens)}</Text>
            </View>
          )}
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
          {!report.is_balanced && report.imbalance_diagnosis && (
            <Text style={{ fontSize: 8, color: '#666', marginTop: 4 }}>
              {report.imbalance_diagnosis.message}
            </Text>
          )}
        </View>

        <FooterBlock company={company} generatedAt={generatedAt} />
      </Page>
    </Document>
  )
}

/**
 * One ÅRL heading: label, then its subsections or account rows, then its
 * Summa line. minPresenceAhead keeps a heading from ending a page alone.
 */
function BalansrapportSectionPDF({ section, depth }: { section: BalansrapportSection; depth: 0 | 1 }) {
  return (
    <View>
      <Text style={depth === 0 ? styles.sectionHeading : styles.subsectionHeading} minPresenceAhead={30}>
        {section.label}
      </Text>
      {section.note && <Text style={styles.sectionNote}>{section.note}</Text>}
      {section.sections.map((child) => (
        <BalansrapportSectionPDF key={child.key} section={child} depth={1} />
      ))}
      {section.rows.map((row) => (
        <View key={row.account_number} style={styles.row} wrap={false}>
          <Text style={styles.colAccount}>{row.account_number}</Text>
          <Text style={styles.colName}>{row.account_name}</Text>
          <Text style={styles.colAmountMuted}>{formatAmount(row.ib)}</Text>
          <Text style={styles.colAmountMuted}>{formatAmount(row.period_change)}</Text>
          <Text style={styles.colAmount}>{formatAmount(row.ub)}</Text>
        </View>
      ))}
      <View style={depth === 0 && section.sections.length > 0 ? styles.subtotalRow : styles.sectionTotalRow} wrap={false}>
        <Text style={styles.subtotalLabel}>{section.total_label}</Text>
        <Text style={[styles.subtotalAmount, { color: '#666' }]}>{formatAmount(section.subtotal_ib)}</Text>
        <Text style={[styles.subtotalAmount, { color: '#666' }]}>{formatAmount(section.subtotal_change)}</Text>
        <Text style={styles.subtotalAmount}>{formatAmount(section.subtotal_ub)}</Text>
      </View>
    </View>
  )
}
