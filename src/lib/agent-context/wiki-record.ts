/**
 * A wiki record page, read off gnubok_get_record's answer.
 *
 * The page at /wiki/<kind>/<id> shows the record an agent opens with
 * get_record, from get_record itself (run on the server through the core
 * agent tool registry): no second column list, so the page and the agent
 * read the same fields, links and decision. This module only turns that
 * answer into the page's rows.
 *
 * Kinds: what get_record opens on main. document and journal_entry for every
 * company; agreement, party and fact where the company brain is on (the tool
 * refuses them otherwise). Further kinds (bank rows, customer and supplier
 * invoices, skattekonto rows: accounted MR !1324) slot in by adding them to
 * WIKI_RECORD_KINDS: links already read the `record_ref` that MR returns.
 *
 * Pure: no IO, safe on the client too.
 */

export const WIKI_RECORD_KINDS = ['document', 'journal_entry', 'agreement', 'party', 'fact'] as const
export type WikiRecordKind = (typeof WIKI_RECORD_KINDS)[number]

/** The kinds get_record opens only where the company brain is on (lib/arkiv/flag.ts). */
export const BRAIN_RECORD_KINDS: ReadonlySet<WikiRecordKind> = new Set(['agreement', 'party', 'fact'])

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isWikiRecordKind(kind: string): kind is WikiRecordKind {
  return (WIKI_RECORD_KINDS as readonly string[]).includes(kind)
}

export function isRecordId(id: string): boolean {
  return UUID.test(id)
}

/** The wiki address of a record. */
export function wikiRecordHref(kind: WikiRecordKind, id: string): string {
  return `/wiki/${kind}/${id}`
}

/**
 * The page a linked record opens: its wiki page where the wiki has one, else
 * the record's own page in the app. null when neither exists.
 */
export function linkedRecordHref(kind: string, id: string): string | null {
  if (!UUID.test(id)) return null
  if (isWikiRecordKind(kind)) return wikiRecordHref(kind, id)
  switch (kind) {
    case 'transaction':
    case 'bank_transaction':
      return `/transactions?highlight=${id}`
    case 'invoice':
      return `/invoices/${id}`
    case 'supplier_invoice':
      return `/supplier-invoices/${id}`
    case 'skattekonto_transaction':
      return '/skattekonto'
    default:
      return null
  }
}

/** The record's own page in the app (the verifikat page, the file itself), for the top bar. */
export function nativeRecordHref(kind: WikiRecordKind, id: string): string | null {
  switch (kind) {
    case 'journal_entry':
      return `/bookkeeping/${id}`
    case 'document':
      return `/api/documents/${id}/inline`
    case 'agreement':
      return `/arkiv/avtal/${id}`
    default:
      return null
  }
}

/** "<kind>:<uuid>" to its parts; null for anything else. */
export function parseRecordRef(ref: unknown): { kind: string; id: string } | null {
  if (typeof ref !== 'string') return null
  const at = ref.indexOf(':')
  if (at <= 0) return null
  const kind = ref.slice(0, at)
  const id = ref.slice(at + 1)
  return /^[a-z_]+$/.test(kind) && UUID.test(id) ? { kind, id } : null
}

/** The labelled fields a page shows (sv and en under wiki.record.fields). */
export type RecordFieldLabel =
  | 'voucher'
  | 'entry_date'
  | 'description'
  | 'file_name'
  | 'doc_type'
  | 'received'
  | 'page_count'
  | 'admission_state'
  | 'agreement_kind'
  | 'status'
  | 'counterparty'
  | 'starts_on'
  | 'ends_on'
  | 'amount'
  | 'org_number'
  | 'party_kind'
  | 'predicate'
  | 'value'
  | 'valid_from'

/** Where a field comes from: the books, the archive (the file and what was read from it) or a register. */
export type RecordFieldSource = 'ledger' | 'archive' | 'register'

export interface RecordField {
  label: RecordFieldLabel
  value: string
  source: RecordFieldSource
}

/**
 * Why two records are linked, in the page's words (wiki.record.relations).
 * The link-basis vocabulary (lib/links/link-basis.ts) says how the link was
 * made; this says what the other record is to this one.
 */
export type RecordRelation =
  | 'underlag'
  | 'verifikat'
  | 'bank_row'
  | 'invoice_payment'
  | 'supplier_invoice_payment'
  | 'settlement'
  | 'agreement'
  | 'counterparty'
  | 'source_document'
  | 'document'
  | 'linked'

export interface RecordLink {
  relation: RecordRelation | string
  target_kind: string
  target_id: string | null
  /** A name for the other record where the answer carries one (a file name, a title). */
  label: string | null
  /** How the link was made, as the writer recorded it; null when nothing was recorded. */
  basis: string | null
  href: string | null
  /** A later copy of the same file: counted once. */
  duplicate: boolean
}

/** Who kept the record current: the decision that booked it and the staged operation behind it. */
export interface RecordMaintainer {
  decided_at: string | null
  outcome: string | null
  decided_by: { actor_type: string; label: string | null }
  proposed_by: { actor_type: string; label: string | null; model: string | null; pending_operation_id: string } | null
  agent_reason: string | null
}

export interface WikiRecordView {
  kind: WikiRecordKind
  id: string
  record_ref: string
  /** The page title: the voucher, the file name, the title or name; null when the record carries none. */
  title: string | null
  fields: RecordField[]
  links: RecordLink[]
  maintainer: RecordMaintainer | null
  /** get_record could not read the links (it says so instead of failing the read). */
  links_unavailable: boolean
  native_href: string | null
}

type Json = Record<string, unknown>
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null)
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])

function field(label: RecordFieldLabel, value: unknown, source: RecordFieldSource): RecordField[] {
  if (value === null || value === undefined || value === '') return []
  if (typeof value === 'object') return []
  return [{ label, value: String(value), source }]
}

function link(relation: RecordLink['relation'], kind: string, id: string | null, extra: Partial<RecordLink> = {}): RecordLink {
  return {
    relation,
    target_kind: kind,
    target_id: id,
    label: null,
    basis: null,
    href: id ? linkedRecordHref(kind, id) : null,
    duplicate: false,
    ...extra,
  }
}

/** A link written as a record_ref (brain links, and every record's links once accounted MR !1324 lands). */
function refLink(raw: Json, fallbackRelation: RecordRelation): RecordLink | null {
  const ref = parseRecordRef(raw.record_ref)
  if (!ref) return null
  return link(str(raw.relation) ?? fallbackRelation, ref.kind, ref.id, {
    basis: str(raw.basis),
    label: str(raw.title) ?? str(raw.label),
  })
}

/** journal_entry's compact voucher links (lib/links/voucher-links.ts toCompactLinks). */
function voucherLink(raw: Json): RecordLink | null {
  const basis = str(raw.basis)
  switch (raw.kind) {
    case 'bank_transaction':
      return link('bank_row', 'transaction', str(raw.transaction_id), { basis })
    case 'document':
      return link('underlag', 'document', str(raw.document_id), { basis })
    case 'invoice_payment':
      return link('invoice_payment', 'invoice', str(raw.invoice_id), { basis })
    case 'supplier_invoice_payment':
      return link('supplier_invoice_payment', 'supplier_invoice', str(raw.supplier_invoice_id), { basis })
    case 'ledger_settlement':
      return link('settlement', 'ledger_settlement', null, { basis })
    default:
      return isObject(raw) && raw.record_ref ? refLink(raw, 'linked') : null
  }
}

function maintainerOf(decision: unknown): RecordMaintainer | null {
  if (!isObject(decision) || !isObject(decision.decided_by)) return null
  const proposed = isObject(decision.proposed_by) ? decision.proposed_by : null
  return {
    decided_at: str(decision.decided_at),
    outcome: str(decision.outcome),
    decided_by: { actor_type: str(decision.decided_by.actor_type) ?? 'user', label: str(decision.decided_by.label) },
    proposed_by:
      proposed && str(proposed.pending_operation_id)
        ? {
            actor_type: str(proposed.actor_type) ?? 'agent',
            label: str(proposed.label),
            model: str(proposed.model),
            pending_operation_id: str(proposed.pending_operation_id)!,
          }
        : null,
    agent_reason: str(decision.agent_reason),
  }
}

/** Every link once: the same record named twice (a document and its link row) keeps the one with a basis. */
function dedupe(links: RecordLink[]): RecordLink[] {
  const out: RecordLink[] = []
  for (const l of links) {
    const twin = l.target_id ? out.find((o) => o.target_id === l.target_id && o.target_kind === l.target_kind) : undefined
    if (!twin) {
      out.push(l)
      continue
    }
    twin.basis ??= l.basis
    twin.label ??= l.label
    twin.duplicate ||= l.duplicate
  }
  return out
}

/** Describe get_record's answer for one record. Throws when the answer is not for this kind. */
export function describeRecord(kind: WikiRecordKind, id: string, answer: Json): WikiRecordView {
  const body = answer[kind]
  if (!isObject(body)) throw new Error(`get_record answered no ${kind}`)
  const base = { kind, id, record_ref: `${kind}:${id}`, native_href: nativeRecordHref(kind, id) }

  // Links in the !1324 shape (relation + record_ref) on any kind; read before the kind's own.
  const refLinks = arr(body.links).filter(isObject).flatMap((l) => (l.record_ref ? [refLink(l, 'linked')] : [])).filter((l): l is RecordLink => !!l)

  switch (kind) {
    case 'journal_entry': {
      const documents = arr(body.documents).filter(isObject).map((d) =>
        link('underlag', 'document', str(d.document_id), { label: str(d.file_name), duplicate: !!str(d.duplicate_of) }),
      )
      const compact = arr(body.links).filter(isObject).filter((l) => !l.record_ref).map(voucherLink).filter((l): l is RecordLink => !!l)
      const books = arr(body.books).filter(isObject).map((b) => refLink(b, 'linked')).filter((l): l is RecordLink => !!l)
      return {
        ...base,
        title: str(body.voucher),
        fields: [...field('voucher', body.voucher, 'ledger'), ...field('entry_date', body.entry_date, 'ledger'), ...field('description', body.description, 'ledger')],
        links: dedupe([...documents, ...compact, ...refLinks, ...books]),
        maintainer: maintainerOf(body.decision),
        links_unavailable: body.links_unavailable === true,
      }
    }
    case 'document': {
      const entry = str(body.journal_entry_id)
      const agreement = parseRecordRef(body.agreement_ref)
      return {
        ...base,
        title: str(body.file_name),
        fields: [
          ...field('doc_type', body.doc_type, 'archive'),
          ...field('received', body.created_at, 'archive'),
          ...field('page_count', body.page_count, 'archive'),
          ...field('admission_state', body.admission_state, 'archive'),
        ],
        links: dedupe([
          ...(entry ? [link('verifikat', 'journal_entry', entry)] : []),
          ...refLinks,
          ...(agreement ? [link('agreement', agreement.kind, agreement.id)] : []),
        ]),
        maintainer: null,
        links_unavailable: false,
      }
    }
    case 'agreement': {
      const counterparty = isObject(body.counterparty) ? body.counterparty : {}
      const party = parseRecordRef(counterparty.party_ref)
      const source = parseRecordRef(body.source_document_ref)
      return {
        ...base,
        title: str(body.title),
        fields: [
          ...field('agreement_kind', body.kind, 'archive'),
          ...field('status', body.status, 'archive'),
          ...field('counterparty', str(counterparty.name), 'archive'),
          ...field('starts_on', body.starts_on, 'archive'),
          ...field('ends_on', body.ends_on, 'archive'),
          ...field('amount', body.amount === null || body.amount === undefined ? null : [body.amount, str(body.currency)].filter((x) => x !== null).join(' '), 'archive'),
        ],
        links: dedupe([
          ...(party ? [link('counterparty', party.kind, party.id, { label: str(counterparty.name) })] : []),
          ...(source ? [link('source_document', source.kind, source.id)] : []),
          ...refLinks,
        ]),
        maintainer: null,
        links_unavailable: false,
      }
    }
    case 'party': {
      const documents = arr(body.documents).filter(isObject).map((d) => refLink(d, 'document')).filter((l): l is RecordLink => !!l)
      const agreements = arr(body.agreements).filter(isObject).map((a) => refLink(a, 'agreement')).filter((l): l is RecordLink => !!l)
      return {
        ...base,
        title: str(body.display_name) ?? str(body.legal_name),
        fields: [...field('org_number', body.org_number, 'register'), ...field('party_kind', body.kind, 'register'), ...field('status', body.status, 'register')],
        links: dedupe([...documents, ...agreements, ...refLinks]),
        maintainer: null,
        links_unavailable: false,
      }
    }
    case 'fact': {
      const subject = parseRecordRef(body.subject_ref)
      const value = body.value
      return {
        ...base,
        title: str(body.label) ?? str(body.predicate),
        fields: [
          ...field('predicate', body.predicate, 'archive'),
          ...field('value', typeof value === 'object' && value !== null ? JSON.stringify(value) : value, 'archive'),
          ...field('valid_from', body.valid_from, 'archive'),
          ...field('status', body.status, 'archive'),
        ],
        links: dedupe([
          ...(subject && subject.kind !== 'company' ? [link('linked', subject.kind, subject.id)] : []),
          ...(str(body.source_document_id) ? [link('source_document', 'document', str(body.source_document_id))] : []),
        ]),
        maintainer: null,
        links_unavailable: false,
      }
    }
  }
}
