import { getAiService } from '@/lib/ai'
import type { AiTier } from '@/lib/ai/types'
import type { AiDocumentInput, AiImageMediaType } from '@/lib/ai'
import type { ReadPage } from './types'

/**
 * Scans and photos: the model transcribes the page. Plain text out, no JSON,
 * so nothing to parse and nothing to invent. Page-level provenance only.
 */
const TRANSCRIBE_SYSTEM =
  'You transcribe documents for a Swedish accounting archive. Return the complete text of the page exactly as printed, in reading order, one line per printed line, tables as rows with cells separated by " | ". Keep numbers, dates, names and identifiers exactly. Do not summarise, translate, or add anything that is not on the page. If the page is blank or unreadable, answer with an empty response.'

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
  return { ok: true, text: result.text.trim() }
}

export async function readImageWithModel(bytes: Buffer, mediaType: AiImageMediaType, opts: { tier?: AiTier } = {}): Promise<{ ok: true; pages: ReadPage[] } | { ok: false; skipped: 'ai_unconfigured' | 'ai_no_vision' }> {
  const out = await transcribeWithModel({ kind: 'image', data: bytes, mediaType }, opts)
  if (!out.ok) return out
  return { ok: true, pages: out.text ? [{ pageNo: 1, text: out.text, reader: 'claude_vision', hasTextLayer: false }] : [] }
}
