/**
 * An agent card's line in words, in both languages, read from the real
 * message files.
 */
import { describe, expect, it } from 'vitest'
import { createTranslator } from 'next-intl'
import sv from '@/messages/sv.json'
import en from '@/messages/en.json'
import type { AgentCardLine } from '@/lib/agent-context/agent-cards'
import { agentCardDetail, agentLineText, agentShortLineText, shortDay, CARD_LINE_BUDGET, type CardWords, type PictureMessages } from '../agent-card-text'

const tSv = createTranslator({ locale: 'sv', messages: sv, namespace: 'wiki' }) as unknown as PictureMessages
const tEn = createTranslator({ locale: 'en', messages: en, namespace: 'wiki' }) as unknown as PictureMessages

// A Monday in March, Swedish time.
const NOW = new Date('2026-03-02T09:00:00.000Z')
const TODAY: Record<'sv' | 'en', string> = { sv: 'i dag', en: 'today' }
const words = (locale: 'sv' | 'en'): CardWords => ({
  time: (instant) => instant.slice(11, 16),
  when: (instant) => (locale === 'sv' ? `i dag ${instant.slice(11, 16)}` : `today ${instant.slice(11, 16)}`),
  day: (instant) => shortDay(instant, NOW, locale, TODAY[locale]),
})
const both = (line: AgentCardLine): [string, string] => [agentLineText(line, tSv, words('sv')), agentLineText(line, tEn, words('en'))]

describe('what an agent card\'s line says', () => {
  it('says that the card is reading now', () => {
    expect(both({ kind: 'reading' })).toEqual(['Läser nu', 'Reading now'])
  })

  it('says the questions asked and the proposals prepared today', () => {
    expect(both({ kind: 'work', questions: 2, proposals: 3 })).toEqual(['2 frågor och 3 förslag i dag', '2 questions and 3 proposals today'])
    expect(both({ kind: 'work', questions: 1, proposals: 1 })).toEqual(['1 fråga och 1 förslag i dag', '1 question and 1 proposal today'])
  })

  it('says the questions alone, or the proposals alone, when the card did only the one', () => {
    expect(both({ kind: 'work', questions: 1, proposals: 0 })).toEqual(['1 fråga i dag', '1 question today'])
    expect(both({ kind: 'work', questions: 4, proposals: 0 })).toEqual(['4 frågor i dag', '4 questions today'])
    expect(both({ kind: 'work', questions: 0, proposals: 1 })).toEqual(['1 förslag i dag', '1 proposal today'])
    expect(both({ kind: 'work', questions: 0, proposals: 12 })).toEqual(['12 förslag i dag', '12 proposals today'])
  })

  it('says the calls of the day with the time of the last one, as before', () => {
    expect(both({ kind: 'calls', count: 14, last_call_at: '2026-03-02T14:32:00.000Z', capped: false })).toEqual(['14 anrop i dag, senast 14:32', '14 calls today, last 14:32'])
    expect(both({ kind: 'calls', count: 1, last_call_at: '2026-03-02T14:32:00.000Z', capped: false })).toEqual(['1 anrop i dag, senast 14:32', '1 call today, last 14:32'])
    expect(agentLineText({ kind: 'calls', count: 1000, last_call_at: '2026-03-02T14:32:00.000Z', capped: true }, tSv, words('sv'))).toMatch(/^Över 1\s000 anrop i dag, senast 14:32$/)
    expect(agentLineText({ kind: 'calls', count: 1000, last_call_at: '2026-03-02T14:32:00.000Z', capped: true }, tEn, words('en'))).toBe('Over 1,000 calls today, last 14:32')
  })

  it('says when the card was last used, or that it never was', () => {
    expect(both({ kind: 'last_used', at: '2026-03-02T09:12:00.000Z' })).toEqual(['Senast använd i dag 09:12', 'Last used today 09:12'])
    expect(both({ kind: 'never_used' })).toEqual(['Aldrig använd', 'Never used'])
  })
})

describe('an agent card\'s detail line', () => {
  it('is the line alone for a card that stands for one connection', () => {
    expect(agentCardDetail({ line: { kind: 'work', questions: 2, proposals: 3 }, connections: 1 }, tSv, words('sv'))).toEqual({ lead: '2 frågor och 3 förslag i dag' })
    expect(agentCardDetail({ line: { kind: 'never_used' }, connections: 1 }, tEn, words('en'))).toEqual({ lead: 'Never used' })
  })

  it('keeps the full wording for one connection: the calls with the time of the last one, the last use with its time', () => {
    expect(agentCardDetail({ line: { kind: 'calls', count: 14, last_call_at: '2026-03-02T14:32:00.000Z', capped: false }, connections: 1 }, tSv, words('sv'))).toEqual({ lead: '14 anrop i dag, senast 14:32' })
    expect(agentCardDetail({ line: { kind: 'last_used', at: '2026-03-02T09:12:00.000Z' }, connections: 1 }, tSv, words('sv'))).toEqual({ lead: 'Senast använd i dag 09:12' })
  })

  it('puts how many connections the card stands for on a row of its own when there are several, under the line in its short wording', () => {
    expect(agentCardDetail({ line: { kind: 'work', questions: 2, proposals: 3 }, connections: 4 }, tSv, words('sv'))).toEqual({
      lead: '2 frågor, 3 förslag',
      under: '4 anslutningar',
    })
    expect(agentCardDetail({ line: { kind: 'calls', count: 14, last_call_at: '2026-03-02T14:32:00.000Z', capped: false }, connections: 2 }, tEn, words('en'))).toEqual({
      lead: '14 calls today',
      under: '2 connections',
    })
    expect(agentCardDetail({ line: { kind: 'last_used', at: '2026-03-02T09:12:00.000Z' }, connections: 5 }, tSv, words('sv'))).toEqual({
      lead: 'Senast använd i dag',
      under: '5 anslutningar',
    })
    // The line and the count never share a row: nothing is kept whole at the cost of the line.
    expect(agentCardDetail({ line: { kind: 'reading' }, connections: 2 }, tSv, words('sv'))).not.toHaveProperty('tail')
  })
})

describe('a day in few words', () => {
  it('says today, a day of this year by its day and month, and a day of another year by the year', () => {
    expect(shortDay('2026-03-02T07:00:00.000Z', NOW, 'sv', 'i dag')).toBe('i dag')
    expect(shortDay('2026-01-14T07:00:00.000Z', NOW, 'sv', 'i dag')).toBe('14 jan.')
    expect(shortDay('2025-11-03T07:00:00.000Z', NOW, 'sv', 'i dag')).toBe('2025')
    expect(shortDay('2026-01-14T07:00:00.000Z', NOW, 'en', 'today')).toBe('14 Jan')
    expect(shortDay('2025-11-03T07:00:00.000Z', NOW, 'en', 'today')).toBe('2025')
    // The day is the Swedish one: 23:30 UTC on New Year's Eve is already the new year in Stockholm.
    expect(shortDay('2025-12-31T23:30:00.000Z', NOW, 'sv', 'i dag')).toBe('1 jan.')
    expect(shortDay('not a date', NOW, 'sv', 'i dag')).toBe('')
  })
})

describe('the text of a card that stands for several connections, against the room the card has', () => {
  // What each case can hold at most: three questions are filed for a company in a day, the day's
  // proposals are read up to 5 000 rows and the day's calls up to 1 000.
  const QUESTIONS = 3
  const PROPOSALS = 5000
  const CALLS = 1000
  const CONNECTIONS = 999
  const LOCALES: Array<'sv' | 'en'> = ['sv', 'en']
  const t: Record<'sv' | 'en', PictureMessages> = { sv: tSv, en: tEn }

  /** Every day of the year before, of this year and today: the last use that is longest to say is among them. */
  const days: string[] = []
  for (let at = Date.parse('2025-01-01T11:00:00.000Z'); at <= NOW.getTime(); at += 24 * 60 * 60 * 1000) days.push(new Date(at).toISOString())

  /** The lines a case can produce: for the last use, one per day. */
  const cases: Array<{ name: string; lines: AgentCardLine[] }> = [
    { name: 'reading now', lines: [{ kind: 'reading' }] },
    { name: 'questions and proposals', lines: [{ kind: 'work', questions: QUESTIONS, proposals: PROPOSALS }] },
    { name: 'questions alone', lines: [{ kind: 'work', questions: QUESTIONS, proposals: 0 }] },
    { name: 'proposals alone', lines: [{ kind: 'work', questions: 0, proposals: PROPOSALS }] },
    { name: 'the calls of the day', lines: [{ kind: 'calls', count: CALLS - 1, last_call_at: '2026-03-02T08:59:00.000Z', capped: false }] },
    { name: 'more calls than were read', lines: [{ kind: 'calls', count: CALLS, last_call_at: '2026-03-02T08:59:00.000Z', capped: true }] },
    { name: 'last used', lines: days.map((at): AgentCardLine => ({ kind: 'last_used', at })) },
    { name: 'never used', lines: [{ kind: 'never_used' }] },
  ]

  it('states the room as 23 characters', () => {
    expect(CARD_LINE_BUDGET).toBe(23)
  })

  for (const locale of LOCALES) {
    for (const { name, lines } of cases) {
      it(`fits the longest line of "${name}" in ${locale}`, () => {
        const longest = lines.map((line) => agentShortLineText(line, t[locale], words(locale))).reduce((a, b) => (b.length > a.length ? b : a))
        expect(longest.length, longest).toBeLessThanOrEqual(CARD_LINE_BUDGET)
        // The card's own text is that line, with the count on the row under it.
        const detail = agentCardDetail({ line: lines[0], connections: CONNECTIONS }, t[locale], words(locale))
        expect(detail.under!.length, detail.under).toBeLessThanOrEqual(CARD_LINE_BUDGET)
      })
    }

    it(`would not fit the full wording with the count after it in ${locale}: the reason the count has a row of its own`, () => {
      const full = `${agentLineText({ kind: 'calls', count: 2, last_call_at: '2026-03-02T08:59:00.000Z', capped: false }, t[locale], words(locale))} · ${t[locale]('picture.agent_connections', { count: 4 })}`
      expect(full.length).toBeGreaterThan(CARD_LINE_BUDGET)
    })
  }

  it('says the longest lines in the words the card shows', () => {
    expect(agentShortLineText({ kind: 'work', questions: QUESTIONS, proposals: PROPOSALS }, tSv, words('sv'))).toMatch(/^3 frågor, 5\s000 förslag$/)
    expect(agentShortLineText({ kind: 'work', questions: QUESTIONS, proposals: PROPOSALS }, tEn, words('en'))).toBe('3 asked, 5,000 proposed')
    expect(agentShortLineText({ kind: 'work', questions: 1, proposals: 1 }, tSv, words('sv'))).toBe('1 fråga, 1 förslag')
    expect(agentShortLineText({ kind: 'calls', count: CALLS, last_call_at: '2026-03-02T08:59:00.000Z', capped: true }, tSv, words('sv'))).toMatch(/^Över 1\s000 anrop i dag$/)
    expect(agentShortLineText({ kind: 'calls', count: 1, last_call_at: '2026-03-02T08:59:00.000Z', capped: false }, tEn, words('en'))).toBe('1 call today')
    expect(agentShortLineText({ kind: 'last_used', at: '2026-01-14T07:00:00.000Z' }, tSv, words('sv'))).toBe('Senast använd 14 jan.')
    expect(agentShortLineText({ kind: 'last_used', at: '2025-11-03T07:00:00.000Z' }, tEn, words('en'))).toBe('Last used 2025')
    // The cases that are short as they stand keep their words.
    expect(agentShortLineText({ kind: 'reading' }, tSv, words('sv'))).toBe('Läser nu')
    expect(agentShortLineText({ kind: 'work', questions: 0, proposals: 12 }, tSv, words('sv'))).toBe('12 förslag i dag')
    expect(agentShortLineText({ kind: 'never_used' }, tEn, words('en'))).toBe('Never used')
  })
})

describe('the count of the cards past the listed ones', () => {
  it('counts cards, with a plus', () => {
    expect(tSv('picture.agents_more', { count: 2 })).toBe('+2 till')
    expect(tEn('picture.agents_more', { count: 2 })).toBe('+2 more')
  })
})

describe('the card of the connections the person may not list', () => {
  const sentence = (t: PictureMessages, count: number): string => `${t('picture.agents_others', { count })} ${t('picture.agents_others_by', { count })}`

  it('says how many connections other people have made, in the singular and the plural', () => {
    expect(sentence(tSv, 3)).toBe('3 anslutningar som andra har kopplat')
    expect(sentence(tSv, 1)).toBe('1 anslutning som någon annan har kopplat')
    expect(sentence(tEn, 3)).toBe('3 connections made by others')
    expect(sentence(tEn, 1)).toBe('1 connection made by someone else')
  })
})
