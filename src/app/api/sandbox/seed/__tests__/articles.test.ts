import { describe, expect, it } from 'vitest'
import { buildSandboxArticles } from '../articles'

const input = { userId: 'user-1', companyId: 'company-1' }

/** The articles CHECK constraints from 20260621120000_artikelregister.sql. */
const ALLOWED_TYPES = ['vara', 'tjanst']
const ALLOWED_VAT_RATES = [0, 6, 12, 25]

describe('sandbox article seed data', () => {
  it('seeds five articles scoped to the sandbox company', () => {
    const articles = buildSandboxArticles(input)

    expect(articles).toHaveLength(5)
    expect(articles.every((a) => a.user_id === 'user-1' && a.company_id === 'company-1')).toBe(true)
    expect(articles.every((a) => a.active === true)).toBe(true)
  })

  it('numbers the articles A-001 upwards without gaps', () => {
    const articles = buildSandboxArticles(input)

    expect(articles.map((a) => a.article_number)).toEqual([
      'A-001',
      'A-002',
      'A-003',
      'A-004',
      'A-005',
    ])
    // uq_articles_company_number is unique per company when article_number is set.
    expect(new Set(articles.map((a) => a.article_number)).size).toBe(articles.length)
  })

  it('satisfies every CHECK constraint on articles', () => {
    const articles = buildSandboxArticles(input)

    for (const article of articles) {
      expect(ALLOWED_TYPES).toContain(article.type)
      expect(ALLOWED_VAT_RATES).toContain(article.vat_rate)
      expect(article.unit.length).toBeGreaterThan(0)
      expect(article.price_excl_vat).toBeGreaterThan(0)
      expect(Number.isFinite(article.price_excl_vat)).toBe(true)
    }
  })

  it('covers the mix the register is supposed to demonstrate', () => {
    const articles = buildSandboxArticles(input)

    // Hourly consulting, a fixed-price package, and a resold licence.
    expect(articles.some((a) => a.type === 'tjanst' && a.unit === 'tim')).toBe(true)
    expect(articles.some((a) => a.type === 'tjanst' && a.unit === 'st')).toBe(true)
    expect(articles.some((a) => a.type === 'vara' && a.unit === 'st')).toBe(true)
  })

  it('only uses a reduced VAT rate where Swedish law allows one', () => {
    const articles = buildSandboxArticles(input)

    const reduced = articles.filter((a) => a.vat_rate !== 25)
    // A printed book is 6 % (ML 9 kap. 7 §). Consulting, the fixed-price
    // package and the rebilled licence are ordinary 25 % supplies: a reduced
    // rate on any of them would be a VAT error shipped as demo data.
    expect(reduced).toHaveLength(1)
    expect(reduced[0].vat_rate).toBe(6)
    expect(reduced[0].name).toContain('Handbok')
    expect(articles.filter((a) => a.vat_rate === 25)).toHaveLength(4)
  })

  it('leaves the revenue account to the VAT treatment', () => {
    const articles = buildSandboxArticles(input)

    // NULL means "derive from the VAT treatment at line-create time". Pinning
    // an override would freeze a 25 % account onto the 6 % book line.
    expect(articles.every((a) => a.revenue_account === null)).toBe(true)
  })

  it('sets every optional column on every row', () => {
    const articles = buildSandboxArticles(input)

    // PostgREST normalizes columns across a bulk insert: a key present on one
    // row and absent on another is sent as NULL instead of falling through to
    // the schema default.
    const keySets = articles.map((a) => Object.keys(a).sort().join(','))
    expect(new Set(keySets).size).toBe(1)
    for (const article of articles) {
      expect(article).toHaveProperty('name_en')
      expect(article).toHaveProperty('cost_price')
      expect(article).toHaveProperty('ean')
      expect(article).toHaveProperty('housework_type')
      expect(article).toHaveProperty('notes')
      expect(article.currency).toBe('SEK')
    }
  })

  it('is deterministic', () => {
    expect(buildSandboxArticles(input)).toEqual(buildSandboxArticles(input))
  })
})
