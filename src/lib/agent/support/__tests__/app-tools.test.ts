import { describe, it, expect, vi } from 'vitest'
import sv from '@/messages/sv.json'
import { gateContext, SV_LABELS } from '@/lib/agent/ask/__tests__/ui-fixture'
import type { UiMapInput } from '@/lib/agent/ask/ui-map'
import type { MessageTree, PageTextIndex } from '../page-text-index'
import { buildAppTools, handoffTool, isPageVisible, type HandoffOffer } from '../app-tools'

// The real menu (nav-v3.ts, labelled from sv.json) with every opt-in surface
// on, and the same menu for a company that pays no salaries.
const WIDE: UiMapInput = { ctx: gateContext(), labels: SV_LABELS, hasMcpExtension: true }
const NO_SALARY: UiMapInput = {
  ctx: gateContext({ surface: { hidden: ['payroll'], notForLegalForm: [] } }),
  labels: SV_LABELS,
  hasMcpExtension: true,
}

const INDEX: PageTextIndex = {
  files: [
    'app/(dashboard)/invoices/page.tsx',
    'app/(dashboard)/salary/page.tsx',
    'app/(dashboard)/help/page.tsx',
    'app/(dashboard)/salary/runs/[id]/page.tsx',
  ],
  keys: [['nav.help'], ['nav.help'], ['nav.help'], ['nav.help']],
  // The invoices page shows the text as a button; the others do not say what it is.
  roles: ['b', '-', '-', '-'],
  routes: { '/invoices': [0], '/salary': [1], '/help': [2], '/salary/runs/[id]': [3] },
}
const MESSAGES = sv as unknown as MessageTree

function tools(ui: UiMapInput, onHandoff: (offer: HandoffOffer) => void = () => undefined) {
  const list = buildAppTools({ index: INDEX, messages: MESSAGES, locale: 'sv', ui, onHandoff })
  const byName = (name: string) => {
    const tool = list.find((t) => t.name === name)
    if (!tool) throw new Error(`no tool ${name}`)
    return tool
  }
  return { list, byName }
}

describe('isPageVisible', () => {
  it('lets through a page in the company menu and a page the menu never lists', () => {
    expect(isPageVisible('/invoices', WIDE)).toBe(true)
    expect(isPageVisible('/help', WIDE)).toBe(true)
  })

  it('refuses a page that exists in the full menu and not in this company', () => {
    // Guard the fixture itself: if hiding the salary surface stops removing
    // the page from the menu, this test would pass for the wrong reason.
    expect(isPageVisible('/salary', WIDE)).toBe(true)
    expect(isPageVisible('/salary', NO_SALARY)).toBe(false)
    // A record page under that row goes with it.
    expect(isPageVisible('/salary/runs/[id]', WIDE)).toBe(true)
    expect(isPageVisible('/salary/runs/[id]', NO_SALARY)).toBe(false)
  })

  it('refuses a settings page outside the sections the company sees', () => {
    expect(isPageVisible('/settings/company', WIDE)).toBe(true)
    expect(isPageVisible('/settings/no-such-section', WIDE)).toBe(false)
  })
})

describe('buildAppTools', () => {
  it('offers the three tools in one fixed order, each with a closed schema', () => {
    const { list } = tools(WIDE)
    expect(list.map((t) => t.name)).toEqual(['read_page', 'find_in_app', 'offer_human_support'])
    for (const tool of list) {
      expect(tool.jsonSchema.additionalProperties).toBe(false)
      expect(tool.description.length).toBeGreaterThan(40)
    }
  })

  it('read_page answers with the page and its texts, named by its place in the menu', async () => {
    const out = (await tools(WIDE).byName('read_page').execute({ path: '/invoices' })) as { page: string; texts: string }
    expect(out.page).toContain('(/invoices)')
    expect(out.page).toContain('→')
    expect(out.texts).toBe(`[page] ${sv.nav.help} (knapp)`)
    // The same text on a page that does not place it carries no role.
    const help = (await tools(WIDE).byName('read_page').execute({ path: '/help' })) as { texts: string }
    expect(help.texts).toBe(`[page] ${sv.nav.help}`)
  })

  it('read_page refuses a page the company does not have, a path without a slash and an unknown page', async () => {
    const read = tools(NO_SALARY).byName('read_page')
    expect(await read.execute({ path: '/salary' })).toEqual({ error: expect.stringContaining('not part of this company') })
    expect(await read.execute({ path: 'invoices' })).toEqual({ error: expect.stringContaining('slash') })
    expect(await read.execute({ path: '/nowhere' })).toEqual({ error: expect.stringContaining('No page texts') })
  })

  it('find_in_app searches only the pages the company has', async () => {
    const wide = (await tools(WIDE).byName('find_in_app').execute({ query: sv.nav.help })) as {
      matches: Array<{ text: string; on: string[] }>
    }
    expect(wide.matches).toHaveLength(1)
    expect(wide.matches[0].on.some((place) => place.includes('/salary'))).toBe(true)

    const narrow = (await tools(NO_SALARY).byName('find_in_app').execute({ query: sv.nav.help })) as {
      matches: Array<{ text: string; on: string[] }>
    }
    expect(narrow.matches[0].on.some((place) => place.includes('/salary'))).toBe(false)
  })

  it('find_in_app says so when nothing matches or the query is too short', async () => {
    const find = tools(WIDE).byName('find_in_app')
    expect(await find.execute({ query: 'zzzzqqq' })).toEqual({ matches: [], note: expect.stringContaining('zzzzqqq') })
    expect(await find.execute({ query: 'a' })).toEqual({ error: expect.any(String) })
  })
})

describe('offer_human_support', () => {
  it('hands the offer to the caller and answers that the button is shown', async () => {
    const onHandoff = vi.fn()
    const out = await handoffTool(onHandoff).execute({ reason: 'problem_report', summary: '  Knappen svarar inte.  ' })
    expect(out).toEqual({ shown: true })
    expect(onHandoff).toHaveBeenCalledWith({ reason: 'problem_report', summary: 'Knappen svarar inte.' })
  })

  it('falls back to "cannot answer" for a reason outside the list and bounds the summary', async () => {
    const onHandoff = vi.fn()
    await handoffTool(onHandoff).execute({ reason: 'whatever', summary: 'x'.repeat(2000) })
    const offer = onHandoff.mock.calls[0][0] as HandoffOffer
    expect(offer.reason).toBe('cannot_answer')
    expect(offer.summary).toHaveLength(600)
  })
})
