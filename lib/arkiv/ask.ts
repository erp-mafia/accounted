import { createHash } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { getAiService, getAiStatus } from '@/lib/ai'
import { recordActivity, softwareAgent } from '@/lib/documents/provenance'
import { locateQuote, type PageText } from '@/lib/documents/extract/locate'
import type { WordBox } from '@/lib/documents/read/types'

/**
 * Schema on read (phase 8): ask a document one question and get the answer
 * from its own text, with the page and the sentence it came from, or an
 * honest "not in the document". Nothing is pre-extracted for this and
 * nothing is stored except the question itself as an activity; an answer
 * a person wants kept becomes a fact through the normal proposal path.
 */
export const ASKER = { name: 'arkiv.ask', version: '1' } as const

/** Text budget per question: the whole document when it fits, the most relevant pages otherwise. */
const MAX_CHARS = 60_000
const MAX_TOKENS = 700

export type AskOutcome =
  | {
      status: 'answered'
      answer: string | null
      page: number | null
      quote: string | null
      quote_verified: boolean
      confidence: number
      pages_read: number[]
      page_count: number
      not_found: boolean
    }
  | { status: 'skipped'; reason: 'ai_unconfigured' | 'not_found' | 'no_text' }
  | { status: 'error'; reason: string }

const ANSWER_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['answer', 'page', 'quote', 'confidence', 'not_found'],
  properties: {
    answer: {
      type: ['string', 'null'],
      description: 'The answer in the language of the question, as written in the document. Null when the document does not answer it.',
    },
    page: {
      type: ['integer', 'null'],
      description: 'The page the answer stands on.',
    },
    quote: {
      type: ['string', 'null'],
      description: 'The exact sentence or fragment the answer is taken from, copied verbatim.',
    },
    confidence: {
      type: 'number',
      description: '0 to 1: how clearly the document answers the question.',
    },
    not_found: {
      type: 'boolean',
      description: 'True when the document does not contain the answer.',
    },
  },
} as const

export function buildAskSystem(company: { name: string }, fileName: string): string {
  return `You answer one question about one document in the accounting archive of ${company.name}. The document is "${fileName}". Answer only from the page text you are given: never infer, never compute, never use outside knowledge. Quote the exact fragment the answer comes from and say which page. If the document does not answer the question, say so (not_found true) and leave answer null. Never write a placeholder such as "not stated".`
}

/** The pages sent with a question: the ones asked for, else the whole document when it fits, else the pages that mention the question. */
export function selectAskPages(pages: PageText[], question: string, wanted?: number[]): PageText[] {
  if (wanted?.length) {
    const chosen: PageText[] = []
    let used = 0
    for (const page of pages.filter((p) => wanted.includes(p.pageNo))) {
      if (used + page.text.length > MAX_CHARS) break
      chosen.push(page)
      used += page.text.length
    }
    return chosen
  }
  const total = pages.reduce((n, p) => n + p.text.length, 0)
  if (total <= MAX_CHARS) return pages
  const words = question
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length >= 4)
  // A prefix stands in for a stem: "uppsägningstiden" finds "uppsägningstid".
  const stems = words.map((w) => w.slice(0, 8))
  const scored = pages.map((page) => ({
    page,
    hits: stems.filter((w) => page.text.toLowerCase().includes(w)).length,
  }))
  const chosen: PageText[] = []
  let used = 0
  for (const { page } of [...scored].sort((a, b) => b.hits - a.hits || a.page.pageNo - b.page.pageNo)) {
    if (used + page.text.length > MAX_CHARS) continue
    chosen.push(page)
    used += page.text.length
  }
  if (!chosen.some((p) => p.pageNo === pages[0].pageNo) && pages[0].text.length + used <= MAX_CHARS * 1.1) chosen.push(pages[0])
  return chosen.sort((a, b) => a.pageNo - b.pageNo)
}

/** Letters and digits only: a quote read across table cells or markdown marks still matches the page. */
const fold = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()

/** A quote stitched from fragments ("... ", "[...]") is verified when one page holds every fragment. */
export function quoteOnPage(pageText: string, quote: string): boolean {
  const fragments = quote
    .split(/\s*(?:\[\.\.\.\]|\.\.\.|…)\s*/)
    .map(fold)
    .filter((f) => f.length >= 12)
  if (fragments.length === 0) return fold(pageText).includes(fold(quote))
  const text = fold(pageText)
  return fragments.every((f) => text.includes(f))
}

export async function askDocument(
  supabase: SupabaseClient,
  input: {
    companyId: string
    documentId: string
    question: string
    pages?: number[]
    company: { name: string }
    askedBy: { agentName: string; agentVersion: string }
  },
): Promise<AskOutcome> {
  if (!getAiStatus().configured) return { status: 'skipped', reason: 'ai_unconfigured' }
  try {
    const { data: doc, error: docError } = await supabase
      .from('document_attachments')
      .select('id, file_name, page_count')
      .eq('id', input.documentId)
      .eq('company_id', input.companyId)
      .maybeSingle()
    if (docError) throw new Error(`document fetch failed: ${docError.message}`)
    if (!doc) return { status: 'skipped', reason: 'not_found' }
    const d = doc as {
      id: string
      file_name: string
      page_count: number | null
    }
    const { data: rows, error: pagesError } = await supabase
      .from('document_pages')
      .select('page_no, text, words')
      .eq('document_id', input.documentId)
      .order('page_no', { ascending: true })
    if (pagesError) throw new Error(`pages fetch failed: ${pagesError.message}`)
    const pages: PageText[] = (
      (rows ?? []) as Array<{
        page_no: number
        text: string
        words: WordBox[] | null
      }>
    ).map((p) => ({ pageNo: p.page_no, text: p.text, words: p.words }))
    if (!pages.some((p) => p.text.trim())) return { status: 'skipped', reason: 'no_text' }

    const sent = selectAskPages(pages, input.question, input.pages)
    if (sent.length === 0) return { status: 'skipped', reason: 'no_text' }
    const system = buildAskSystem(input.company, d.file_name)
    const prompt = `${sent.map((p) => `=== PAGE ${p.pageNo} ===\n${p.text}`).join('\n\n')}\n\nQUESTION: ${input.question}`
    const startedAt = new Date().toISOString()
    const result = await getAiService().generateStructured({
      tier: 'extraction',
      system,
      prompt,
      maxTokens: MAX_TOKENS,
      schema: {
        name: 'document_answer',
        description: 'The answer to one question about the document.',
        jsonSchema: ANSWER_SCHEMA,
      },
    })
    const raw = (result.value ?? {}) as {
      answer?: unknown
      page?: unknown
      quote?: unknown
      confidence?: unknown
      not_found?: unknown
    }
    const answer = typeof raw.answer === 'string' && raw.answer.trim() ? raw.answer.trim() : null
    const quote = typeof raw.quote === 'string' && raw.quote.trim() ? raw.quote.trim() : null
    const claimedPage = typeof raw.page === 'number' ? raw.page : null
    const located = locateQuote(pages, quote, claimedPage)
    const verified = quote != null && pages.some((p) => (located.page == null || p.pageNo === located.page) && quoteOnPage(p.text, quote))
    const notFound = raw.not_found === true || answer == null
    // A "not in the document" carries no page, quote or confidence, whatever the model put beside it.
    const confidence = notFound ? 0 : typeof raw.confidence === 'number' ? Math.max(0, Math.min(1, raw.confidence)) : 0.5

    await recordActivity(supabase, {
      companyId: input.companyId,
      documentId: input.documentId,
      agentId: await softwareAgent(supabase, input.askedBy.agentName, input.askedBy.agentVersion),
      kind: 'ask',
      modelIds: [result.model],
      promptSha256: createHash('sha256')
        .update(system + '\n' + prompt)
        .digest('hex'),
      startedAt,
      outcome: 'settled',
      detail: {
        question: input.question.slice(0, 500),
        answered: !notFound,
        page: notFound ? null : (located.page ?? claimedPage),
        quote_verified: !notFound && verified,
        pages_sent: sent.map((p) => p.pageNo),
      },
    })
    return {
      status: 'answered',
      answer: notFound ? null : answer,
      page: notFound ? null : (located.page ?? claimedPage),
      quote: notFound ? null : quote,
      quote_verified: !notFound && verified,
      confidence,
      pages_read: sent.map((p) => p.pageNo),
      page_count: d.page_count ?? pages.length,
      not_found: notFound,
    }
  } catch (err) {
    return {
      status: 'error',
      reason: (err instanceof Error ? err.message : String(err)).slice(0, 300),
    }
  }
}
