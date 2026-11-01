import { formatOrgNumber } from '@/lib/utils'
import {
  Document,
  Page,
  Text,
  View,
  StyleSheet,
} from '@react-pdf/renderer'
import { formatDateSv, pdfAmount } from '@/lib/pdf/number-text'
import type { KassaflodesanalysFullReport } from './kassaflodesanalys'
import {
  KASSAFLODESANALYS_LAYOUT,
  type KassaflodesanalysLayoutRow,
  type KassaflodesanalysSection,
  type KassaflodesanalysYear,
} from '@/lib/reports/kassaflodesanalys-statement'
import type { CompanySettings } from '@/types'

// Single-file PDF template: the kassaflödesanalys layout is distinct enough
// from the BR/RR template (no per-account rows, three labelled sections, a
// reconciliation footer) that a dedicated template keeps things readable.
// It prints the K3 chapter 7 statement (report.statement) in the order and
// wording of KASSAFLODESANALYS_LAYOUT, with the comparative year when the
// report carries one.
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
  // Two amount columns: the year and the comparative year (K3 3.5).
  yearAmount: {
    width: 100,
    textAlign: 'right',
    fontFamily: 'Courier',
    color: '#1a1a1a',
  },
  yearHeader: {
    width: 100,
    textAlign: 'right',
    fontSize: 9,
    color: '#666',
  },
  noteText: { fontSize: 9, color: '#444', marginTop: 4 },
})

/** A financial year's column heading: 2026, or 2025/26 for a broken year. */
function yearLabel(year: KassaflodesanalysYear): string {
  const start = year.period_start.slice(0, 4)
  const end = year.period_end.slice(0, 4)
  return start === end ? end : `${start}/${end.slice(2)}`
}

const SECTION_HEADINGS: Record<KassaflodesanalysSection, string | null> = {
  lopande: 'Den löpande verksamheten',
  investering: 'Investeringsverksamheten',
  finansiering: 'Finansieringsverksamheten',
  likvida_medel: null,
}

interface KassaflodePDFProps {
  report: KassaflodesanalysFullReport
  company: CompanySettings
  generatedAt: string
}

export function KassaflodesanalysPDF({
  report,
  company,
  generatedAt,
}: KassaflodePDFProps) {
  const companyName = company.company_name || ''
  const periodLabel = `${formatDateSv(report.period_start)}: ${formatDateSv(report.period_end)}`
  const { current, previous } = report.statement
  const recon = current.reconciliation
  const reconStyles = [
    styles.reconciliationBlock,
    recon.is_reconciled ? styles.reconciliationOk : styles.reconciliationBad,
  ]

  const shown = KASSAFLODESANALYS_LAYOUT.filter((row) => row.alwaysShow
    || current.amounts[row.key] !== 0
    || (previous !== null && previous.amounts[row.key] !== 0))
  const labelOf = (row: KassaflodesanalysLayoutRow) => row.key === 'ovriga_poster'
    ? `${row.label} (konto ${[...new Set([...current.unclassified_accounts, ...(previous?.unclassified_accounts ?? [])])].join(', ')})`
    : row.label
  const amountCells = (pick: (year: KassaflodesanalysYear) => number, style: typeof styles.yearAmount) => (
    <>
      <Text style={style}>{pdfAmount(pick(current))}</Text>
      {previous && <Text style={style}>{pdfAmount(pick(previous))}</Text>}
    </>
  )
  const renderRow = (row: KassaflodesanalysLayoutRow) => (
    <View key={row.key} style={row.kind === 'line' ? styles.row : styles.subtotalRow}>
      <Text style={row.kind === 'line' ? styles.label : styles.subtotalLabel}>{labelOf(row)}</Text>
      {amountCells((year) => year.amounts[row.key], styles.yearAmount)}
    </View>
  )
  const sections = (['lopande', 'investering', 'finansiering', 'likvida_medel'] as const).map((section) => ({
    section,
    heading: SECTION_HEADINGS[section],
    rows: shown.filter((row) => row.section === section),
  }))
  const composition: { label: string; pick: (year: KassaflodesanalysYear, side: 'ib' | 'ub') => number }[] = [
    { label: 'Kassamedel', pick: (year, side) => year.likvida_medel[side].kassamedel },
    { label: 'Disponibla tillgodohavanden hos banker och kreditinstitut', pick: (year, side) => year.likvida_medel[side].bank },
    { label: 'Kortfristiga placeringar', pick: (year, side) => year.likvida_medel[side].kortfristiga_placeringar },
    { label: 'Andel av medel på koncernkonto', pick: (year, side) => year.likvida_medel[side].koncernkonto },
  ]
  const compositionShown = composition.filter(({ pick }) => pick(current, 'ub') !== 0
    || (previous !== null && pick(previous, 'ub') !== 0))

  return (
    <Document>
      <Page size="A4" style={styles.page}>
        <View style={styles.header} fixed>
          <View style={styles.titleBlock}>
            <Text style={styles.title}>Kassaflödesanalys</Text>
            {companyName && <Text style={styles.subtitle}>{companyName}</Text>}
            <Text style={styles.period}>Period: {periodLabel}</Text>
            <Text style={styles.period}>Indirekt metod enligt K3 kapitel 7 (BFNAR 2012:1)</Text>
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

        <View style={styles.row}>
          <Text style={styles.label} />
          <Text style={styles.yearHeader}>{yearLabel(current)}</Text>
          {previous && <Text style={styles.yearHeader}>{yearLabel(previous)}</Text>}
        </View>

        {sections.map(({ section, heading, rows }) => heading ? (
          <View key={section} style={styles.section}>
            <Text style={styles.sectionHeading}>{heading}</Text>
            {rows.map(renderRow)}
          </View>
        ) : (
          <View key={section} style={styles.totalBlock}>
            {rows.map(renderRow)}
          </View>
        ))}

        {/* Likvida medel by the parts K3 7.18 names. */}
        <View style={styles.section}>
          <Text style={styles.sectionHeading}>Likvida medel</Text>
          {compositionShown.map(({ label, pick }) => (
            <View key={label} style={styles.row}>
              <Text style={styles.label}>{label}</Text>
              {amountCells((year) => pick(year, 'ub'), styles.yearAmount)}
            </View>
          ))}
          <View style={styles.subtotalRow}>
            <Text style={styles.subtotalLabel}>Likvida medel vid årets slut</Text>
            {amountCells((year) => year.likvida_medel.ub.total, styles.yearAmount)}
          </View>
          {current.likvida_medel.definition.koncernkonto_included && current.likvida_medel.ub.koncernkonto !== 0 && (
            <Text style={styles.noteText}>
              Företagets andel av medel på koncernkonto har behandlats som likvida medel.
            </Text>
          )}
        </View>

        {/* Reconciliation */}
        <View style={reconStyles}>
          <Text style={styles.reconciliationTitle}>Avstämning mot likvida medel</Text>
          <View style={styles.reconciliationRow}>
            <Text style={styles.reconciliationLabel}>Ingående saldo</Text>
            <Text style={styles.reconciliationAmount}>
              {pdfAmount(current.amounts.likvida_medel_ib)}
            </Text>
          </View>
          <View style={styles.reconciliationRow}>
            <Text style={styles.reconciliationLabel}>Utgående saldo</Text>
            <Text style={styles.reconciliationAmount}>
              {pdfAmount(current.amounts.likvida_medel_ub)}
            </Text>
          </View>
          <View style={styles.reconciliationRow}>
            <Text style={styles.reconciliationLabel}>Faktisk förändring</Text>
            <Text style={styles.reconciliationAmount}>
              {pdfAmount(recon.delta_actual)}
            </Text>
          </View>
          <View style={styles.reconciliationRow}>
            <Text style={styles.reconciliationLabel}>Beräknad förändring</Text>
            <Text style={styles.reconciliationAmount}>
              {pdfAmount(recon.delta_calculated)}
            </Text>
          </View>
          {!recon.is_reconciled && (
            <View style={styles.reconciliationRow}>
              <Text
                style={[styles.reconciliationLabel, styles.reconciliationMismatch]}
              >
                Avvikelse: kontrollera bokföringen
              </Text>
              <Text
                style={[styles.reconciliationAmount, styles.reconciliationMismatch]}
              >
                {pdfAmount(recon.mismatch_amount)}
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
