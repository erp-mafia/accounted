/**
 * The model's own reading of a document, as distinct from the reading a
 * person corrected.
 *
 * document_attachments.extracted_data is the document's reading for every
 * reader, so a person's correction in the inbox is mirrored onto it
 * (mirrorCorrectedReadingToDocument). Before the first correction overwrites
 * it, the model's reading is copied to document_attachments.model_reading
 * (migration 20261016050000) with the extracted_at it belongs to; the
 * suggestion log reads it from there (lib/suggestion-log/inbox.ts). A later
 * extraction stamps a new extracted_at and writes extracted_data afresh, which
 * makes the kept copy stale without anyone clearing it.
 *
 * Pure: no client, no I/O.
 */

export interface ModelReading {
  extracted_data: Record<string, unknown>
  extraction_model: string
  extracted_at: string | null
}

/** The columns these rules read off a document_attachments row. */
export interface DocumentReadingRow {
  extracted_data?: unknown
  extraction_model?: string | null
  extracted_at?: string | null
  model_reading?: unknown
}

/** A stamp a model call wrote: not 'skipped:<reason>' / 'failed:<reason>', which mark a reading that never happened. */
export function isModelExtraction(model: string | null | undefined): model is string {
  return typeof model === 'string' && model.length > 0 && !/^(skipped|failed):/.test(model)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The kept copy, when it still belongs to the row's current extraction. */
function currentKept(row: DocumentReadingRow): ModelReading | null {
  const kept = row.model_reading
  if (!isRecord(kept) || !isRecord(kept.extracted_data) || !isModelExtraction(kept.extraction_model as string | null)) return null
  const keptAt = (kept.extracted_at as string | null | undefined) ?? null
  if (keptAt !== (row.extracted_at ?? null)) return null
  return { extracted_data: kept.extracted_data, extraction_model: kept.extraction_model as string, extracted_at: keptAt }
}

/**
 * What the model read on this document: the kept copy while it is current,
 * else the row's own reading when a model wrote it, else null (never read, or
 * only a person's reading is left).
 */
export function modelReadingOf(row: DocumentReadingRow | null | undefined): ModelReading | null {
  if (!row) return null
  const kept = currentKept(row)
  if (kept) return kept
  if (!isRecord(row.extracted_data) || !isModelExtraction(row.extraction_model)) return null
  return { extracted_data: row.extracted_data, extraction_model: row.extraction_model, extracted_at: row.extracted_at ?? null }
}

/**
 * What a correction writes to model_reading before it replaces
 * extracted_data: the row's reading when a model wrote it and no current copy
 * is kept yet; undefined (leave the column alone) when a current copy already
 * stands or there is no model reading to keep.
 */
export function modelReadingToKeep(row: DocumentReadingRow): ModelReading | undefined {
  if (currentKept(row)) return undefined
  if (!isRecord(row.extracted_data) || !isModelExtraction(row.extraction_model)) return undefined
  return { extracted_data: row.extracted_data, extraction_model: row.extraction_model, extracted_at: row.extracted_at ?? null }
}
