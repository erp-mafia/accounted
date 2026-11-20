import { Document, Page, Text, View, StyleSheet, renderToBuffer } from '@react-pdf/renderer'
import { Footer, Header } from '../pdf'
import type { MinutesPdfData } from './minutes-pdf-data'

/**
 * The minutes (protokoll) of a meeting on the react-pdf stack the
 * årsredovisning and the aktiebok use. Content comes from
 * minutes-pdf-data.ts; this file only lays it out. Swedish only.
 */

const styles = StyleSheet.create({
  page: { paddingTop: 48, paddingHorizontal: 56, paddingBottom: 64, fontSize: 10, fontFamily: 'Helvetica', lineHeight: 1.4 },
  title: { fontSize: 18, fontFamily: 'Helvetica-Bold', marginBottom: 4 },
  heading: { fontSize: 11, color: '#333', marginBottom: 16 },
  metaRow: { flexDirection: 'row', marginBottom: 2 },
  metaLabel: { width: 110, color: '#555' },
  section: { fontSize: 10.5, fontFamily: 'Helvetica-Bold', marginTop: 14, marginBottom: 4 },
  paragraph: { marginBottom: 10 },
  paragraphTitle: { fontFamily: 'Helvetica-Bold', marginBottom: 2 },
  small: { fontSize: 8.5, color: '#555' },
  signRow: { flexDirection: 'row', flexWrap: 'wrap', marginTop: 28 },
  signCell: { width: '50%', paddingRight: 24, marginBottom: 34 },
  signLine: { borderTopWidth: 0.5, borderTopColor: '#333', paddingTop: 3, marginTop: 28 },
  row: { flexDirection: 'row', borderBottomWidth: 0.25, borderBottomColor: '#ccc', paddingVertical: 3 },
  headRow: { flexDirection: 'row', borderBottomWidth: 0.75, borderBottomColor: '#555', paddingBottom: 3, fontFamily: 'Helvetica-Bold' },
})

export function MinutesPDF({ data }: { data: MinutesPdfData }) {
  return (
    <Document title={`${data.title} ${data.company.name}`} author={data.company.name}>
      <Page size="A4" style={styles.page}>
        <Header left={data.company_line} right={data.title} />
        <Text style={styles.title}>{data.title}</Text>
        <Text style={styles.heading}>{data.heading}</Text>
        {data.meta.map((m) => (
          <View key={m.label} style={styles.metaRow}>
            <Text style={styles.metaLabel}>{m.label}</Text>
            <Text>{m.value}</Text>
          </View>
        ))}
        {data.intro ? <Text style={{ marginTop: 10 }}>{data.intro}</Text> : null}

        {data.present.length > 0 && (
          <View wrap={false}>
            <Text style={styles.section}>Närvarande</Text>
            {data.present.map((p) => (
              <Text key={p}>{p}</Text>
            ))}
          </View>
        )}
        {data.absent.length > 0 && (
          <View wrap={false}>
            <Text style={styles.section}>Frånvarande</Text>
            {data.absent.map((p) => (
              <Text key={p}>{p}</Text>
            ))}
          </View>
        )}

        <Text style={styles.section}>Beslut</Text>
        {data.paragraphs.length === 0 ? <Text>Inga beslut.</Text> : null}
        {data.paragraphs.map((p) => (
          <View key={p.number} style={styles.paragraph} wrap={false}>
            <Text style={styles.paragraphTitle}>
              § {p.number} {p.title}
            </Text>
            {p.text ? <Text>{p.text}</Text> : null}
            {p.votes ? <Text style={styles.small}>{p.votes}</Text> : null}
            {p.reservations ? <Text style={styles.small}>{p.reservations}</Text> : null}
          </View>
        ))}

        <View wrap={false}>
          {data.closing ? <Text style={{ marginTop: 12 }}>{data.closing}</Text> : null}
          <View style={styles.signRow}>
            {(data.signers.length > 0 ? data.signers : [{ name: '', role_label: 'Protokollförare' }]).map((s, i) => (
              <View key={`${s.name}-${i}`} style={styles.signCell}>
                <View style={styles.signLine}>
                  <Text>{s.name}</Text>
                  <Text style={styles.small}>{s.role_label}</Text>
                </View>
              </View>
            ))}
          </View>
        </View>
        <Footer text={`Utskriven ${data.generated_at}`} />
      </Page>

      {data.voting_list && (
        <Page size="A4" style={styles.page}>
          <Header left={data.company_line} right={`${data.title}, bilaga 1`} />
          <Text style={styles.title}>Bilaga 1: Röstlängd</Text>
          <Text style={styles.heading}>
            Enligt aktieboken per {data.voting_list.as_of}: {data.voting_list.total_shares} aktier och {data.voting_list.total_votes} röster. Närvarande eller
            företrädda: {data.voting_list.present_shares} aktier och {data.voting_list.present_votes} röster.
          </Text>
          <View style={styles.headRow} fixed>
            <Text style={{ width: '40%' }}>Aktieägare</Text>
            <Text style={{ width: '14%', textAlign: 'right' }}>Aktier</Text>
            <Text style={{ width: '14%', textAlign: 'right' }}>Röster</Text>
            <Text style={{ width: '12%', textAlign: 'right' }}>Närvarande</Text>
            <Text style={{ width: '20%', paddingLeft: 8 }}>Ombud</Text>
          </View>
          {data.voting_list.rows.map((r, i) => (
            <View key={`${r.name}-${i}`} style={styles.row} wrap={false}>
              <Text style={{ width: '40%' }}>{r.name}</Text>
              <Text style={{ width: '14%', textAlign: 'right' }}>{r.shares}</Text>
              <Text style={{ width: '14%', textAlign: 'right' }}>{r.votes}</Text>
              <Text style={{ width: '12%', textAlign: 'right' }}>{r.present}</Text>
              <Text style={{ width: '20%', paddingLeft: 8 }}>{r.proxy}</Text>
            </View>
          ))}
          {data.aktiebok_appendix ? (
            <Text style={[styles.small, { marginTop: 12 }]}>
              Bilaga 2: aktieboken per stämmodagen, som hölls tillgänglig vid stämman (7 kap. 28 § aktiebolagslagen).
            </Text>
          ) : null}
          <Footer text={`Utskriven ${data.generated_at}`} />
        </Page>
      )}
    </Document>
  )
}

export function renderMinutesPdf(data: MinutesPdfData): Promise<Buffer> {
  return renderToBuffer(MinutesPDF({ data }))
}
