/**
 * Deterministic clarifying-question triggers, evaluated per receipt AFTER
 * extraction. Max ONE question per receipt; priority
 * unreadable > representation > partial. Pure functions: everything here is
 * unit-testable without a DB or model.
 *
 * The triggers key on the Phase-0 extraction classification
 * (documentKind/merchantCategory/legibility) and fall back to heuristics when
 * a cached pre-classification extraction lacks those fields.
 */

import { MEAL_PATTERN } from '@/lib/tax/expense-warnings'
import type { InvoiceExtractionResult } from '@/types'
import type { QuestionType } from './conversation'

/** Representation question only above this total (SEK): Skatteverket-grade
 *  documentation for a 45 kr coffee is noise, not compliance. */
export const REPRESENTATION_MIN_TOTAL = 150

/** Compressed-chat-photo signal: WhatsApp chat photos are JPEG, nameless and
 *  small. Below this size with an empty extraction, assume the compression
 *  destroyed the text. Never triggers on file size alone. */
export const COMPRESSED_PHOTO_MAX_BYTES = 150 * 1024

/** MEAL_PATTERN (lib/tax/expense-warnings.ts) extended with venue words per
 *  the conversation spec. Word-bounded where substrings would misfire
 *  ("bar" inside "Barkarby"). */
const EXTENDED_MEAL_PATTERN = /\b(krog|bar|pub|catering|bistro|pizzeria)\b/i

/** Caption words that mark a business meal regardless of the merchant. */
const CAPTION_REPRESENTATION_PATTERN = /kund|möte|representation/i

const REPRESENTATION_CATEGORIES: ReadonlySet<string> = new Set([
  'restaurant',
  'cafe',
  'hotel',
])

export interface QuestionInput {
  extracted: InvoiceExtractionResult | null
  caption: string | null
  mime: string | null
  filename: string | null
  /** Stored size of the ingested document (document_attachments). */
  fileSizeBytes: number | null
}

export interface QuestionCandidate {
  type: QuestionType
}

function mealHeuristic(input: QuestionInput): boolean {
  const haystacks: string[] = []
  const supplierName = input.extracted?.supplier?.name
  if (supplierName) haystacks.push(supplierName)
  for (const line of input.extracted?.lineItems ?? []) {
    if (line.description) haystacks.push(line.description)
  }
  if (input.caption) haystacks.push(input.caption)
  const matchesMeal = haystacks.some(
    (text) => MEAL_PATTERN.test(text) || EXTENDED_MEAL_PATTERN.test(text),
  )
  const captionSignal =
    input.caption != null && CAPTION_REPRESENTATION_PATTERN.test(input.caption)
  return matchesMeal || captionSignal
}

function isUnreadable(input: QuestionInput): boolean {
  if (input.extracted?.legibility === 'unreadable') return true
  // Fallback: compressed chat photo whose extraction came back empty.
  const total = input.extracted?.totals?.total ?? null
  const supplierName = input.extracted?.supplier?.name ?? null
  return (
    (input.mime ?? '').toLowerCase() === 'image/jpeg' &&
    !input.filename &&
    input.fileSizeBytes != null &&
    input.fileSizeBytes < COMPRESSED_PHOTO_MAX_BYTES &&
    total == null &&
    supplierName == null
  )
}

function isRepresentation(input: QuestionInput): boolean {
  const extracted = input.extracted
  const total = extracted?.totals?.total ?? null
  if (total == null || total < REPRESENTATION_MIN_TOTAL) return false

  const kind = extracted?.documentKind ?? null
  const category = extracted?.merchantCategory ?? null

  // Classification present and decisive.
  if (kind != null && kind !== 'receipt') return false
  if (category != null) return REPRESENTATION_CATEGORIES.has(category)
  // Classification absent (pre-Phase-0 extraction): heuristic fallback.
  return mealHeuristic(input)
}

function isPartial(input: QuestionInput): boolean {
  if (input.extracted?.legibility === 'partial') return true
  const total = input.extracted?.totals?.total ?? null
  const supplierName = input.extracted?.supplier?.name ?? null
  // Exactly one of the two key fields missing.
  return (total == null) !== (supplierName == null)
}

/**
 * The at-most-one question this receipt warrants, or null.
 */
export function evaluateQuestion(input: QuestionInput): QuestionCandidate | null {
  if (isUnreadable(input)) return { type: 'resend' }
  if (isRepresentation(input)) return { type: 'representation' }
  if (isPartial(input)) return { type: 'context' }
  return null
}

/** Cross-item ordering inside one burst: time-sensitive re-sends first, then
 *  representation (legal completeness), then free-text context. */
export const QUESTION_PRIORITY: Record<QuestionType, number> = {
  resend: 0,
  representation: 1,
  context: 2,
}
