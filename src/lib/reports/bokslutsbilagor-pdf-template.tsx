import { formatOrgNumber } from '@/lib/utils'
import { Document, Page, StyleSheet, Text, View } from '@react-pdf/renderer'
import type { BilagaAccount, BilagaChecklistItem, BokslutsbilagorReport } from '@/lib/reports/bokslutsbilagor-types'
import { formatStockholmTimestamp } from '@/lib/reports/behandlingshistorik'

/**
 * Bokslutsbilagor as a printable pärm: the checklist first, then one bilaga
 * per balance account with the balances, what it was reconciled against, the
 * sign-off and the underlag files with their hashes. Same layout rules as the
 * other report PDFs: bundled Helvetica/Courier (no Font.register), header and
 * footer `fixed`, every row `wrap={false}`, and no `break` props (they
 * deadlock multi-page renders in @react-pdf/renderer 4).
 */

const INK = '#1a1a1a'
const MUTED = '#666'
const HAIRLINE = '#d4d4d4'

const styles = StyleSheet.create({
  page: { paddingTop: 36, paddingHorizontal: 40, paddingBottom: 54, fontSize: 8.5, fontFamily: 'Helvetica', color: INK },
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
  meta: { flexDirection: 'row', flexWrap: 'wrap', marginBottom: 8 },
  metaItem: { width: '25%', paddingRight: 10, marginBottom: 4 },
  metaLabel: { fontSize: 7, color: MUTED, textTransform: 'uppercase', letterSpacing: 0.4 },
  metaValue: { fontSize: 9 },
  sectionHeading: { fontSize: 10.5, fontWeight: 'bold', marginTop: 12, marginBottom: 4, paddingBottom: 3, borderBottomWidth: 0.5, borderBottomColor: '#888' },
  sectionNote: { fontSize: 8, color: MUTED, marginBottom: 4 },
  row: { flexDirection: 'row', paddingVertical: 2.5, borderBottomWidth: 0.5, borderBottomColor: '#ececec' },
  checkState: { width: 70, fontFamily: 'Courier', fontSize: 7.5 },
  checkLabel: { flex: 1, paddingRight: 8 },
  checkWho: { width: 150, fontSize: 7.5, color: MUTED },
  bilaga: { marginTop: 8, paddingTop: 6, borderTopWidth: 0.5, borderTopColor: '#bbb' },
  bilagaHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 3 },
  bilagaTitle: { fontSize: 9.5, fontWeight: 'bold' },
  bilagaKey: { fontFamily: 'Courier', fontSize: 7.5, color: MUTED },
  numbers: { flexDirection: 'row', marginBottom: 3 },
  numCell: { width: '20%', paddingRight: 8 },
  numLabel: { fontSize: 6.8, color: MUTED, textTransform: 'uppercase', letterSpacing: 0.3 },
  numValue: { fontFamily: 'Courier', fontSize: 8.5 },
  line: { fontSize: 8, color: '#333', marginBottom: 1.5 },
  lineMuted: { fontSize: 7.5, color: MUTED, marginBottom: 1.5 },
  fileRow: { flexDirection: 'row', paddingVertical: 1.5 },
  fileName: { flex: 1, fontSize: 7.8, paddingRight: 6 },
  fileMeta: { width: 200, fontFamily: 'Courier', fontSize: 6.8, color: MUTED },
  empty: { fontSize: 8.5, color: MUTED, fontStyle: 'italic', paddingVertical: 6 },
  footer: { position: 'absolute', bottom: 22, left: 40, right: 40, borderTopWidth: 0.5, borderTopColor: HAIRLINE, paddingTop: 5, flexDirection: 'row', justifyContent: 'space-between' },
  footerText: { fontSize: 7.5, color: '#888' },
})

/** WinAnsi only: arrows, true minus and narrow spaces would drop silently. */
function pdfText(value: string): string {
  return value.replace(/→/g, '->').replace(/−/g, '-').replace(/[   ]/g, ' ')
}

const NUMBER = new Intl.NumberFormat('sv-SE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

function amount(n: number | null): string {
  return n == null ? '-' : pdfText(NUMBER.format(n))
}

const STATE_LABEL: Record<BilagaChecklistItem['state'], string> = {
  done: '[x] Klart',
  not_applicable: '[-] Ej tillämpl.',
  open: '[ ] Öppet',
}

const GROUP_LABEL: Record<string, string> = {
  avstamning: 'Avstämningar',
  periodisering: 'Periodiseringar',
  vardering: 'Värdering',
  dispositioner: 'Dispositioner och skatt',
  kontroll: 'Kontroller',
  rapportering: 'Rapportering',
}

function ChecklistRow({ item }: { item: BilagaChecklistItem }) {
  const who = item.done_at ? `${item.done_by_label ?? ''} ${formatStockholmTimestamp(item.done_at)}`.trim() : ''
  return (
    <View style={styles.row} wrap={false}>
      <Text style={styles.checkState}>{STATE_LABEL[item.state]}</Text>
      <Text style={styles.checkLabel}>
        {pdfText(item.label_sv)}
        {item.note ? ` (${pdfText(item.note)})` : ''}
      </Text>
      <Text style={styles.checkWho}>{pdfText(who)}</Text>
    </View>
  )
}

function Bilaga({ account, balansdag }: { account: BilagaAccount; balansdag: string }) {
  const s = account.signoff
  const signLine = !s
    ? 'Ej signerad.'
    : s.on_balansdag
      ? `Signerad per ${s.through_date} av ${s.signed_by_label} (${formatStockholmTimestamp(s.signed_at)})${s.note ? `: ${s.note}` : ''}`
      : `Senast signerad t.o.m. ${s.through_date} av ${s.signed_by_label} (${formatStockholmTimestamp(s.signed_at)}), inte per balansdagen ${balansdag}${s.note ? `: ${s.note}` : ''}`
  const active = account.attachments.filter((a) => !a.removed_at)
  const removed = account.attachments.filter((a) => a.removed_at)
  return (
    <View style={styles.bilaga}>
      <View style={styles.bilagaHead} wrap={false}>
        <Text style={styles.bilagaTitle}>
          {account.account_number} {pdfText(account.name)}
        </Text>
        <Text style={styles.bilagaKey}>{account.account_key}</Text>
      </View>
      <View style={styles.numbers} wrap={false}>
        <View style={styles.numCell}>
          <Text style={styles.numLabel}>Ingående balans</Text>
          <Text style={styles.numValue}>{amount(account.opening_balance)}</Text>
        </View>
        <View style={styles.numCell}>
          <Text style={styles.numLabel}>Förändring</Text>
          <Text style={styles.numValue}>{amount(account.movement)}</Text>
        </View>
        <View style={styles.numCell}>
          <Text style={styles.numLabel}>Utgående balans</Text>
          <Text style={styles.numValue}>{amount(account.closing_balance)}</Text>
        </View>
        <View style={styles.numCell}>
          <Text style={styles.numLabel}>Enligt underlag</Text>
          <Text style={styles.numValue}>{amount(account.external_balance)}</Text>
        </View>
        <View style={styles.numCell}>
          <Text style={styles.numLabel}>Differens</Text>
          <Text style={styles.numValue}>{amount(account.difference)}</Text>
        </View>
      </View>
      <Text style={styles.lineMuted} wrap={false}>
        Underlag: {pdfText(account.external_label_sv)}
      </Text>
      <Text style={styles.line} wrap={false}>
        {pdfText(signLine)}
      </Text>
      {active.length === 0 ? (
        <Text style={styles.lineMuted} wrap={false}>
          Inga bifogade filer.
        </Text>
      ) : (
        active.map((a) => (
          <View key={a.id} style={styles.fileRow} wrap={false}>
            <Text style={styles.fileName}>
              {pdfText(a.file_name)}
              {a.note ? ` (${pdfText(a.note)})` : ''}
              {a.through_date !== balansdag ? ` per ${a.through_date}` : ''}
            </Text>
            <Text style={styles.fileMeta}>
              sha256 {a.sha256.slice(0, 16)} · {formatStockholmTimestamp(a.uploaded_at)}
            </Text>
          </View>
        ))
      )}
      {removed.map((a) => (
        <View key={a.id} style={styles.fileRow} wrap={false}>
          <Text style={[styles.fileName, { color: MUTED }]}>
            Borttagen: {pdfText(a.file_name)}
            {a.removed_reason ? ` (${pdfText(a.removed_reason)})` : ''}
          </Text>
          <Text style={styles.fileMeta}>{a.removed_at ? formatStockholmTimestamp(a.removed_at) : ''}</Text>
        </View>
      ))}
    </View>
  )
}

export interface BokslutsbilagorPDFProps {
  report: BokslutsbilagorReport
}

export function BokslutsbilagorPDF({ report }: BokslutsbilagorPDFProps) {
  const generated = formatStockholmTimestamp(report.generated_at)
  const groups = [...new Set(report.checklist.items.map((i) => i.group))]
  return (
    <Document title={`Bokslutsbilagor ${report.period.name}`} author={report.company.name} subject="Bokslutsbilagor per balansdagen">
      <Page size="A4" style={styles.page}>
        <View style={styles.header} fixed>
          <View style={styles.titleBlock}>
            <Text style={styles.title}>Bokslutsbilagor</Text>
            <Text style={styles.subtitle}>
              {report.period.name} ({report.period.start} till {report.period.end}) · Balansdag {report.period.end}
            </Text>
            <Text style={styles.legal}>Avstämning och dokumentation per balanspost · Tider i Europe/Stockholm</Text>
          </View>
          <View style={styles.companyInfo}>
            {report.company.name ? <Text style={styles.companyName}>{pdfText(report.company.name)}</Text> : null}
            {report.company.org_number ? <Text style={styles.companyMeta}>Org.nr: {formatOrgNumber(report.company.org_number)}</Text> : null}
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
            <Text style={styles.metaLabel}>Balanskonton</Text>
            <Text style={styles.metaValue}>
              {String(report.summary.accounts)} · signerade per balansdagen {String(report.summary.signed_on_balansdag)} · annan dag{' '}
              {String(report.summary.signed_other_date)} · osignerade {String(report.summary.unsigned)}
            </Text>
          </View>
          <View style={styles.metaItem}>
            <Text style={styles.metaLabel}>Bifogade filer</Text>
            <Text style={styles.metaValue}>{String(report.summary.attachments)}</Text>
          </View>
        </View>

        <Text style={styles.sectionHeading}>Bokslutschecklista</Text>
        <Text style={styles.sectionNote}>
          {report.checklist.summary.done} klara, {report.checklist.summary.not_applicable} ej tillämpliga, {report.checklist.summary.open} öppna av{' '}
          {report.checklist.summary.total}. Steg som systemet bedömer själv visas som de stod när pärmen genererades.
        </Text>
        {groups.map((group) => (
          <View key={group}>
            <Text style={[styles.lineMuted, { marginTop: 4 }]}>{GROUP_LABEL[group] ?? group}</Text>
            {report.checklist.items.filter((i) => i.group === group).map((item) => <ChecklistRow key={item.key} item={item} />)}
          </View>
        ))}

        <Text style={styles.sectionHeading}>Bilagor per balanskonto</Text>
        <Text style={styles.sectionNote}>
          Bokfört enligt saldobalansen per balansdagen. Enligt underlag: reskontra eller beräkning där systemet har en, annars det saldo som angavs
          eller hämtades vid signeringen. Filer identifieras med SHA-256; borttagna filer finns kvar i arkivet.
        </Text>
        {report.accounts.length === 0 ? (
          <Text style={styles.empty}>Inga balanskonton med saldo eller rörelse i perioden.</Text>
        ) : (
          report.accounts.map((account) => <Bilaga key={account.account_key} account={account} balansdag={report.period.end} />)
        )}

        <View style={styles.footer} fixed>
          <Text style={styles.footerText}>
            {pdfText(report.company.name)}
            {report.company.org_number ? ` · ${formatOrgNumber(report.company.org_number)}` : ''}
            {' · Bokslutsbilagor '}
            {report.period.name}
          </Text>
          <Text style={styles.footerText} render={({ pageNumber, totalPages }) => `Genererad ${generated} · Sida ${pageNumber} av ${totalPages}`} />
        </View>
      </Page>
    </Document>
  )
}
