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
    paddingBottom: 60,
    fontSize: 9,
    fontFamily: 'Helvetica',
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: 20,
    paddingBottom: 12,
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
  asOf: {
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
  summaryRow: {
    flexDirection: 'row',
    gap: 24,
    marginBottom: 16,
  },
  summaryItem: {
    flexDirection: 'column',
  },
  summaryLabel: {
    fontSize: 8,
    color: '#666',
    marginBottom: 2,
  },
  summaryValue: {
    fontSize: 12,
    fontWeight: 'bold',
    fontFamily: 'Courier',
  },
  sectionHeading: {
    fontSize: 12,
    fontWeight: 'bold',
    color: '#1a1a1a',
    marginTop: 12,
    marginBottom: 6,
    paddingBottom: 4,
    borderBottomWidth: 1,
    borderBottomColor: '#1a1a1a',
  },
  tableHeader: {
    flexDirection: 'row',
    paddingVertical: 3,
    borderBottomWidth: 0.8,
    borderBottomColor: '#999',
  },
  headerCell: {
    fontSize: 7.5,
    fontWeight: 'bold',
    color: '#555',
    textTransform: 'uppercase',
  },
  row: {
    flexDirection: 'row',
    paddingVertical: 3,
    borderBottomWidth: 0.4,
    borderBottomColor: '#e4e4e4',
  },
  totalRow: {
    flexDirection: 'row',
    paddingVertical: 4,
    marginTop: 2,
    borderTopWidth: 1,
    borderTopColor: '#1a1a1a',
  },
  colName: {
    flex: 1,
    paddingRight: 8,
    color: '#1a1a1a',
  },
  colAmount: {
    width: 62,
    textAlign: 'right',
    fontFamily: 'Courier',
    color: '#1a1a1a',
  },
  bold: {
    fontWeight: 'bold',
  },
  // Invoice detail table columns
  colInvName: {
    flex: 1,
    paddingRight: 6,
  },
  colInvNumber: {
    width: 60,
    paddingRight: 6,
  },
  colInvDate: {
    width: 56,
    fontFamily: 'Courier',
  },
  colInvAmount: {
    width: 62,
    textAlign: 'right',
    fontFamily: 'Courier',
  },
  colInvDays: {
    width: 36,
    textAlign: 'right',
    fontFamily: 'Courier',
  },
  colInvCurrency: {
    width: 28,
    textAlign: 'right',
    color: '#666',
  },
  // SEK bridge column: wider than colInvAmount so a 7-figure amount plus the
  // "UTEST. SEK" header both fit on one line at these font sizes.
  colInvSek: {
    width: 68,
    textAlign: 'right',
    fontFamily: 'Courier',
    color: '#1a1a1a',
  },
  // An FX invoice with no exchange_rate has no SEK amount. It is listed but
  // excluded from the aging totals, so the cell says so instead of showing a
  // number that would read as zero.
  colInvSekMissing: {
    width: 68,
    textAlign: 'right',
    color: '#92400e',
  },
  // Unit disclosure under a section heading: which currency the table below is
  // denominated in, and how it relates to the other table on the page.
  tableCaption: {
    fontSize: 8,
    color: '#666',
    marginBottom: 5,
  },
  fxNote: {
    marginTop: 8,
    fontSize: 8,
    color: '#92400e',
  },
  emptyNote: {
    fontSize: 9,
    color: '#888',
    fontStyle: 'italic',
    marginTop: 4,
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

export interface ReskontraAgingRow {
  name: string
  current: number
  days_1_30: number
  days_31_60: number
  days_61_90: number
  days_90_plus: number
  total_outstanding: number
}

export interface ReskontraInvoiceRow {
  counterparty: string
  invoice_number: string
  invoice_date: string
  due_date: string
  /** Outstanding in the invoice's own currency (see `currency`). */
  outstanding: number
  /**
   * `outstanding` converted to SEK at the invoice-date rate: the amount that
   * actually feeds the aging table. `null` for an FX invoice with no rate,
   * which is therefore missing from the aging totals.
   */
  outstanding_sek: number | null
  currency: string
  days_overdue: number
}

interface ReskontraPDFProps {
  /** 'Kundreskontra' | 'Leverantörsreskontra' */
  title: string
  /** 'Kund' | 'Leverantör' */
  counterpartyLabel: string
  asOfDate: string
  aging: ReskontraAgingRow[]
  totals: ReskontraAgingRow
  unpaidCount: number
  unconvertedFxCount: number
  /** Per-invoice detail rows (kundreskontra only). */
  invoices?: ReskontraInvoiceRow[]
  company: CompanySettings
  generatedAt: string
}

const AGING_COLUMNS: Array<{ key: keyof ReskontraAgingRow; label: string }> = [
  { key: 'current', label: 'Ej förfallet' },
  { key: 'days_1_30', label: '1-30 dgr' },
  { key: 'days_31_60', label: '31-60 dgr' },
  { key: 'days_61_90', label: '61-90 dgr' },
  { key: 'days_90_plus', label: '90+ dgr' },
  { key: 'total_outstanding', label: 'Totalt' },
]

export function ReskontraPDF({
  title,
  counterpartyLabel,
  asOfDate,
  aging,
  totals,
  unpaidCount,
  unconvertedFxCount,
  invoices,
  company,
  generatedAt,
}: ReskontraPDFProps) {
  const companyDisplayName = company.company_name || ''

  // The aging table is always SEK (it has to reconcile against the 1510/2440
  // control account) while the invoice table below it is in each invoice's own
  // currency. Both sit on the same page, so the unit of each is stated and the
  // SEK bridge column is rendered whenever the two can actually differ.
  const invoiceRows = invoices ?? []
  const hasForeignCurrency = invoiceRows.some((inv) => inv.currency !== 'SEK')
  const invoiceSekTotal =
    Math.round(
      invoiceRows.reduce((sum, inv) => sum + (inv.outstanding_sek ?? 0), 0) * 100
    ) / 100

  return (
    <Document>
      <Page size="A4" style={styles.page}>
        <View style={styles.header} fixed>
          <View style={styles.titleBlock}>
            <Text style={styles.title}>{title}</Text>
            {companyDisplayName && <Text style={styles.subtitle}>{companyDisplayName}</Text>}
            <Text style={styles.asOf}>Per datum: {formatDateSv(asOfDate)}</Text>
          </View>
          <View style={styles.companyInfo}>
            {company.company_name && <Text style={styles.companyName}>{company.company_name}</Text>}
            {company.org_number && (
              <Text style={styles.companyMeta}>Org.nr: {formatOrgNumber(company.org_number)}</Text>
            )}
            {company.vat_number && <Text style={styles.companyMeta}>VAT: {company.vat_number}</Text>}
          </View>
        </View>

        <View style={styles.summaryRow}>
          <View style={styles.summaryItem}>
            <Text style={styles.summaryLabel}>TOTALT UTESTÅENDE</Text>
            <Text style={styles.summaryValue}>{pdfAmount(totals.total_outstanding)} kr</Text>
          </View>
          <View style={styles.summaryItem}>
            <Text style={styles.summaryLabel}>EJ FÖRFALLET</Text>
            <Text style={styles.summaryValue}>{pdfAmount(totals.current)} kr</Text>
          </View>
          <View style={styles.summaryItem}>
            <Text style={styles.summaryLabel}>FÖRFALLET</Text>
            <Text style={styles.summaryValue}>
              {pdfAmount(totals.total_outstanding - totals.current)} kr
            </Text>
          </View>
          <View style={styles.summaryItem}>
            <Text style={styles.summaryLabel}>FAKTUROR</Text>
            <Text style={styles.summaryValue}>{unpaidCount}</Text>
          </View>
        </View>

        <Text style={styles.sectionHeading}>
          Åldersfördelning per {counterpartyLabel.toLowerCase()} (SEK)
        </Text>
        <Text style={styles.tableCaption}>
          Alla belopp i SEK. Fakturor i utländsk valuta är omräknade till kursen på fakturadagen.
        </Text>

        {aging.length === 0 ? (
          <Text style={styles.emptyNote}>Inga utestående fakturor per detta datum.</Text>
        ) : (
          <View>
            <View style={styles.tableHeader}>
              <Text style={[styles.colName, styles.headerCell]}>{counterpartyLabel}</Text>
              {AGING_COLUMNS.map((col) => (
                <Text key={col.key} style={[styles.colAmount, styles.headerCell]}>
                  {col.label}
                </Text>
              ))}
            </View>
            {aging.map((row, i) => (
              <View key={i} style={styles.row} wrap={false}>
                <Text style={styles.colName}>{row.name}</Text>
                {AGING_COLUMNS.map((col) => (
                  <Text key={col.key} style={styles.colAmount}>
                    {pdfAmount(row[col.key] as number)}
                  </Text>
                ))}
              </View>
            ))}
            <View style={styles.totalRow}>
              <Text style={[styles.colName, styles.bold]}>Summa</Text>
              {AGING_COLUMNS.map((col) => (
                <Text key={col.key} style={[styles.colAmount, styles.bold]}>
                  {pdfAmount(totals[col.key] as number)}
                </Text>
              ))}
            </View>
          </View>
        )}

        {invoiceRows.length > 0 && (
          <View>
            {/* NOTE: no `break` here: react-pdf 4.x deadlocks in layout when a
                break element's section spills across pages (verified against
                this template with 40+ rows). The table flows inline instead. */}
            <Text style={styles.sectionHeading}>
              Fakturor {hasForeignCurrency ? '(fakturans valuta)' : '(SEK)'}
            </Text>
            <Text style={styles.tableCaption}>
              {hasForeignCurrency
                ? 'Utestående visas i fakturans egen valuta (kolumnen Val.). Utest. SEK är samma belopp omräknat till SEK och är det som ingår i åldersfördelningen ovan. Kolumnen Utestående kan inte summeras: den blandar valutor.'
                : 'Alla belopp i SEK, samma enhet som åldersfördelningen ovan.'}
            </Text>
            {/* Column order is unchanged from the SEK-only layout; the SEK
                bridge column is inserted next to the invoice-currency amount
                only when the two can actually differ. */}
            <View style={styles.tableHeader}>
              <Text style={[styles.colInvName, styles.headerCell]}>{counterpartyLabel}</Text>
              <Text style={[styles.colInvNumber, styles.headerCell]}>Fakturanr</Text>
              <Text style={[styles.colInvDate, styles.headerCell]}>Fakturadatum</Text>
              <Text style={[styles.colInvDate, styles.headerCell]}>Förfaller</Text>
              <Text style={[styles.colInvAmount, styles.headerCell]}>Utestående</Text>
              {hasForeignCurrency && (
                <Text style={[styles.colInvSek, styles.headerCell]}>Utest. SEK</Text>
              )}
              <Text style={[styles.colInvDays, styles.headerCell]}>Dgr</Text>
              <Text style={[styles.colInvCurrency, styles.headerCell]}>Val.</Text>
            </View>
            {invoiceRows.map((inv, i) => (
              <View key={i} style={styles.row} wrap={false}>
                <Text style={styles.colInvName}>{inv.counterparty}</Text>
                <Text style={styles.colInvNumber}>{inv.invoice_number}</Text>
                <Text style={styles.colInvDate}>{inv.invoice_date}</Text>
                <Text style={styles.colInvDate}>{inv.due_date}</Text>
                <Text style={styles.colInvAmount}>{pdfAmount(inv.outstanding)}</Text>
                {hasForeignCurrency &&
                  (inv.outstanding_sek === null ? (
                    <Text style={styles.colInvSekMissing}>saknas</Text>
                  ) : (
                    <Text style={styles.colInvSek}>{pdfAmount(inv.outstanding_sek)}</Text>
                  ))}
                <Text style={styles.colInvDays}>{inv.days_overdue > 0 ? inv.days_overdue : ''}</Text>
                <Text style={styles.colInvCurrency}>{inv.currency}</Text>
              </View>
            ))}
            {hasForeignCurrency && (
              <View style={styles.totalRow}>
                <Text style={[styles.colInvName, styles.bold]}>Summa</Text>
                <Text style={styles.colInvNumber} />
                <Text style={styles.colInvDate} />
                <Text style={styles.colInvDate} />
                {/* Deliberately blank: mixed currencies do not add up. */}
                <Text style={styles.colInvAmount} />
                <Text style={[styles.colInvSek, styles.bold]}>{pdfAmount(invoiceSekTotal)}</Text>
                <Text style={styles.colInvDays} />
                <Text style={styles.colInvCurrency}>SEK</Text>
              </View>
            )}
          </View>
        )}

        {unconvertedFxCount > 0 && (
          <Text style={styles.fxNote}>
            {unconvertedFxCount}{' '}
            {unconvertedFxCount === 1 ? 'faktura' : 'fakturor'} i utländsk valuta saknar växelkurs och
            ingår därför inte i åldersfördelningen i SEK ovan.
            {hasForeignCurrency ? ' Raderna är markerade med "saknas" i kolumnen Utest. SEK.' : ''}
          </Text>
        )}

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
