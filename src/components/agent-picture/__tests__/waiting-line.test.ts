/**
 * The line under the company's name: what waits on the company's people.
 * Which parts it names, where each leads, and its words in both languages,
 * rendered with the real message files. The counts themselves come from the
 * counters Hem and the menu read (the picture's route test pins that).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement, type ComponentProps } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { NextIntlClientProvider } from 'next-intl'
import sv from '@/messages/sv.json'
import en from '@/messages/en.json'
import { createTableMockSupabase } from '@/tests/helpers'
import { waitingLine } from '@/lib/agent-context/agent-picture-view'
import type { PictureWaiting } from '@/lib/agent-context/agent-picture'
import { countOpenQuestions } from '@/lib/questions/app-answer'
import { WaitingLine } from '../WaitingLine'

const IntlProvider = NextIntlClientProvider as (props: Omit<ComponentProps<typeof NextIntlClientProvider>, 'children'>) => ReturnType<typeof NextIntlClientProvider>

function render(waiting: PictureWaiting | null, locale: 'sv' | 'en' = 'sv'): string {
  return renderToStaticMarkup(createElement(IntlProvider, { locale, messages: locale === 'sv' ? sv : en }, createElement(WaitingLine, { waiting })))
}
/** The text between the tags of some markup. */
const textOf = (html: string): string =>
  html
    .split('<')
    .map((part, index) => (index === 0 ? part : part.slice(part.indexOf('>') + 1)))
    .join('')
const linksOf = (html: string): Array<[string, string]> => [...html.matchAll(/<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)].map((m) => [m[1], textOf(m[2])])

describe('waitingLine', () => {
  it('names the questions and the proposals when both wait', () => {
    expect(waitingLine({ questions: 2, proposals: 3 })).toEqual({ kind: 'both', questions: 2, proposals: 3 })
  })

  it('names the one that waits when only one does', () => {
    expect(waitingLine({ questions: 2, proposals: 0 })).toEqual({ kind: 'questions', count: 2 })
    expect(waitingLine({ questions: 0, proposals: 3 })).toEqual({ kind: 'proposals', count: 3 })
  })

  it('is no line when nothing waits, and when what waits was not counted', () => {
    expect(waitingLine({ questions: 0, proposals: 0 })).toBeNull()
    expect(waitingLine(null)).toBeNull()
    expect(waitingLine(undefined)).toBeNull()
  })
})

describe('the waiting line of the company card', () => {
  it('says how many questions and proposals wait, each part leading to its page', () => {
    const html = render({ questions: 2, proposals: 3 })
    expect(textOf(html)).toBe('2 frågor och 3 förslag väntar på dig')
    expect(linksOf(html)).toEqual([
      ['/questions', '2 frågor'],
      ['/pending', '3 förslag'],
    ])
    const english = render({ questions: 2, proposals: 3 }, 'en')
    expect(textOf(english)).toBe('2 questions and 3 proposals wait for you')
    expect(linksOf(english)).toEqual([
      ['/questions', '2 questions'],
      ['/pending', '3 proposals'],
    ])
    expect(textOf(render({ questions: 1, proposals: 1 }))).toBe('1 fråga och 1 förslag väntar på dig')
    expect(textOf(render({ questions: 1, proposals: 1 }, 'en'))).toBe('1 question and 1 proposal wait for you')
  })

  it('says the questions alone when no proposal waits', () => {
    const html = render({ questions: 2, proposals: 0 })
    expect(textOf(html)).toBe('2 frågor väntar på dig')
    expect(linksOf(html)).toEqual([['/questions', '2 frågor']])
    expect(textOf(render({ questions: 1, proposals: 0 }))).toBe('1 fråga väntar på dig')
    expect(textOf(render({ questions: 2, proposals: 0 }, 'en'))).toBe('2 questions wait for you')
    expect(textOf(render({ questions: 1, proposals: 0 }, 'en'))).toBe('1 question waits for you')
  })

  it('says the proposals alone when no question waits', () => {
    const html = render({ questions: 0, proposals: 3 })
    expect(textOf(html)).toBe('3 förslag väntar på dig')
    expect(linksOf(html)).toEqual([['/pending', '3 förslag']])
    expect(textOf(render({ questions: 0, proposals: 1 }))).toBe('1 förslag väntar på dig')
    expect(textOf(render({ questions: 0, proposals: 3 }, 'en'))).toBe('3 proposals wait for you')
    expect(textOf(render({ questions: 0, proposals: 1 }, 'en'))).toBe('1 proposal waits for you')
  })

  it('shows nothing when nothing waits, and when it was not counted', () => {
    expect(render({ questions: 0, proposals: 0 })).toBe('')
    expect(render(null)).toBe('')
    expect(render({ questions: 0, proposals: 0 }, 'en')).toBe('')
  })
})

describe('a company without the question list', () => {
  beforeEach(() => {
    vi.stubEnv('COMPANY_QUESTIONS_COMPANY_IDS', 'another-company')
  })

  it('shows only the proposal part: the question counter answers none for it, without a read', async () => {
    // Five open questions in the table: the counter never asks.
    const mock = createTableMockSupabase({ company_questions: { count: 5 } })
    const questions = await countOpenQuestions(mock.supabase as never, 'company-1')
    expect(questions).toBe(0)
    expect(mock.tables()).toEqual([])

    const html = render({ questions, proposals: 3 })
    expect(textOf(html)).toBe('3 förslag väntar på dig')
    expect(linksOf(html)).toEqual([['/pending', '3 förslag']])
    // And nothing at all when no proposal waits either.
    expect(render({ questions, proposals: 0 })).toBe('')
  })
})
