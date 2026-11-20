/**
 * Resolve what is stored about one document (and its inbox item) into one
 * DocumentReading.
 *
 * PRECEDENCE, field by field: person > xml > model > door.
 *   1. person: a person's correction, i.e. the reading people book from
 *      (the inbox item's extracted_data, else the document's) differs from
 *      the machine reading it started as, or a correction marked the field
 *      (personFields), which a new reading carries over and never changes.
 *      A person decided, so it stands even over the XML (Ditt val).
 *   2. xml: the parsed Peppol UBL (Exakt): the sender's own data outranks
 *      any model's reading of a rendering.
 *   3. model: the model's reading (vision or text, by what the model was
 *      handed), Stark when another source corroborates it, else Trolig.
 *   4. door: what the door recorded (the Peppol sender endpoint as the
 *      seller's organisationsnummer), only where nothing read the document.
 *
 * One exception, document_type: its value is the inbox's existing kind rule
 * (resolveInboxKind, lib/documents/inbox-kind.ts), where a declared kind (the
 * +lev / +ver tag, the type Arkiv queued it as, a person's type in Dokument)
 * outranks the model's classification. The reading does not decide the kind
 * a second way; it only says which input decided it.
 *
 * Which machine reading a correction is measured against:
 *   - a Peppol item: the delivery's mapping of the UBL;
 *   - otherwise: the model's reading of the document (model_reading while it
 *     is current, else extracted_data when a model wrote it, see
 *     lib/documents/model-reading.ts);
 *   - a document the model never read (the extraction was skipped or
 *     failed): the empty reading an unread item starts from, so every value
 *     on it was typed by a person;
 *   - none of these (an item from before the document kept the model's
 *     reading): no correction can be told apart, every value is attributed
 *     to the model and the reading says so (note origin_unknown).
 * A reading an agent supplied (gnubok_set_inbox_extracted_data, which marks
 * it with confidence 0.95) is a machine reading, never a person's choice.
 *
 * Pure: no client, no I/O. ./load.ts fetches the rows.
 */
import { isInboxDocumentKind, resolveInboxKind } from '@/lib/documents/inbox-kind'
import { isModelExtraction, modelReadingOf, type DocumentReadingRow } from '@/lib/documents/model-reading'
import { intakeSourceForInboxItem, intakeSourceFromUploadSource } from '@/lib/intake/sources'
import type { PeppolInboundDocument } from '@/lib/invoices/peppol-inbound-ubl'
import type { InvoiceExtractionResult } from '@/types'
import type { InboxChannelContext } from '@/types'
import { personFieldPaths } from '@/lib/documents/person-corrections'
import {
  arkivAgreement,
  corroborationsFor,
  fieldsAtPaths,
  holdsKey,
  inboxKindOfDocType,
  prepaidDeduction,
  projectExtraction,
  sameValue,
  xmlValues,
  type ArkivRecord,
  type CorroborationContext,
  type ReadingValueMap,
  type SupplierCard,
} from './assemble'
import {
  READING_FIELD_NAMES,
  type DocumentReading,
  type ReadingDoor,
  type ReadingField,
  type ReadingFieldName,
  type ReadingFields,
  type ReadingNote,
  type ReadingSource,
  type ReadingValues,
} from './types'

/** The inbox item columns a reading needs. */
export interface ReadingItemRow {
  id: string
  document_id?: string | null
  source?: string | null
  extracted_data?: unknown
  extraction_skipped?: boolean | null
  kind_hint?: string | null
  channel_context?: InboxChannelContext | null
  email_from?: string | null
  email_received_at?: string | null
  matched_supplier_id?: string | null
}

/** The document_attachments columns a reading needs. */
export interface ReadingDocumentRow extends DocumentReadingRow {
  id: string
  mime_type?: string | null
  file_name?: string | null
  upload_source?: string | null
  doc_type?: string | null
}

export interface ReadingInputs {
  item: ReadingItemRow | null
  document: ReadingDocumentRow | null
  /** The parsed UBL of a Peppol item, when its archive row was found. */
  peppol: PeppolInboundDocument | null
  /**
   * The delivery's own UBL mapping (lib/invoices/peppol-reading.ts), passed
   * in: the invoicing block owns it and this block may not import it. Without
   * it a Peppol item is read without its xml source.
   */
  peppolToExtraction?: (document: PeppolInboundDocument) => InvoiceExtractionResult
  /** The document's current Arkiv record, when it has one. */
  arkiv: ArkivRecord | null
  /** The matched supplier's card, when the item has one. */
  supplier: SupplierCard | null
}

/** The marker gnubok_set_inbox_extracted_data puts on an agent-supplied reading (the extractor writes 1 or 0). */
const AGENT_READING_CONFIDENCE = 0.95

/** What an unread inbox item starts from (emptyResult in extract-invoice-fields.ts): only the default currency. */
const UNREAD_SKELETON = { invoice: { currency: 'SEK' } }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * What the model was handed: text only for a mail body or a text file, the
 * file itself (pages it looks at) for a PDF or a photo. No document: a file.
 */
export function readerOf(mimeType: string | null | undefined): Extract<ReadingSource, 'text' | 'vision'> {
  if (!mimeType) return 'vision'
  return mimeType.startsWith('text/') || mimeType === 'application/xhtml+xml' ? 'text' : 'vision'
}

function neverRead(item: ReadingItemRow | null, document: ReadingDocumentRow | null): boolean {
  if (item?.extraction_skipped === true) return true
  const stamp = document?.extraction_model
  return typeof stamp === 'string' && stamp.length > 0 && !isModelExtraction(stamp)
}

interface Origins {
  /** The reading people book from. */
  current: Record<string, unknown> | null
  /** The machine reading a correction is measured against; null when none can be. */
  baseline: Record<string, unknown> | null
  /** The model's (or an agent's) reading, for the fields the XML does not hold. */
  model: Record<string, unknown> | null
  notes: ReadingNote[]
}

function originsOf(inputs: ReadingInputs, xmlExtraction: Record<string, unknown> | null): Origins {
  const { item, document } = inputs
  const ownReading = item ? item.extracted_data : undefined
  const current = isRecord(ownReading) ? ownReading : isRecord(document?.extracted_data) ? document.extracted_data : null
  const notes: ReadingNote[] = []
  const agent = current !== null && current.confidence === AGENT_READING_CONFIDENCE
  if (agent) notes.push('agent_reading')
  const kept = modelReadingOf(document)?.extracted_data ?? null

  if (xmlExtraction) {
    return { current, baseline: agent ? null : xmlExtraction, model: agent ? current : kept, notes }
  }
  if (item?.source === 'peppol' || item?.channel_context?.channel === 'peppol') notes.push('structured_source_missing')
  if (agent) return { current, baseline: null, model: current, notes }
  if (kept) return { current, baseline: kept, model: kept, notes }
  if (neverRead(item, document)) return { current, baseline: UNREAD_SKELETON, model: null, notes }
  if (current) notes.push('origin_unknown')
  return { current, baseline: null, model: current, notes }
}

/** A person's value per field; null is a value a person cleared. */
type PersonValues = Partial<Record<ReadingFieldName, unknown>>

/**
 * The fields a person changed: where the reading people book from holds the
 * field (holdsKey) and either a person's correction marked it (personFields,
 * lib/documents/person-corrections.ts: it stays theirs when a new reading
 * agrees with it) or it differs from the machine reading it started as.
 */
function personValues(origins: Origins): PersonValues {
  const { current, baseline } = origins
  if (!current) return {}
  const marked = fieldsAtPaths(personFieldPaths(current))
  if (!baseline && marked.size === 0) return {}
  const now = projectExtraction(current)
  const before = baseline ? projectExtraction(baseline) : null
  const changed: PersonValues = {}
  for (const field of READING_FIELD_NAMES) {
    if (!holdsKey(current, field)) continue
    if (marked.has(field) || (before && !sameValue(field, now[field], before[field]))) changed[field] = now[field] ?? null
  }
  return changed
}

/** The door's own evidence for a field: a Peppol sender endpoint under scheme 0007 is a Swedish organisationsnummer. */
function doorValues(item: ReadingItemRow | null): ReadingValueMap {
  const endpoint = item?.channel_context?.peppol_sender_endpoint
  const match = typeof endpoint === 'string' ? endpoint.match(/^0007:(\d{10})$/) : null
  return match ? { seller_legal_registration_identifier: match[1] } : {}
}

function doorOf(item: ReadingItemRow | null, document: ReadingDocumentRow | null): ReadingDoor {
  const context = item?.channel_context ?? null
  const intake = item
    ? intakeSourceForInboxItem({
        source: item.source,
        channel_context: context,
        document_upload_source: document?.upload_source ?? null,
        document_file_name: document?.file_name ?? null,
      })
    : intakeSourceFromUploadSource(document?.upload_source, { fileName: document?.file_name ?? null })
  return {
    intake_source: intake,
    sender: context?.peppol_sender_endpoint ?? context?.mail_from ?? item?.email_from ?? null,
    received_at: context?.mail_received_at ?? item?.email_received_at ?? null,
  }
}

type Picked = { value: unknown; tier: 'person' | 'xml' | 'model' | 'door' }

function located(field: ReadingFieldName, value: unknown, arkiv: ArkivRecord | null): { page?: number; quote?: string } {
  if (value === null || value === undefined) return {}
  const { page, quote } = arkivAgreement(field, value, arkiv)
  return { ...(page !== undefined ? { page } : {}), ...(quote !== undefined ? { quote } : {}) }
}

function machineField(
  field: ReadingFieldName,
  value: unknown,
  source: ReadingSource,
  ctx: CorroborationContext,
  options: { corroborate: boolean },
): ReadingField<unknown> {
  const corroborated = options.corroborate ? corroborationsFor(field, value, ctx) : []
  return {
    value,
    source,
    evidence: corroborated.length > 0 ? 'stark' : 'trolig',
    ...located(field, value, ctx.arkiv),
    ...(corroborated.length > 0 ? { corroborated_by: corroborated } : {}),
  }
}

function documentTypeField(
  inputs: ReadingInputs,
  origins: Origins,
  person: PersonValues,
  xml: ReadingValueMap | null,
  reader: ReadingSource,
): ReadingField<ReadingValues['document_type']> | undefined {
  const effective = origins.current ?? origins.model
  const value = resolveInboxKind({
    kind_hint: inputs.item?.kind_hint ?? null,
    extracted_data: (effective as Parameters<typeof resolveInboxKind>[0]['extracted_data']) ?? null,
  })
  if (!value) return undefined
  if (person.document_type === value) return { value, source: 'person', evidence: 'ditt_val' }
  if (xml?.document_type === value) return { value, source: 'xml', evidence: 'exakt' }
  const hint = isInboxDocumentKind(inputs.item?.kind_hint) ? inputs.item!.kind_hint : null
  const modelKind = projectExtraction(origins.model).document_type
  if (hint === value) {
    return modelKind === value
      ? { value, source: 'door', evidence: 'stark', corroborated_by: ['declared_kind'] }
      : { value, source: 'door', evidence: 'trolig' }
  }
  // No machine read it (the model never ran): the kind follows from what a person typed, a credit's amounts say.
  if (!origins.model && !xml && origins.current) return { value, source: 'person', evidence: 'ditt_val' }
  // The model's kind, or its amounts read as a credit: only an independent classifier corroborates it.
  return inboxKindOfDocType(inputs.document?.doc_type) === value
    ? { value, source: reader, evidence: 'stark', corroborated_by: ['second_reading'] }
    : { value, source: reader, evidence: 'trolig' }
}

/** The one reading of a document and its inbox item. */
export function resolveDocumentReading(inputs: ReadingInputs): DocumentReading {
  const { item, document, peppol, arkiv, supplier, peppolToExtraction } = inputs
  const xml = peppol && peppolToExtraction ? xmlValues(peppol, peppolToExtraction) : null
  const origins = originsOf(inputs, xml ? (xml.extraction as unknown as Record<string, unknown>) : null)
  const reader = readerOf(document?.mime_type)

  const person = personValues(origins)
  const model = projectExtraction(origins.model)
  const door = doorValues(item)

  // Lines only from a structured door (field rule 2026-09-27): never a model's reading of them.
  delete model.invoice_lines
  if (!xml) delete person.invoice_lines

  const picked = new Map<ReadingFieldName, Picked>()
  for (const field of READING_FIELD_NAMES) {
    if (field === 'document_type') continue
    if (field in person) picked.set(field, { value: person[field] ?? null, tier: 'person' })
    else if (xml && xml.values[field] !== undefined) picked.set(field, { value: xml.values[field], tier: 'xml' })
    else if (model[field] !== undefined) picked.set(field, { value: model[field], tier: 'model' })
    else if (door[field] !== undefined) picked.set(field, { value: door[field], tier: 'door' })
  }

  const resolved: ReadingValueMap = {}
  for (const [field, pick] of picked) {
    if (pick.value !== null) (resolved as Record<string, unknown>)[field] = pick.value
  }
  const roundingOf = (reading: Record<string, unknown> | null): number | null => {
    const value = isRecord(reading?.totals) ? reading.totals.roundingAmount : null
    return typeof value === 'number' && Number.isFinite(value) ? value : null
  }
  const ctx: CorroborationContext = {
    values: resolved,
    arkiv,
    supplier,
    roundingAmount: roundingOf(origins.current) ?? roundingOf(origins.model),
    prepaidAmount: prepaidDeduction((origins.current ?? origins.model)?.totals),
  }
  // A total promoted from the document's one prominent amount is fallback-grade (InvoiceExtractionResult.totalSource).
  const promotedTotal = origins.model?.totalSource === 'prominent'

  const fields: ReadingFields = {}
  const out = fields as Record<string, ReadingField<unknown>>
  for (const [field, pick] of picked) {
    if (pick.tier === 'person') out[field] = { value: pick.value, source: 'person', evidence: 'ditt_val', ...located(field, pick.value, arkiv) }
    else if (pick.tier === 'xml') out[field] = { value: pick.value, source: 'xml', evidence: 'exakt' }
    else if (pick.tier === 'model') {
      out[field] = machineField(field, pick.value, reader, ctx, { corroborate: !(field === 'amount_due_for_payment' && promotedTotal) })
    } else out[field] = machineField(field, pick.value, 'door', ctx, { corroborate: true })
  }
  const documentType = documentTypeField(inputs, origins, person, xml?.values ?? null, reader)
  if (documentType) fields.document_type = documentType

  return {
    document_id: document?.id ?? item?.document_id ?? null,
    inbox_item_id: item?.id ?? null,
    fields: orderedFields(fields),
    door: doorOf(item, document),
    notes: origins.notes,
  }
}

/** The fields in READING_TERMS order, so every reading reads the same way. */
function orderedFields(fields: ReadingFields): ReadingFields {
  const ordered: ReadingFields = {}
  for (const field of READING_FIELD_NAMES) {
    const value = fields[field]
    if (value) (ordered as Record<string, unknown>)[field] = value
  }
  return ordered
}
