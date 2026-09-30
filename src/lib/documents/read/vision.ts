import { getAiService } from '@/lib/ai'
import type { AiTier } from '@/lib/ai/types'
import type { AiDocumentInput, AiImageMediaType } from '@/lib/ai'
import type { ReadPage } from './types'

/**
 * Scans and photos: the model transcribes the page. Plain text out, no JSON,
 * so nothing to parse and nothing to invent. Page-level provenance only.
 */
export const NO_TEXT = 'NO_TEXT'

const TRANSCRIBE_SYSTEM =
  `You transcribe documents for a Swedish accounting archive. Return the complete text of the page exactly as printed, in reading order, one line per printed line, tables as rows with cells separated by " | ". Keep numbers, dates, names and identifiers exactly. Do not summarise, translate, describe, or add anything that is not on the page. If the page has no printed text to transcribe (blank, unreadable, a photo of an object or a person, a QR code or barcode alone), answer with exactly ${NO_TEXT} and nothing else.`

/**
 * The reader talking about the page instead of transcribing it. Before the
 * NO_TEXT answer the model wrote "The page is blank." or described a product
 * photo, and that sentence was stored and searched as if the document said it
 * (prod 2026-09-25: 90 pages in 33 companies). Only a short answer in the
 * reader's own voice counts; a real document that happens to start "This
 * invoice..." is long and is kept.
 */
const COMMENTARY_MAX_CHARS = 400
const COMMENTARY_RE =
  /^\s*(i'm not able|i am not able|i'm unable|i am unable|i cannot|i can't|i do not see|i don't see|(the|this) (page|image|document|photo|picture) (appears|seems|is|contains|does|shows)|there is no (readable |visible |legible )?text|no (readable |visible |legible )?text|unable to (transcribe|read)|jag kan inte|sidan (verkar|är) (vara )?tom|bilden (verkar|innehåller|visar))/i

export function isReaderCommentary(text: string): boolean {
  const t = text.trim()
  if (t === '' || t === NO_TEXT) return true
  return t.length < COMMENTARY_MAX_CHARS && COMMENTARY_RE.test(t)
}

export type VisionOutcome = { ok: true; text: string } | { ok: false; skipped: 'ai_unconfigured' | 'ai_no_vision' }

export async function transcribeWithModel(document: AiDocumentInput, opts: { tier?: AiTier } = {}): Promise<VisionOutcome> {
  const ai = getAiService()
  const result = await ai.extractFromDocument({
    document,
    system: TRANSCRIBE_SYSTEM,
    instruction: 'Transcribe this page.',
    maxTokens: 6000,
    ...(opts.tier ? { tier: opts.tier } : {}),
  })
  if (!result.ok) {
    return { ok: false, skipped: result.skipped === 'ai_no_vision' ? 'ai_no_vision' : 'ai_unconfigured' }
  }
  const text = result.text.trim()
  return { ok: true, text: isReaderCommentary(text) ? '' : text }
}

export async function readImageWithModel(bytes: Buffer, mediaType: AiImageMediaType, opts: { tier?: AiTier } = {}): Promise<{ ok: true; pages: ReadPage[] } | { ok: false; skipped: 'ai_unconfigured' | 'ai_no_vision' }> {
  const out = await transcribeWithModel({ kind: 'image', data: bytes, mediaType }, opts)
  if (!out.ok) return out
  return { ok: true, pages: out.text ? [{ pageNo: 1, text: out.text, reader: 'claude_vision', hasTextLayer: false }] : [] }
}
