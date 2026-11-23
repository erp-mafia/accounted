/**
 * The question page as it is drawn, with the real component and the real
 * messages in both languages: the line that says no question waits, the
 * label over the questions answered before, and the order of the two.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { AppQuestion } from '@/lib/questions/app-answer'

const locale = vi.hoisted(() => ({ current: 'sv' as 'sv' | 'en' }))

vi.mock('next-intl', async (importOriginal) => {
  const actual = await importOriginal<typeof import('next-intl')>()
  const messages = {
    sv: (await import('@/messages/sv.json')).default,
    en: (await import('@/messages/en.json')).default,
  }
  return {
    ...actual,
    // The translator the app gets, strict: a missing key or a broken ICU
    // message throws instead of rendering the key path.
    useTranslations: (namespace: string) =>
      actual.createTranslator({
        locale: locale.current,
        messages: messages[locale.current] as never,
        namespace: namespace as never,
        onError: (error) => {
          throw error
        },
      }),
    useLocale: () => locale.current,
  }
})
// Whether the viewer may write is the page's company context, which this render has none of.
vi.mock('@/components/ui/viewer-lock', () => ({ useViewerLock: () => ({ canWrite: true, lockedTitle: undefined }) }))

const { QuestionList } = await import('../QuestionList')

const id = (n: number) => `e0000000-0000-4000-8000-00000000002${n}`
const question = (n: number, text: string, extra: Partial<AppQuestion> = {}): AppQuestion => ({
  question_id: id(n),
  question: text,
  why: null,
  options: [],
  evidence: [],
  asked_at: '2026-11-19T08:00:00.000Z',
  ...extra,
})

const OPEN = question(1, 'Vad gäller betalningen till leverantören?')
const ANSWERED = question(2, 'Är abonnemanget månadsvis eller årsvis?', {
  answered: { answer: 'Årsvis', answered_at: '2026-11-22T09:00:00.000Z' },
  operations: [],
})
const SETTLED = question(3, 'Vilken faktura hör insättningen till?', {
  settled: { close_note: 'Insättningen är bokförd mot fakturan.', close_evidence: [], closed_at: '2026-11-21T09:00:00.000Z' },
  operations: [],
})

const WORDS = {
  sv: { none: 'Inga frågor väntar på svar.', label: 'Besvarade', empty: 'Inga frågor just nu.' },
  en: { none: 'No questions are waiting for an answer.', label: 'Answered', empty: 'No questions right now.' },
} as const

const render = (language: 'sv' | 'en', initial: AppQuestion[] | null) => {
  locale.current = language
  return renderToStaticMarkup(createElement(QuestionList, { initial }))
}

beforeEach(() => {
  locale.current = 'sv'
})

describe.each(['sv', 'en'] as const)('the question page in %s', (language) => {
  const words = WORDS[language]

  it('says in one line at the top that no question waits, and lists the answered ones under one label', () => {
    const html = render(language, [ANSWERED, SETTLED])

    expect(html).toContain(`<p class="text-[13px] text-foreground">${words.none}</p>`)
    expect(html.split(words.label).length - 1).toBe(1)
    // The line comes first, then the label, then the questions under it.
    const order = [words.none, `>${words.label}<`, ANSWERED.question, SETTLED.question].map((part) => html.indexOf(part))
    expect(order.every((at) => at >= 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
    // The label names the section that holds the list.
    expect(html).toMatch(new RegExp(`<section aria-labelledby="questions-answered-label"><div id="questions-answered-label"[^>]*>${words.label}</div><ul`))
    expect(html).not.toContain(words.empty)
  })

  it('draws the line and the label as text on the page: no icon, no card and no colour of their own', () => {
    const html = render(language, [ANSWERED])
    const line = html.match(new RegExp(`<p class="([^"]*)">${words.none}</p>`))?.[1]
    const label = html.match(new RegExp(`<div id="questions-answered-label" class="([^"]*)">`))?.[1]
    expect(line).toBe('text-[13px] text-foreground')
    expect(label).toBe('pb-2 text-xs font-medium text-muted-foreground')
  })

  it('does not say that none waits while a question is open, and still labels the answered ones after it', () => {
    const html = render(language, [OPEN, ANSWERED])

    expect(html).not.toContain(words.none)
    const order = [OPEN.question, `>${words.label}<`, ANSWERED.question].map((part) => html.indexOf(part))
    expect(order.every((at) => at >= 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
  })

  it('has no label when no question was answered before', () => {
    const html = render(language, [OPEN])
    expect(html).toContain(OPEN.question)
    expect(html).not.toContain(words.label)
    expect(html).not.toContain(words.none)
  })

  it('keeps the page state for no questions at all, without the line or the label', () => {
    const html = render(language, [])
    expect(html).toContain(words.empty)
    expect(html).not.toContain(words.none)
    expect(html).not.toContain(`>${words.label}<`)
  })
})
