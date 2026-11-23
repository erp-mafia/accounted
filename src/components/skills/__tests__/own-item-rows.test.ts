import { describe, expect, it } from 'vitest'
import { agentSegment, createItemHref, isOwnItem, knowledgeHref, ownItemHref, type SkillSummary } from '../data'
import { ownItemRows } from '../own-item-rows'

const FLOW = '11111111-1111-4111-8111-111111111111'
const RULES = '22222222-2222-4222-8222-222222222222'
const ANALYSIS = '33333333-3333-4333-8333-333333333333'
const FIRM = '44444444-4444-4444-8444-444444444444'
const DRAFT = '55555555-5555-4555-8555-555555555555'

/** A catalogue item as GET /api/skills sends it (no body). */
function item(over: Partial<SkillSummary> & Pick<SkillSummary, 'slug' | 'name'>): SkillSummary {
  return { summary: `about ${over.name}`, tags: [], tier: 'own', source: 'own', active: true, installations: [], ...over } as SkillSummary
}

const own = (id: string, name: string, over: Partial<SkillSummary> = {}, scope: 'company' | 'team' = 'company') =>
  item({ slug: `own/${id}`, name, installations: [{ installation_id: id, scope }], ...over })

/** What Accounted ships and what the community shared: never the company's own. */
const SHIPPED = [
  item({ slug: 'bookkeep', name: 'Bokför', tier: 'workflow', source: 'accounted' }),
  item({ slug: 'horizontal/swedish-vat', name: 'Swedish VAT', tier: 'horizontal', source: 'accounted' }),
  item({ slug: 'vertical/konsult-it', name: 'Konsult', tier: 'vertical', source: 'accounted', installations: [{ installation_id: 'x', scope: 'company' }] }),
  item({ slug: 'community/shared', name: 'Delad', tier: 'community', source: 'community' }),
  item({ slug: 'analys-kassaprognos', name: 'Kassaprognos', tier: 'workflow', source: 'accounted', itemKind: 'analysis' }),
]

describe('ownItemRows', () => {
  it('is empty for a company with no own items, whatever else the catalogue holds', () => {
    expect(ownItemRows([], '/skills')).toEqual([])
    expect(ownItemRows(SHIPPED, '/skills')).toEqual([])
  })

  it('lists an own flow, own knowledge and an own analysis, each opening the page the catalogue opens it on', () => {
    const rows = ownItemRows(
      [...SHIPPED, own(FLOW, 'Påminn kunder', { itemKind: 'workflow' }), own(RULES, 'Representation', { itemKind: 'rules' }), own(ANALYSIS, 'Bruttomarginal', { itemKind: 'analysis' })],
      '/skills',
    )
    expect(rows.map((row) => [row.title, row.kind, row.href])).toEqual([
      ['Bruttomarginal', 'analysis', `/skills/egen.${ANALYSIS}`],
      ['Påminn kunder', 'workflow', `/skills/own-${FLOW}`],
      ['Representation', 'rules', `/skills/egen.${RULES}`],
    ])
    // Named as the catalogue names them: the name and the one line they were saved with.
    expect(rows.map((row) => row.desc)).toEqual(['about Bruttomarginal', 'about Påminn kunder', 'about Representation'])
    expect(rows.every((row) => !row.draft && row.scope === 'company')).toBe(true)
  })

  it('reads an item saved without a kind as a flow, as the catalogue does', () => {
    const [row] = ownItemRows([own(FLOW, 'Äldre flöde')], '/skills')
    expect([row.kind, row.href]).toEqual(['workflow', `/skills/own-${FLOW}`])
  })

  it("lists the firm's items with the company's own", () => {
    const rows = ownItemRows([own(FIRM, 'Byråns månadsrutin', { itemKind: 'workflow' }, 'team'), own(RULES, 'Representation', { itemKind: 'rules' })], '/skills')
    expect(rows.map((row) => [row.title, row.scope])).toEqual([
      ['Byråns månadsrutin', 'team'],
      ['Representation', 'company'],
    ])
    expect(rows[0].href).toBe(`/skills/own-${FIRM}`)
  })

  it('puts what waits for a person first: a draft an AI saved', () => {
    const rows = ownItemRows([own(RULES, 'Avtal'), own(DRAFT, 'Ö sist i alfabetet', { draft: true, active: false, itemKind: 'analysis' })], '/skills')
    expect(rows.map((row) => [row.title, row.draft])).toEqual([
      ['Ö sist i alfabetet', true],
      ['Avtal', false],
    ])
  })

  it('leaves out an own row the catalogue sends without an installation', () => {
    expect(ownItemRows([item({ slug: `own/${RULES}`, name: 'Utan rad' })], '/skills')).toEqual([])
  })

  it('links under the base it is given', () => {
    expect(ownItemRows([own(RULES, 'Representation', { itemKind: 'rules' })], '/sandbox/agenter')[0].href).toBe(`/sandbox/agenter/egen.${RULES}`)
  })
})

describe('the addresses of own items', () => {
  it('are the catalogue page\'s own: its filter and its address helpers', () => {
    expect(isOwnItem(own(FLOW, 'Flöde'))).toBe(true)
    expect(SHIPPED.some(isOwnItem)).toBe(false)
    expect(ownItemHref('/skills', `own/${FLOW}`, 'workflow')).toBe(`/skills/${agentSegment(`own/${FLOW}`)}`)
    expect(ownItemHref('/skills', `own/${RULES}`, 'rules')).toBe(knowledgeHref('/skills', `own/${RULES}`))
    expect(ownItemHref('/skills', `own/${ANALYSIS}`, 'analysis')).toBe(`/skills/egen.${ANALYSIS}`)
  })

  it('opens the page that adds an item on the kind given, as that page reads it', () => {
    expect(createItemHref('/skills', 'rules')).toBe('/skills/ny?typ=kunskap')
    expect(createItemHref('/skills', 'analysis')).toBe('/skills/ny?typ=analyser')
    // No ?typ= is a flow: the page's own default.
    expect(createItemHref('/skills', 'workflow')).toBe('/skills/ny')
  })
})
