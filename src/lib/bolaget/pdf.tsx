import { Document, Page, Text, View, StyleSheet, renderToBuffer } from '@react-pdf/renderer'
import {
  companyLine,
  formatCount,
  formatPct,
  rangeLabel,
  type AktiebokPdfData,
  type AktiebokRow,
  type AktiebrevData,
  type HolderExtractData,
} from './pdf-data'

/**
 * The aktiebok printout (ABL 5:10, 7:28), a holder's extract and an
 * aktiebrev (ABL 6:2), on the react-pdf stack the årsredovisning uses.
 * Swedish only, like every statutory document. Content comes from
 * pdf-data.ts; this file only lays it out.
 */

const styles = StyleSheet.create({
  page: { paddingTop: 40, paddingHorizontal: 36, paddingBottom: 56, fontSize: 8.5, fontFamily: 'Helvetica' },
  header: { flexDirection: 'row', justifyContent: 'space-between', borderBottomWidth: 0.5, borderBottomColor: '#999', paddingBottom: 6, marginBottom: 14, fontSize: 8, color: '#555' },
  title: { fontSize: 18, fontFamily: 'Helvetica-Bold', marginBottom: 4 },
  subtitle: { fontSize: 10, color: '#444', marginBottom: 14 },
  section: { fontSize: 10.5, fontFamily: 'Helvetica-Bold', marginTop: 14, marginBottom: 6 },
  small: { fontSize: 7.5, color: '#555' },
  row: { flexDirection: 'row', borderBottomWidth: 0.25, borderBottomColor: '#ccc', paddingVertical: 3 },
  headRow: { flexDirection: 'row', borderBottomWidth: 0.75, borderBottomColor: '#555', paddingBottom: 3, fontFamily: 'Helvetica-Bold' },
  struck: { color: '#888', textDecoration: 'line-through' },
  footer: { position: 'absolute', bottom: 24, left: 36, right: 36, fontSize: 7, color: '#888', flexDirection: 'row', justifyContent: 'space-between' },
  certificate: { paddingTop: 60, paddingHorizontal: 60, paddingBottom: 60, fontSize: 11, fontFamily: 'Helvetica' },
  certTitle: { fontSize: 26, fontFamily: 'Helvetica-Bold', textAlign: 'center', marginBottom: 6 },
  certSub: { fontSize: 12, textAlign: 'center', marginBottom: 30 },
  certBox: { borderWidth: 1, borderColor: '#333', padding: 18, marginBottom: 18 },
  certLine: { marginBottom: 6 },
  signRow: { flexDirection: 'row', flexWrap: 'wrap', marginTop: 30 },
  signCell: { width: '50%', paddingRight: 20, marginBottom: 26 },
  signLine: { borderTopWidth: 0.5, borderTopColor: '#333', paddingTop: 3 },
})

/** The running header every Bolaget PDF shares (the minutes reuse it). */
export function Header({ left, right }: { left: string; right: string }) {
  return (
    <View style={styles.header} fixed>
      <Text>{left}</Text>
      <Text>{right}</Text>
    </View>
  )
}

/** The running footer with the page count, shared the same way. */
export function Footer({ text }: { text: string }) {
  return (
    <View style={styles.footer} fixed>
      <Text>{text}</Text>
      <Text render={({ pageNumber, totalPages }) => `Sida ${pageNumber} av ${totalPages}`} />
    </View>
  )
}

const COLS = { range: '13%', count: '7%', cls: '5%', holder: '19%', identity: '13%', address: '23%', brev: '10%', notes: '10%' }

function ShareRows({ rows }: { rows: AktiebokRow[] }) {
  return (
    <View>
      <View style={styles.headRow} fixed>
        <Text style={{ width: COLS.range }}>Aktienummer</Text>
        <Text style={{ width: COLS.count, textAlign: 'right', paddingRight: 4 }}>Antal</Text>
        <Text style={{ width: COLS.cls }}>Serie</Text>
        <Text style={{ width: COLS.holder }}>Ägare</Text>
        <Text style={{ width: COLS.identity }}>Person-/orgnr</Text>
        <Text style={{ width: COLS.address }}>Postadress</Text>
        <Text style={{ width: COLS.brev }}>Aktiebrev</Text>
        <Text style={{ width: COLS.notes }}>Anteckningar</Text>
      </View>
      {rows.map((r) => (
        <View key={`${r.range_start}-${r.range_end}`} style={styles.row} wrap={false}>
          <Text style={{ width: COLS.range }}>{rangeLabel(r.range_start, r.range_end)}</Text>
          <Text style={{ width: COLS.count, textAlign: 'right', paddingRight: 4 }}>{formatCount(r.count)}</Text>
          <Text style={{ width: COLS.cls }}>{r.class_code}</Text>
          <Text style={{ width: COLS.holder }}>{r.holder_name}{r.board_flag ? ' *' : ''}</Text>
          <Text style={{ width: COLS.identity }}>{r.identity}</Text>
          <Text style={{ width: COLS.address }}>{r.address}</Text>
          <Text style={{ width: COLS.brev }}>{r.aktiebrev ?? 'Nej'}</Text>
          <Text style={{ width: COLS.notes }}>{r.notes.join('; ')}</Text>
        </View>
      ))}
    </View>
  )
}

function History({ rows }: { rows: AktiebokPdfData['history'] }) {
  return (
    <View>
      <View style={styles.headRow} fixed>
        <Text style={{ width: '6%' }}>Nr</Text>
        <Text style={{ width: '11%' }}>Datum</Text>
        <Text style={{ width: '11%' }}>Införd</Text>
        <Text style={{ width: '72%' }}>Anteckning</Text>
      </View>
      {rows.map((h) => (
        <View key={h.event_number} style={styles.row} wrap={false}>
          <Text style={{ width: '6%' }}>{h.event_number}</Text>
          <Text style={{ width: '11%' }}>{h.event_date}</Text>
          <Text style={{ width: '11%' }}>{h.entered_on}</Text>
          <Text style={[{ width: '72%' }, h.voided ? styles.struck : {}]}>{h.voided ? `${h.text} (rättad)` : h.text}</Text>
        </View>
      ))}
    </View>
  )
}

export function AktiebokPDF({ data }: { data: AktiebokPdfData }) {
  const header = companyLine(data.company)
  return (
    <Document title={`Aktiebok ${data.company.name} ${data.as_of}`} author={data.company.name}>
      <Page size="A4" orientation="landscape" style={styles.page}>
        <Header left={header} right={`Aktiebok per ${data.as_of}`} />
        <Text style={styles.title}>Aktiebok</Text>
        <Text style={styles.subtitle}>
          {header}. Utskrift per {data.as_of} (5 kap. 10 § aktiebolagslagen). Totalt {formatCount(data.total_shares)} aktier och {formatCount(data.total_votes)} röster.
        </Text>

        <Text style={styles.section}>Aktieslag och förbehåll</Text>
        {data.classes.map((c) => (
          <View key={c.code} style={{ marginBottom: 4 }}>
            <Text>
              Serie {c.code}{c.name ? ` (${c.name})` : ''}: {formatCount(c.votes_per_share)} röst{c.votes_per_share === 1 ? '' : 'er'} per aktie.{' '}
              {c.forbehall.length > 0 ? `Förbehåll: ${c.forbehall.join(', ')}.` : 'Inga förbehåll.'}
              {c.bolagsordning_reference ? ` Bolagsordningen ${c.bolagsordning_reference}.` : ''}
            </Text>
            {c.forbehall_text ? <Text style={styles.small}>{c.forbehall_text}</Text> : null}
          </View>
        ))}

        <Text style={styles.section}>Aktier i nummerordning</Text>
        {data.rows.length === 0 ? <Text>Aktieboken har inga aktier per {data.as_of}.</Text> : <ShareRows rows={data.rows} />}
        <Text style={[styles.small, { marginTop: 4 }]}>
          * Styrelseledamot, styrelsesuppleant eller verkställande direktör (8 kap. 45 § aktiebolagslagen).
          {data.full_identity ? '' : ' Personnummer visas maskerade.'}
        </Text>

        <Text style={styles.section}>Ägare</Text>
        <View style={styles.headRow}>
          <Text style={{ width: '34%' }}>Ägare</Text>
          <Text style={{ width: '18%' }}>Person-/orgnr</Text>
          <Text style={{ width: '12%', textAlign: 'right' }}>Aktier</Text>
          <Text style={{ width: '12%', textAlign: 'right' }}>Röster</Text>
          <Text style={{ width: '12%', textAlign: 'right' }}>Kapital %</Text>
          <Text style={{ width: '12%', textAlign: 'right' }}>Röster %</Text>
        </View>
        {data.holders.map((h) => (
          <View key={h.party_id} style={styles.row} wrap={false}>
            <Text style={{ width: '34%' }}>{h.name}{h.board_flag ? ' *' : ''}</Text>
            <Text style={{ width: '18%' }}>{h.identity}</Text>
            <Text style={{ width: '12%', textAlign: 'right' }}>{formatCount(h.shares)}</Text>
            <Text style={{ width: '12%', textAlign: 'right' }}>{formatCount(h.votes)}</Text>
            <Text style={{ width: '12%', textAlign: 'right' }}>{formatPct(h.capital_pct)}</Text>
            <Text style={{ width: '12%', textAlign: 'right' }}>{formatPct(h.votes_pct)}</Text>
          </View>
        ))}

        {data.officer_holdings.length > 0 && (
          <View wrap={false}>
            <Text style={styles.section}>Styrelseledamöters och verkställande direktörens innehav (8 kap. 45 §)</Text>
            {data.officer_holdings.map((o) => (
              <Text key={`${o.name}-${o.roles}`}>
                {o.name}, {o.roles}: {formatCount(o.shares)} aktier
              </Text>
            ))}
          </View>
        )}
        <Footer text={`Utskriven ${data.generated_at}`} />
      </Page>
      <Page size="A4" orientation="landscape" style={styles.page}>
        <Header left={header} right="Aktiebokens historik" />
        <Text style={styles.title}>Historik</Text>
        <Text style={styles.subtitle}>Samtliga daterade anteckningar i införd ordning (5 kap. 9 §). En rättad anteckning står kvar, överstruken.</Text>
        <History rows={data.history} />
        <Footer text={`Utskriven ${data.generated_at}`} />
      </Page>
    </Document>
  )
}

export function HolderExtractPDF({ data }: { data: HolderExtractData }) {
  const header = companyLine(data.company)
  return (
    <Document title={`Utdrag ur aktieboken ${data.holder.name}`} author={data.company.name}>
      <Page size="A4" orientation="landscape" style={styles.page}>
        <Header left={header} right={`Utdrag per ${data.as_of}`} />
        <Text style={styles.title}>Utdrag ur aktieboken</Text>
        <Text style={styles.subtitle}>
          {data.holder.name}{data.holder.identity ? `, ${data.holder.identity}` : ''}{data.holder.address ? `, ${data.holder.address}` : ''}
        </Text>
        <Text>
          Per {data.as_of} äger {data.holder.name} {formatCount(data.shares)} av bolagets {formatCount(data.total_shares)} aktier, {formatPct(data.capital_pct)} % av kapitalet och {formatPct(data.votes_pct)} % av rösterna.
        </Text>
        <Text style={styles.section}>Aktier</Text>
        {data.rows.length === 0 ? <Text>Inga aktier per {data.as_of}.</Text> : <ShareRows rows={data.rows} />}
        <Text style={styles.section}>Anteckningar som rör ägaren</Text>
        <History rows={data.history} />
        <Footer text={`Utskriven ${data.generated_at}`} />
      </Page>
    </Document>
  )
}

export function AktiebrevPDF({ data }: { data: AktiebrevData }) {
  return (
    <Document title={`Aktiebrev nr ${data.number}`} author={data.company.name}>
      <Page size="A4" style={styles.certificate}>
        <Text style={styles.certTitle}>AKTIEBREV</Text>
        <Text style={styles.certSub}>Nr {data.number}</Text>
        <View style={styles.certBox}>
          <Text style={styles.certLine}>Bolag: {companyLine(data.company)}</Text>
          <Text style={styles.certLine}>
            Aktieägare: {data.holder.name}{data.holder.identity ? `, ${data.holder.identity}` : ''}
          </Text>
          <Text style={styles.certLine}>
            Aktier: {formatCount(data.count)} aktie{data.count === 1 ? '' : 'r'} av serie {data.class_code}{data.class_name ? ` (${data.class_name})` : ''}, nummer {rangeLabel(data.range_start, data.range_end)}
          </Text>
          <Text style={styles.certLine}>Utfärdat: {data.issued_on}</Text>
          <Text style={styles.certLine}>
            Förbehåll: {data.forbehall.length > 0 ? data.forbehall.join(', ') : 'Inga'}
          </Text>
          {data.forbehall_text ? <Text style={[styles.small, { marginTop: 4 }]}>{data.forbehall_text}</Text> : null}
        </View>
        <Text>
          Detta aktiebrev har utfärdats enligt 6 kap. aktiebolagslagen. Överlåtelse och pantsättning sker genom överlämnande av aktiebrevet
          (6 kap. 8 §). Den som förvärvat aktierna ska anmäla förvärvet till bolaget för införing i aktieboken.
        </Text>
        <View style={styles.signRow}>
          {(data.signers.length > 0 ? data.signers : [{ name: '', role: 'Styrelsen' }]).map((s, i) => (
            <View key={`${s.name}-${i}`} style={styles.signCell}>
              <View style={styles.signLine}>
                <Text>{s.name}</Text>
                <Text style={styles.small}>{s.role}</Text>
              </View>
            </View>
          ))}
        </View>
        <Text style={styles.small}>För {data.company.name}, styrelsen.</Text>
      </Page>
    </Document>
  )
}

export function renderAktiebokPdf(data: AktiebokPdfData): Promise<Buffer> {
  return renderToBuffer(AktiebokPDF({ data }))
}

export function renderHolderExtractPdf(data: HolderExtractData): Promise<Buffer> {
  return renderToBuffer(HolderExtractPDF({ data }))
}

export function renderAktiebrevPdf(data: AktiebrevData): Promise<Buffer> {
  return renderToBuffer(AktiebrevPDF({ data }))
}
