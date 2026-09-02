import { formatOrgNumber } from '@/lib/utils'
import { Document, Page, StyleSheet, Text, View } from '@react-pdf/renderer'
import {
  BEHANDLINGSHISTORIK_CATEGORIES,
  BEHANDLINGSHISTORIK_CATEGORY_LABELS,
  type BehandlingshistorikEvent,
  type BehandlingshistorikReport,
} from '@/lib/reports/behandlingshistorik-types'
import { formatStockholmTimestamp } from '@/lib/reports/behandlingshistorik'

/**
 * Behandlingshistorik as a printable document (BFL 5 kap. 11 §, BFNAR 2013:2
 * punkt 9.16). Two sections in the order the law lists them in reverse of how
 * a reader scans: the system changes first (short, the context), then the
 * bokföringsposter in registreringsordning (long, the body).
 *
 * Layout rules shared with the other report PDFs: Helvetica/Courier (bundled
 * standard fonts, so no Font.register), header + footer + table header
 * `fixed` so they repeat on every page, every row `wrap={false}` so a row is
 * never split across pages, and no `break` props (they deadlock multi-page
 * renders in @react-pdf/renderer 4). Landscape: the details column needs the
 * width.
 */

const INK = '#1a1a1a'
const MUTED = '#666'
const HAIRLINE = '#d4d4d4'

const styles = StyleSheet.create({
  page: {
    paddingTop: 36,
    paddingHorizontal: 36,
    paddingBottom: 54,
    fontSize: 8.5,
    fontFamily: 'Helvetica',
    color: INK,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: 10,
    paddingBottom: 10,
    borderBottomWidth: 1,
    borderBottomColor: HAIRLINE,
  },
  titleBlock: { flex: 1 },
  title: { fontSize: 18, fontWeight: 'bold', marginBottom: 3 },
  subtitle: { fontSize: 9.5, color: '#333', marginBottom: 2 },
  legal: { fontSize: 8, color: MUTED },
  companyInfo: { textAlign: 'right' },
  companyName: { fontSize: 10, fontWeight: 'bold', marginBottom: 2 },
  companyMeta: { fontSize: 8.5, color: MUTED },
  meta: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginBottom: 10,
  },
  metaItem: { width: '25%', paddingRight: 10, marginBottom: 4 },
  metaLabel: { fontSize: 7, color: MUTED, textTransform: 'uppercase', letterSpacing: 0.4 },
  metaValue: { fontSize: 9 },
  summary: { fontSize: 8.5, color: '#333', marginBottom: 10 },
  tableHeader: {
    flexDirection: 'row',
    paddingVertical: 4,
    borderBottomWidth: 0.5,
    borderBottomColor: INK,
    marginBottom: 2,
  },
  tableHeaderText: {
    fontSize: 7.5,
    fontWeight: 'bold',
    color: '#444',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  sectionHeading: {
    fontSize: 10.5,
    fontWeight: 'bold',
    marginTop: 12,
    marginBottom: 4,
    paddingBottom: 3,
    borderBottomWidth: 0.5,
    borderBottomColor: '#888',
  },
  sectionNote: { fontSize: 8, color: MUTED, marginBottom: 4 },
  row: {
    flexDirection: 'row',
    paddingVertical: 2.5,
    borderBottomWidth: 0.5,
    borderBottomColor: '#ececec',
  },
  // Column widths live in one place so the header and the rows line up; the
  // time column gets Courier only in the body (the header stays Helvetica).
  hdrTime: { width: 100, paddingRight: 6 },
  hdrEvent: { width: 190, paddingRight: 8 },
  hdrActor: { width: 140, paddingRight: 8 },
  hdrDetails: { flex: 1 },
  colTime: { width: 100, fontFamily: 'Courier', fontSize: 7.5, color: MUTED, paddingRight: 6 },
  colEvent: { width: 190, paddingRight: 8 },
  colActor: { width: 140, paddingRight: 8, color: '#333' },
  colDetails: { flex: 1 },
  eventLabel: { fontSize: 8.5 },
  objectLabel: { fontFamily: 'Courier', fontSize: 7.5, color: MUTED, marginTop: 1 },
  detail: { fontSize: 7.5, color: '#444', marginBottom: 1 },
  empty: { fontSize: 8.5, color: MUTED, fontStyle: 'italic', paddingVertical: 6 },
  footer: {
    position: 'absolute',
    bottom: 22,
    left: 36,
    right: 36,
    borderTopWidth: 0.5,
    borderTopColor: HAIRLINE,
    paddingTop: 5,
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  footerText: { fontSize: 7.5, color: '#888' },
})

/**
 * The bundled Helvetica/Courier AFM fonts only carry WinAnsi glyphs: an arrow
 * or a true minus would be dropped silently. Map them to ASCII for print.
 */
export function pdfText(value: string): string {
  return value.replace(/→/g, '->').replace(/−/g, '-')
}

function EventRow({ event }: { event: BehandlingshistorikEvent }) {
  return (
    <View style={styles.row} wrap={false}>
      <Text style={styles.colTime}>{formatStockholmTimestamp(event.occurred_at)}</Text>
      <View style={styles.colEvent}>
        <Text style={styles.eventLabel}>{pdfText(event.event)}</Text>
        {event.object ? <Text style={styles.objectLabel}>{pdfText(event.object)}</Text> : null}
      </View>
      <Text style={styles.colActor}>{pdfText(event.actor.label)}</Text>
      <View style={styles.colDetails}>
        {event.details.length > 0 ? (
          // One wrapped paragraph rather than one Text per line: half the
          // layout nodes (render time) and roughly twice the rows per page.
          <Text style={styles.detail}>{pdfText(event.details.join(' · '))}</Text>
        ) : null}
      </View>
    </View>
  )
}

function Section({ title, note, events }: { title: string; note: string; events: BehandlingshistorikEvent[] }) {
  return (
    <View>
      <Text style={styles.sectionHeading}>{title}</Text>
      <Text style={styles.sectionNote}>{note}</Text>
      {events.length === 0 ? (
        <Text style={styles.empty}>Inga händelser i urvalet.</Text>
      ) : (
        events.map((event) => <EventRow key={event.id} event={event} />)
      )}
    </View>
  )
}

export interface BehandlingshistorikPDFProps {
  report: BehandlingshistorikReport
}

export function BehandlingshistorikPDF({ report }: BehandlingshistorikPDFProps) {
  const systemEvents = report.events.filter((e) => e.category !== 'verifikation')
  const voucherEvents = report.events.filter((e) => e.category === 'verifikation')
  const scope =
    report.mode === 'fiscal_year'
      ? 'Hela räkenskapsåret'
      : `${report.range.from} till ${report.range.to}`
  const categoryFilter =
    report.category_filter && report.category_filter.length > 0
      ? report.category_filter.map((c) => BEHANDLINGSHISTORIK_CATEGORY_LABELS[c]).join(', ')
      : null
  const summary = BEHANDLINGSHISTORIK_CATEGORIES.filter((c) => report.by_category[c] > 0)
    .map((c) => `${BEHANDLINGSHISTORIK_CATEGORY_LABELS[c]} ${report.by_category[c]}`)
    .join(' · ')
  const generated = formatStockholmTimestamp(report.generated_at)

  return (
    <Document
      title={`Behandlingshistorik ${report.period.name}`}
      author={report.company.name}
      subject="Behandlingshistorik enligt BFL 5 kap. 11 §"
    >
      <Page size="A4" orientation="landscape" style={styles.page}>
        <View style={styles.header} fixed>
          <View style={styles.titleBlock}>
            <Text style={styles.title}>Behandlingshistorik</Text>
            <Text style={styles.subtitle}>
              {report.period.name} ({report.period.start} till {report.period.end}) · Urval: {scope}
              {categoryFilter ? ` · Kategori: ${categoryFilter}` : ''}
            </Text>
            <Text style={styles.legal}>BFL 5 kap. 11 § · BFNAR 2013:2 punkt 9.16 · Tider i Europe/Stockholm</Text>
          </View>
          <View style={styles.companyInfo}>
            {report.company.name ? <Text style={styles.companyName}>{report.company.name}</Text> : null}
            {report.company.org_number ? (
              <Text style={styles.companyMeta}>Org.nr: {formatOrgNumber(report.company.org_number)}</Text>
            ) : null}
          </View>
        </View>

        <View style={styles.meta}>
          <View style={styles.metaItem}>
            <Text style={styles.metaLabel}>Genererad</Text>
            <Text style={styles.metaValue}>{generated}</Text>
          </View>
          <View style={styles.metaItem}>
            <Text style={styles.metaLabel}>Programversion</Text>
            <Text style={styles.metaValue}>{report.app_version ?? 'okänd'}</Text>
          </View>
          <View style={styles.metaItem}>
            <Text style={styles.metaLabel}>Antal händelser</Text>
            <Text style={styles.metaValue}>{String(report.total_events)}</Text>
          </View>
          <View style={styles.metaItem}>
            <Text style={styles.metaLabel}>Källor</Text>
            <Text style={styles.metaValue}>Verifikationer, oföränderlig ändringslogg, rättelselogg, importer</Text>
          </View>
        </View>
        {summary ? <Text style={styles.summary}>{summary}</Text> : null}

        <View style={styles.tableHeader} fixed>
          <Text style={[styles.tableHeaderText, styles.hdrTime]}>Tidpunkt</Text>
          <Text style={[styles.tableHeaderText, styles.hdrEvent]}>Händelse</Text>
          <Text style={[styles.tableHeaderText, styles.hdrActor]}>Utförd av</Text>
          <Text style={[styles.tableHeaderText, styles.hdrDetails]}>Detaljer</Text>
        </View>

        <Section
          title="Ändringar i bokföringssystemet"
          note="Kontoplan, inställningar som styr bokföringen, räkenskapsår, importer och åtkomst, med tidpunkt och utförare (BFNAR 2013:2 punkt 9.16 andra stycket)."
          events={systemEvents}
        />
        <Section
          title="Bokföringsposter i registreringsordning"
          note="Varje bokförd verifikation med registreringstidpunkt och utförare, samt makuleringar, rättelser och raderingar (BFNAR 2013:2 punkt 9.16 första stycket)."
          events={voucherEvents}
        />

        <View style={styles.footer} fixed>
          <Text style={styles.footerText}>
            {report.company.name}
            {report.company.org_number ? ` · ${formatOrgNumber(report.company.org_number)}` : ''}
            {' · Behandlingshistorik'}
          </Text>
          <Text
            style={styles.footerText}
            render={({ pageNumber, totalPages }) => `Genererad ${generated} · Sida ${pageNumber} av ${totalPages}`}
          />
        </View>
      </Page>
    </Document>
  )
}
