import { describe, it, expect, beforeEach } from 'vitest'
import { composeHandoffMessage, mergeIntoDraft, type HandoffLabels } from '../assistant-handoff'
import { clearSupportAskSession, readSupportAskSession, writeSupportAskSession } from '../assistant-session'
import { createSupportEventReader, encodeSupportEvent, type SupportStreamEvent } from '../assistant-stream'

const LABELS: HandoffLabels = {
  heading: 'Från samtalet med AI-assistenten',
  page: 'Sida',
  summary: 'AI-assistentens sammanfattning',
  you: 'Du',
  assistant: 'AI',
}

describe('the answer stream', () => {
  const events: SupportStreamEvent[] = [
    { type: 'start', conversation_id: 'c-1' },
    { type: 'text', delta: 'Under ' },
    { type: 'tools', names: ['read_page'] },
    { type: 'text', delta: 'Fakturor' },
    { type: 'done', answer: 'Under Fakturor.', handoff: null },
  ]

  it('reads back the events that were written, also when a chunk ends in the middle of a line', () => {
    const wire = events.map(encodeSupportEvent).join('')
    const seen: SupportStreamEvent[] = []
    const reader = createSupportEventReader((event) => seen.push(event))
    for (let i = 0; i < wire.length; i += 7) reader.push(wire.slice(i, i + 7))
    reader.end()
    expect(seen).toEqual(events)
  })

  it('takes a last line that came without its newline, and skips what is not an event', () => {
    const seen: SupportStreamEvent[] = []
    const reader = createSupportEventReader((event) => seen.push(event))
    reader.push('not json\n{"type":"other"}\n\n{"type":"error","message":"Försök igen."}')
    expect(seen).toEqual([])
    reader.end()
    expect(seen).toEqual([{ type: 'error', message: 'Försök igen.' }])
  })
})

describe('composeHandoffMessage', () => {
  const turns = [
    { role: 'user' as const, text: 'Var skapar jag en offert?' },
    { role: 'assistant' as const, text: 'Under Försäljning → Offerter.' },
    { role: 'user' as const, text: 'Knappen syns inte hos mig.' },
    { role: 'assistant' as const, text: 'Det kan supporten titta på.' },
  ]

  it('opens with the last question, then the page, the summary and the turns in order', () => {
    const message = composeHandoffMessage({ turns, labels: LABELS, route: '/quotes', summary: 'Knappen Ny offert saknas.' })
    expect(message.split('\n')).toEqual([
      'Knappen syns inte hos mig.',
      '',
      'Från samtalet med AI-assistenten',
      'Sida: /quotes',
      'AI-assistentens sammanfattning: Knappen Ny offert saknas.',
      '',
      'Du: Var skapar jag en offert?',
      '',
      'AI: Under Försäljning → Offerter.',
      '',
      'Du: Knappen syns inte hos mig.',
      '',
      'AI: Det kan supporten titta på.',
    ])
  })

  it('leaves out the page and the summary when there are none', () => {
    const message = composeHandoffMessage({ turns: turns.slice(0, 2), labels: LABELS })
    expect(message).not.toContain('Sida:')
    expect(message).not.toContain('sammanfattning')
    expect(message.startsWith('Var skapar jag en offert?')).toBe(true)
  })

  it('keeps the newest turns when the conversation is longer than the form', () => {
    const long = Array.from({ length: 30 }, (_, i) => ({
      role: i % 2 === 0 ? ('user' as const) : ('assistant' as const),
      text: `${i}: ${'x'.repeat(400)}`,
    }))
    const message = composeHandoffMessage({ turns: long, labels: LABELS, maxChars: 2000 })
    expect(message.length).toBeLessThanOrEqual(2000)
    expect(message).toContain('AI: 29:')
    expect(message).not.toContain('Du: 0:')
  })

  it('cuts one very long answer instead of dropping it', () => {
    const message = composeHandoffMessage({
      turns: [
        { role: 'user', text: 'Fråga' },
        { role: 'assistant', text: 'y'.repeat(5000) },
      ],
      labels: LABELS,
    })
    expect(message).toContain('AI: yyy')
    expect(message.length).toBeLessThan(1100)
  })
})

describe('mergeIntoDraft', () => {
  it('is the conversation alone when nothing was typed', () => {
    expect(mergeIntoDraft('  ', 'Samtalet')).toBe('Samtalet')
  })

  it('keeps what the user had typed first', () => {
    expect(mergeIntoDraft('Ring mig gärna.', 'Samtalet')).toBe('Ring mig gärna.\n\nSamtalet')
  })

  it('does not repeat a draft the conversation already holds, and fits the form', () => {
    expect(mergeIntoDraft('Samtalet', 'Hej\nSamtalet')).toBe('Hej\nSamtalet')
    expect(mergeIntoDraft('a', 'b'.repeat(6000))).toHaveLength(5000)
  })
})

describe('the conversation kept while the page is loaded', () => {
  beforeEach(() => clearSupportAskSession())

  it('starts empty and gives back what was written for the same company', () => {
    expect(readSupportAskSession('company-1')).toEqual({ companyId: 'company-1', conversationId: null, turns: [] })
    const session = { companyId: 'company-1', conversationId: 'c-1', turns: [{ role: 'user' as const, text: 'Hej' }] }
    writeSupportAskSession(session)
    expect(readSupportAskSession('company-1')).toEqual(session)
  })

  it('never follows the user into another company', () => {
    writeSupportAskSession({ companyId: 'company-1', conversationId: 'c-1', turns: [{ role: 'user', text: 'Hej' }] })
    expect(readSupportAskSession('company-2')).toEqual({ companyId: 'company-2', conversationId: null, turns: [] })
  })
})
