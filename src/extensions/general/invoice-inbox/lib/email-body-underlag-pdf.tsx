import { Document, Page, Text, View, StyleSheet, renderToBuffer } from '@react-pdf/renderer'
import { AFRelationship, PDFDocument } from 'pdf-lib'
import type { EmailBodyUnderlagModel } from './email-body-underlag'

/**
 * The PDF half of email-body-underlag.tsx, split out so the extension registry
 * (imported into every route) does not load react-pdf and pdf-lib; the model
 * and the classification helpers stay there.
 */

// Built on first render, not at import: many route tests mock
// '@react-pdf/renderer' with renderToBuffer only, and a top-level
// StyleSheet.create made those files fail to load.
function buildStyles() {
  return StyleSheet.create({
    page: {
      paddingTop: 40,
      paddingHorizontal: 44,
      paddingBottom: 56,
      fontSize: 9.5,
      fontFamily: 'Helvetica',
      color: '#1a1a1a',
    },
    title: {
      fontSize: 14,
      fontWeight: 'bold',
      marginBottom: 10,
    },
    headerBlock: {
      borderBottomWidth: 1,
      borderBottomColor: '#d4d4d4',
      paddingBottom: 10,
      marginBottom: 14,
    },
    headerRow: {
      flexDirection: 'row',
      marginBottom: 2,
    },
    headerLabel: {
      width: 72,
      fontSize: 7.5,
      fontWeight: 'bold',
      color: '#666',
      textTransform: 'uppercase',
      paddingTop: 1,
    },
    headerValue: {
      flex: 1,
      fontSize: 9,
    },
    // Tight on purpose: a long receipt should not spill onto more pages than
    // the extraction page budget reads (maxPagesForAutoExtract).
    line: {
      lineHeight: 1.1,
    },
    blank: {
      height: 5,
    },
    footer: {
      position: 'absolute',
      bottom: 24,
      left: 44,
      right: 44,
      flexDirection: 'row',
      justifyContent: 'space-between',
      fontSize: 7.5,
      color: '#888',
    },
  })
}

let cachedStyles: ReturnType<typeof buildStyles> | null = null
function getStyles(): ReturnType<typeof buildStyles> {
  return (cachedStyles ??= buildStyles())
}

function HeaderRow({ label, value }: { label: string; value: string }) {
  if (!value) return null
  const styles = getStyles()
  return (
    <View style={styles.headerRow}>
      <Text style={styles.headerLabel}>{label}</Text>
      <Text style={styles.headerValue}>{value}</Text>
    </View>
  )
}

export function EmailBodyUnderlagPDF({ model, generatedAt }: { model: EmailBodyUnderlagModel; generatedAt: string }) {
  const styles = getStyles()
  return (
    <Document
      title={model.subject}
      subject="E-postmeddelande sparat som underlag"
      keywords={model.messageId}
      creator="Accounted"
      producer="Accounted"
    >
      <Page size="A4" style={styles.page}>
        <Text style={styles.title}>E-postmeddelande sparat som underlag</Text>
        <View style={styles.headerBlock}>
          <HeaderRow label="Från" value={model.from} />
          <HeaderRow label="Till" value={model.to} />
          <HeaderRow label="Ämne" value={model.subject} />
          <HeaderRow label="Mottaget" value={model.receivedAt} />
          <HeaderRow label="Message-ID" value={model.messageId} />
        </View>
        <View>
          {model.lines.map((line, i) =>
            line === '' ? <View key={i} style={styles.blank} /> : <Text key={i} style={styles.line}>{line}</Text>,
          )}
          {model.truncated && (
            <Text style={styles.line}>[Texten är förkortad. Hela meddelandet finns inbäddat i denna PDF.]</Text>
          )}
        </View>
        <View style={styles.footer} fixed>
          <Text>Återgivning av mejltexten. Originalet i mottagen form ligger inbäddat i denna PDF.</Text>
          <Text render={({ pageNumber, totalPages }) => `Skapad ${generatedAt} · Sida ${pageNumber} av ${totalPages}`} />
        </View>
      </Page>
    </Document>
  )
}

/**
 * Render the model and embed the received parts inside the PDF. Returns the
 * saved PDF bytes.
 */
export async function renderEmailBodyUnderlagPdf(
  model: EmailBodyUnderlagModel,
  generatedAt: string,
  receivedAt: string | null | undefined,
): Promise<Uint8Array> {
  const rendered = await renderToBuffer(<EmailBodyUnderlagPDF model={model} generatedAt={generatedAt} />)

  const pdf = await PDFDocument.load(rendered, { updateMetadata: false })
  const received = receivedAt ? new Date(receivedAt) : new Date()
  const stamp = Number.isNaN(received.getTime()) ? new Date() : received
  for (const original of model.originals) {
    await pdf.attach(original.bytes, original.name, {
      mimeType: original.mimeType,
      description: `Mottaget e-postmeddelande i ursprunglig form (Message-ID: ${model.messageId || 'saknas'})`,
      creationDate: stamp,
      modificationDate: stamp,
      afRelationship: AFRelationship.Source,
    })
  }
  return pdf.save()
}
