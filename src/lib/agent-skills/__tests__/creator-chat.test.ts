import { describe, expect, it, vi } from 'vitest'
import type { AiService } from '@/lib/ai'
import { draftCreatorStep, CreatorDraftError, type CreatorDraftInput } from '../creator-chat'

const input: CreatorDraftInput = { client: 'Claude', locale: 'sv', description: 'Gå igenom leverantörsfakturorna varje månad.', turns: [], extra: [], summarize: false }
const nulls = { question: null, topic: null, suggestions: null, name: null, lede: null, steps: null, rules: null, facts: null }
const summary = { ...nulls, kind: 'summary', name: 'Månadens fakturor', lede: 'Varje månad.', steps: ['Hämta.', 'Kolla.'], rules: [], facts: ['Varje månad'] }

function service(value: unknown) {
  const generateStructured = vi.fn().mockResolvedValue({ value, model: 'm', usage: {} })
  return { ai: { generateStructured } as unknown as AiService, generateStructured }
}

describe('draftCreatorStep', () => {
  it('returns a cleaned question with at most three suggestions', async () => {
    const { ai } = service({ ...nulls, kind: 'question', question: 'Alla <b>leverantörer</b>?', topic: 'Leverantörer', suggestions: ['Alla', 'Några', 'Inga', 'Fler', 7] })
    expect(await draftCreatorStep(ai, input)).toEqual({ kind: 'question', question: 'Alla bleverantörer/b?', topic: 'Leverantörer', suggestions: ['Alla', 'Några', 'Inga'] })
  })

  it('returns the summary when the model is done', async () => {
    const { ai } = service(summary)
    expect(await draftCreatorStep(ai, input)).toMatchObject({ kind: 'summary', name: 'Månadens fakturor', steps: ['Hämta.', 'Kolla.'] })
  })

  it('asks for the summary once three questions are answered, and ignores a fourth question', async () => {
    const turns = [1, 2, 3].map((n) => ({ question: `Fråga ${n}`, answer: 'Ja' }))
    const { ai, generateStructured } = service({ ...summary, kind: 'question', question: 'En till?', topic: 'Mer', suggestions: [] })
    expect((await draftCreatorStep(ai, { ...input, turns })).kind).toBe('summary')
    expect(generateStructured.mock.calls[0][0].system).toContain('Answer with kind "summary"')
    expect(generateStructured.mock.calls[0][0].prompt).toContain('Question 3: Fråga 3\nAnswer: Ja')
  })

  it('throws when the answer is neither a question nor a summary', async () => {
    const { ai } = service({ ...nulls, kind: 'summary', name: 'X' })
    await expect(draftCreatorStep(ai, input)).rejects.toBeInstanceOf(CreatorDraftError)
  })
})
