/**
 * The doors a document, a bank line or a ledger reaches Accounted through,
 * under one name each.
 *
 * Four vocabularies name the door today, each for its own table, and none of
 * them can answer "where did this come from" on its own:
 *
 *   - document_attachments.upload_source (CHECK: camera, file_upload, email,
 *     e_invoice, scan, api, system, whatsapp, mail_hunt). 'api' is written by
 *     the v1 API, both MCP upload tools, the provider migrations (Fortnox,
 *     Bokio, ...) and the bank sync's raw-answer archive alike;
 *   - invoice_inbox_items.source (CHECK: email, upload, whatsapp, mail_hunt,
 *     peppol). 'upload' covers the dashboard, MCP and whatever Arkiv queued;
 *   - invoice_inbox_items.channel_context.channel (whatsapp, mail_hunt, peppol)
 *     and, from this change, channel_context.intake_source: the canonical id
 *     stamped by a writer that knows the door;
 *   - processing_history payload.channel (DocumentIngested and friends: the
 *     inbox source values, plus 'mcp' and 'app' on approvals).
 *
 * The canonical ids below are the one vocabulary the arrivals table uses too,
 * so they are spelled exactly once, here. The mapping functions are pure: a
 * reader that holds the legacy values gets the canonical id without a query.
 * Where a legacy value cannot tell two doors apart, the function says which
 * one it picks and why, and a writer that knows better stamps
 * channel_context.intake_source instead of leaving the reader to guess.
 *
 * Core lib: no extension imports, safe in routes, MCP tools and scripts.
 */
import type { InboxItemSource } from '@/types'

export const INTAKE_SOURCE_IDS = [
  'intake_email',
  'mailbox',
  'whatsapp',
  'upload',
  'peppol',
  'partner_api',
  'mcp',
  'migration',
  'system',
  'bank_feed',
  'bank_file',
  'sie',
  'billo',
  'kivra',
  'paypal',
  'portal',
] as const

export type IntakeSourceId = (typeof INTAKE_SOURCE_IDS)[number]

/** What the door delivers: underlag, bank lines, or bookkeeping history. */
export type IntakeSourceKind = 'document' | 'bank' | 'ledger'

export interface IntakeSource {
  id: IntakeSourceId
  kind: IntakeSourceKind
  /** True when the door is built (it delivers wherever the deployment carries it); false for one that is planned only. */
  live: boolean
  /** next-intl key of the door's name; the same key holds the Swedish (sv.json) and the English (en.json) label. */
  labelKey: `intake_sources.${IntakeSourceId}`
}

const source = (id: IntakeSourceId, kind: IntakeSourceKind, live: boolean): IntakeSource => ({
  id,
  kind,
  live,
  labelKey: `intake_sources.${id}`,
})

/**
 * Every door, keyed by id. `live` says what delivers today:
 *   - intake_email: the company's inbox address (Resend inbound);
 *   - mailbox: the receipt hunt in a connected mailbox (Kvittojakten,
 *     upload_source and inbox source 'mail_hunt'), Gmail or Microsoft alike:
 *     the provider is metadata (channel_context.mail_provider), not a door;
 *   - whatsapp, upload (dashboard, Arkiv drop, camera, scan), peppol (Qvalia
 *     receiving), partner_api (v1), mcp, migration (provider imports),
 *     system (what Accounted produced: invoices, filings, payment files);
 *   - bank_feed (PSD2 sync), bank_file (camt/CSV import), sie (SIE import);
 *   - billo, kivra: the company's digital mailbox, read into the Inkorg
 *     (src/lib/digital-mailboxes). Built, so live; whether a deployment
 *     carries them is runtime config (Accounted's partner credentials and
 *     the per-company rollout, see digitalMailboxAvailability), which the
 *     surfaces that offer the door ask for themselves;
 *   - paypal, portal: named and planned, not wired. Supplier-portal invoices
 *     reach the books today only when a person fetches them and uploads
 *     them, which is the upload door.
 */
export const INTAKE_SOURCES: Readonly<Record<IntakeSourceId, IntakeSource>> = {
  intake_email: source('intake_email', 'document', true),
  mailbox: source('mailbox', 'document', true),
  whatsapp: source('whatsapp', 'document', true),
  upload: source('upload', 'document', true),
  peppol: source('peppol', 'document', true),
  partner_api: source('partner_api', 'document', true),
  mcp: source('mcp', 'document', true),
  migration: source('migration', 'ledger', true),
  system: source('system', 'document', true),
  bank_feed: source('bank_feed', 'bank', true),
  bank_file: source('bank_file', 'bank', true),
  sie: source('sie', 'ledger', true),
  billo: source('billo', 'document', true),
  kivra: source('kivra', 'document', true),
  paypal: source('paypal', 'bank', false),
  portal: source('portal', 'document', false),
}

const ID_SET: ReadonlySet<string> = new Set(INTAKE_SOURCE_IDS)

export function isIntakeSourceId(value: unknown): value is IntakeSourceId {
  return typeof value === 'string' && ID_SET.has(value)
}

// ---------------------------------------------------------------------------
// From the legacy vocabularies
// ---------------------------------------------------------------------------

/** The doors that write upload_source 'api'. */
export type ApiUploadCaller = Extract<IntakeSourceId, 'partner_api' | 'mcp' | 'migration' | 'bank_feed'>

export interface UploadSourceHints {
  /** The door that wrote the row, when the reader knows it (the code path, an inbox item's stamp). Decides 'api'. */
  caller?: ApiUploadCaller | null
  /** The stored file name: the bank sync archives each raw PSD2 answer as psd2-response_*.json. */
  fileName?: string | null
}

const BANK_FEED_ARCHIVE_NAME = /^psd2-response_/

/**
 * document_attachments.upload_source to the canonical door.
 *
 * 'api' names no single door. With a `caller` hint that door wins; a
 * psd2-response_ file is the bank sync's own archive; anything else resolves
 * to partner_api, the honest fallback: 'api' is the value the v1 API stores
 * by name (a v1 client may even send upload_source=api itself), while MCP,
 * the provider migrations and the bank sync are doors that know who they are
 * and say so through `caller` or the inbox stamp. A bare 'api' row therefore
 * over-counts partner_api and never claims mcp without evidence.
 *
 * 'email' is the inbox address's door; a v1 or dashboard client that
 * declared upload_source=email is read the same way, since the column cannot
 * tell them apart. Null for a missing or unknown value.
 */
export function intakeSourceFromUploadSource(
  uploadSource: string | null | undefined,
  hints: UploadSourceHints = {},
): IntakeSourceId | null {
  switch (uploadSource) {
    case 'camera':
    case 'file_upload':
    case 'scan':
      return 'upload'
    case 'email':
      return 'intake_email'
    case 'e_invoice':
      return 'peppol'
    case 'system':
      return 'system'
    case 'whatsapp':
      return 'whatsapp'
    case 'mail_hunt':
      return 'mailbox'
    case 'api':
      if (hints.caller) return hints.caller
      if (hints.fileName && BANK_FEED_ARCHIVE_NAME.test(hints.fileName)) return 'bank_feed'
      return 'partner_api'
    default:
      return null
  }
}

/**
 * invoice_inbox_items.source to the canonical door, from the column alone.
 * 'upload' stays upload here: telling the dashboard from MCP needs the
 * document (intakeSourceForInboxItem).
 */
export function intakeSourceFromInboxSource(source: string | null | undefined): IntakeSourceId | null {
  switch (source) {
    case 'email':
      return 'intake_email'
    case 'upload':
      return 'upload'
    case 'whatsapp':
      return 'whatsapp'
    case 'mail_hunt':
      return 'mailbox'
    case 'peppol':
      return 'peppol'
    default:
      return null
  }
}

/** invoice_inbox_items.channel_context.channel to the canonical door. */
export function intakeSourceFromChannel(channel: string | null | undefined): IntakeSourceId | null {
  switch (channel) {
    case 'whatsapp':
      return 'whatsapp'
    case 'mail_hunt':
      return 'mailbox'
    case 'peppol':
      return 'peppol'
    default:
      return null
  }
}

/**
 * processing_history payload.channel to the canonical door. DocumentIngested
 * and DocumentDuplicateSkipped carry the inbox source values; approvals and
 * BYO extraction carry 'mcp' or 'app'. 'app' is a person acting in the
 * dashboard on something that already arrived, not a door: null.
 */
export function intakeSourceFromProcessingChannel(channel: string | null | undefined): IntakeSourceId | null {
  if (channel === 'mcp') return 'mcp'
  if (channel === 'app') return null
  return intakeSourceFromInboxSource(channel)
}

export interface InboxItemIntakeInput {
  source: string | null | undefined
  channel_context?: { intake_source?: unknown; channel?: unknown } | null
  /** upload_source of the item's document, when the reader fetched it. */
  document_upload_source?: string | null
  /** file_name of the item's document, when the reader fetched it. */
  document_file_name?: string | null
}

/**
 * The door one inbox item came through. In order:
 *   1. channel_context.intake_source, stamped by a writer that knew (Arkiv's
 *      queueing, the MCP upload tools);
 *   2. channel_context.channel (WhatsApp, the receipt hunt, Peppol);
 *   3. the item's source column; for 'upload' the document decides: an
 *      'api' document under an 'upload' item is an MCP upload, since MCP is
 *      the only door that files its own inbox item over an 'api' document (v1,
 *      the provider migrations and the bank sync reach the inbox only through
 *      Arkiv's queueing, which stamps step 1 from this change on; an item it
 *      queued before reads as mcp too). Any other document reads through
 *      intakeSourceFromUploadSource, and an unread document as upload.
 */
export function intakeSourceForInboxItem(item: InboxItemIntakeInput): IntakeSourceId | null {
  const stamped = item.channel_context?.intake_source
  if (isIntakeSourceId(stamped)) return stamped
  const channel = item.channel_context?.channel
  const byChannel = typeof channel === 'string' ? intakeSourceFromChannel(channel) : null
  if (byChannel) return byChannel
  if (item.source !== 'upload') return intakeSourceFromInboxSource(item.source)
  if (item.document_upload_source === 'api') return 'mcp'
  return intakeSourceFromUploadSource(item.document_upload_source, { fileName: item.document_file_name }) ?? 'upload'
}

// ---------------------------------------------------------------------------
// To the legacy vocabulary
// ---------------------------------------------------------------------------

/**
 * The closest value invoice_inbox_items.source allows (its CHECK is
 * unchanged) for a canonical door: the four doors with a column value of
 * their own keep it, every other door is 'upload'. The true door goes in
 * channel_context.intake_source beside it.
 */
export function inboxSourceForIntake(id: IntakeSourceId): InboxItemSource {
  switch (id) {
    case 'intake_email':
      return 'email'
    case 'mailbox':
      return 'mail_hunt'
    case 'whatsapp':
      return 'whatsapp'
    case 'peppol':
      return 'peppol'
    default:
      return 'upload'
  }
}
