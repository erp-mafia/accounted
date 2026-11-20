import { describe, expect, it } from 'vitest'
import { legacyKnowledgeHref, parseWikiView, wikiViewHref } from '../wiki-views'

describe('wiki views', () => {
  it('lands on the context view and puts every other view in the URL', () => {
    expect(wikiViewHref('context')).toBe('/wiki')
    expect(wikiViewHref('map')).toBe('/wiki?view=map')
    expect(parseWikiView(null)).toBe('context')
    expect(parseWikiView('memory')).toBe('memory')
    expect(parseWikiView('knowledge')).toBe('context')
  })

  it('sends each old "Vad din agent vet" link to its wiki view', () => {
    expect(legacyKnowledgeHref(undefined)).toBe('/wiki')
    expect(legacyKnowledgeHref('knowledge')).toBe('/wiki?view=map')
    expect(legacyKnowledgeHref('facts')).toBe('/wiki?view=facts')
    expect(legacyKnowledgeHref('memory')).toBe('/wiki?view=memory')
    expect(legacyKnowledgeHref('skills')).toBe('/wiki?view=skills')
    expect(legacyKnowledgeHref('nonsense')).toBe('/wiki')
  })
})
