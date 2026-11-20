import { Document, Page, Text, View, StyleSheet, renderToBuffer } from '@react-pdf/renderer'
import { Footer, Header } from '../pdf'
import { companyLine, type PdfCompany } from '../pdf-data'
import type { K10OwnerView, K10YearView } from './k10'
import type { SpecialListRow } from './loans-view'

/**
 * The K10 underlag for one delägare and the special list of loans under an
 * exception (ABL 21:10), on the react-pdf stack the aktiebok uses. Swedish
 * only, like every document for Skatteverket or the company's records.
 * Masked identities only: the owner files K10 with their own personnummer.
 */

const styles = StyleSheet.create({
  page: { paddingTop: 40, paddingHorizontal: 40, paddingBottom: 56, fontSize: 9, fontFamily: 'Helvetica' },
  title: { fontSize: 17, fontFamily: 'Helvetica-Bold', marginBottom: 4 },
  subtitle: { fontSize: 10, color: '#444', marginBottom: 12 },
  section: { fontSize: 10.5, fontFamily: 'Helvetica-Bold', marginTop: 12, marginBottom: 5 },
  small: { fontSize: 7.5, color: '#555' },
  row: { flexDirection: 'row', borderBottomWidth: 0.25, borderBottomColor: '#ccc', paddingVertical: 3 },
  strong: { flexDirection: 'row', borderBottomWidth: 0.75, borderBottomColor: '#555', paddingVertical: 3, fontFamily: 'Helvetica-Bold' },
  headRow: { flexDirection: 'row', borderBottomWidth: 0.75, borderBottomColor: '#555', paddingBottom: 3, fontFamily: 'Helvetica-Bold' },
  note: { marginTop: 4, color: '#333' },
})

const SEK = new Intl.NumberFormat('sv-SE', { minimumFractionDigits: 0, maximumFractionDigits: 2 })

function amount(n: number, unit: 'sek' | 'percent'): string {
  const text = SEK.format(n).replace(/ /g, ' ')
  return unit === 'percent' ? `${text} %` : `${text} kr`
}

/** The lines set apart in bold: the totals the K10 carries forward. */
const TOTAL_KEYS = new Set(['wage_space', 'annual_limit', 'total_limit', 'saved_space_carried_forward'])

export interface K10PdfData {
  company: PdfCompany
  year: K10YearView
  owner: K10OwnerView
  generated_at: string
}

export function K10UnderlagPDF({ data }: { data: K10PdfData }) {
  const { owner, year } = data
  const header = companyLine(data.company)
  return (
    <Document title={`Underlag K10 ${year.income_year} ${owner.name}`} author={data.company.name}>
      <Page size="A4" style={styles.page}>
        <Header left={header} right={`Inkomstår ${year.income_year}`} />
        <Text style={styles.title}>Underlag för K10, inkomstår {year.income_year}</Text>
        <Text style={styles.subtitle}>
          {owner.name}{owner.identity ? `, ${owner.identity}` : ''}. Kvalificerade andelar i fåmansföretag (3:12-reglerna efter SFS 2025:1361).
        </Text>
        <Text>
          Bolaget {year.famansforetag.value ? 'är' : 'är inte'} ett fåmansföretag {year.income_year}
          {year.famansforetag.confirmed ? ' (bekräftat)' : ' enligt aktieboken (inte bekräftat)'}. Aktier vid årets ingång: {SEK.format(owner.shares_at_start).replace(/ /g, ' ')} av{' '}
          {SEK.format(year.total_shares_at_start).replace(/ /g, ' ')}.
        </Text>
        <Text style={styles.section}>Beräkning</Text>
        <View style={styles.headRow}>
          <Text style={{ width: '42%' }}>Rad</Text>
          <Text style={{ width: '18%', textAlign: 'right', paddingRight: 8 }}>Belopp</Text>
          <Text style={{ width: '40%' }}>Källa</Text>
        </View>
        {owner.result.lines.map((l) => (
          <View key={l.key} style={TOTAL_KEYS.has(l.key) ? styles.strong : styles.row} wrap={false}>
            <Text style={{ width: '42%' }}>{l.label_sv}</Text>
            <Text style={{ width: '18%', textAlign: 'right', paddingRight: 8 }}>{amount(l.amount, l.unit)}</Text>
            <Text style={{ width: '40%' }}>{l.detail_sv}</Text>
          </View>
        ))}
        {owner.warnings.length > 0 ? (
          <View>
            <Text style={styles.section}>Att kontrollera</Text>
            {owner.warnings.map((w) => (
              <Text key={w.code} style={styles.note}>{w.message_sv}</Text>
            ))}
          </View>
        ) : null}
        <Text style={styles.section}>Om underlaget</Text>
        <Text style={styles.note}>
          Underlaget är beräknat av Accounted ur bolagets aktiebok, utdelningar, lönekörningar och aktieägartillskott, med de belopp du själv har angett.
          Delägaren lämnar blankett K10 till Skatteverket med sin inkomstdeklaration och ansvarar för uppgifterna. Takbeloppet för utdelning som
          beskattas i tjänst gäller per år för all utdelning från fåmansföretag; beräkningen här ser bara det här bolaget.
        </Text>
        <Footer text={`Utskrivet ${data.generated_at}`} />
      </Page>
    </Document>
  )
}

export interface SpecialListPdfData {
  company: PdfCompany
  year: number
  rows: SpecialListRow[]
  generated_at: string
}

export function SpecialListPDF({ data }: { data: SpecialListPdfData }) {
  const header = companyLine(data.company)
  return (
    <Document title={`Särskild förteckning lån ${data.year}`} author={data.company.name}>
      <Page size="A4" orientation="landscape" style={styles.page}>
        <Header left={header} right={`Räkenskapsår ${data.year}`} />
        <Text style={styles.title}>Särskild förteckning över lån och säkerheter, {data.year}</Text>
        <Text style={styles.subtitle}>
          Lån och säkerheter som lämnats med stöd av 21 kap. 2 § första stycket 2 eller dispens enligt 21 kap. 8 § aktiebolagslagen. Förteckningen
          upprättas för varje räkenskapsår och bevaras i tio år (21 kap. 10 §).
        </Text>
        {data.rows.length === 0 ? (
          <Text>Bolaget har inga sådana lån eller säkerheter {data.year}.</Text>
        ) : (
          <View>
            <View style={styles.headRow} fixed>
              <Text style={{ width: '15%' }}>Låntagare</Text>
              <Text style={{ width: '13%' }}>Förhållande</Text>
              <Text style={{ width: '7%' }}>Typ</Text>
              <Text style={{ width: '9%' }}>Lämnat</Text>
              <Text style={{ width: '10%', textAlign: 'right', paddingRight: 6 }}>Belopp</Text>
              <Text style={{ width: '10%', textAlign: 'right', paddingRight: 6 }}>Utestående</Text>
              <Text style={{ width: '6%', textAlign: 'right', paddingRight: 6 }}>Ränta</Text>
              <Text style={{ width: '15%' }}>Grund</Text>
              <Text style={{ width: '15%' }}>Villkor</Text>
            </View>
            {data.rows.map((r) => (
              <View key={r.owner_loan_id} style={styles.row} wrap={false}>
                <Text style={{ width: '15%' }}>{r.party_name}</Text>
                <Text style={{ width: '13%' }}>{r.relation_sv}</Text>
                <Text style={{ width: '7%' }}>{r.kind === 'security' ? 'Säkerhet' : 'Lån'}</Text>
                <Text style={{ width: '9%' }}>{r.start_date}</Text>
                <Text style={{ width: '10%', textAlign: 'right', paddingRight: 6 }}>{amount(r.principal, 'sek')}</Text>
                <Text style={{ width: '10%', textAlign: 'right', paddingRight: 6 }}>{r.status === 'repaid' ? `Återbetalt ${r.repaid_on ?? ''}` : amount(r.outstanding, 'sek')}</Text>
                <Text style={{ width: '6%', textAlign: 'right', paddingRight: 6 }}>{r.interest_rate === null ? '' : amount(r.interest_rate, 'percent')}</Text>
                <Text style={{ width: '15%' }}>{r.exception_sv}{r.exception_note ? `. ${r.exception_note}` : ''}</Text>
                <Text style={{ width: '15%' }}>{r.terms ?? ''}</Text>
              </View>
            ))}
          </View>
        )}
        <Footer text={`Utskriven ${data.generated_at}`} />
      </Page>
    </Document>
  )
}

export function renderK10UnderlagPdf(data: K10PdfData): Promise<Buffer> {
  return renderToBuffer(K10UnderlagPDF({ data }))
}

export function renderSpecialListPdf(data: SpecialListPdfData): Promise<Buffer> {
  return renderToBuffer(SpecialListPDF({ data }))
}
