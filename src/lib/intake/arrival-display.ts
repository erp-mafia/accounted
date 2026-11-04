/**
 * How the Inkorg shows where an underlag came from, read off its arrivals
 * (GET /api/documents/:id/arrivals): the provenance line under the item, the
 * other doors it also came through ("Kom även via ..."), and how to show each
 * original in "Visa originalet".
 *
 * Pure: no React, no fetch, no Node builtins (a client component imports it;
 * only the ArrivalSummary type comes from arrivals.ts, which is server code).
 * Text comes back as keys in the `inbox_arrivals` message namespace plus
 * values, so Swedish and English read from the same decision.
 */
import type { ArrivalSource, ArrivalSummary } from '@/lib/intake/arrivals'

/** A message in the `inbox_arrivals` namespace and the values it takes. */
export interface MessageRef {
  key: string
  values: Record<string, string>
}

export interface ProvenanceOptions {
  /** Formats received_at for the line (the UI passes formatDateLong in the active locale). */
  formatDate: (iso: string) => string
  /** The signed-in user, so an upload of their own reads "Uppladdad av dig". */
  currentUserId?: string | null
  /**
   * The item's channel_context.mail_provider. The arrivals route does not
   * return source_meta (where the hunt keeps the provider), and the item
   * already knows it.
   */
  mailProvider?: string | null
  /**
   * The document the Inkorg previews. An original that is this very file is
   * not offered again under "Visa originalet".
   */
  documentId?: string | null
}

/**
 * Every door with a line and a label of its own. A Record so a door added to
 * ARRIVAL_SOURCES fails the typecheck here until it has its wording.
 */
const SOURCE_IDS: Record<ArrivalSource, true> = {
  intake_email: true,
  mailbox: true,
  whatsapp: true,
  upload: true,
  peppol: true,
  partner_api: true,
  mcp: true,
  migration: true,
  system: true,
  bank_feed: true,
  bank_file: true,
  sie: true,
  billo: true,
  kivra: true,
  paypal: true,
  portal: true,
}

/** The label id for a source: its own id when known, `unknown` otherwise. */
export function sourceLabelId(source: string): ArrivalSource | 'unknown' {
  return Object.prototype.hasOwnProperty.call(SOURCE_IDS, source) ? (source as ArrivalSource) : 'unknown'
}

/** Brand names, the same in both languages. */
const MAIL_PROVIDER_LABEL: Record<string, string> = {
  gmail: 'Gmail',
  microsoft: 'Outlook',
}

/** Doors that deliver a mail: their arrival can show an envelope and text. */
const MAIL_SOURCES = new Set<string>(['intake_email', 'mailbox'])

function str(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function strList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(str).filter((v): v is string => v !== null)
  const one = str(value)
  return one ? [one] : []
}

/**
 * A mail header address split into its display name and address:
 * `"Leverantör AB" <faktura@lev.se>` gives both, a bare address only the
 * address. Anything without an address is kept as the name.
 */
export function parseMailbox(raw: unknown): { name: string | null; address: string | null } {
  const value = str(raw)
  if (!value) return { name: null, address: null }
  const angle = value.match(/^(.*?)<([^<>]+)>\s*$/)
  if (angle) {
    const name = str(angle[1].replace(/^["'\s]+|["'\s]+$/g, ''))
    return { name, address: str(angle[2]) }
  }
  if (/^[^\s@]+@[^\s@]+$/.test(value)) return { name: null, address: value }
  return { name: value.replace(/^["']+|["']+$/g, '') || null, address: null }
}

/** Who a mail is from, as one short label: the display name, else the address. */
export function mailboxLabel(raw: unknown): string | null {
  const { name, address } = parseMailbox(raw)
  return name ?? address
}

/** Oldest first; ties keep the order the route gave. */
export function sortArrivals<T extends Pick<ArrivalSummary, 'received_at'>>(arrivals: readonly T[]): T[] {
  return arrivals
    .map((arrival, index) => ({ arrival, index, at: Date.parse(arrival.received_at) }))
    .sort((a, b) => {
      const at = Number.isNaN(a.at) ? Infinity : a.at
      const bt = Number.isNaN(b.at) ? Infinity : b.at
      return at === bt ? a.index - b.index : at - bt
    })
    .map(({ arrival }) => arrival)
}

/** The first delivery: the one the underlag is shown as having come through. */
export function primaryArrival<T extends Pick<ArrivalSummary, 'received_at'>>(arrivals: readonly T[]): T | null {
  return sortArrivals(arrivals)[0] ?? null
}

/** The short line that says how one arrival came in, ending with its date. */
export function provenanceLine(arrival: ArrivalSummary, opts: ProvenanceOptions): MessageRef {
  const date = opts.formatDate(arrival.received_at)
  const sender = arrival.sender ?? {}
  const fetchedBy = arrival.fetched_by ?? {}
  const line = (variant: string, values: Record<string, string> = {}): MessageRef => ({
    key: `line.${variant}`,
    values: { ...values, date },
  })

  switch (arrival.source) {
    case 'intake_email': {
      const from = mailboxLabel(sender.from)
      return from ? line('intake_email_from', { from }) : line('intake_email')
    }
    case 'mailbox': {
      const provider = opts.mailProvider ? MAIL_PROVIDER_LABEL[opts.mailProvider] : undefined
      return provider ? line('mailbox_provider', { provider }) : line('mailbox')
    }
    case 'whatsapp': {
      const phone = str(sender.phone_masked)
      return phone ? line('whatsapp_from', { phone }) : line('whatsapp')
    }
    case 'peppol': {
      const from = str(sender.name)
      return from ? line('peppol_from', { from }) : line('peppol')
    }
    case 'upload': {
      const userId = str(fetchedBy.user_id)
      return userId && opts.currentUserId && userId === opts.currentUserId ? line('upload_self') : line('upload')
    }
    case 'mcp': {
      const label = str(fetchedBy.label)
      return label ? line('mcp_label', { label }) : line('mcp')
    }
    default:
      return line(sourceLabelId(arrival.source))
  }
}

/**
 * The doors this underlag also came through after the first, each once, in
 * the order they were used. The first door counts again when the same
 * delivery repeated (a supplier mailing the invoice twice): that is worth
 * knowing too.
 */
export function otherDoors(arrivals: readonly ArrivalSummary[]): Array<ArrivalSource | 'unknown'> {
  const doors: Array<ArrivalSource | 'unknown'> = []
  for (const arrival of sortArrivals(arrivals).slice(1)) {
    const id = sourceLabelId(arrival.source)
    if (!doors.includes(id)) doors.push(id)
  }
  return doors
}

// ── Originals ────────────────────────────────────────────────

export type OriginalView =
  | {
      kind: 'mail'
      from: string | null
      to: string[]
      cc: string[]
      subject: string | null
      receivedAt: string
      text: string | null
      /** False when only the envelope and text were kept, never the whole .eml. */
      kept: boolean
      /** Signed download of the .eml; null when not kept or not signable right now. */
      url: string | null
      fileName: string | null
    }
  | {
      kind: 'einvoice'
      senderName: string | null
      endpoint: string | null
      orgNumber: string | null
      receivedAt: string
      url: string | null
      fileName: string | null
    }
  | {
      kind: 'file'
      fileName: string | null
      mime: string | null
      size: number | null
      receivedAt: string
      url: string | null
    }
  | { kind: 'none' }

/** `Text/XML; charset=utf-8` -> `text/xml`. */
export function normaliseMime(mime: string | null | undefined): string | null {
  const base = (mime ?? '').split(';')[0].trim().toLowerCase()
  return base.length > 0 ? base : null
}

function isXmlMime(mime: string | null): boolean {
  return mime === 'application/xml' || mime === 'text/xml' || (!!mime && /^application\/[a-z0-9.+-]+\+xml$/.test(mime))
}

function hasExtension(fileName: string | null, ext: string): boolean {
  return !!fileName && fileName.toLowerCase().endsWith(ext)
}

/**
 * How to show one arrival's original, by what it is: a mail (message/rfc822)
 * as its envelope and text with the .eml to download, an e-invoice (XML) with
 * the XML to open, anything else as the file. A mail whose .eml was never
 * kept (a backfilled one) still shows its envelope and text when the text
 * survived. Nothing to show is `none`: no original and nothing readable.
 */
export function originalViewFor(arrival: ArrivalSummary): OriginalView {
  const mime = normaliseMime(arrival.original_mime)
  const fileName = arrival.original_file_name
  const sender = arrival.sender ?? {}
  const text = typeof arrival.message_text === 'string' && arrival.message_text.trim().length > 0 ? arrival.message_text : null
  const mail = (kept: boolean): OriginalView => ({
    kind: 'mail',
    from: str(sender.from),
    to: strList(sender.to),
    cc: strList(sender.cc),
    subject: str(arrival.subject),
    receivedAt: arrival.received_at,
    text,
    kept,
    url: kept ? arrival.original_url : null,
    fileName: kept ? fileName : null,
  })

  if (arrival.has_original) {
    if (mime === 'message/rfc822' || (mime == null && hasExtension(fileName, '.eml'))) return mail(true)
    if (isXmlMime(mime) || (mime == null && (arrival.source === 'peppol' || hasExtension(fileName, '.xml')))) {
      return {
        kind: 'einvoice',
        senderName: str(sender.name),
        endpoint: str(sender.endpoint),
        orgNumber: str(sender.org_number),
        receivedAt: arrival.received_at,
        url: arrival.original_url,
        fileName,
      }
    }
    return {
      kind: 'file',
      fileName,
      mime,
      size: typeof arrival.original_size === 'number' ? arrival.original_size : null,
      receivedAt: arrival.received_at,
      url: arrival.original_url,
    }
  }
  if (MAIL_SOURCES.has(arrival.source) && text) return mail(false)
  return { kind: 'none' }
}

/**
 * Doors whose arrival points at the document they filed instead of keeping a
 * copy (recordDocumentArrival): an uploaded, MCP or API file is its own
 * original, and the arrival links that document as its attachment.
 */
const SELF_ORIGINAL_DOORS = new Set<string>(['upload', 'mcp', 'partner_api'])

/**
 * Whether an arrival's original is the very file the Inkorg already previews
 * (its original_path is that document's storage path). The summary carries no
 * paths, but the doors that point at a document instead of storing a copy
 * name it in their outputs: an upload, MCP or API file as the `attachment`,
 * a Peppol e-invoice its archived XML as `xml`. A mail's .eml is always a
 * copy of its own.
 *
 * An arrival of an earlier version of the document links that version, so
 * its original (the file as it first came) reads as a different file. When
 * the previewed document is unknown, or a self-original door names no
 * document, the door's original is taken to be what is shown.
 */
export function originalIsPreviewed(arrival: ArrivalSummary, documentId?: string | null): boolean {
  if (!arrival.has_original) return false
  const documents = (arrival.outputs ?? []).filter((output) => output.kind === 'document')
  if (SELF_ORIGINAL_DOORS.has(arrival.source)) {
    const filed = documents.filter((output) => output.role === 'attachment')
    if (!documentId || filed.length === 0) return true
    return filed.some((output) => output.id === documentId)
  }
  if (arrival.source === 'peppol') {
    return !!documentId && documents.some((output) => output.role === 'xml' && output.id === documentId)
  }
  return false
}

/**
 * The arrivals "Visa originalet" has something to show for, first delivery
 * first: an original other than the previewed file, or a mail's text.
 */
export function showableArrivals(arrivals: readonly ArrivalSummary[], documentId?: string | null): ArrivalSummary[] {
  return sortArrivals(arrivals).filter(
    (arrival) => originalViewFor(arrival).kind !== 'none' && !originalIsPreviewed(arrival, documentId),
  )
}

// ── What the delivery said ──────────────────────────────────

/**
 * What the deliveries said in their own words: the short message a partner
 * or an API caller sends with a document (`message` on the delivery, kept as
 * the arrival's message_text, never on the item). A mail's text is its body,
 * shown with the mail under "Visa originalet", so mail doors are left out.
 * Each text once, first delivery first.
 */
export function deliveryNotes(arrivals: readonly ArrivalSummary[]): string[] {
  const notes: string[] = []
  for (const arrival of sortArrivals(arrivals)) {
    if (MAIL_SOURCES.has(arrival.source)) continue
    const text = str(arrival.message_text)
    if (text && !notes.includes(text)) notes.push(text)
  }
  return notes
}

// ── The whole provenance block ───────────────────────────────

export interface ProvenanceDisplay {
  primary: ArrivalSummary
  /** "Mejlad av {from} till inkorgsadressen · {date}" and its siblings. */
  line: MessageRef
  /** The mail subject, shown under the line; null for doors without one. */
  subject: string | null
  /** Label ids (`source.<id>`) for "Kom även via ..."; empty for one arrival. */
  alsoVia: Array<ArrivalSource | 'unknown'>
  /** The messages that came with the deliveries (deliveryNotes); empty for most. */
  notes: string[]
  /** Whether "Visa originalet" has anything to open besides the previewed file. */
  canShowOriginal: boolean
}

/**
 * Everything the provenance block under an Inkorg item needs. Null when no
 * arrival is recorded (items from before arrivals existed): the Inkorg then
 * keeps the provenance it rendered before.
 */
export function provenanceFor(arrivals: readonly ArrivalSummary[], opts: ProvenanceOptions): ProvenanceDisplay | null {
  const primary = primaryArrival(arrivals)
  if (!primary) return null
  return {
    primary,
    line: provenanceLine(primary, opts),
    subject: str(primary.subject),
    alsoVia: otherDoors(arrivals),
    notes: deliveryNotes(arrivals),
    canShowOriginal: showableArrivals(arrivals, opts.documentId).length > 0,
  }
}

/** A file size for people: `4,2 kB`, `1,3 MB`. Null when unknown. */
export function formatOriginalSize(bytes: number | null | undefined, locale: string): string | null {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return null
  const nf = new Intl.NumberFormat(locale === 'en' ? 'en-US' : 'sv-SE', { maximumFractionDigits: 1 })
  if (bytes < 1024) return `${nf.format(bytes)} B`
  if (bytes < 1024 * 1024) return `${nf.format(bytes / 1024)} kB`
  return `${nf.format(bytes / (1024 * 1024))} MB`
}
