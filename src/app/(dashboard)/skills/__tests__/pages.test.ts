import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { knowledgeItemParam } from '@/lib/agent-context/wiki-views'
import { createItemHref, ownItemHref, rulesSegment } from '@/components/skills/data'
import type { ItemKind } from '@/components/skills/hues'

// /skills and /skills/[id] with and without the agent picture
// (AGENT_PICTURE_COMPANY_IDS, lib/env/agent-picture-switch.ts). With the
// picture, /skills and a knowledge item's address lead to the picture with
// its Kunskap row open, and an own item's pages (the page that adds one, an
// own flow, own knowledge or an own analysis) answer whatever the Agenter
// page's own switch (AGENTS_PAGE_COMPANY_IDS) says. Without the picture, and
// for every other id, both pages answer by the Agenter page's switch alone.

const redirect = vi.fn((url: string) => {
  throw new Error(`NEXT_REDIRECT:${url}`)
})
const notFound = vi.fn(() => {
  throw new Error('NEXT_NOT_FOUND')
})
vi.mock('next/navigation', () => ({
  redirect: (url: string) => redirect(url),
  notFound: () => notFound(),
}))
vi.mock('@/components/skills/SkillsPage', () => ({ SkillsPage: () => null }))
vi.mock('@/components/skills/InstructionDetail', () => ({ InstructionDetail: () => null }))

const COMPANY = 'aaaaaaaa-0000-4000-8000-000000000001'
vi.mock('../../request-context', () => ({ getDashboardCompanyId: async () => COMPANY }))

const { default: SkillsIndexPage } = await import('../page')
const { default: SkillsItemPage } = await import('../[id]/page')
const { SkillsPage } = await import('@/components/skills/SkillsPage')
const { InstructionDetail } = await import('@/components/skills/InstructionDetail')

const itemPage = (id: string) => SkillsItemPage({ params: Promise.resolve({ id }) })

const OWN_ID = '11111111-1111-4111-8111-111111111111'
/** The three kinds of page an own item has, as their address segments. */
const OWN_ITEM_PAGES: readonly string[] = ['ny', `own-${OWN_ID}`, `egen.${OWN_ID}`]
/** Ids that are not an own item's page: a curated flow, an analysis, a shared item and an unknown one. */
const OTHER_PAGES: readonly string[] = ['bookkeep', 'analys.kassaprognos', 'community.some-item', 'granskning-x']

/** The Agenter page's own switch: named for the company, or naming another. */
function agentsPage(on: boolean) {
  vi.stubEnv('AGENTS_PAGE_COMPANY_IDS', on ? COMPANY : 'another-company')
}

beforeEach(() => {
  vi.clearAllMocks()
})
afterEach(() => {
  vi.unstubAllEnvs()
})

describe.each([
  ['the Agenter page open', true],
  ['the Agenter page closed', false],
])('with the agent picture on and %s', (_name, agents) => {
  beforeEach(() => {
    vi.stubEnv('AGENT_PICTURE_COMPANY_IDS', COMPANY)
    agentsPage(agents)
  })

  it('/skills leads to the picture with Kunskap open', async () => {
    await expect(SkillsIndexPage()).rejects.toThrow('NEXT_REDIRECT:/wiki?view=knowledge')
    expect(notFound).not.toHaveBeenCalled()
  })

  it('a knowledge item leads to the picture with that folder open', async () => {
    await expect(itemPage('kunskap.horizontal.swedish-vat')).rejects.toThrow('NEXT_REDIRECT:/wiki?view=knowledge&item=horizontal.swedish-vat')
    // The segment as the browser may send it.
    await expect(itemPage('kunskap.modifier.holding%2Dab')).rejects.toThrow('NEXT_REDIRECT:/wiki?view=knowledge&item=modifier.holding-ab')
    expect(notFound).not.toHaveBeenCalled()
  })

  it('names the item as the catalogue spelled its address', () => {
    for (const id of ['horizontal/swedish-vat', 'vertical/restaurang', 'modifier/holding-ab']) {
      expect(rulesSegment(id)).toBe(`kunskap.${knowledgeItemParam(id)}`)
    }
  })

  it('the page that adds an own item, an own flow and own knowledge open their own page', async () => {
    for (const id of OWN_ITEM_PAGES) {
      const page = await itemPage(id)
      expect(page.type, id).toBe(InstructionDetail)
      expect(page.props, id).toEqual({ segment: id })
    }
    // The segment as the browser may send it.
    const encoded = await itemPage(`egen%2E${OWN_ID}`)
    expect(encoded.type).toBe(InstructionDetail)
    expect(redirect).not.toHaveBeenCalled()
    expect(notFound).not.toHaveBeenCalled()
  })

  it('opens the pages the links to an own item are built with', async () => {
    const kinds: ItemKind[] = ['workflow', 'rules', 'analysis']
    const hrefs: string[] = [
      ...kinds.map((kind) => createItemHref('/skills', kind)),
      ...kinds.map((kind) => ownItemHref('/skills', `own/${OWN_ID}`, kind)),
    ]
    for (const href of hrefs) {
      const segment = new URL(href, 'http://localhost').pathname.slice('/skills/'.length)
      const page = await itemPage(segment)
      expect(page.type, href).toBe(InstructionDetail)
    }
    expect(notFound).not.toHaveBeenCalled()
  })

  it('every other id answers by the Agenter page switch alone, with no redirect', async () => {
    for (const id of OTHER_PAGES) {
      if (agents) {
        const page = await itemPage(id)
        expect(page.type, id).toBe(InstructionDetail)
        expect(page.props, id).toEqual({ segment: id })
      } else {
        await expect(itemPage(id), id).rejects.toThrow('NEXT_NOT_FOUND')
      }
    }
    expect(redirect).not.toHaveBeenCalled()
  })
})

describe.each([
  ['unset', undefined],
  ['naming another company', 'another-company'],
])('with the agent picture %s: as before', (_name, picture) => {
  beforeEach(() => {
    if (picture !== undefined) vi.stubEnv('AGENT_PICTURE_COMPANY_IDS', picture)
  })

  it('/skills is the Agenter page where it is open, with every kind', async () => {
    agentsPage(true)
    const page = await SkillsIndexPage()
    expect(page.props.children.type).toBe(SkillsPage)
    // No knowledge-only form: the page is the whole catalogue.
    expect(page.props.children.props).toEqual({})
    expect(redirect).not.toHaveBeenCalled()
  })

  it('/skills is not found where the Agenter page is closed', async () => {
    agentsPage(false)
    await expect(SkillsIndexPage()).rejects.toThrow('NEXT_NOT_FOUND')
    expect(redirect).not.toHaveBeenCalled()
  })

  it('an item, a knowledge item among them, opens its own page where the Agenter page is open', async () => {
    agentsPage(true)
    for (const id of ['kunskap.horizontal.swedish-vat', 'bookkeep', 'community.some-item', ...OWN_ITEM_PAGES]) {
      const page = await itemPage(id)
      expect(page.type, id).toBe(InstructionDetail)
      expect(page.props, id).toEqual({ segment: id })
    }
    expect(redirect).not.toHaveBeenCalled()
  })

  it('an item is not found where the Agenter page is closed, an own item\'s pages among them', async () => {
    agentsPage(false)
    for (const id of ['kunskap.horizontal.swedish-vat', ...OTHER_PAGES, ...OWN_ITEM_PAGES]) {
      await expect(itemPage(id), id).rejects.toThrow('NEXT_NOT_FOUND')
    }
    expect(redirect).not.toHaveBeenCalled()
  })
})
