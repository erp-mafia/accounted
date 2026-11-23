import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { knowledgeItemParam } from '@/lib/agent-context/wiki-views'
import { rulesSegment } from '@/components/skills/data'

// /skills and /skills/[id] with and without the agent picture
// (AGENT_PICTURE_COMPANY_IDS, lib/env/agent-picture-switch.ts). With the
// picture, /skills and a knowledge item's address lead to the picture with
// its Kunskap row open. Without it, and for every other id, both pages
// answer by the Agenter page's own switch (AGENTS_PAGE_COMPANY_IDS) alone.

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

  it('every other id answers by the Agenter page switch alone, with no redirect', async () => {
    for (const id of ['bookkeep', 'own-11111111-1111-4111-8111-111111111111', 'egen.11111111-1111-4111-8111-111111111111', 'analys.kassaprognos', 'community.some-item', 'ny', 'granskning-x']) {
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
    for (const id of ['kunskap.horizontal.swedish-vat', 'bookkeep', 'egen.11111111-1111-4111-8111-111111111111', 'community.some-item', 'ny']) {
      const page = await itemPage(id)
      expect(page.type, id).toBe(InstructionDetail)
      expect(page.props, id).toEqual({ segment: id })
    }
    expect(redirect).not.toHaveBeenCalled()
  })

  it('an item is not found where the Agenter page is closed', async () => {
    agentsPage(false)
    for (const id of ['kunskap.horizontal.swedish-vat', 'bookkeep']) {
      await expect(itemPage(id), id).rejects.toThrow('NEXT_NOT_FOUND')
    }
    expect(redirect).not.toHaveBeenCalled()
  })
})
