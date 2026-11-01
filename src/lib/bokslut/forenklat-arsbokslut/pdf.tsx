import { Document, Page, StyleSheet, Text, View } from '@react-pdf/renderer'
import { formatDateSv, pdfAmount, pdfText } from '@/lib/pdf/number-text'
import { formatOrgNumberDisplay } from '@/lib/invariants/org-number'
import type { ForenklatArsbokslut } from './service'
import type { K1StatementRow } from './types'

/**
 * The förenklat årsbokslut as the document the styrelse signs, in the layout
 * of BFNAR 2010:1 bilaga 2 and BFN's example 5-2: the förening's name, the
 * räkenskapsår, the resultaträkning and balansräkning with comparatives, the
 * tilläggsupplysningar, then "Beslutat" with a date line and one signature
 * and date line per styrelseledamot (BFL 6 kap. 6 § with ÅRL 2 kap. 7 §, as
 * BFNAR 2024:6 put it in bilaga 2). Never account numbers: the posts are the
 * document.
 */

const styles = StyleSheet.create({
  page: { paddingTop: 48, paddingHorizontal: 48, paddingBottom: 64, fontSize: 10, fontFamily: 'Helvetica', color: '#1a1a1a' },
  entity: { fontSize: 16, fontWeight: 'bold', marginBottom: 4 },
  title: { fontSize: 12, marginBottom: 2 },
  meta: { fontSize: 9, color: '#555', marginBottom: 2 },
  statement: { marginTop: 24 },
  statementTitle: { fontSize: 12, fontWeight: 'bold', marginBottom: 6 },
  headerRow: { flexDirection: 'row', borderBottomWidth: 0.8, borderBottomColor: '#1a1a1a', paddingBottom: 3, marginBottom: 2 },
  row: { flexDirection: 'row', paddingVertical: 2 },
  rubrikRow: { flexDirection: 'row', paddingTop: 8, paddingBottom: 2 },
  summaRow: { flexDirection: 'row', paddingVertical: 3, marginTop: 2, borderTopWidth: 0.5, borderTopColor: '#999' },
  label: { flex: 1, paddingRight: 12 },
  rubrik: { flex: 1, fontWeight: 'bold' },
  summaLabel: { flex: 1, fontWeight: 'bold', paddingRight: 12 },
  amount: { width: 110, textAlign: 'right' },
  summaAmount: { width: 110, textAlign: 'right', fontWeight: 'bold' },
  columnHead: { width: 110, textAlign: 'right', fontSize: 8, color: '#555' },
  notes: { marginTop: 24 },
  notesText: { lineHeight: 1.4 },
  decided: { marginTop: 36, flexDirection: 'row' },
  signatures: { marginTop: 24, flexDirection: 'row', flexWrap: 'wrap' },
  signature: { width: '50%', paddingRight: 24, marginBottom: 28 },
  line: { borderBottomWidth: 0.6, borderBottomColor: '#1a1a1a', height: 22, marginBottom: 3 },
  small: { fontSize: 8, color: '#555' },
  footer: {
    position: 'absolute',
    bottom: 28,
    left: 48,
    right: 48,
    flexDirection: 'row',
    justifyContent: 'space-between',
    fontSize: 8,
    color: '#888',
  },
})

function range(start: string, end: string): string {
  return `${formatDateSv(start)} - ${formatDateSv(end)}`
}

function Statement({
  title,
  rows,
  currentHead,
  previousHead,
}: {
  title: string
  rows: K1StatementRow[]
  currentHead: string
  previousHead: string | null
}) {
  return (
    <View style={styles.statement}>
      <Text style={styles.statementTitle}>{title}</Text>
      <View style={styles.headerRow}>
        <Text style={styles.label} />
        <Text style={styles.columnHead}>{currentHead}</Text>
        {previousHead !== null && <Text style={styles.columnHead}>{previousHead}</Text>}
      </View>
      {rows.map((row) => {
        if (row.kind === 'rubrik') {
          return (
            <View key={row.key} style={styles.rubrikRow} wrap={false}>
              <Text style={styles.rubrik}>{row.label}</Text>
            </View>
          )
        }
        const summa = row.kind === 'summa'
        return (
          <View key={row.key} style={summa ? styles.summaRow : styles.row} wrap={false}>
            <Text style={summa ? styles.summaLabel : styles.label}>{row.label}</Text>
            <Text style={summa ? styles.summaAmount : styles.amount}>{pdfAmount(row.current ?? 0)}</Text>
            {previousHead !== null && (
              <Text style={summa ? styles.summaAmount : styles.amount}>{pdfAmount(row.previous ?? 0)}</Text>
            )}
          </View>
        )
      })}
    </View>
  )
}

/** Four blank signature blocks when no styrelseledamöter are recorded, as BFN's bilaga 2 shows A to D. */
const BLANK_SIGNATORIES = [null, null, null, null]

export function ForenklatArsbokslutPDF({ report }: { report: ForenklatArsbokslut }) {
  const { fiscal_period: period, previous_period: previous } = report
  const signatories = report.signatories.length > 0 ? report.signatories : BLANK_SIGNATORIES

  return (
    <Document title={`Förenklat årsbokslut ${period.name}`} author={report.company.name}>
      <Page size="A4" style={styles.page} wrap>
        <Text style={styles.entity}>{report.company.name}</Text>
        <Text style={styles.title}>
          Förenklat årsbokslut för räkenskapsåret {range(period.period_start, period.period_end)}
        </Text>
        {report.company.org_number && (
          <Text style={styles.meta}>Organisationsnummer {formatOrgNumberDisplay(report.company.org_number)}</Text>
        )}

        <Statement
          title="Resultaträkning"
          rows={report.resultatrakning}
          currentHead={range(period.period_start, period.period_end)}
          previousHead={previous ? range(previous.period_start, previous.period_end) : null}
        />

        <Statement
          title="Balansräkning"
          rows={report.balansrakning}
          currentHead={formatDateSv(period.period_end)}
          previousHead={previous ? formatDateSv(previous.period_end) : null}
        />

        {report.notes && (
          <View style={styles.notes}>
            <Text style={styles.statementTitle}>Tilläggsupplysningar</Text>
            <Text style={styles.notesText}>{pdfText(report.notes)}</Text>
          </View>
        )}

        <View wrap={false}>
          <View style={styles.decided}>
            <Text>Beslutat </Text>
            <View style={{ width: 140, borderBottomWidth: 0.6, borderBottomColor: '#1a1a1a' }} />
          </View>
          <View style={styles.signatures}>
            {signatories.map((signatory, index) => (
              <View key={index} style={styles.signature}>
                <View style={styles.line} />
                <Text>{signatory ? signatory.name : 'Namnförtydligande'}</Text>
                {signatory?.role && <Text style={styles.small}>{signatory.role}</Text>}
                <View style={[styles.line, { width: 110, height: 18 }]} />
                <Text style={styles.small}>Datum</Text>
              </View>
            ))}
          </View>
        </View>

        <View style={styles.footer} fixed>
          <Text>
            {report.company.name}
            {report.company.org_number ? ` · ${formatOrgNumberDisplay(report.company.org_number)}` : ''}
          </Text>
          <Text render={({ pageNumber, totalPages }) => `Sida ${pageNumber} av ${totalPages}`} />
        </View>
      </Page>
    </Document>
  )
}
