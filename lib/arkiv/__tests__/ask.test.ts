import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createQueuedMockSupabase } from '@/tests/helpers'

const generateStructured = vi.fn()
vi.mock('@/lib/ai', () => ({
  getAiService: () => ({ generateStructured }),
  getAiStatus: vi.fn(() => ({ configured: true })),
}))
vi.mock('@/lib/arkiv/usage', () => ({ recordArkivUsage: vi.fn(async () => undefined) }))
vi.mock('@/lib/documents/provenance', () => ({
  recordActivity: vi.fn(async () => 'act-1'),
  softwareAgent: vi.fn(async () => 'agent-ask'),
}))

import { askDocument, buildAskSystem, quoteOnPage, selectAskPages } from '../ask'
import { recordActivity } from '@/lib/documents/provenance'
import { getAiStatus } from '@/lib/ai'

const mock = createQueuedMockSupabase()
const { enqueue, reset } = mock
const supabase = mock.supabase as unknown as SupabaseClient
const doc = { id: 'doc-1', file_name: 'Core Contract.pdf', page_count: 2 }
const pages = [
  {
    page_no: 1,
    text: 'Core programme agreement between Sting and the Company.',
    words: null,
  },
  {
    page_no: 2,
    text: 'Either party may terminate this agreement with three (3) months written notice.',
    words: null,
  },
]
const ask = (question: string) =>
  askDocument(supabase, {
    companyId: 'co-1',
    documentId: 'doc-1',
    question,
    company: { name: 'Arcim Technology AB' },
    askedBy: { agentName: 'mcp.ask', agentVersion: '1' },
  })

beforeEach(() => {
  reset()
  generateStructured.mockReset()
  ;(getAiStatus as ReturnType<typeof vi.fn>).mockReturnValue({
    configured: true,
  })
})

describe('askDocument', () => {
  it('answers from the text with the page and a verified quote, and records the question', async () => {
    enqueue({ data: doc })
    enqueue({ data: pages })
    generateStructured.mockResolvedValue({
      model: 'sonnet',
      value: {
        answer: 'Three months written notice',
        page: 2,
        quote: 'three (3) months written notice',
        confidence: 0.9,
        not_found: false,
      },
    })
    const out = await ask('What is the notice period?')
    expect(out).toEqual({
      status: 'answered',
      answer: 'Three months written notice',
      page: 2,
      quote: 'three (3) months written notice',
      quote_verified: true,
      confidence: 0.9,
      pages_read: [1, 2],
      page_count: 2,
      not_found: false,
    })
    const call = generateStructured.mock.calls[0][0] as {
      system: string
      prompt: string
      tier: string
    }
    expect(call.tier).toBe('extraction')
    expect(call.system).toContain('Core Contract.pdf')
    expect(call.prompt).toContain('=== PAGE 2 ===')
    expect(call.prompt).toContain('QUESTION: What is the notice period?')
    expect(recordActivity).toHaveBeenCalledWith(
      supabase,
      expect.objectContaining({
        kind: 'ask',
        agentId: 'agent-ask',
        detail: expect.objectContaining({
          question: 'What is the notice period?',
          answered: true,
          page: 2,
          quote_verified: true,
        }),
      }),
    )
  })

  it('says not found honestly and flags a quote the document does not contain', async () => {
    enqueue({ data: doc })
    enqueue({ data: pages })
    generateStructured.mockResolvedValue({
      model: 'sonnet',
      value: {
        answer: null,
        page: null,
        quote: null,
        confidence: 0.1,
        not_found: true,
      },
    })
    expect(await ask('What is the rent?')).toMatchObject({
      status: 'answered',
      answer: null,
      not_found: true,
      quote: null,
      page: null,
      quote_verified: false,
      confidence: 0,
    })

    enqueue({ data: doc })
    enqueue({ data: pages })
    generateStructured.mockResolvedValue({
      model: 'sonnet',
      value: {
        answer: 'Six months',
        page: 2,
        quote: 'six months notice',
        confidence: 0.8,
        not_found: false,
      },
    })
    expect(await ask('Notice?')).toMatchObject({
      status: 'answered',
      answer: 'Six months',
      quote_verified: false,
    })
  })

  it('skips without a model, a document, or text, and reports a failing model as an error', async () => {
    ;(getAiStatus as ReturnType<typeof vi.fn>).mockReturnValueOnce({
      configured: false,
    })
    expect(await ask('x')).toEqual({
      status: 'skipped',
      reason: 'ai_unconfigured',
    })
    enqueue({ data: null })
    expect(await ask('x')).toEqual({ status: 'skipped', reason: 'not_found' })
    enqueue({ data: doc })
    enqueue({ data: [{ page_no: 1, text: '   ', words: null }] })
    expect(await ask('x')).toEqual({ status: 'skipped', reason: 'no_text' })
    enqueue({ data: doc })
    enqueue({ data: pages })
    generateStructured.mockRejectedValue(new Error('throttled'))
    expect(await ask('x')).toEqual({ status: 'error', reason: 'throttled' })
  })
})

describe('quoteOnPage', () => {
  it('accepts a verbatim quote and one stitched from fragments of the same page, and refuses an invented one', () => {
    const page = 'Räntesats fn 2025-11-27: Intervall 1 - 60 11,10 %. Kredittid: 60 månader. Förfallodagar för betalning av ränta och amortering: den sista varje månad.'
    expect(quoteOnPage(page, 'Kredittid: 60 månader')).toBe(true)
    expect(quoteOnPage(page, 'Intervall 1 - 60 11,10 % ... Kredittid: 60 månader [...] den sista varje månad')).toBe(true)
    expect(quoteOnPage(page, 'Intervall 1 - 60 11,10 % ... Kredittid: 72 månader')).toBe(false)
    // The page is a markdown table; the model quotes across the cells.
    expect(quoteOnPage('Kreditbelopp: | 500 000 kr\nKredittid: | 60 månader\n**Räntesats fn 2025-11-27:** | 11,10%', 'Kredittid: 60 månader ... Räntesats fn 2025-11-27: 11,10 %')).toBe(true)
  })
})

describe('selectAskPages', () => {
  it('sends everything when it fits and the pages that mention the question otherwise', () => {
    const small = pages.map((p) => ({
      pageNo: p.page_no,
      text: p.text,
      words: null,
    }))
    expect(selectAskPages(small, 'notice').map((p) => p.pageNo)).toEqual([1, 2])
    const big = Array.from({ length: 8 }, (_, i) => ({
      pageNo: i + 1,
      text: (i === 5 ? 'uppsägningstid tre månader ' : 'lorem ') + 'x'.repeat(12_000),
      words: null,
    }))
    const chosen = selectAskPages(big, 'Vad är uppsägningstiden?').map((p) => p.pageNo)
    expect(chosen).toContain(6)
    expect(chosen).toContain(1)
    expect(chosen.length).toBeLessThan(8)
    // An agent that saw pages_read and page_count asks for the rest by number.
    expect(selectAskPages(big, 'Vad är uppsägningstiden?', [7, 8, 99]).map((p) => p.pageNo)).toEqual([7, 8])
    expect(buildAskSystem({ name: 'Arcim' }, 'a.pdf')).toContain('never compute')
  })
})
