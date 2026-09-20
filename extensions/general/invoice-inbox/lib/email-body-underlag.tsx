import { Document, Page, Text, View, StyleSheet, renderToBuffer } from '@react-pdf/renderer'
import { AFRelationship, PDFDocument } from 'pdf-lib'
import { htmlToText } from './extract-invoice-fields'
import { sanitiseFilename } from './upload-and-extract'

/**
 * A receipt that IS the mail body (#2751).
 *
 * App-store, SaaS and travel receipts arrive with no attachment: the body is
 * the underlag. This module turns such a mail into one archived PDF: a header
 * block (from, to, subject, received at, message id) and the body text, with
 * the received form (the HTML and/or text part, byte for byte) embedded in the
 * same PDF as file attachments. One WORM document then carries both the
 * readable rendering and the original: BFL 7 kap 2 § (material received from
 * someone else is kept in the form it had on arrival) and 7 kap 6 § (a
 * transfer to another form must not lose räkenskapsinformation) are satisfied
 * by the same SHA-256.
 *
 * Swedish-only on purpose: underlag is räkenskapsinformation, the same
 * stays-Swedish surface class as invoice PDFs and the webshop orderunderlag.
 */

/**
 * Inline images at or under this size are signature logos, tracking pixels and
 * mail-client decorations, never a receipt: a phone photo is megabytes and a
 * screenshot of a receipt is well above this. They are what turned a
 * forwarded body-receipt into "logo filed, body ignored" (#2751): Resend lists
 * them as attachments, so the mail took the attachment path.
 */
export const SIGNATURE_IMAGE_MAX_BYTES = 64 * 1024

/**
 * A mail that carries signature images is filed by its body only when the
 * body has this much text: below it the mail is a note ("Skickat från min
 * iPhone") and there is nothing worth archiving. Counted without whitespace:
 * a forwarded receipt clears it on the forward header (about 130) alone, a
 * note with a short signature does not.
 */
export const SUBSTANTIVE_BODY_MIN_CHARS = 120

/** Rendering budget; the embedded original keeps the rest. */
export const MAX_RENDERED_BODY_CHARS = 200_000

/** The fields of a Resend or mailparser attachment the classification needs. */
export interface InboundAttachmentShape {
  content_type?: string | null
  content_disposition?: string | null
  content_id?: string | null
  size?: number | null
}

export function isSignatureImage(att: InboundAttachmentShape): boolean {
  const type = (att.content_type ?? '').toLowerCase().trim()
  if (!type.startsWith('image/')) return false
  const disposition = (att.content_disposition ?? '').toLowerCase().trim()
  // Resend leaves the raw header value unnormalised; mailparser lowercases.
  // A missing disposition with a content id is an inline part in practice.
  const inline = disposition.startsWith('inline') || (disposition === '' && !!att.content_id)
  if (!inline) return false
  // Size unknown: it may be a photo; keep it as a document.
  return typeof att.size === 'number' && att.size >= 0 && att.size <= SIGNATURE_IMAGE_MAX_BYTES
}

/**
 * The readable text of a mail body. The sender's own text part is used when
 * it is a complete rendering (mail clients generate it from the same HTML
 * with a better engine than ours); a stub ("This mail requires HTML") loses
 * to the flattened HTML part. Line endings normalised, outer whitespace
 * trimmed.
 */
export function emailBodyToText(html: string | null | undefined, text: string | null | undefined): string {
  const fromHtml = html?.trim() ? htmlToText(html, MAX_RENDERED_BODY_CHARS) : ''
  const fromText = (text ?? '').replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n').trim().slice(0, MAX_RENDERED_BODY_CHARS)
  if (!fromHtml) return fromText
  if (!fromText) return fromHtml
  const compact = (s: string) => s.replace(/\s+/g, '').length
  return compact(fromText) * 2 >= compact(fromHtml) ? fromText : fromHtml
}

export function isSubstantiveBody(text: string): boolean {
  return text.replace(/\s+/g, '').length >= SUBSTANTIVE_BODY_MIN_CHARS
}

// ── Text made safe for a standard PDF font ─────────────────────
//
// The rendering uses Helvetica (WinAnsi): a code point outside its table is
// emitted as an unmapped byte and the viewer draws nothing (see
// lib/pdf/number-text.ts). Mail bodies carry all of Unicode, so the text is
// mapped before it reaches a <Text>: spaces and dashes to their ASCII
// equivalents, invisible characters dropped, emoji and dingbats dropped
// (decoration), anything else unrepresentable shown as '?' so a lost glyph is
// visible instead of silent. The embedded original keeps the exact text.

const WINANSI_EXTRA = new Set<number>([
  0x20ac, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039, 0x0152,
  0x017d, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a,
  0x0153, 0x017e, 0x0178,
])

function isWinAnsi(code: number): boolean {
  if (code >= 0x20 && code <= 0x7e) return true
  if (code >= 0xa0 && code <= 0xff) return true
  return WINANSI_EXTRA.has(code)
}

function isDroppedSymbol(code: number): boolean {
  return (
    (code >= 0x1f000 && code <= 0x1faff) || // emoji blocks
    (code >= 0x2600 && code <= 0x27bf) || // misc symbols, dingbats
    (code >= 0x2b00 && code <= 0x2bff) || // misc symbols and arrows
    code === 0xfe0f || code === 0xfe0e || // variation selectors
    (code >= 0x1f3fb && code <= 0x1f3ff) || // skin tone modifiers
    code === 0x200d // zero width joiner (emoji sequences)
  )
}

export function pdfSafeText(text: string): string {
  let out = ''
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0
    if (ch === '\n' || ch === '\t') {
      out += ch === '\t' ? '    ' : ch
    } else if (code === 0x200b || code === 0x200c || code === 0x200e || code === 0x200f || code === 0x2060 || code === 0xfeff || code === 0xad) {
      // zero-width characters and soft hyphens (U+00AD sits inside Latin-1,
      // so this runs before the WinAnsi check)
    } else if (isWinAnsi(code)) {
      out += ch
    } else if ((code >= 0x2000 && code <= 0x200a) || code === 0x202f || code === 0x205f || code === 0x3000) {
      out += ' '
    } else if (code === 0x2212 || code === 0x2010 || code === 0x2011 || code === 0x2015) {
      out += '-'
    } else if (isDroppedSymbol(code)) {
      // decoration
    } else if (code < 0x20) {
      // control characters (CR already folded into LF by the caller)
    } else {
      out += '?'
    }
  }
  return out
}

// ── Model ───────────────────────────────────────────────────────

export interface EmailBodyUnderlagInput {
  from: string | null | undefined
  to: string[] | string | null | undefined
  subject: string | null | undefined
  /** ISO timestamp of receipt. */
  receivedAt: string | null | undefined
  messageId: string | null | undefined
  html: string | null | undefined
  text: string | null | undefined
}

/** Everything the PDF renders, precomputed so it is testable without react-pdf. */
export interface EmailBodyUnderlagModel {
  from: string
  to: string
  subject: string
  receivedAt: string
  messageId: string
  /** One entry per line of the body; '' is a blank line. */
  lines: string[]
  truncated: boolean
  /** The original parts the PDF embeds. */
  originals: Array<{ name: string; mimeType: string; bytes: Uint8Array }>
}

const HEADER_VALUE_MAX = 500

function formatReceivedAt(iso: string | null | undefined): string {
  if (!iso) return ''
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso.slice(0, HEADER_VALUE_MAX)
  const parts = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Europe/Stockholm',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date)
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? ''
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`
}

function headerValue(value: string | null | undefined): string {
  return pdfSafeText((value ?? '').replace(/\s+/g, ' ').trim()).slice(0, HEADER_VALUE_MAX)
}

/**
 * Build the render model, or null when the mail has no body worth archiving.
 * `requireSubstantive` is the signature-image rule: set when the mail carried
 * inline images that were classified as decoration, so a trivial note does
 * not become a PDF underlag on their account.
 */
export function buildEmailBodyUnderlagModel(
  input: EmailBodyUnderlagInput,
  opts: { requireSubstantive?: boolean } = {},
): EmailBodyUnderlagModel | null {
  const text = emailBodyToText(input.html, input.text)
  if (!text) return null
  if (opts.requireSubstantive && !isSubstantiveBody(text)) return null

  const safe = pdfSafeText(text)
  const truncated =
    (input.html?.trim().length ?? 0) > MAX_RENDERED_BODY_CHARS ||
    (input.text?.trim().length ?? 0) > MAX_RENDERED_BODY_CHARS
  const lines = safe.split('\n').map((line) => line.trimEnd())
  // Collapse runs of blank lines: the text is rendered line by line.
  const collapsed: string[] = []
  for (const line of lines) {
    if (line === '' && collapsed[collapsed.length - 1] === '') continue
    collapsed.push(line)
  }

  const encoder = new TextEncoder()
  const originals: EmailBodyUnderlagModel['originals'] = []
  if (input.html?.trim()) {
    originals.push({ name: 'original.html', mimeType: 'text/html', bytes: encoder.encode(input.html) })
  }
  if (input.text?.trim()) {
    originals.push({ name: 'original.txt', mimeType: 'text/plain', bytes: encoder.encode(input.text) })
  }

  const to = Array.isArray(input.to) ? input.to.join(', ') : (input.to ?? '')
  return {
    from: headerValue(input.from),
    to: headerValue(to),
    subject: headerValue(input.subject) || '(inget ämne)',
    receivedAt: formatReceivedAt(input.receivedAt),
    messageId: headerValue(input.messageId),
    lines: collapsed,
    truncated,
    originals,
  }
}

/**
 * Sanitised-enough name; uploadDocument sanitises the storage key itself.
 * Slashes are folded first: sanitiseFilename takes the basename, which would
 * keep only what follows the last "/" of a subject.
 */
export function emailBodyUnderlagFilename(subject: string | null | undefined): string {
  const flat = (subject ?? '').replace(/[\\/]+/g, ' ')
  return `mail-${sanitiseFilename(flat, 'meddelande')}.pdf`
}

// ── PDF ─────────────────────────────────────────────────────────

// Built on first render, not at import. The extension registry imports this
// module into every route that loads extensions, and many route tests mock
// '@react-pdf/renderer' with renderToBuffer only: a top-level StyleSheet.create
// made those files fail to load.
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

export interface RenderedEmailBodyUnderlag {
  name: string
  buffer: ArrayBuffer
  type: 'application/pdf'
}

/**
 * Render the body as a PDF and embed the received parts inside it. Returns
 * null when there is no body to archive (the caller keeps its error row).
 */
export async function renderEmailBodyUnderlag(
  input: EmailBodyUnderlagInput,
  opts: { requireSubstantive?: boolean; generatedAt?: string } = {},
): Promise<RenderedEmailBodyUnderlag | null> {
  const model = buildEmailBodyUnderlagModel(input, opts)
  if (!model) return null

  const generatedAt = opts.generatedAt ?? new Date().toISOString().split('T')[0]
  const rendered = await renderToBuffer(<EmailBodyUnderlagPDF model={model} generatedAt={generatedAt} />)

  const pdf = await PDFDocument.load(rendered, { updateMetadata: false })
  const received = input.receivedAt ? new Date(input.receivedAt) : new Date()
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
  const bytes = await pdf.save()
  // Copy into a fresh ArrayBuffer: Uint8Array.buffer is ArrayBufferLike
  // (possibly SharedArrayBuffer-backed) and may span more than the view.
  const out = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(out).set(bytes)
  return { name: emailBodyUnderlagFilename(input.subject), buffer: out, type: 'application/pdf' }
}
