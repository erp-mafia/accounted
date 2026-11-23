import { describe, expect, it } from 'vitest'
import type { KnowledgeOption } from '../knowledge-choices'
import { catalogueKnowledge, industryFirst, SEARCH_FROM_ROWS } from '../knowledge-list'

const option = (id: string, tier: KnowledgeOption['tier']): KnowledgeOption => ({ id, tier, title: id, summary: '', version: 1, reviewed_at: null })

describe('catalogueKnowledge', () => {
  it('holds the product\'s own items and leaves out the community\'s and the company\'s own', () => {
    const list = catalogueKnowledge([
      option('horizontal/swedish-vat', 'horizontal'),
      option('community/shared', 'community'),
      option('vertical/konsult-it', 'vertical'),
      option('own/0d6f6f0e-0000-4000-8000-000000000001', 'own'),
      option('modifier/holding-ab', 'modifier'),
    ])
    expect(list.map((o) => o.id)).toEqual(['horizontal/swedish-vat', 'vertical/konsult-it', 'modifier/holding-ab'])
  })

  it('is empty for an empty catalogue', () => {
    expect(catalogueKnowledge([])).toEqual([])
  })
})

describe('industryFirst', () => {
  const rows = [{ key: 'horizontal/a' }, { key: 'vertical/konsult-it' }, { key: 'horizontal/b' }]

  it('puts the company\'s own industry item first and keeps the others in order', () => {
    expect(industryFirst(rows, 'vertical/konsult-it').map((row) => row.key)).toEqual(['vertical/konsult-it', 'horizontal/a', 'horizontal/b'])
  })

  it('leaves the list as it is without an industry, or with one the list does not hold', () => {
    expect(industryFirst(rows, null).map((row) => row.key)).toEqual(['horizontal/a', 'vertical/konsult-it', 'horizontal/b'])
    expect(industryFirst(rows, 'vertical/unknown').map((row) => row.key)).toEqual(['horizontal/a', 'vertical/konsult-it', 'horizontal/b'])
  })
})

describe('the search field', () => {
  it('comes with a list longer than about twenty rows', () => {
    expect(SEARCH_FROM_ROWS).toBe(20)
  })
})
