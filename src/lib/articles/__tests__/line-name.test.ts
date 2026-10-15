import { describe, expect, it } from 'vitest'
import { articleLineName, documentLanguageOf, planArticleNameSwap } from '@/lib/articles/line-name'

const consulting = { id: 'a1', name: 'Konsulttimme', name_en: 'Consulting hour' }
const swedishOnly = { id: 'a2', name: 'Fika', name_en: null }
const blankEnglish = { id: 'a3', name: 'Resa', name_en: '   ' }

describe('documentLanguageOf', () => {
  it('is English only for a customer whose language is en', () => {
    expect(documentLanguageOf({ language: 'en' })).toBe('en')
    expect(documentLanguageOf({ language: 'sv' })).toBe('sv')
    expect(documentLanguageOf(null)).toBe('sv')
    expect(documentLanguageOf(undefined)).toBe('sv')
  })
})

describe('articleLineName', () => {
  it('takes the English name on an English-language document', () => {
    expect(articleLineName(consulting, 'en')).toBe('Consulting hour')
  })

  it('takes the Swedish name on a Swedish document', () => {
    expect(articleLineName(consulting, 'sv')).toBe('Konsulttimme')
  })

  it('falls back to the Swedish name when the article has no English name', () => {
    expect(articleLineName(swedishOnly, 'en')).toBe('Fika')
    expect(articleLineName(blankEnglish, 'en')).toBe('Resa')
  })

  it('trims the English name', () => {
    expect(articleLineName({ name: 'Konsulttimme', name_en: ' Consulting hour ' }, 'en')).toBe('Consulting hour')
  })
})

describe('planArticleNameSwap', () => {
  const articles = [consulting, swedishOnly]

  it('moves an untouched article line to the new language', () => {
    expect(
      planArticleNameSwap({
        items: [{ article_id: 'a1', description: 'Konsulttimme' }],
        articles,
        from: 'sv',
        to: 'en',
      }),
    ).toEqual([{ index: 0, description: 'Consulting hour' }])
    expect(
      planArticleNameSwap({
        items: [{ article_id: 'a1', description: 'Consulting hour' }],
        articles,
        from: 'en',
        to: 'sv',
      }),
    ).toEqual([{ index: 0, description: 'Konsulttimme' }])
  })

  it('leaves a text the user edited, a free-text line and a text row alone', () => {
    expect(
      planArticleNameSwap({
        items: [
          { article_id: 'a1', description: 'Konsulttimme, september' },
          { article_id: null, description: 'Konsulttimme' },
          { line_type: 'text', article_id: 'a1', description: 'Konsulttimme' },
          undefined,
        ],
        articles,
        from: 'sv',
        to: 'en',
      }),
    ).toEqual([])
  })

  it('has nothing to switch for an article without an English name or one no longer in the list', () => {
    expect(
      planArticleNameSwap({
        items: [
          { article_id: 'a2', description: 'Fika' },
          { article_id: 'gone', description: 'Konsulttimme' },
        ],
        articles,
        from: 'sv',
        to: 'en',
      }),
    ).toEqual([])
  })

  it('does nothing when the language stays the same', () => {
    expect(
      planArticleNameSwap({ items: [{ article_id: 'a1', description: 'Konsulttimme' }], articles, from: 'sv', to: 'sv' }),
    ).toEqual([])
  })

  it('keeps the line index of each swap', () => {
    expect(
      planArticleNameSwap({
        items: [
          { article_id: 'a2', description: 'Fika' },
          { article_id: 'a1', description: 'Konsulttimme' },
        ],
        articles,
        from: 'sv',
        to: 'en',
      }),
    ).toEqual([{ index: 1, description: 'Consulting hour' }])
  })
})
