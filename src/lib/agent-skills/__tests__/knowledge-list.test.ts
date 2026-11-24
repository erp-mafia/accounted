import { describe, expect, it } from 'vitest'
import type { KnowledgeOption } from '../knowledge-choices'
import { catalogueKnowledge, chosenKnowledge, groupKnowledge, isActiveKnowledge, knowledgeTextNote, SEARCH_FROM_TILES } from '../knowledge-list'

const option = (id: string, tier: KnowledgeOption['tier']): KnowledgeOption => ({ id, tier, title: id, summary: '', version: 1, reviewed_at: null })

const CATALOGUE = [
  option('horizontal/swedish-vat', 'horizontal'),
  option('horizontal/swedish-payroll', 'horizontal'),
  option('modifier/holding-ab', 'modifier'),
  option('modifier/mixed-verksamhet', 'modifier'),
  option('vertical/konsult-it', 'vertical'),
  option('vertical/e-handel', 'vertical'),
  option('community/shared', 'community'),
  option('own/0d6f6f0e-0000-4000-8000-000000000001', 'own'),
]

describe('catalogueKnowledge', () => {
  it('holds the product\'s own items and leaves out the community\'s and the company\'s own', () => {
    expect(catalogueKnowledge(CATALOGUE).map((o) => o.id)).toEqual([
      'horizontal/swedish-vat',
      'horizontal/swedish-payroll',
      'modifier/holding-ab',
      'modifier/mixed-verksamhet',
      'vertical/konsult-it',
      'vertical/e-handel',
    ])
  })

  it('is empty for an empty catalogue', () => {
    expect(catalogueKnowledge([])).toEqual([])
  })
})

describe('what a company has chosen', () => {
  it('is what its profile names and what it installed', () => {
    const chosen = chosenKnowledge({ vertical_atoms: ['vertical/konsult-it'], modifier_atoms: ['modifier/holding-ab'] }, [{ atom_id: 'vertical/e-handel' }, { atom_id: null }])
    expect([...chosen].sort()).toEqual(['modifier/holding-ab', 'vertical/e-handel', 'vertical/konsult-it'])
  })

  it('is nothing for a company with no profile and nothing installed', () => {
    expect(chosenKnowledge(null, []).size).toBe(0)
    expect(chosenKnowledge({ vertical_atoms: null, modifier_atoms: null }, []).size).toBe(0)
  })
})

describe('isActiveKnowledge', () => {
  const chosen = new Set(['vertical/konsult-it'])

  it('is true for every general item, chosen or not', () => {
    expect(isActiveKnowledge('horizontal', 'horizontal/swedish-vat', chosen)).toBe(true)
    expect(isActiveKnowledge('horizontal', 'horizontal/swedish-vat', new Set())).toBe(true)
  })

  it('is true for another item only when the company has chosen it', () => {
    expect(isActiveKnowledge('vertical', 'vertical/konsult-it', chosen)).toBe(true)
    expect(isActiveKnowledge('vertical', 'vertical/e-handel', chosen)).toBe(false)
    expect(isActiveKnowledge('modifier', 'modifier/holding-ab', chosen)).toBe(false)
    expect(isActiveKnowledge('community', 'community/shared', chosen)).toBe(false)
  })
})

describe('groupKnowledge', () => {
  const ids = (groups: ReturnType<typeof groupKnowledge<KnowledgeOption>>) => groups.groups.map((g) => [g.id, g.items.map((o) => o.id)])

  it('puts what the agent gets today first, by kind, then what else exists', () => {
    const groups = groupKnowledge(CATALOGUE, new Set(['horizontal/swedish-vat', 'horizontal/swedish-payroll', 'vertical/konsult-it', 'modifier/holding-ab']))
    expect(ids(groups)).toEqual([
      ['industry', ['vertical/konsult-it']],
      ['general', ['horizontal/swedish-vat', 'horizontal/swedish-payroll']],
      ['form', ['modifier/holding-ab']],
      ['also', ['modifier/mixed-verksamhet', 'vertical/e-handel']],
    ])
    expect(groups.active).toBe(4)
  })

  it('leaves out a group with nothing in it', () => {
    const general = groupKnowledge(CATALOGUE, new Set(['horizontal/swedish-vat', 'horizontal/swedish-payroll']))
    expect(ids(general)).toEqual([
      ['general', ['horizontal/swedish-vat', 'horizontal/swedish-payroll']],
      ['also', ['modifier/holding-ab', 'modifier/mixed-verksamhet', 'vertical/konsult-it', 'vertical/e-handel']],
    ])
    expect(general.active).toBe(2)

    const everything = groupKnowledge(CATALOGUE, new Set(CATALOGUE.map((o) => o.id)))
    expect(everything.groups.map((g) => g.id)).toEqual(['industry', 'general', 'form'])
    expect(everything.active).toBe(6)
  })

  it('never lists what the community shared or the company wrote, active or not', () => {
    const groups = groupKnowledge(CATALOGUE, new Set(['community/shared', 'own/0d6f6f0e-0000-4000-8000-000000000001']))
    expect(groups.groups.flatMap((g) => g.items.map((o) => o.id))).not.toContain('community/shared')
    expect(groups.active).toBe(0)
  })

  it('guesses nothing when it is not known which are active: one group, no number', () => {
    const groups = groupKnowledge(CATALOGUE, null)
    expect(groups.groups.map((g) => g.id)).toEqual(['all'])
    expect(groups.groups[0].items).toHaveLength(6)
    expect(groups.active).toBeNull()
    expect(groupKnowledge([], null)).toEqual({ groups: [], active: null })
  })

  it('counts the same items the card counts: the active ones', () => {
    // The loader's number is the active ids' length; the panel's is this count over the same list and ids.
    const active = ['horizontal/swedish-vat', 'horizontal/swedish-payroll', 'vertical/konsult-it']
    expect(groupKnowledge(CATALOGUE, new Set(active)).active).toBe(active.length)
  })
})

describe('the search field', () => {
  it('comes with more than thirty tiles', () => {
    expect(SEARCH_FROM_TILES).toBe(30)
  })
})

describe('knowledgeTextNote', () => {
  it('says of a general item that its text is written for the AI and is in English', () => {
    expect(knowledgeTextNote('horizontal')).toBe('ai_english')
  })

  it('says of an industry or company-form item that its text is written for the AI, and names no language', () => {
    expect(knowledgeTextNote('vertical')).toBe('ai')
    expect(knowledgeTextNote('modifier')).toBe('ai')
  })

  it('says nothing of what the company or the community wrote', () => {
    expect(knowledgeTextNote('own')).toBeNull()
    expect(knowledgeTextNote('community')).toBeNull()
  })

  it('has a line for every item of the catalogue\'s knowledge list, and for no other', () => {
    for (const item of CATALOGUE) {
      expect(knowledgeTextNote(item.tier) !== null, item.id).toBe(catalogueKnowledge([item]).length === 1)
    }
  })
})
