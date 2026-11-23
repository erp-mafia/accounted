/**
 * The pages about what an agent gets, walked by address: /wiki and its
 * views, /skills and its items, /rules, and the two addresses that only
 * forward (/agent-knowledge, /settings/assistant).
 *
 * With the agent picture on (AGENT_PICTURE_COMPANY_IDS) the addresses the
 * picture took over lead to it, each in one step and never in a circle.
 * Without it every address answers as it did: the same page, or the same
 * one step to the same place.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

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
vi.mock('next-intl/server', () => ({
  getLocale: async () => 'sv',
  getTranslations: async () => (key: string) => key,
}))
vi.mock('@/components/ui/page-header', () => ({ PageHeader: () => null }))
vi.mock('@/components/ui/help-popover', () => ({ HelpPopover: () => null }))
vi.mock('@/components/wiki/WikiViews', () => ({ WikiViews: () => null }))
vi.mock('@/components/skills/SkillsPage', () => ({ SkillsPage: () => null }))
vi.mock('@/components/skills/InstructionDetail', () => ({ InstructionDetail: () => null }))
vi.mock('@/components/rules/RulesList', () => ({ default: () => null }))
vi.mock('@/components/rules/BookingBlocks', () => ({ default: () => null }))
vi.mock('@/lib/agent-context/profile-line', () => ({ readProfileFacts: async () => ({ method: null, vatPeriod: null, series: [] }), profileLine: () => null }))

const COMPANY = 'aaaaaaaa-0000-4000-8000-000000000001'
vi.mock('../request-context', () => ({
  getDashboardCompanyId: async () => COMPANY,
  getDashboardAuthContext: async () => ({ supabase: {}, user: { id: 'user-1' }, sessionId: null }),
  redirectInvoicerOffPage: async () => {},
}))

const { default: WikiPage } = await import('../wiki/page')
const { default: SkillsIndexPage } = await import('../skills/page')
const { default: SkillsItemPage } = await import('../skills/[id]/page')
const { default: RulesPage } = await import('../rules/page')
const { default: AgentKnowledgePage } = await import('../agent-knowledge/page')
const { default: AssistantSettingsPage } = await import('../settings/assistant/page')

/** The page that answers an address, as the App Router would call it. */
async function open(address: string): Promise<unknown> {
  const url = new URL(address, 'https://app.test')
  const view = url.searchParams.get('view')
  const searchParams = Promise.resolve(view === null ? {} : { view })
  if (url.pathname === '/wiki') return WikiPage({ searchParams })
  if (url.pathname === '/skills') return SkillsIndexPage()
  if (url.pathname.startsWith('/skills/')) return SkillsItemPage({ params: Promise.resolve({ id: url.pathname.slice('/skills/'.length) }) })
  if (url.pathname === '/rules') return RulesPage()
  if (url.pathname === '/agent-knowledge') return AgentKnowledgePage({ searchParams })
  if (url.pathname === '/settings/assistant') return AssistantSettingsPage({ searchParams })
  throw new Error(`no page in this walk answers ${address}`)
}

/** Follows an address until a page answers: where it ended, and every step on the way. */
async function walk(start: string): Promise<{ end: string; steps: string[] }> {
  const steps: string[] = []
  let address = start
  for (;;) {
    let next: string | null = null
    try {
      await open(address)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (message === 'NEXT_NOT_FOUND') return { end: 'not found', steps }
      if (!message.startsWith('NEXT_REDIRECT:')) throw err
      next = message.slice('NEXT_REDIRECT:'.length)
    }
    if (next === null) return { end: address, steps }
    if (steps.includes(next) || next === start) throw new Error(`${start} goes in a circle: ${[start, ...steps, next].join(' -> ')}`)
    steps.push(next)
    address = next
    if (steps.length > 4) throw new Error(`${start} takes more than four steps: ${steps.join(' -> ')}`)
  }
}

const WIKI = ['/wiki', '/wiki?view=context', '/wiki?view=checks', '/wiki?view=memory', '/wiki?view=knowledge', '/wiki?view=skills', '/wiki?view=facts', '/wiki?view=nonsense']
const FORWARDS = [
  '/agent-knowledge',
  '/agent-knowledge?view=knowledge',
  '/agent-knowledge?view=facts',
  '/agent-knowledge?view=memory',
  '/agent-knowledge?view=skills',
  '/agent-knowledge?view=nonsense',
  '/settings/assistant',
  '/settings/assistant?view=memory',
  '/settings/assistant?view=skills',
  '/settings/assistant?view=nonsense',
]
const EVERY = [...WIKI, '/wiki?view=map', '/skills', '/skills/kunskap.horizontal.swedish-vat', '/skills/bookkeep', '/skills/ny', '/rules', ...FORWARDS]

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

  it('shows the picture at /wiki and at every address that names one of its rows, with no step', async () => {
    for (const address of WIKI) expect(await walk(address), address).toEqual({ end: address, steps: [] })
  })

  it('leads each address the picture took over to its place, in one step', async () => {
    const leads: Record<string, string> = {
      '/skills': '/wiki?view=knowledge',
      '/skills/kunskap.horizontal.swedish-vat': '/wiki?view=knowledge&item=horizontal.swedish-vat',
      '/wiki?view=map': '/rules',
      '/agent-knowledge': '/wiki',
      '/agent-knowledge?view=knowledge': '/rules',
      '/agent-knowledge?view=facts': '/wiki?view=facts',
      '/agent-knowledge?view=memory': '/wiki?view=memory',
      '/agent-knowledge?view=skills': '/wiki?view=knowledge',
      '/agent-knowledge?view=nonsense': '/wiki',
      '/settings/assistant': '/rules',
      '/settings/assistant?view=memory': '/wiki?view=memory',
      '/settings/assistant?view=skills': '/wiki?view=knowledge',
      '/settings/assistant?view=nonsense': '/rules',
    }
    for (const [address, place] of Object.entries(leads)) {
      expect(await walk(address), address).toEqual({ end: place, steps: [place] })
    }
  })

  it('keeps /rules a page, and the other ids under /skills by the Agenter page switch alone', async () => {
    expect(await walk('/rules')).toEqual({ end: '/rules', steps: [] })
    for (const address of ['/skills/bookkeep', '/skills/ny']) {
      expect(await walk(address), address).toEqual(agents ? { end: address, steps: [] } : { end: 'not found', steps: [] })
    }
  })

  it('never goes in a circle and never takes a second step, from any address', async () => {
    for (const address of EVERY) {
      const { steps } = await walk(address)
      expect(steps.length, address).toBeLessThanOrEqual(1)
    }
  })
})

describe.each([
  ['unset', undefined],
  ['naming another company', 'another-company'],
])('with the agent picture %s: every address as before', (_name, picture) => {
  beforeEach(() => {
    if (picture !== undefined) vi.stubEnv('AGENT_PICTURE_COMPANY_IDS', picture)
  })

  it('shows every wiki address its own page, the bookkeeping profile too', async () => {
    agentsPage(true)
    for (const address of [...WIKI, '/wiki?view=map']) expect(await walk(address), address).toEqual({ end: address, steps: [] })
  })

  it('keeps /rules a page and /skills the Agenter page where that is open', async () => {
    agentsPage(true)
    for (const address of ['/rules', '/skills', '/skills/kunskap.horizontal.swedish-vat', '/skills/bookkeep', '/skills/ny']) {
      expect(await walk(address), address).toEqual({ end: address, steps: [] })
    }
  })

  it('answers /skills and its items with not found where the Agenter page is closed', async () => {
    agentsPage(false)
    for (const address of ['/skills', '/skills/kunskap.horizontal.swedish-vat', '/skills/bookkeep']) {
      expect(await walk(address), address).toEqual({ end: 'not found', steps: [] })
    }
  })

  it.each([
    [true, '/skills'],
    [false, '/wiki?view=skills'],
  ])('forwards the old addresses where it always did (Agenter page open: %s)', async (agents, skills) => {
    agentsPage(agents)
    const leads: Record<string, string> = {
      '/agent-knowledge': '/wiki',
      '/agent-knowledge?view=knowledge': '/wiki?view=map',
      '/agent-knowledge?view=facts': '/wiki?view=facts',
      '/agent-knowledge?view=memory': '/wiki?view=memory',
      '/agent-knowledge?view=skills': '/wiki?view=skills',
      '/agent-knowledge?view=nonsense': '/wiki',
      '/settings/assistant': '/wiki?view=map',
      '/settings/assistant?view=memory': '/wiki?view=memory',
      '/settings/assistant?view=skills': skills,
      '/settings/assistant?view=nonsense': '/wiki?view=map',
    }
    for (const [address, place] of Object.entries(leads)) {
      expect(await walk(address), address).toEqual({ end: place, steps: [place] })
    }
  })
})
