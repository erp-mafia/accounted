import { isValidElement, type ReactElement, type ReactNode } from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// /wiki with and without the agent picture (AGENT_PICTURE_COMPANY_IDS).
// With it the page is the picture under the picture's own title whichever
// row the address names, and the map leads to Bokföringsregler. Without it
// every address shows the view it always showed, under that view's title.

const redirect = vi.fn((url: string) => {
  throw new Error(`NEXT_REDIRECT:${url}`)
})
vi.mock('next/navigation', () => ({ redirect: (url: string) => redirect(url) }))
vi.mock('next-intl/server', () => ({ getTranslations: async () => (key: string) => key }))
vi.mock('@/components/ui/page-header', () => ({ PageHeader: () => null }))
vi.mock('@/components/ui/help-popover', () => ({ HelpPopover: () => null }))
vi.mock('@/components/wiki/WikiViews', () => ({ WikiViews: () => null }))

const COMPANY = 'aaaaaaaa-0000-4000-8000-000000000001'
vi.mock('../../request-context', () => ({ getDashboardCompanyId: async () => COMPANY }))

// The extensions the installation is built with: the agent connection is the MCP server extension.
const { enabled } = vi.hoisted(() => ({ enabled: new Set<string>() }))
vi.mock('@/lib/extensions/_generated/enabled-extensions', () => ({ ENABLED_EXTENSION_IDS: enabled }))

const { default: WikiPage } = await import('../page')
const { PageHeader } = await import('@/components/ui/page-header')
const { WikiViews } = await import('@/components/wiki/WikiViews')

function elements(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(elements)
  if (!isValidElement<Record<string, unknown>>(node)) return []
  return [node, ...elements(node.props.children as ReactNode), ...elements(node.props.help as ReactNode)]
}

/** The top bar's title and help, and what the views are told, for one address. */
async function page(view?: string | string[]) {
  const all = elements(await WikiPage({ searchParams: Promise.resolve(view === undefined ? {} : { view }) }))
  const header = all.find((el) => el.type === PageHeader)!
  const help = header.props.help as ReactElement<{ children: string }>
  return { title: header.props.title, help: help.props.children, views: all.find((el) => el.type === WikiViews)!.props }
}

beforeEach(() => {
  vi.clearAllMocks()
  enabled.clear()
  enabled.add('mcp-server')
})
afterEach(() => {
  vi.unstubAllEnvs()
})

describe('/wiki with the agent picture on', () => {
  beforeEach(() => {
    vi.stubEnv('AGENT_PICTURE_COMPANY_IDS', COMPANY)
  })

  it.each([undefined, 'context', 'checks', 'memory', 'knowledge', 'skills', 'nonsense'])('is the picture, under its own title and help, for view=%s', async (view) => {
    expect(await page(view)).toEqual({ title: 'view_context', help: 'picture.help', views: { facts: false, picture: true } })
    expect(redirect).not.toHaveBeenCalled()
  })

  it('reads the first value when the address names view more than once', async () => {
    expect(await page(['memory', 'map'])).toEqual({ title: 'view_context', help: 'picture.help', views: { facts: false, picture: true } })
    expect(redirect).not.toHaveBeenCalled()
    await expect(page(['map', 'memory'])).rejects.toThrow('NEXT_REDIRECT:/rules')
  })

  it('leads the map to Bokföringsregler', async () => {
    await expect(page('map')).rejects.toThrow('NEXT_REDIRECT:/rules')
    expect(redirect).toHaveBeenCalledTimes(1)
  })

  it('keeps Fakta its own view where Arkiv reads the documents, and the picture elsewhere', async () => {
    expect(await page('facts')).toEqual({ title: 'view_context', help: 'picture.help', views: { facts: false, picture: true } })
    vi.stubEnv('ARKIV_BRAIN_COMPANY_IDS', COMPANY)
    expect(await page('facts')).toEqual({ title: 'view_facts', help: 'help', views: { facts: true, picture: true } })
    // The picture's rows open the same there.
    expect(await page('memory')).toEqual({ title: 'view_context', help: 'picture.help', views: { facts: true, picture: true } })
    await expect(page('map')).rejects.toThrow('NEXT_REDIRECT:/rules')
  })
})

describe('/wiki with the agent picture on, on an installation without the agent connection', () => {
  beforeEach(() => {
    vi.stubEnv('AGENT_PICTURE_COMPANY_IDS', COMPANY)
    enabled.delete('mcp-server')
  })

  it.each([undefined, 'context', 'checks', 'memory', 'knowledge', 'skills', 'map', 'nonsense'])('leads to Bokföringsregler instead of a page that says the connection does not exist, for view=%s', async (view) => {
    await expect(page(view)).rejects.toThrow('NEXT_REDIRECT:/rules')
    expect(redirect).toHaveBeenCalledTimes(1)
  })

  it('keeps Fakta its own view where Arkiv reads the documents', async () => {
    vi.stubEnv('ARKIV_BRAIN_COMPANY_IDS', COMPANY)
    expect(await page('facts')).toEqual({ title: 'view_facts', help: 'help', views: { facts: true, picture: true } })
    expect(redirect).not.toHaveBeenCalled()
  })

  it('shows the picture again with the connection', async () => {
    enabled.add('mcp-server')
    expect(await page()).toEqual({ title: 'view_context', help: 'picture.help', views: { facts: false, picture: true } })
    expect(redirect).not.toHaveBeenCalled()
  })
})

describe.each([
  ['unset', undefined],
  ['naming another company', 'another-company'],
])('/wiki with the agent picture %s: as before', (_name, picture) => {
  beforeEach(() => {
    if (picture !== undefined) vi.stubEnv('AGENT_PICTURE_COMPANY_IDS', picture)
  })

  it.each([
    [undefined, 'view_context'],
    ['context', 'view_context'],
    ['map', 'view_map'],
    ['memory', 'view_memory'],
    ['skills', 'view_skills'],
    // Fakta is not offered outside the Arkiv rollout: the landing.
    ['facts', 'view_context'],
    // The picture's own row names are not wiki views: the landing.
    ['knowledge', 'view_context'],
    ['checks', 'view_context'],
    ['nonsense', 'view_context'],
  ])('shows view=%s under %s, with the wiki help, and leads nowhere', async (view, title) => {
    expect(await page(view)).toEqual({ title, help: 'help', views: { facts: false, picture: false } })
    expect(redirect).not.toHaveBeenCalled()
  })

  it('shows Fakta where Arkiv reads the documents', async () => {
    vi.stubEnv('ARKIV_BRAIN_COMPANY_IDS', COMPANY)
    expect(await page('facts')).toEqual({ title: 'view_facts', help: 'help', views: { facts: true, picture: false } })
    expect(redirect).not.toHaveBeenCalled()
  })
})
