import type { ReactNode } from 'react'
import { formatOrgNumber } from '@/lib/utils'
import { Document, Page, StyleSheet, Text, View } from '@react-pdf/renderer'
import type { SystemdokumentationReport } from '@/lib/reports/systemdokumentation-types'
import { formatStockholmTimestamp } from '@/lib/reports/behandlingshistorik'

/**
 * Systemdokumentation as a printable document, section by section after
 * BFNAR 2013:2 kap. 9: system, kontoplan, samlingsplan, verifikationsserier,
 * behandlingsregler, rättelse och låsning, behörigheter, integrationer,
 * arkivering. Same layout rules as the other report PDFs: bundled
 * Helvetica/Courier (no Font.register), header and footer `fixed`, every
 * row `wrap={false}`, and no `break` props (they deadlock multi-page
 * renders in @react-pdf/renderer 4).
 */

const INK = '#1a1a1a'
const MUTED = '#666'
const HAIRLINE = '#d4d4d4'

const styles = StyleSheet.create({
  page: { paddingTop: 36, paddingHorizontal: 40, paddingBottom: 54, fontSize: 8.5, fontFamily: 'Helvetica', color: INK },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 10, paddingBottom: 10, borderBottomWidth: 1, borderBottomColor: HAIRLINE },
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
  para: { fontSize: 8.5, marginBottom: 4, lineHeight: 1.35 },
  row: { flexDirection: 'row', paddingVertical: 2.5, borderBottomWidth: 0.5, borderBottomColor: '#ececec' },
  rowHead: { flexDirection: 'row', paddingVertical: 2.5, borderBottomWidth: 0.5, borderBottomColor: '#888' },
  th: { fontSize: 7, color: MUTED, textTransform: 'uppercase', letterSpacing: 0.3 },
  cell: { fontSize: 8, paddingRight: 6 },
  mono: { fontFamily: 'Courier', fontSize: 7.8 },
  muted: { color: MUTED },
  ruleTitle: { fontSize: 8.5, fontWeight: 'bold', marginTop: 4, marginBottom: 1 },
  bullet: { flexDirection: 'row', marginBottom: 2 },
  bulletDot: { width: 10, fontSize: 8.5 },
  bulletText: { flex: 1, fontSize: 8.5, lineHeight: 1.35 },
  footer: { position: 'absolute', bottom: 22, left: 40, right: 40, borderTopWidth: 0.5, borderTopColor: HAIRLINE, paddingTop: 5, flexDirection: 'row', justifyContent: 'space-between' },
  footerText: { fontSize: 7.5, color: '#888' },
})

/** WinAnsi only: arrows, true minus and narrow spaces would drop silently. */
function pdfText(value: string): string {
  return value.replace(/→/g, '->').replace(/−/g, '-').replace(/[   ]/g, ' ')
}

const ENTITY_LABEL: Record<string, string> = {
  enskild_firma: 'Enskild firma',
  aktiebolag: 'Aktiebolag',
  ideell_forening: 'Ideell förening',
}
const METHOD_LABEL: Record<string, string> = { accrual: 'Faktureringsmetoden', cash: 'Kontantmetoden' }
const FRAMEWORK_LABEL: Record<string, string> = { k2: 'K2', k3: 'K3' }
const MOMS_LABEL: Record<string, string> = { monthly: 'Månad', quarterly: 'Kvartal', yearly: 'Helår' }
const ROLE_LABEL: Record<string, string> = { owner: 'Ägare', admin: 'Administratör', member: 'Medlem', viewer: 'Läsare' }

const NUMBER = new Intl.NumberFormat('sv-SE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

function Section({ title, note, children }: { title: string; note?: string; children: ReactNode }) {
  return (
    <View>
      {/* A heading with nothing below it on the page reads as a stray line: demand room for a few rows. */}
      <View minPresenceAhead={60}>
        <Text style={styles.sectionHeading} wrap={false}>
          {title}
        </Text>
        {note ? <Text style={styles.sectionNote}>{pdfText(note)}</Text> : null}
      </View>
      {children}
    </View>
  )
}

function Bullet({ text }: { text: string }) {
  return (
    <View style={styles.bullet} wrap={false}>
      <Text style={styles.bulletDot}>-</Text>
      <Text style={styles.bulletText}>{pdfText(text)}</Text>
    </View>
  )
}

function Head({ cols }: { cols: { label: string; width: number | string }[] }) {
  return (
    <View style={styles.rowHead} wrap={false}>
      {cols.map((c) => (
        <Text key={c.label} style={[styles.th, { width: c.width }]}>
          {c.label}
        </Text>
      ))}
    </View>
  )
}

export interface SystemdokumentationPDFProps {
  report: SystemdokumentationReport
}

export function SystemdokumentationPDF({ report }: SystemdokumentationPDFProps) {
  const generated = formatStockholmTimestamp(report.generated_at)
  const c = report.company
  const activeDelsystem = report.delsystem.filter((d) => d.active)
  const inactiveDelsystem = report.delsystem.filter((d) => !d.active)
  const activeIntegrations = report.integrationer.filter((i) => i.active)
  const seriesInUse = [...new Set(report.verifikationsserier.per_source_type.map((r) => r.series))].sort()
  const bySeries = seriesInUse.map((letter) => ({
    letter,
    label: report.verifikationsserier.per_source_type.find((r) => r.series === letter)?.series_label ?? '',
    types: report.verifikationsserier.per_source_type.filter((r) => r.series === letter).map((r) => r.label),
  }))

  return (
    <Document title={`Systemdokumentation ${report.period.name}`} author={report.company.name ?? undefined} subject="Systemdokumentation enligt BFL 5 kap. 11 § och BFNAR 2013:2 kap. 9">
      <Page size="A4" style={styles.page}>
        <View style={styles.header} fixed>
          <View style={styles.titleBlock}>
            <Text style={styles.title}>Systemdokumentation</Text>
            <Text style={styles.subtitle}>
              {report.period.name} ({report.period.start} till {report.period.end})
            </Text>
            <Text style={styles.legal}>BFL 5 kap. 11 § och BFNAR 2013:2 kap. 9 · Genererad ur företagets inställningar i {pdfText(report.system.name)}</Text>
          </View>
          <View style={styles.companyInfo}>
            {c.name ? <Text style={styles.companyName}>{pdfText(c.name)}</Text> : null}
            {c.org_number ? <Text style={styles.companyMeta}>Org.nr: {formatOrgNumber(c.org_number)}</Text> : null}
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
            <Text style={styles.metaLabel}>Företagsform</Text>
            <Text style={styles.metaValue}>{c.entity_type ? ENTITY_LABEL[c.entity_type] ?? c.entity_type : '-'}</Text>
          </View>
          <View style={styles.metaItem}>
            <Text style={styles.metaLabel}>Bokföringsmetod</Text>
            <Text style={styles.metaValue}>{c.accounting_method ? METHOD_LABEL[c.accounting_method] ?? c.accounting_method : '-'}</Text>
          </View>
          <View style={styles.metaItem}>
            <Text style={styles.metaLabel}>Regelverk</Text>
            <Text style={styles.metaValue}>{c.accounting_framework ? FRAMEWORK_LABEL[c.accounting_framework] ?? c.accounting_framework : '-'}</Text>
          </View>
          <View style={styles.metaItem}>
            <Text style={styles.metaLabel}>Moms</Text>
            <Text style={styles.metaValue}>{c.vat_registered ? `Registrerad, ${c.moms_period ? MOMS_LABEL[c.moms_period] ?? c.moms_period : 'period okänd'}` : 'Ej momsregistrerad'}</Text>
          </View>
          <View style={styles.metaItem}>
            <Text style={styles.metaLabel}>Räkenskapsårets status</Text>
            <Text style={styles.metaValue}>{report.period.is_closed ? 'Stängt' : report.period.locked_at ? 'Låst' : 'Öppet'}</Text>
          </View>
          <View style={styles.metaItem}>
            <Text style={styles.metaLabel}>Bokföringen låst t.o.m.</Text>
            <Text style={styles.metaValue}>{report.rattelse_och_las.lock_date ?? 'inget låsdatum'}</Text>
          </View>
        </View>

        <Section title="1. Bokföringssystemet" note="BFNAR 2013:2 punkt 9.2 och 9.5: systemets uppbyggnad och organisation.">
          <Text style={styles.para}>
            {pdfText(
              `Bokföringen förs i ${report.system.name} (${report.system.url}), ett webbaserat bokföringsprogram med dubbel bokföring enligt bokföringslagen. ${
                report.system.hosted
                  ? 'Programmet drivs som molntjänst av leverantören; databas och filer lagras i Sverige (AWS, Stockholm).'
                  : 'Programmet drivs i egen regi; var databasen finns och vem som ansvarar för drift och säkerhetskopiering anges i företagets egen dokumentation.'
              } Bokföringslagens krav på balans, varaktighet, löpande verifikationsnummer och periodlåsning upprätthålls av databasen själv, inte enbart av programkoden. Programversionen anges ovan; varje ny version registreras med datum i behandlingshistoriken. Kontoplan, inställningar, behörigheter och integrationer beskrivs som de är vid framtagningen; hur de såg ut tidigare under räkenskapsåret, och varje ändring med datum och utförare, framgår av behandlingshistoriken för året.`,
            )}
          </Text>
          <Text style={styles.para}>
            {pdfText(
              'Kedjan från affärshändelse till bokslut: en affärshändelse ger en verifikation med underlag; verifikationen bokförs som journalpost i registreringsordning (grundbokföring) och konteras på kontoplanens konton i systematisk ordning (huvudbokföring); ur huvudboken tas saldobalans, resultat- och balansräkning, momsdeklaration och bokslut. Varje led kan följas åt båda hållen: en rapportpost leder till sina konteringsrader, verifikationen och underlaget, och ett underlag leder till sin verifikation.',
            )}
          </Text>
        </Section>

        <Section title="2. Kontoplan" note={`BFNAR 2013:2 punkt 9.2 a och 9.3. ${report.kontoplan.standard}, ${report.kontoplan.accounts.length} aktiva konton. Hela kontoplanen med SRU-koder följer i bilaga A.`}>
          <Head cols={[{ label: 'Klass', width: 60 }, { label: 'Innehåll', width: 300 }, { label: 'Antal konton', width: 80 }]} />
          {report.kontoplan.class_summary.map((row) => (
            <View key={row.account_class} style={styles.row} wrap={false}>
              <Text style={[styles.cell, styles.mono, { width: 60 }]}>{row.account_class}</Text>
              <Text style={[styles.cell, { width: 300 }]}>{CLASS_LABEL[row.account_class] ?? ''}</Text>
              <Text style={[styles.cell, styles.mono, { width: 80 }]}>{row.count}</Text>
            </View>
          ))}
          <Text style={[styles.para, { marginTop: 4 }]}>{pdfText(report.kontoplan.sie_import_regler)}</Text>
        </Section>

        <Section title="3. Samlingsplan: delsystem" note="BFNAR 2013:2 punkt 9.2 c, 9.4 och 9.11: vilka delsystem som matar bokföringen och hur de konterar.">
          <Head cols={[{ label: 'Delsystem', width: 130 }, { label: 'Beskrivning', width: 230 }, { label: 'Kontering', width: 150 }]} />
          {activeDelsystem.map((d) => (
            <View key={d.key} style={styles.row} wrap={false}>
              <Text style={[styles.cell, { width: 130 }]}>{pdfText(d.label)}</Text>
              <Text style={[styles.cell, { width: 230 }]}>{pdfText(d.description)}</Text>
              <Text style={[styles.cell, { width: 150 }]}>{pdfText(d.kontering)}</Text>
            </View>
          ))}
          {inactiveDelsystem.length ? (
            <Text style={[styles.sectionNote, { marginTop: 4 }]}>
              {pdfText(`Finns i programmet men används inte av företaget: ${inactiveDelsystem.map((d) => d.label).join(', ')}.`)}
            </Text>
          ) : null}
        </Section>

        <Section title="4. Verifikationsserier" note="BFNAR 2013:2 punkt 9.6: serier, vad de omfattar och nummer tilldelade under räkenskapsåret.">
          <Head cols={[{ label: 'Serie', width: 50 }, { label: 'Namn', width: 160 }, { label: 'Verifikattyper', width: 300 }]} />
          {bySeries.map((row) => (
            <View key={row.letter} style={styles.row} wrap={false}>
              <Text style={[styles.cell, styles.mono, { width: 50 }]}>{row.letter}</Text>
              <Text style={[styles.cell, { width: 160 }]}>{pdfText(row.label)}</Text>
              <Text style={[styles.cell, { width: 300 }]}>{pdfText(row.types.join(', '))}</Text>
            </View>
          ))}
          {report.verifikationsserier.cash_account_overrides.length ? (
            <View>
              <Text style={styles.ruleTitle}>Egen serie per bankkonto</Text>
              {report.verifikationsserier.cash_account_overrides.map((o, i) => (
                <Bullet key={`${o.ledger_account}-${i}`} text={`${o.account_name} (${o.ledger_account}): serie ${o.series} ${o.series_label}`} />
              ))}
            </View>
          ) : null}
          <Text style={styles.ruleTitle}>Nummer tilldelade under räkenskapsåret</Text>
          {report.verifikationsserier.sequences.length === 0 ? (
            <Text style={styles.sectionNote}>Inga verifikationsnummer har tilldelats ännu.</Text>
          ) : (
            report.verifikationsserier.sequences.map((q) => <Bullet key={q.series} text={`Serie ${q.series} ${q.series_label}: ${q.series}1 till ${q.series}${q.last_number}`} />)
          )}
          <Text style={styles.ruleTitle}>Så avgörs serien</Text>
          {report.verifikationsserier.ordning.map((o, i) => (
            <Bullet key={i} text={`${i + 1}. ${o}`} />
          ))}
          <Text style={styles.ruleTitle}>Undantag</Text>
          {report.verifikationsserier.undantag.map((u, i) => (
            <Bullet key={i} text={u} />
          ))}
        </Section>

        <Section title="5. Behandlingsregler" note="BFNAR 2013:2 punkt 9.9 och 9.16: regler programmet tillämpar på egen hand. Ändringar registreras med datum i behandlingshistoriken.">
          {report.behandlingsregler.map((r) => (
            <View key={r.rubrik}>
              <Text style={styles.ruleTitle} wrap={false}>
                {pdfText(r.rubrik)}
              </Text>
              <Text style={styles.para}>{pdfText(r.text)}</Text>
            </View>
          ))}
        </Section>

        <Section title="6. Rättelser och låsning" note={`BFL 5 kap. 5 §. Låsdatum: ${report.rattelse_och_las.lock_date ?? 'inget'}${report.rattelse_och_las.auto_lock_period_days != null ? `, flyttas automatiskt ${report.rattelse_och_las.auto_lock_period_days} dagar efter momsperiodens slut` : ''}.`}>
          {report.rattelse_och_las.rules.map((r, i) => (
            <Bullet key={i} text={r} />
          ))}
        </Section>

        <Section title="7. Behörigheter och åtkomst" note={`Läget vid framtagningen; tilldelningar och återkallelser under året finns i behandlingshistoriken. All data är knuten till företaget och isolerad i databasen (Row Level Security). ${report.behorigheter.mfa_required ? 'Inloggning kräver en andra faktor (engångskod eller BankID).' : 'Ingen andra faktor krävs vid inloggning i denna installation.'}`}>
          <Head cols={[{ label: 'Användare', width: 260 }, { label: 'Roll', width: 120 }, { label: 'Sedan', width: 100 }]} />
          {report.behorigheter.members.map((m, i) => (
            <View key={`${m.label}-${i}`} style={styles.row} wrap={false}>
              <Text style={[styles.cell, { width: 260 }]}>{pdfText(m.label)}</Text>
              <Text style={[styles.cell, { width: 120 }]}>{ROLE_LABEL[m.role] ?? m.role}</Text>
              <Text style={[styles.cell, styles.mono, { width: 100 }]}>{m.joined_at.slice(0, 10)}</Text>
            </View>
          ))}
          <Text style={styles.ruleTitle}>API-nycklar och AI-assistenter</Text>
          {report.behorigheter.api_keys.length === 0 ? (
            <Text style={styles.sectionNote}>Inga aktiva API-nycklar.</Text>
          ) : (
            <View>
              <Text style={styles.sectionNote}>
                Aktiva nycklar knutna till detta företag och hållna av dess medlemmar. Åtgärder via nyckel loggas i behandlingshistoriken med nyckeln som utförare.
              </Text>
              <Head cols={[{ label: 'Namn', width: 140 }, { label: 'Innehavare', width: 130 }, { label: 'Behörigheter', width: 170 }, { label: 'Tak utan granskning', width: 70 }]} />
              {report.behorigheter.api_keys.map((k, i) => (
                <View key={`${k.key_prefix}-${i}`} style={styles.row} wrap={false}>
                  <Text style={[styles.cell, { width: 140 }]}>
                    {pdfText(k.name)} <Text style={[styles.mono, styles.muted]}>{k.key_prefix}</Text>
                  </Text>
                  <Text style={[styles.cell, { width: 130 }]}>{pdfText(k.owner_label)}</Text>
                  <Text style={[styles.cell, { width: 170 }]}>{pdfText(k.scopes.length ? k.scopes.join(', ') : 'Endast läsning')}</Text>
                  <Text style={[styles.cell, styles.mono, { width: 70 }]}>{k.unattended_commit_limit != null ? `${NUMBER.format(k.unattended_commit_limit)} kr` : 'inget'}</Text>
                </View>
              ))}
            </View>
          )}
        </Section>

        <Section title="8. Integrationer" note="Anslutna vid framtagningen. System som lämnar eller tar emot uppgifter. Underbiträden och behandlingsplatser framgår av integritetspolicyn.">
          <Head cols={[{ label: 'Integration', width: 190 }, { label: 'Beskrivning', width: 320 }]} />
          {activeIntegrations.map((i) => (
            <View key={i.key} style={styles.row} wrap={false}>
              <Text style={[styles.cell, { width: 190 }]}>{pdfText(i.label)}</Text>
              <Text style={[styles.cell, { width: 320 }]}>{pdfText(i.description)}</Text>
            </View>
          ))}
        </Section>

        <Section title="9. Arkivering och behandlingshistorik" note="BFNAR 2013:2 punkt 8.2, 8.3, 9.12, 9.15 och 9.16.">
          <Bullet text={`Bevarandetid: ${report.arkivering.lagringsregel} (7 kap. 2 § BFL).`} />
          <Bullet text={`Lagring: ${report.arkivering.lagringsplats}, ${report.arkivering.format}. Integritetskontroll: ${report.arkivering.integritetskontroll}.`} />
          <Bullet text="Egen kopia: Importera/Exportera > Exportera > Komplett arkiv ger SIE-filer, rapporter, underlag, register, behandlingshistorik och denna dokumentation som ZIP; förvaras åtskild från originalet." />
          <Bullet text="Utskrift: rapporter tas ut som PDF eller Excel, verifikationer visas på skärm och underlag laddas ner som originalfiler." />
          <Bullet text={report.arkivering.behandlingshistorik} />
          <Bullet text="Företagets arkivplan (var räkenskapsinformationen förvaras, egna rutiner, ansvariga) upprättas av företaget; mall finns under Hjälp." />
        </Section>

        <Section title="Bilaga A. Kontoplan" note={`${report.kontoplan.standard}. Aktiva konton med SRU-kod.`}>
          <Head cols={[{ label: 'Konto', width: 60 }, { label: 'Namn', width: 330 }, { label: 'SRU', width: 60 }]} />
          {report.kontoplan.accounts.map((a) => (
            <View key={a.account_number} style={styles.row} wrap={false}>
              <Text style={[styles.cell, styles.mono, { width: 60 }]}>{a.account_number}</Text>
              <Text style={[styles.cell, { width: 330 }]}>{pdfText(a.account_name)}</Text>
              <Text style={[styles.cell, styles.mono, { width: 60 }]}>{a.sru_code ?? ''}</Text>
            </View>
          ))}
        </Section>

        <View style={styles.footer} fixed>
          <Text style={styles.footerText}>
            {pdfText(`${report.company.name ?? ''}${report.company.org_number ? ` · ${formatOrgNumber(report.company.org_number)}` : ''} · Systemdokumentation ${report.period.name}`)}
          </Text>
          <Text style={styles.footerText} render={({ pageNumber, totalPages }) => `Genererad ${generated} · Sida ${pageNumber} av ${totalPages}`} />
        </View>
      </Page>
    </Document>
  )
}

const CLASS_LABEL: Record<number, string> = {
  1: 'Tillgångar',
  2: 'Eget kapital och skulder',
  3: 'Rörelsens inkomster och intäkter',
  4: 'Utgifter och kostnader för varor, material och vissa köpta tjänster',
  5: 'Övriga externa rörelseutgifter och kostnader',
  6: 'Övriga externa rörelseutgifter och kostnader',
  7: 'Utgifter och kostnader för personal, avskrivningar m.m.',
  8: 'Finansiella och andra inkomster och intäkter samt utgifter och kostnader',
  9: 'Egna konton utanför BAS-strukturen',
}
