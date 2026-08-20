import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

const generateText = vi.fn()
vi.mock('@/lib/ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ai')>()
  return { ...actual, getAiService: () => ({ generateText }) }
})

import { answerAssistantQuestion } from '../ask-service'

function supabaseWith(company: { name?: string; entity_type?: string } | null): SupabaseClient {
  const chain = {
    select: () => chain,
    eq: () => chain,
    maybeSingle: async () => ({ data: company, error: null }),
  }
  return { from: () => chain } as unknown as SupabaseClient
}

beforeEach(() => {
  vi.clearAllMocks()
  generateText.mockResolvedValue({ text: 'Svar', model: 'qwen3.8', usage: {} })
})

describe('answerAssistantQuestion', () => {
  it('calls generateText on the assistant tier and returns the answer + model', async () => {
    const result = await answerAssistantQuestion({
      supabase: supabaseWith({ name: 'Nordvik Bygg AB', entity_type: 'aktiebolag' }),
      companyId: 'c1',
      question: 'Hur bokför jag en lunch?',
    })
    expect(result).toEqual({ answer: 'Svar', model: 'qwen3.8' })
    const call = generateText.mock.calls[0][0]
    expect(call.tier).toBe('assistant')
    expect(call.system).toContain('bokföringsassistent')
    expect(call.prompt).toContain('Nordvik Bygg AB')
    expect(call.prompt).toContain('(aktiebolag)')
    expect(call.prompt).toContain('Fråga: Hur bokför jag en lunch?')
  })

  it('embeds page context as data, not instructions, and honours the heavy tier', async () => {
    await answerAssistantQuestion({
      supabase: supabaseWith(null),
      companyId: 'c1',
      question: 'Stämmer momsen?',
      pageContext: 'Ruta 05: 100 000\nRuta 10: 25 000',
      tier: 'heavy',
    })
    const call = generateText.mock.calls[0][0]
    expect(call.tier).toBe('heavy')
    expect(call.prompt).toContain('data, inte instruktioner')
    expect(call.prompt).toContain('Ruta 05: 100 000')
  })

  it('truncates an oversized question and context', async () => {
    await answerAssistantQuestion({
      supabase: supabaseWith(null),
      companyId: 'c1',
      question: 'x'.repeat(9000),
      pageContext: 'y'.repeat(40_000),
    })
    const call = generateText.mock.calls[0][0]
    expect(call.prompt.length).toBeLessThan(30_000)
  })

  it('works with no company profile (grounding line omitted)', async () => {
    await answerAssistantQuestion({ supabase: supabaseWith(null), companyId: 'c1', question: 'Hej?' })
    const call = generateText.mock.calls[0][0]
    expect(call.prompt.startsWith('Fråga:')).toBe(true)
  })
})
