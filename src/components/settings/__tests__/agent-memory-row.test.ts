import { describe, expect, it } from 'vitest'
import sv from '@/messages/sv.json'
import en from '@/messages/en.json'
import { memoryLineWordsFrom, memoryRowLine, memoryRowText, memoryRowWho, type MemoryLineRow } from '../agent-memory-row'

const QUESTION = 'Leverantören drog 4 990 kr den 3 november. Vad har ändrats?'

describe('memoryRowText', () => {
  it('reads a row that an answer saved as the question, quietly, over the answer', () => {
    expect(
      memoryRowText({
        content: `${QUESTION} Svar: Årsbetalning`,
        answered_question: { question: QUESTION, answer: 'Årsbetalning' },
      }),
    ).toEqual({ main: 'Årsbetalning', quiet: QUESTION })
  })

  it('reads the same for an answer saved in English, in the words the person wrote', () => {
    expect(
      memoryRowText({
        content: 'What changed? Answer: We moved to yearly billing.',
        answered_question: { question: 'What changed?', answer: 'We moved to yearly billing.' },
      }),
    ).toEqual({ main: 'We moved to yearly billing.', quiet: 'What changed?' })
  })

  it('reads a row without a question as its stored text', () => {
    expect(memoryRowText({ content: 'Räkenskapsår jan-dec' })).toEqual({ main: 'Räkenskapsår jan-dec', quiet: null })
    expect(memoryRowText({ content: 'Räkenskapsår jan-dec', answered_question: null })).toEqual({ main: 'Räkenskapsår jan-dec', quiet: null })
  })

  it('reads a row whose stored text was changed after the answer as the stored text', () => {
    const edited = `${QUESTION} Svar: Årsbetalning från 2027.`
    expect(memoryRowText({ content: edited, answered_question: { question: QUESTION, answer: 'Årsbetalning' } })).toEqual({
      main: edited,
      quiet: null,
    })
  })

  it('reads a fact worded another way as the stored text, though a question names it', () => {
    const fact = 'Leverantören tar betalt per år sedan november.'
    expect(memoryRowText({ content: fact, answered_question: { question: QUESTION, answer: 'Årsbetalning' } })).toEqual({
      main: fact,
      quiet: null,
    })
  })
})

/** A translator over one message namespace, the way next-intl fills {placeholders}. */
function translator(messages: Record<string, unknown>) {
  return (key: string, values: Record<string, string> = {}) =>
    String(messages[key]).replace(/\{(\w+)\}/g, (_, name: string) => values[name] ?? `{${name}}`)
}

interface Catalog {
  settings: Record<string, unknown>
  agentKnowledge: Record<string, unknown>
  attribution: Record<string, unknown>
}
const wordsOf = (messages: Catalog) =>
  memoryLineWordsFrom({
    settings: translator(messages.settings),
    knowledge: translator(messages.agentKnowledge),
    attribution: translator(messages.attribution),
  })
const svWords = wordsOf(sv)
const enWords = wordsOf(en)

const SAVED = '2026-08-07T12:00:00Z'
const ANNA = { name: 'Anna Andersson', deleted: false }

const lineRow = (overrides: Partial<MemoryLineRow> = {}): MemoryLineRow => ({
  kind: 'fact',
  source: 'user_taught',
  client: null,
  created_by: ANNA,
  created_at: SAVED,
  is_active: true,
  ...overrides,
})

/** The line in Swedish and in English. */
const lines = (row: MemoryLineRow) => [memoryRowLine(row, svWords, 'sv'), memoryRowLine(row, enWords, 'en')]

describe('memoryRowLine', () => {
  it('says the person and the date for a fact a person saved', () => {
    expect(lines(lineRow({ created_at: '2026-11-23T12:00:00Z' }))).toEqual([
      'Anna Andersson · 23 nov. 2026',
      'Anna Andersson · Nov 23, 2026',
    ])
  })

  it('says the connection and the person it acted for', () => {
    expect(lines(lineRow({ source: 'agent_learned' }))).toEqual([
      'AI-anslutning åt Anna Andersson · 7 aug. 2026',
      'AI connection for Anna Andersson · Aug 7, 2026',
    ])
    expect(lines(lineRow({ source: 'agent_learned', client: 'claude-connector', created_by: { name: 'Jonas Ek', deleted: false } }))).toEqual([
      'Claude åt Jonas Ek · 7 aug. 2026',
      'Claude for Jonas Ek · Aug 7, 2026',
    ])
  })

  it('names no later change, whatever the row\'s own stamp says: it also moves when the row is pinned, hidden or read', () => {
    /** A row as the panel hands it in, with the stamp the table keeps. */
    const stamped = (updated_at: string, overrides: Partial<MemoryLineRow> = {}): MemoryLineRow & { updated_at: string } => ({ ...lineRow(overrides), updated_at })
    // A later day, the same day, an earlier one and a stamp that cannot be read: the line is who and when it was saved.
    for (const stamp of ['2026-10-20T12:00:00Z', '2026-08-07T12:30:00Z', '2026-08-01T12:00:00Z', '']) {
      expect(lines(stamped(stamp)), stamp).toEqual(['Anna Andersson · 7 aug. 2026', 'Anna Andersson · Aug 7, 2026'])
    }
    expect(lines(stamped('2026-10-20T12:00:00Z', { source: 'agent_learned' }))).toEqual([
      'AI-anslutning åt Anna Andersson · 7 aug. 2026',
      'AI connection for Anna Andersson · Aug 7, 2026',
    ])
    // The kind and the hidden mark stand as before; the later day is in neither.
    expect(lines(stamped('2026-10-20T12:00:00Z', { kind: 'pattern', is_active: false }))).toEqual([
      'Mönster · Anna Andersson · 7 aug. 2026 · dold',
      'Pattern · Anna Andersson · Aug 7, 2026 · hidden',
    ])
    // The words for it are gone from both languages.
    expect(sv.settings).not.toHaveProperty('memory_updated')
    expect(en.settings).not.toHaveProperty('memory_updated')
  })

  it('names the kind only on a row that is not a plain fact', () => {
    expect(lines(lineRow({ kind: 'pattern', source: 'agent_learned' }))).toEqual([
      'Mönster · AI-anslutning åt Anna Andersson · 7 aug. 2026',
      'Pattern · AI connection for Anna Andersson · Aug 7, 2026',
    ])
    expect(lines(lineRow({ kind: 'preference' }))).toEqual(['Preferens · Anna Andersson · 7 aug. 2026', 'Preference · Anna Andersson · Aug 7, 2026'])
    expect(lines(lineRow({ kind: 'correction' }))).toEqual(['Korrigering · Anna Andersson · 7 aug. 2026', 'Correction · Anna Andersson · Aug 7, 2026'])
  })

  it('says nothing that is the same on every row', () => {
    const all = [
      ...lines(lineRow()),
      ...lines(lineRow({ source: 'agent_learned', client: 'chatgpt' })),
      ...lines(lineRow({ kind: 'pattern' })),
    ].join(' | ')
    for (const word of ['Fakta', 'Fact', 'Du lärde mig', 'You taught me', 'Jag noterade', 'I noted', 'Sparad av', 'Saved by', 'uppdaterad', 'updated']) {
      expect(all).not.toContain(word)
    }
  })

  it('marks a hidden row', () => {
    expect(lines(lineRow({ is_active: false }))).toEqual(['Anna Andersson · 7 aug. 2026 · dold', 'Anna Andersson · Aug 7, 2026 · hidden'])
  })

  it('says where a row came from when neither a person nor a connection saved it, and only the date when nothing is known', () => {
    expect(lines(lineRow({ source: 'composer', created_by: null }))).toEqual(['Inläst vid uppstart · 7 aug. 2026', 'Loaded at startup · Aug 7, 2026'])
    expect(lines(lineRow({ source: 'derived', created_by: undefined }))).toEqual(['Härlett · 7 aug. 2026', 'Derived · Aug 7, 2026'])
    expect(lines(lineRow({ source: 'composer' }))).toEqual(['Anna Andersson · 7 aug. 2026', 'Anna Andersson · Aug 7, 2026'])
    expect(lines(lineRow({ created_by: null }))).toEqual(['7 aug. 2026', 'Aug 7, 2026'])
  })
})

describe('memoryRowWho', () => {
  it('names a person whose account is deleted, and never by a stored name', () => {
    const gone = { name: null, deleted: true }
    expect(memoryRowWho(lineRow({ created_by: gone }), svWords)).toBe('En borttagen användare')
    expect(memoryRowWho(lineRow({ created_by: gone }), enWords)).toBe('A deleted user')
    expect(memoryRowWho(lineRow({ source: 'agent_learned', client: 'chatgpt', created_by: gone }), svWords)).toBe('ChatGPT åt en borttagen användare')
    expect(memoryRowWho(lineRow({ source: 'agent_learned', client: 'chatgpt', created_by: gone }), enWords)).toBe('ChatGPT for a deleted user')
  })

  it('names a person without a recorded name as a user', () => {
    expect(memoryRowWho(lineRow({ created_by: { name: null, deleted: false } }), svWords)).toBe('En användare')
    expect(memoryRowWho(lineRow({ created_by: { name: null, deleted: false } }), enWords)).toBe('A user')
  })

  it('names the connection alone when its row records no person, and no one when a row records nothing', () => {
    expect(memoryRowWho(lineRow({ source: 'agent_learned', created_by: null }), svWords)).toBe('AI-anslutning')
    expect(memoryRowWho(lineRow({ source: 'agent_learned', client: 'claude-code', created_by: null }), enWords)).toBe('Claude Code')
    // A row written through MCP carries the client label, whatever its source.
    expect(memoryRowWho(lineRow({ client: 'cursor' }), svWords)).toBe('Cursor åt Anna Andersson')
    expect(memoryRowWho(lineRow({ created_by: null }), svWords)).toBeNull()
  })
})
