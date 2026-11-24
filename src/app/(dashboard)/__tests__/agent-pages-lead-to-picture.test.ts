/**
 * The pages about what an agent gets, walked by address: /wiki and its
 * views, /skills and its items, /rules, and the two addresses that only
 * forward (/agent-knowledge, /settings/assistant).
 *
 * With the agent picture on (AGENT_PICTURE_COMPANY_IDS) the addresses the
 * picture took over lead to it, each in one step and never in a circle.
 * Without it every address answers as it did: the same page, or the same
 * one step to the same place.
 *
 * The walk states the installation itself: with the agent connection (the
 * MCP server extension) unless a case takes it away, never by what the
 * generated extension list of the machine happens to hold. Without the
 * connection there is no picture to show, and every address the picture
 * took over ends on Bokföringsregler, still in one step.
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

// The extensions the installation is built with, as the pages read them.
const { extensions } = vi.hoisted(() => ({ extensions: new Set<string>() }))
vi.mock('@/lib/extensions/_generated/enabled-extensions', () => ({ ENABLED_EXTENSION_IDS: extensions }))

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

/** The installation: with or without the agent connection (the MCP server extension). */
function agentConnection(on: boolean) {
  extensions.clear()
  if (on) extensions.add('mcp-server')
}

beforeEach(() => {
  vi.clearAllMocks()
  agentConnection(true)
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

  it('keeps /rules a page, an own item\'s pages open, and the other ids under /skills by the Agenter page switch alone', async () => {
    expect(await walk('/rules')).toEqual({ end: '/rules', steps: [] })
    // The pages the Kunskap panel leads to answer with the picture on, whatever the Agenter page switch says.
    expect(await walk('/skills/ny')).toEqual({ end: '/skills/ny', steps: [] })
    // Every other id follows the Agenter page switch, as before.
    expect(await walk('/skills/bookkeep')).toEqual(agents ? { end: '/skills/bookkeep', steps: [] } : { end: 'not found', steps: [] })
  })

  it('never goes in a circle and never takes a second step, from any address', async () => {
    for (const address of EVERY) {
      const { steps } = await walk(address)
      expect(steps.length, address).toBeLessThanOrEqual(1)
    }
  })
})

describe.each([
  ['the Agenter page open', true],
  ['the Agenter page closed', false],
])('with the agent picture on, without the agent connection, and %s', (_name, agents) => {
  beforeEach(() => {
    vi.stubEnv('AGENT_PICTURE_COMPANY_IDS', COMPANY)
    agentsPage(agents)
    agentConnection(false)
  })

  it('leads /wiki and every address that names a row of the picture to Bokföringsregler, in one step', async () => {
    for (const address of [...WIKI, '/wiki?view=map']) expect(await walk(address), address).toEqual({ end: '/rules', steps: ['/rules'] })
  })

  it('leads each address that forwards into the picture to Bokföringsregler itself, in one step and not by way of /wiki', async () => {
    for (const address of ['/skills', '/skills/kunskap.horizontal.swedish-vat', ...FORWARDS]) {
      expect(await walk(address), address).toEqual({ end: '/rules', steps: ['/rules'] })
    }
  })

  it('keeps /rules a page, an own item\'s pages open, and the other ids under /skills by the Agenter page switch alone', async () => {
    expect(await walk('/rules')).toEqual({ end: '/rules', steps: [] })
    expect(await walk('/skills/ny')).toEqual({ end: '/skills/ny', steps: [] })
    expect(await walk('/skills/bookkeep')).toEqual(agents ? { end: '/skills/bookkeep', steps: [] } : { end: 'not found', steps: [] })
  })

  it('never goes in a circle, never takes a second step and never ends on /wiki, from any address', async () => {
    for (const address of EVERY) {
      const { end, steps } = await walk(address)
      expect(steps.length, address).toBeLessThanOrEqual(1)
      expect(end.startsWith('/wiki'), `${address} ends on ${end}`).toBe(false)
      for (const step of steps) expect(step.startsWith('/wiki'), `${address} goes by way of ${step}`).toBe(false)
    }
  })

  it('keeps Fakta a page of its own where Arkiv reads the documents: it needs no agent connection', async () => {
    vi.stubEnv('ARKIV_BRAIN_COMPANY_IDS', COMPANY)
    expect(await walk('/wiki?view=facts')).toEqual({ end: '/wiki?view=facts', steps: [] })
    expect(await walk('/agent-knowledge?view=facts')).toEqual({ end: '/wiki?view=facts', steps: ['/wiki?view=facts'] })
    // Every other address still ends on Bokföringsregler, in one step.
    for (const address of ['/wiki', '/wiki?view=memory', '/skills', '/agent-knowledge', '/settings/assistant?view=memory']) {
      expect(await walk(address), address).toEqual({ end: '/rules', steps: ['/rules'] })
    }
  })
})

describe('with the agent picture off, the agent connection changes nothing', () => {
  beforeEach(() => {
    vi.stubEnv('AGENT_PICTURE_COMPANY_IDS', 'another-company')
  })

  it.each([
    ['open', true],
    ['closed', false],
  ])('answers every address the same in both installations, in one step at most (Agenter page %s)', async (_name, agents) => {
    agentsPage(agents)
    for (const address of EVERY) {
      agentConnection(true)
      const withConnection = await walk(address)
      agentConnection(false)
      const withoutConnection = await walk(address)
      expect(withoutConnection, address).toEqual(withConnection)
      expect(withoutConnection.steps.length, address).toBeLessThanOrEqual(1)
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
