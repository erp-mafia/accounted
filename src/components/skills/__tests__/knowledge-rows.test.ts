import { describe, expect, it } from 'vitest'
import type { KnowledgeOption } from '@/lib/agent-skills/knowledge-choices'
import { knowledgeRows } from '../knowledge-rows'

const option = (id: string, tier: KnowledgeOption['tier'], title = id, summary = `about ${id}`): KnowledgeOption => ({ id, tier, title, summary, version: 1, reviewed_at: null })

const label = { name: (id: string, title: string) => `name:${title}`, desc: (_id: string, summary: string) => `desc:${summary}` }

describe('knowledgeRows', () => {
  it('lists the product\'s own knowledge items, not the community\'s and not the company\'s own', () => {
    const rows = knowledgeRows(
      [
        option('horizontal/swedish-vat', 'horizontal'),
        option('vertical/konsult-it', 'vertical'),
        option('modifier/holding-ab', 'modifier'),
        option('community/shared', 'community'),
        option('own/0d6f6f0e-0000-4000-8000-000000000001', 'own'),
      ],
      '/skills',
      label,
    )
    expect(rows.map((row) => row.key)).toEqual(['horizontal/swedish-vat', 'vertical/konsult-it', 'modifier/holding-ab'])
  })

  it('gives each row its display name, its one line and the page it opens', () => {
    const [row] = knowledgeRows([option('horizontal/swedish-vat', 'horizontal', 'Moms', 'Svensk moms')], '/skills', label)
    expect(row).toEqual({
      key: 'horizontal/swedish-vat',
      kind: 'rules',
      title: 'name:Moms',
      desc: 'desc:Svensk moms',
      href: '/skills/kunskap.horizontal.swedish-vat',
      source: 'accounted',
      meta: null,
      categories: [],
      popularity: 0,
      usedByFlows: 0,
    })
  })

  it('files an industry or company-form item under itself and links under the given base', () => {
    const rows = knowledgeRows([option('vertical/konsult-it', 'vertical'), option('modifier/holding-ab', 'modifier')], '/sandbox/agenter', label)
    expect(rows.map((row) => row.categories)).toEqual([['vertical/konsult-it'], ['modifier/holding-ab']])
    expect(rows[0].href).toBe('/sandbox/agenter/kunskap.vertical.konsult-it')
  })

  it('counts the flows that carry an item, when told', () => {
    const rows = knowledgeRows([option('horizontal/a', 'horizontal'), option('horizontal/b', 'horizontal')], '/skills', label, (id) => (id === 'horizontal/a' ? 3 : 0))
    expect(rows.map((row) => [row.popularity, row.usedByFlows])).toEqual([
      [3, 3],
      [0, 0],
    ])
  })
})
