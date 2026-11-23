/**
 * Arrivals: one row per delivery into a company, whatever the door.
 *
 * An arrival says HOW something came in (the mail, the chat message, the
 * e-invoice, the upload) and keeps the original exactly as it came: the whole
 * mail as .eml, the provider's JSON, the XML. arrival_outputs links it to what
 * it produced (documents, inbox items, transactions, journal entries), so the
 * Inkorg can show "Visa originalet" and "Kom även via" and an agent can read
 * everything the company received.
 *
 * Every function here is best effort and never throws: a door that fails to
 * record its arrival must still file the underlag. Failures are logged.
 *
 * Tables: supabase/migrations/20261016051000_intake_arrivals.sql (append-only,
 * idempotent on company + source + source_ref).
 */
import { createHash, randomUUID } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createLogger } from '@/lib/logger'
import type { CommitActor } from '@/lib/bookkeeping/actor-context'
import { INTAKE_SOURCE_IDS, isIntakeSourceId, type IntakeSourceId } from '@/lib/intake/sources'
import { isCompanyFolderDocumentKey, isDocumentKeyOfCompany } from '@/lib/core/documents/storage-key'

const log = createLogger('intake/arrivals')

/**
 * The canonical door ids, spelled once in src/lib/intake/sources.ts. The
 * column is unconstrained in SQL, so the list is the contract.
 */
export const ARRIVAL_SOURCES = INTAKE_SOURCE_IDS
export type ArrivalSource = IntakeSourceId

export const isArrivalSource: (value: unknown) => value is ArrivalSource = isIntakeSourceId

/**
 * Who fetched the delivery. Shaped to become the formal actor record later
 * (another track builds it): keep the keys, add none ad hoc.
 */
export type ArrivalActorType = 'user' | 'api_key' | 'mcp_oauth' | 'service_account' | 'cron' | 'system' | 'webhook'
export interface ArrivalActor {
  type: ArrivalActorType
  /** The person; for a service account its sponsor, the person it acts for. */
  user_id?: string
  api_key_id?: string
  /** The service account whose key delivered (lib/service-accounts). */
  service_account_id?: string
  label?: string
}

/**
 * Who delivered through a key (the v1 doors): a service account's key is the
 * account, labelled with its name, as the commit actor records it; any other
 * key is the key.
 */
export function apiKeyArrivalActor(key: {
  userId: string
  apiKeyId?: string | null
  actor: Pick<CommitActor, 'type' | 'label'>
  serviceAccount?: { id: string } | null
}): ArrivalActor {
  const keyId = key.apiKeyId ? { api_key_id: key.apiKeyId } : {}
  const label = key.actor.label ? { label: key.actor.label } : {}
  if (key.serviceAccount) {
    return { type: 'service_account', user_id: key.userId, ...keyId, service_account_id: key.serviceAccount.id, ...label }
  }
  return { type: key.actor.type === 'mcp_oauth' ? 'mcp_oauth' : 'api_key', user_id: key.userId, ...keyId, ...label }
}

export type ArrivalOutputKind = 'document' | 'inbox_item' | 'transaction' | 'journal_entry'
export type ArrivalOutputRole = 'attachment' | 'body' | 'xml' | 'rendering' | 'row' | 'entry'

export interface ArrivalRow {
  id: string
  company_id: string
  source: string
  source_ref: string
  received_at: string
  sender: Record<string, unknown>
  subject: string | null
  message_text: string | null
  original_path: string | null
  original_sha256: string | null
  original_mime: string | null
  original_size: number | null
  fetched_by: Record<string, unknown>
  source_meta: Record<string, unknown>
  created_at: string
}


/** Bytes to keep as the original, stored under the arrival's own key. */
export interface ArrivalOriginalBytes {
  bytes: ArrayBuffer | Uint8Array
  filename: string
  mime: string
}

/**
 * An original that is already archived: in the documents bucket (a Peppol
 * XML, an uploaded file, a bank file) or in the SIE import's own archive.
 */
export interface ArrivalOriginalRef {
  path: string
  /**
   * The bucket holding the bytes, documents by default. Another one is kept
   * in source_meta.original_bucket, so a reader signs the right object.
   */
  bucket?: ArrivalOriginalBucket
  sha256?: string | null
  mime?: string | null
  size?: number | null
}

export interface RecordArrivalInput {
  companyId: string
  source: ArrivalSource
  sourceRef: string
  receivedAt: string | Date
  sender?: Record<string, unknown>
  subject?: string | null
  messageText?: string | null
  fetchedBy: ArrivalActor
  sourceMeta?: Record<string, unknown>
  /**
   * The original's bytes, or a function that fetches them. The function runs
   * only for a new arrival, so a redelivered webhook never downloads twice.
   */
  original?: ArrivalOriginalBytes | (() => Promise<ArrivalOriginalBytes | null>)
  /** Point at bytes already archived instead of storing them twice. Wins over `original`. */
  originalRef?: ArrivalOriginalRef
}

export interface RecordArrivalResult {
  arrival: ArrivalRow
  /** False when the arrival was already recorded (a redelivery or a re-run). */
  created: boolean
}

export interface ArrivalOutputInput {
  kind: ArrivalOutputKind
  id: string
  role: ArrivalOutputRole
  position?: number
}

export const DOCUMENTS_BUCKET = 'documents'
const DOCUMENTS_PATH_ROOT = 'documents'

/**
 * Where an original may sit. An SIE import keeps its file in sie-files (keys
 * `<companyId>/...`); pointing at it there instead of copying it into
 * documents keeps one copy of a file of up to 50 MB.
 */
export const SIE_FILES_BUCKET = 'sie-files'
export const ARRIVAL_ORIGINAL_BUCKETS = [DOCUMENTS_BUCKET, SIE_FILES_BUCKET] as const
export type ArrivalOriginalBucket = (typeof ARRIVAL_ORIGINAL_BUCKETS)[number]

/** message_text is for reading and search; the original holds the rest. */
export const MAX_MESSAGE_TEXT_CHARS = 100_000
const MAX_SUBJECT_CHARS = 1_000
const MAX_JSON_STRING_CHARS = 4_000
const MAX_SOURCE_REF_CHARS = 512

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const SHA256_RE = /^[0-9a-f]{64}$/

// Postgres text and jsonb both refuse U+0000; mail bodies do carry it.
// eslint-disable-next-line no-control-regex
const NUL_RE = /\u0000/g

function cleanText(value: string | null | undefined, max: number): string | null {
  if (value == null) return null
  const cleaned = value.replace(NUL_RE, '')
  if (cleaned.length === 0) return null
  return cleaned.length > max ? cleaned.slice(0, max) : cleaned
}

/** A jsonb-safe copy: no NUL characters, long strings capped, no undefined. */
export function sanitiseArrivalJson(value: unknown, depth = 0): unknown {
  if (value == null) return null
  if (typeof value === 'string') return cleanText(value, MAX_JSON_STRING_CHARS) ?? ''
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'boolean') return value
  if (depth > 6) return null
  if (Array.isArray(value)) return value.slice(0, 200).map((v) => sanitiseArrivalJson(v, depth + 1))
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      if (v === undefined) continue
      out[key.replace(NUL_RE, '').slice(0, 200)] = sanitiseArrivalJson(v, depth + 1)
    }
    return out
  }
  return null
}

function jsonObject(value: Record<string, unknown> | undefined): Record<string, unknown> {
  return (sanitiseArrivalJson(value ?? {}) as Record<string, unknown> | null) ?? {}
}

/** Storage-safe file name: the original's own name, made into one plain path segment. */
export function safeArrivalFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? ''
  const dot = base.lastIndexOf('.')
  const stem = (dot > 0 ? base.slice(0, dot) : base)
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^[_.]+|_+$/g, '')
    .slice(0, 100)
  const ext = dot > 0 ? base.slice(dot).replace(/[^a-zA-Z0-9.]/g, '_').slice(0, 20) : ''
  return (stem || 'original') + ext
}

/**
 * Storage key of an arrival's original. Under the company folder of the
 * documents bucket, so the bucket's company-scoped policies cover it and the
 * WORM rules (no DELETE policy) apply as they do to the underlag.
 */
export function buildArrivalOriginalPath(companyId: string, arrivalId: string, fileName: string): string {
  return `${DOCUMENTS_PATH_ROOT}/${companyId}/arrivals/${arrivalId}/${safeArrivalFileName(fileName)}`
}

function toArrayBuffer(bytes: ArrayBuffer | Uint8Array): ArrayBuffer {
  if (bytes instanceof ArrayBuffer) return bytes
  const out = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(out).set(bytes)
  return out
}

function sha256Hex(buffer: ArrayBuffer): string {
  return createHash('sha256').update(new Uint8Array(buffer)).digest('hex')
}

/**
 * Upload an original's bytes under the arrival's key and describe them. The
 * arrival row is written afterwards with these fields in the same insert:
 * the row is append-only, so nothing is filled in later.
 */
export async function storeArrivalOriginal(
  supabase: SupabaseClient,
  params: { companyId: string; arrivalId: string } & ArrivalOriginalBytes,
): Promise<{ path: string; sha256: string; mime: string; size: number } | null> {
  try {
    const buffer = toArrayBuffer(params.bytes)
    const path = buildArrivalOriginalPath(params.companyId, params.arrivalId, params.filename)
    const sha256 = sha256Hex(buffer)
    const mime = cleanText(params.mime, 200) ?? 'application/octet-stream'
    const { error } = await supabase.storage
      .from(DOCUMENTS_BUCKET)
      .upload(path, buffer, { contentType: mime, upsert: false })
    if (error) {
      log.warn('arrival original upload failed', { companyId: params.companyId, entityId: params.arrivalId, reason: error.message })
      return null
    }
    return { path, sha256, mime, size: buffer.byteLength }
  } catch (err) {
    log.warn('arrival original upload threw', { companyId: params.companyId, entityId: params.arrivalId, reason: err instanceof Error ? err.message : String(err) })
    return null
  }
}

async function findArrival(
  supabase: SupabaseClient,
  companyId: string,
  source: string,
  sourceRef: string,
): Promise<ArrivalRow | null> {
  const { data, error } = await supabase
    .from('arrivals')
    .select(
      'id, company_id, source, source_ref, received_at, sender, subject, message_text, original_path, original_sha256, original_mime, original_size, fetched_by, source_meta, created_at',
    )
    .eq('company_id', companyId)
    .eq('source', source)
    .eq('source_ref', sourceRef)
    .maybeSingle()
  if (error) throw new Error(error.message)
  return (data as unknown as ArrivalRow | null) ?? null
}

function receivedAtIso(value: string | Date): string {
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString()
}

/**
 * Record one delivery. Idempotent on (company, source, source_ref): an
 * existing row is returned with created=false and its original is not
 * fetched or stored again. Returns null (and logs) on any failure.
 */
export async function recordArrival(
  supabase: SupabaseClient,
  input: RecordArrivalInput,
): Promise<RecordArrivalResult | null> {
  const sourceRef = cleanText(input.sourceRef?.trim(), MAX_SOURCE_REF_CHARS)
  if (!isArrivalSource(input.source) || !sourceRef || !UUID_RE.test(input.companyId ?? '')) {
    log.warn('arrival refused: unknown source, empty reference or bad company id', {
      companyId: input.companyId,
      operation: String(input.source),
    })
    return null
  }

  try {
    const existing = await findArrival(supabase, input.companyId, input.source, sourceRef)
    if (existing) return { arrival: existing, created: false }

    const arrivalId = randomUUID()
    const sourceMeta: Record<string, unknown> = { ...(input.sourceMeta ?? {}) }

    let original: { path: string; sha256: string | null; mime: string | null; size: number | null } | null = null
    if (input.originalRef?.path) {
      const ref = input.originalRef
      if (ref.bucket && ref.bucket !== DOCUMENTS_BUCKET) sourceMeta.original_bucket = ref.bucket
      original = {
        path: ref.path,
        sha256: ref.sha256 && SHA256_RE.test(ref.sha256) ? ref.sha256 : null,
        mime: cleanText(ref.mime ?? null, 200),
        size: typeof ref.size === 'number' && ref.size >= 0 ? Math.floor(ref.size) : null,
      }
    } else if (input.original) {
      let bytes: ArrivalOriginalBytes | null = null
      try {
        bytes = typeof input.original === 'function' ? await input.original() : input.original
      } catch (err) {
        log.warn('arrival original could not be fetched', {
          companyId: input.companyId,
          operation: input.source,
          reason: err instanceof Error ? err.message : String(err),
        })
        sourceMeta.original_missing = 'fetch_failed'
      }
      if (bytes) {
        original = await storeArrivalOriginal(supabase, { companyId: input.companyId, arrivalId, ...bytes })
        if (!original) sourceMeta.original_missing = 'store_failed'
      }
    }

    // One insert with every field: the row is append-only, nothing is filled in later.
    const { data, error } = await supabase
      .from('arrivals')
      .upsert(
        {
          id: arrivalId,
          company_id: input.companyId,
          source: input.source,
          source_ref: sourceRef,
          received_at: receivedAtIso(input.receivedAt),
          sender: jsonObject(input.sender),
          subject: cleanText(input.subject ?? null, MAX_SUBJECT_CHARS),
          message_text: cleanText(input.messageText ?? null, MAX_MESSAGE_TEXT_CHARS),
          original_path: original?.path ?? null,
          original_sha256: original?.sha256 ?? null,
          original_mime: original?.mime ?? null,
          original_size: original?.size ?? null,
          fetched_by: jsonObject(input.fetchedBy as unknown as Record<string, unknown>),
          source_meta: jsonObject(sourceMeta),
        },
        { onConflict: 'company_id,source,source_ref', ignoreDuplicates: true },
      )
      .select(
        'id, company_id, source, source_ref, received_at, sender, subject, message_text, original_path, original_sha256, original_mime, original_size, fetched_by, source_meta, created_at',
      )
    if (error) throw new Error(error.message)

    const inserted = (data as unknown as ArrivalRow[] | null)?.[0]
    if (inserted) return { arrival: inserted, created: true }

    // A concurrent delivery recorded it between the lookup and the insert.
    // Any original stored above is an unreferenced object; the bucket is
    // WORM, so it stays.
    const raced = await findArrival(supabase, input.companyId, input.source, sourceRef)
    if (raced) return { arrival: raced, created: false }
    log.warn('arrival insert returned no row', { companyId: input.companyId, operation: input.source })
    return null
  } catch (err) {
    log.error('arrival could not be recorded', err, { companyId: input.companyId, operation: input.source })
    return null
  }
}

/**
 * Link what an arrival produced. Idempotent on (arrival, kind, output): a
 * second link of the same output is a no-op. Returns false (and logs) on
 * failure. Positions default to the order given.
 */
export async function linkArrivalOutputs(
  supabase: SupabaseClient,
  arrival: { id: string; company_id: string },
  outputs: ArrivalOutputInput[],
): Promise<boolean> {
  const seen = new Set<string>()
  const wanted = outputs
    .map((o, index) => ({ ...o, position: o.position ?? index }))
    .filter((o) => UUID_RE.test(o.id ?? ''))
    .filter((o) => {
      const key = `${o.kind}:${o.id}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
  try {
    // One row per call: a literal payload the schema guard can check, and a
    // delivery produces a handful of outputs at most.
    for (const o of wanted) {
      const { error } = await supabase.from('arrival_outputs').upsert(
        {
          arrival_id: arrival.id,
          company_id: arrival.company_id,
          output_kind: o.kind,
          output_id: o.id,
          role: o.role,
          position: o.position,
        },
        { onConflict: 'arrival_id,output_kind,output_id', ignoreDuplicates: true },
      )
      if (error) throw new Error(error.message)
    }
    return true
  } catch (err) {
    log.error('arrival outputs could not be linked', err, { companyId: arrival.company_id, entityId: arrival.id })
    return false
  }
}

/**
 * The arrival of an underlag that IS its own original (an upload, an MCP or
 * v1 file): the arrival points at the archived document's bytes instead of
 * storing them twice, and links the document and its inbox item. The
 * reference defaults to the document id, so the same document recorded
 * again through the same door is one arrival.
 */
export async function recordDocumentArrival(
  supabase: SupabaseClient,
  params: {
    companyId: string
    source: ArrivalSource
    documentId: string
    inboxItemId?: string | null
    sourceRef?: string | null
    fetchedBy: ArrivalActor
    sender?: Record<string, unknown>
    /** What the delivery said about itself (a partner's subject and short message). */
    subject?: string | null
    messageText?: string | null
    sourceMeta?: Record<string, unknown>
    receivedAt?: string | Date
  },
): Promise<RecordArrivalResult | null> {
  if (!UUID_RE.test(params.companyId ?? '') || !UUID_RE.test(params.documentId ?? '')) {
    log.warn('document arrival refused: bad company or document id', { companyId: params.companyId, entityId: params.documentId })
    return null
  }
  try {
    const { data, error } = await supabase
      .from('document_attachments')
      .select('id, storage_path, sha256_hash, mime_type, file_size_bytes, file_name')
      .eq('id', params.documentId)
      .eq('company_id', params.companyId)
      .maybeSingle()
    if (error) throw new Error(error.message)
    const doc = data as {
      id: string
      storage_path: string | null
      sha256_hash: string | null
      mime_type: string | null
      file_size_bytes: number | null
      file_name: string | null
    } | null
    if (!doc) {
      log.warn('document arrival skipped: document not found', { companyId: params.companyId, entityId: params.documentId })
      return null
    }

    const recorded = await recordArrival(supabase, {
      companyId: params.companyId,
      source: params.source,
      sourceRef: params.sourceRef || doc.id,
      receivedAt: params.receivedAt ?? new Date(),
      sender: params.sender,
      subject: params.subject,
      messageText: params.messageText,
      fetchedBy: params.fetchedBy,
      sourceMeta: { document_id: doc.id, file_name: doc.file_name, ...(params.sourceMeta ?? {}) },
      originalRef: doc.storage_path
        ? { path: doc.storage_path, sha256: doc.sha256_hash, mime: doc.mime_type, size: doc.file_size_bytes }
        : undefined,
    })
    if (!recorded) return null

    await linkArrivalOutputs(supabase, recorded.arrival, [
      { kind: 'document', id: doc.id, role: 'attachment' },
      ...(params.inboxItemId ? [{ kind: 'inbox_item' as const, id: params.inboxItemId, role: 'attachment' as const }] : []),
    ])
    return recorded
  } catch (err) {
    log.error('document arrival could not be recorded', err, { companyId: params.companyId, entityId: params.documentId })
    return null
  }
}

// ── Read path ────────────────────────────────────────────────

/** What a reader (the Inkorg, an agent) gets for one arrival. */
export interface ArrivalSummary {
  id: string
  source: string
  received_at: string
  sender: Record<string, unknown>
  subject: string | null
  message_text: string | null
  fetched_by: Record<string, unknown>
  has_original: boolean
  original_mime: string | null
  original_size: number | null
  original_file_name: string | null
  /** Short-lived signed URL of the original, when one was asked for and could be made. */
  original_url: string | null
  /**
   * Headers every request to original_url must carry: the signed token when
   * the URL is served from this app's origin, where no token rides in a URL;
   * empty for a raw signed Storage URL and when there is no URL. On every
   * summary made with toRequest (the agent and API doors), absent otherwise.
   */
  original_url_headers?: Record<string, string>
  /** What this arrival produced, so a reader can tell the attachment from the mail body. */
  outputs: Array<{ kind: ArrivalOutputKind; id: string; role: ArrivalOutputRole }>
}

/**
 * The arrivals that produced any of `outputs`, oldest first, each with
 * everything it produced. Company-scoped explicitly (defense in depth next
 * to RLS; service-role callers have none).
 */
export async function listArrivalsForOutputs(
  supabase: SupabaseClient,
  companyId: string,
  outputs: Array<{ kind: ArrivalOutputKind; id: string }>,
): Promise<Array<ArrivalRow & { outputs: ArrivalSummary['outputs'] }>> {
  const wanted = outputs.filter((o) => UUID_RE.test(o.id ?? ''))
  if (wanted.length === 0) return []

  const arrivalIds = new Set<string>()
  for (const kind of new Set(wanted.map((o) => o.kind))) {
    const ids = wanted.filter((o) => o.kind === kind).map((o) => o.id)
    const { data, error } = await supabase
      .from('arrival_outputs')
      .select('arrival_id')
      .eq('company_id', companyId)
      .eq('output_kind', kind)
      .in('output_id', ids)
    if (error) throw new Error(error.message)
    for (const row of (data as Array<{ arrival_id: string }> | null) ?? []) arrivalIds.add(row.arrival_id)
  }
  if (arrivalIds.size === 0) return []

  const ids = [...arrivalIds]
  const [{ data: arrivals, error: arrivalsError }, { data: produced, error: producedError }] = await Promise.all([
    supabase
      .from('arrivals')
      .select(
        'id, company_id, source, source_ref, received_at, sender, subject, message_text, original_path, original_sha256, original_mime, original_size, fetched_by, source_meta, created_at',
      )
      .eq('company_id', companyId)
      .in('id', ids),
    supabase
      .from('arrival_outputs')
      .select('arrival_id, output_kind, output_id, role, position')
      .eq('company_id', companyId)
      .in('arrival_id', ids),
  ])
  if (arrivalsError) throw new Error(arrivalsError.message)
  if (producedError) throw new Error(producedError.message)

  const byArrival = new Map<string, Array<{ kind: ArrivalOutputKind; id: string; role: ArrivalOutputRole; position: number }>>()
  for (const row of (produced as Array<{ arrival_id: string; output_kind: ArrivalOutputKind; output_id: string; role: ArrivalOutputRole; position: number }> | null) ?? []) {
    const list = byArrival.get(row.arrival_id) ?? []
    list.push({ kind: row.output_kind, id: row.output_id, role: row.role, position: row.position })
    byArrival.set(row.arrival_id, list)
  }

  return ((arrivals as unknown as ArrivalRow[] | null) ?? [])
    .map((arrival) => ({
      ...arrival,
      outputs: (byArrival.get(arrival.id) ?? [])
        .sort((a, b) => a.position - b.position)
        .map(({ kind, id, role }) => ({ kind, id, role })),
    }))
    .sort((a, b) => a.received_at.localeCompare(b.received_at) || a.created_at.localeCompare(b.created_at))
}

function originalFileName(path: string | null): string | null {
  if (!path) return null
  return path.split('/').pop() || null
}

/**
 * The bucket an arrival's original is signed from, or null when it may not
 * be signed. Documents unless the row says otherwise; sie-files only for a
 * key under the arrival's own company, since the row read is the whole
 * authorization and must never name another company's archive.
 */
export function arrivalOriginalBucket(arrival: Pick<ArrivalRow, 'company_id' | 'original_path' | 'source_meta'>): ArrivalOriginalBucket | null {
  const bucket = arrival.source_meta?.original_bucket
  if (bucket == null || bucket === DOCUMENTS_BUCKET) return DOCUMENTS_BUCKET
  if (bucket === SIE_FILES_BUCKET && arrival.original_path?.startsWith(`${arrival.company_id}/`)) return SIE_FILES_BUCKET
  return null
}

/** Seconds a signed original URL lives: long enough to open, short enough not to leak. */
export const ARRIVAL_ORIGINAL_URL_TTL_SEC = 300

/**
 * Turns the signed Storage URL of an original into the request a reader
 * makes: the URL and the headers that go with it. The agent and API doors
 * pass toSameOriginStorageRequest (lib/core/documents/storage-proxy.ts),
 * which serves the original from this app's origin with its token in a
 * header; without one the raw signed URL is handed out, with no headers.
 */
export type ArrivalOriginalRequest = (signedUrl: string) => { url: string; headers: Record<string, string> }

const originalKey = (companyId: string, path: string) => `${companyId}\n${path}`

/**
 * The documents-bucket originals that may be signed: a key under the
 * arrival's own company folder (an original stored by recordArrival, a
 * document filed there), or the storage key of one of the company's own
 * documents (older documents sit under other folders). The arrival row alone
 * is not enough: any member of the company can insert one, and the signing
 * client is the service role, so a row must never name another company's
 * file. A document row's key counts when it lies inside the company
 * (storage-key.ts). Keys are company + path.
 */
async function signableDocumentOriginals(
  client: SupabaseClient,
  arrivals: Array<Pick<ArrivalRow, 'company_id' | 'original_path' | 'source_meta'>>,
): Promise<Set<string>> {
  const allowed = new Set<string>()
  const toCheck = new Map<string, Set<string>>()
  for (const arrival of arrivals) {
    const path = arrival.original_path
    if (!path || arrivalOriginalBucket(arrival) !== DOCUMENTS_BUCKET || !isDocumentKeyOfCompany(path, arrival.company_id)) continue
    if (isCompanyFolderDocumentKey(path, arrival.company_id)) {
      allowed.add(originalKey(arrival.company_id, path))
      continue
    }
    const paths = toCheck.get(arrival.company_id) ?? new Set<string>()
    paths.add(path)
    toCheck.set(arrival.company_id, paths)
  }
  for (const [companyId, paths] of toCheck) {
    try {
      const { data, error } = await client
        .from('document_attachments')
        .select('storage_path')
        .eq('company_id', companyId)
        .in('storage_path', [...paths])
      if (error) throw new Error(error.message)
      for (const row of (data as Array<{ storage_path: string | null }> | null) ?? []) {
        if (row.storage_path) allowed.add(originalKey(companyId, row.storage_path))
      }
    } catch (err) {
      log.warn('arrival originals could not be checked against the documents', {
        companyId,
        reason: err instanceof Error ? err.message : String(err),
      })
    }
  }
  return allowed
}

/**
 * Summaries for a reader, signing each original with `storageClient` (the
 * service role). The row read above, with RLS and the explicit company
 * filter, says the reader may see the arrival; the original is signed only
 * from the arrival's own company (its sie-files folder, its documents folder
 * or one of its documents), never from wherever the row points.
 * A failed signing leaves original_url null, never fails the read.
 */
export async function summariseArrivals(
  arrivals: Array<ArrivalRow & { outputs: ArrivalSummary['outputs'] }>,
  opts: { storageClient?: SupabaseClient; ttlSec?: number; toRequest?: ArrivalOriginalRequest } = {},
): Promise<ArrivalSummary[]> {
  const signableDocuments = opts.storageClient ? await signableDocumentOriginals(opts.storageClient, arrivals) : new Set<string>()
  return Promise.all(
    arrivals.map(async (arrival) => {
      let url: string | null = null
      let headers: Record<string, string> = {}
      const fileName = originalFileName(arrival.original_path)
      const bucket = arrivalOriginalBucket(arrival)
      const signable =
        bucket === SIE_FILES_BUCKET ||
        (bucket === DOCUMENTS_BUCKET && arrival.original_path != null && signableDocuments.has(originalKey(arrival.company_id, arrival.original_path)))
      if (opts.storageClient && arrival.original_path && bucket && signable) {
        try {
          const { data, error } = await opts.storageClient.storage
            .from(bucket)
            .createSignedUrl(arrival.original_path, opts.ttlSec ?? ARRIVAL_ORIGINAL_URL_TTL_SEC, {
              download: fileName ?? true,
            })
          if (error) throw new Error(error.message)
          if (data?.signedUrl) {
            ;({ url, headers } = opts.toRequest ? opts.toRequest(data.signedUrl) : { url: data.signedUrl, headers: {} })
          }
        } catch (err) {
          log.warn('arrival original could not be signed', {
            companyId: arrival.company_id,
            entityId: arrival.id,
            reason: err instanceof Error ? err.message : String(err),
          })
        }
      }
      return {
        id: arrival.id,
        source: arrival.source,
        received_at: arrival.received_at,
        sender: arrival.sender ?? {},
        subject: arrival.subject,
        message_text: arrival.message_text,
        fetched_by: arrival.fetched_by ?? {},
        has_original: arrival.original_path != null,
        original_mime: arrival.original_mime,
        original_size: arrival.original_size,
        original_file_name: fileName,
        original_url: url,
        ...(opts.toRequest ? { original_url_headers: headers } : {}),
        outputs: arrival.outputs,
      }
    }),
  )
}

/**
 * The arrivals behind one inbox item (through the item and its document),
 * summarised and signed. For read surfaces that must not fail on this part
 * (MCP gnubok_get_inbox_item): any error is logged and answered with [].
 */
export async function readInboxItemArrivals(
  supabase: SupabaseClient,
  companyId: string,
  item: { id: string; document_id?: string | null },
  opts: { storageClient?: SupabaseClient; toRequest?: ArrivalOriginalRequest } = {},
): Promise<ArrivalSummary[]> {
  try {
    const arrivals = await listArrivalsForOutputs(supabase, companyId, [
      { kind: 'inbox_item', id: item.id },
      ...(item.document_id ? [{ kind: 'document' as const, id: item.document_id }] : []),
    ])
    return await summariseArrivals(arrivals, { storageClient: opts.storageClient ?? supabase, toRequest: opts.toRequest })
  } catch (err) {
    log.warn('inbox item arrivals could not be read', {
      companyId,
      entityId: item.id,
      reason: err instanceof Error ? err.message : String(err),
    })
    return []
  }
}
