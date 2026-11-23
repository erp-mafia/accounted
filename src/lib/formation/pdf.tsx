import { Document, Page, StyleSheet, Text, View } from '@react-pdf/renderer'
import type { DocBlock, FormationDocument } from './document-model'

/**
 * A FormationDocument as a printable A4 PDF. The same layout rules as the
 * report PDFs (lib/reports/systemdokumentation-pdf-template.tsx): the
 * bundled Helvetica (no Font.register, å ä ö are in WinAnsi), the footer
 * `fixed`, every row and signature `wrap={false}`, and no `break` props
 * (they deadlock multi-page renders in @react-pdf/renderer 4).
 */

const INK = '#17140F'
const MUTED = '#6B655C'
const HAIRLINE = '#D9D4CC'

const styles = StyleSheet.create({
  page: { paddingTop: 48, paddingHorizontal: 56, paddingBottom: 64, fontSize: 10, fontFamily: 'Helvetica', color: INK, lineHeight: 1.4 },
  title: { fontSize: 18, fontFamily: 'Helvetica-Bold', lineHeight: 1.2, marginBottom: 8 },
  subtitle: { fontSize: 10, color: MUTED, marginBottom: 20 },
  heading: { fontSize: 11.5, fontFamily: 'Helvetica-Bold', marginTop: 14, marginBottom: 5 },
  para: { marginBottom: 6 },
  muted: { color: MUTED },
  bold: { fontFamily: 'Helvetica-Bold' },
  listRow: { flexDirection: 'row', marginBottom: 3 },
  listMark: { width: 16 },
  listText: { flex: 1 },
  table: { marginTop: 2, marginBottom: 8 },
  th: { flexDirection: 'row', borderBottomWidth: 0.75, borderBottomColor: MUTED, paddingVertical: 3 },
  tr: { flexDirection: 'row', borderBottomWidth: 0.5, borderBottomColor: HAIRLINE, paddingVertical: 3 },
  thText: { fontSize: 8.5, color: MUTED, fontFamily: 'Helvetica-Bold', paddingRight: 6 },
  td: { fontSize: 9.5, paddingRight: 6 },
  fieldRow: { flexDirection: 'row', borderBottomWidth: 0.5, borderBottomColor: HAIRLINE, paddingVertical: 4 },
  fieldLabel: { width: '40%', color: MUTED, paddingRight: 8 },
  fieldValue: { width: '60%' },
  signature: { marginTop: 28, width: 260 },
  signLine: { borderBottomWidth: 0.75, borderBottomColor: INK, height: 22, marginBottom: 4 },
  footer: { position: 'absolute', bottom: 28, left: 56, right: 56, flexDirection: 'row', justifyContent: 'space-between', borderTopWidth: 0.5, borderTopColor: HAIRLINE, paddingTop: 6 },
  footerText: { fontSize: 7.5, color: MUTED },
})

/** WinAnsi only: arrows, the true minus and narrow spaces would drop silently. */
export function pdfText(value: string): string {
  return value
    .replace(/→/g, '->')
    .replace(/−/g, '-')
    .replace(/[   ]/g, ' ')
}

function Block({ block }: { block: DocBlock }) {
  switch (block.kind) {
    case 'heading':
      return (
        <Text style={styles.heading} minPresenceAhead={40}>
          {pdfText(block.text)}
        </Text>
      )
    case 'paragraph':
      return (
        <Text style={[styles.para, ...(block.muted ? [styles.muted] : []), ...(block.bold ? [styles.bold] : [])]}>
          {pdfText(block.text)}
        </Text>
      )
    case 'list':
      return (
        <View style={{ marginBottom: 6 }}>
          {block.items.map((item, i) => (
            <View key={i} style={styles.listRow} wrap={false}>
              <Text style={styles.listMark}>{block.ordered ? `${i + 1}.` : '•'}</Text>
              <Text style={styles.listText}>{pdfText(item)}</Text>
            </View>
          ))}
        </View>
      )
    case 'table': {
      const widths = block.widths && block.widths.length === block.head.length ? block.widths : block.head.map(() => 1)
      const total = widths.reduce((a, b) => a + b, 0)
      const pct = widths.map((w) => `${(w / total) * 100}%`)
      return (
        <View style={styles.table}>
          <View style={styles.th} wrap={false}>
            {block.head.map((h, i) => (
              <Text key={i} style={[styles.thText, { width: pct[i] }]}>
                {pdfText(h)}
              </Text>
            ))}
          </View>
          {block.rows.map((row, r) => (
            <View key={r} style={styles.tr} wrap={false}>
              {row.map((cell, i) => (
                <Text key={i} style={[styles.td, { width: pct[i] }]}>
                  {pdfText(cell)}
                </Text>
              ))}
            </View>
          ))}
        </View>
      )
    }
    case 'fields':
      return (
        <View style={{ marginBottom: 8 }}>
          {block.rows.map((row, i) => (
            <View key={i} style={styles.fieldRow} wrap={false}>
              <Text style={styles.fieldLabel}>{pdfText(row.label)}</Text>
              <Text style={styles.fieldValue}>{pdfText(row.value)}</Text>
            </View>
          ))}
        </View>
      )
    case 'signatures':
      return (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between' }}>
          {block.people.map((p, i) => (
            <View key={i} style={styles.signature} wrap={false}>
              <View style={styles.signLine} />
              <Text style={styles.bold}>{pdfText(p.name)}</Text>
              {p.caption ? <Text style={styles.muted}>{pdfText(p.caption)}</Text> : null}
            </View>
          ))}
        </View>
      )
  }
}

export function FormationPdf({ doc }: { doc: FormationDocument }) {
  return (
    <Document title={pdfText(doc.title)} author="Accounted" creator="Accounted">
      <Page size="A4" style={styles.page}>
        <Text style={styles.title}>{pdfText(doc.title)}</Text>
        {doc.subtitle ? <Text style={styles.subtitle}>{pdfText(doc.subtitle)}</Text> : <View style={{ height: 12 }} />}
        {doc.blocks.map((block, i) => (
          <Block key={i} block={block} />
        ))}
        <View style={styles.footer} fixed>
          <Text style={styles.footerText}>{pdfText(doc.footer ?? doc.title)}</Text>
          <Text style={styles.footerText} render={({ pageNumber, totalPages }) => `${pageNumber} / ${totalPages}`} />
        </View>
      </Page>
    </Document>
  )
}

export async function renderFormationPdf(doc: FormationDocument): Promise<Uint8Array<ArrayBuffer>> {
  const { renderToBuffer } = await import('@react-pdf/renderer')
  const buffer = await renderToBuffer(FormationPdf({ doc }))
  return new Uint8Array(buffer)
}
