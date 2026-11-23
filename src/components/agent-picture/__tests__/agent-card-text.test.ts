/**
 * An agent card's line in words, in both languages, read from the real
 * message files.
 */
import { describe, expect, it } from 'vitest'
import { createTranslator } from 'next-intl'
import sv from '@/messages/sv.json'
import en from '@/messages/en.json'
import type { AgentCardLine } from '@/lib/agent-context/agent-cards'
import { agentCardDetail, agentLineText, type PictureMessages, type PictureWords } from '../agent-card-text'

const tSv = createTranslator({ locale: 'sv', messages: sv, namespace: 'wiki' }) as unknown as PictureMessages
const tEn = createTranslator({ locale: 'en', messages: en, namespace: 'wiki' }) as unknown as PictureMessages

const words = (locale: 'sv' | 'en'): PictureWords => ({
  time: (instant) => instant.slice(11, 16),
  when: (instant) => (locale === 'sv' ? `i dag ${instant.slice(11, 16)}` : `today ${instant.slice(11, 16)}`),
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

  it('adds how many connections the card stands for when there are several, as the part that is kept whole', () => {
    expect(agentCardDetail({ line: { kind: 'work', questions: 2, proposals: 3 }, connections: 4 }, tSv, words('sv'))).toEqual({
      lead: '2 frågor och 3 förslag i dag',
      tail: ' · 4 anslutningar',
    })
    expect(agentCardDetail({ line: { kind: 'calls', count: 14, last_call_at: '2026-03-02T14:32:00.000Z', capped: false }, connections: 2 }, tEn, words('en'))).toEqual({
      lead: '14 calls today, last 14:32',
      tail: ' · 2 connections',
    })
    expect(agentCardDetail({ line: { kind: 'last_used', at: '2026-03-02T09:12:00.000Z' }, connections: 2 }, tSv, words('sv'))).toEqual({
      lead: 'Senast använd i dag 09:12',
      tail: ' · 2 anslutningar',
    })
  })
})

describe('the count of the cards past the listed ones', () => {
  it('counts cards, with a plus', () => {
    expect(tSv('picture.agents_more', { count: 2 })).toBe('+2 till')
    expect(tEn('picture.agents_more', { count: 2 })).toBe('+2 more')
  })
})
