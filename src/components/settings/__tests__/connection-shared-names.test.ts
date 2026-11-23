/**
 * The connection list (Settings, API and MCP): a row whose shown name
 * another row carries too says since when it has been connected, as quiet
 * text after the name, short enough to be shown whole with its date; a row
 * with a name of its own shows nothing more. Rendered with the real message
 * files.
 */
import { describe, expect, it, vi } from 'vitest'
import { createElement, type ComponentProps } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { NextIntlClientProvider } from 'next-intl'
import sv from '@/messages/sv.json'
import en from '@/messages/en.json'
import { TooltipProvider } from '@/components/ui/info-tooltip'
import { SHARED_NAME_TEXT_BUDGET, sharedNames } from '@/lib/settings/mcp-connections'

// The panel asks whether the viewer may write; the list itself reads the same either way.
vi.mock('@/lib/hooks/use-can-write', () => ({ useCanWrite: () => ({ canWrite: true }) }))

import { McpConnectionsPanel } from '../McpConnectionsPanel'
import type { ApiKeyRow } from '../useApiKeys'

const IntlProvider = NextIntlClientProvider as (props: Omit<ComponentProps<typeof NextIntlClientProvider>, 'children'>) => ReturnType<typeof NextIntlClientProvider>

const OAUTH_KEY_NAME = 'MCP-klient (OAuth)'
const row = (id: string, over: Partial<ApiKeyRow> = {}): ApiKeyRow => ({
  id,
  key_prefix: 'gnubok_sk_abcd',
  name: OAUTH_KEY_NAME,
  scopes: ['reports:read'],
  rate_limit_rpm: 100,
  last_used_at: null,
  revoked_at: null,
  created_at: '2026-01-04T10:00:00.000Z',
  client: 'claude',
  source: 'signin',
  is_own: true,
  owner_name: null,
  service_account: null,
  ...over,
})

function render(keys: ApiKeyRow[], locale: 'sv' | 'en' = 'sv'): string {
  return renderToStaticMarkup(
    createElement(
      IntlProvider,
      { locale, messages: locale === 'sv' ? sv : en, timeZone: 'Europe/Stockholm' },
      createElement(TooltipProvider, null, createElement(McpConnectionsPanel, { keys, isLoading: false, onRevoke: async () => {} })),
    ),
  )
}
/** The text of each row's name cell: the name, its badges and the quiet text, tags stripped. */
const nameCells = (html: string): string[] =>
  [...html.matchAll(/<li class="flex items-center gap-3 border-b-hairline px-1 py-2">[\s\S]*?<span class="flex min-w-0 flex-1 items-center gap-2 text-\[13px\]">([\s\S]*?)<\/span><span class="hidden w-40/g)].map((m) =>
    m[1]
      .split('<')
      .map((part, index) => (index === 0 ? part : part.slice(part.indexOf('>') + 1)))
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim(),
  )

/** The quiet text of each row that has one, with the title a pointer shows over it. */
const quietTexts = (html: string): Array<{ text: string; title: string }> =>
  [...html.matchAll(/<span class="min-w-0 truncate text-xs text-muted-foreground" title="([^"]*)">([^<]*)<\/span>/g)].map((m) => ({ title: m[1], text: m[2] }))

/** The classes of each badge that names an owner or a service account. */
const ownerBadges = (html: string): string[] => [...html.matchAll(/class="([^"]*max-w-(?:56|48) truncate[^"]*)"/g)].map((m) => m[1])

describe('sharedNames', () => {
  it('answers the names more than one row carries', () => {
    expect([...sharedNames(['Claude', 'MCP-klient', 'Claude', 'Nattjobbet', 'MCP-klient', 'Claude'])].sort()).toEqual(['Claude', 'MCP-klient'])
    expect(sharedNames(['Claude', 'ChatGPT', 'Nattjobbet']).size).toBe(0)
    expect(sharedNames([]).size).toBe(0)
  })

  it('tells names apart exactly as they are shown', () => {
    expect(sharedNames(['Nattjobbet', 'nattjobbet', 'Nattjobbet ']).size).toBe(0)
  })
})

describe('the connection list', () => {
  it('shows a row with a name of its own as before: the name alone', () => {
    const cells = nameCells(render([row('c1'), row('g1', { client: 'chatgpt' }), row('k1', { name: 'Nattjobbet', client: null, source: 'manual' })]))
    expect(cells).toEqual(['Claude', 'ChatGPT', 'Nattjobbet'])
  })

  it('says who connected a row and since when on every row whose name another row carries', () => {
    const cells = nameCells(
      render([
        row('c1'),
        row('c2', { created_at: '2026-02-12T10:00:00.000Z' }),
        row('g1', { client: 'chatgpt' }),
        row('m1', { client: null, created_at: '2025-11-30T10:00:00.000Z' }),
        row('m2', { client: null, created_at: '2025-12-24T10:00:00.000Z' }),
      ]),
    )
    expect(cells).toEqual([
      'Claude sedan 4 jan. 2026',
      'Claude sedan 12 feb. 2026',
      // The one ChatGPT row is told apart by its name.
      'ChatGPT',
      'MCP-klient sedan 30 nov. 2025',
      'MCP-klient sedan 24 dec. 2025',
    ])
  })

  it("says on the viewer's own row, in the text's title, that they connected it", () => {
    const own = [row('c1'), row('c2', { created_at: '2026-02-12T10:00:00.000Z' })]
    expect(quietTexts(render(own))).toEqual([
      { text: 'sedan 4 jan. 2026', title: 'Ansluten av dig sedan 4 jan. 2026' },
      { text: 'sedan 12 feb. 2026', title: 'Ansluten av dig sedan 12 feb. 2026' },
    ])
    expect(quietTexts(render(own, 'en'))).toEqual([
      { text: 'since Jan 4, 2026', title: 'Connected by you since Jan 4, 2026' },
      { text: 'since Feb 12, 2026', title: 'Connected by you since Feb 12, 2026' },
    ])
  })

  it('leaves the owner to the badge on a colleague\'s row and adds since when', () => {
    const cells = nameCells(render([row('c1'), row('c2', { is_own: false, owner_name: 'Anna Ek', created_at: '2026-02-12T10:00:00.000Z' }), row('c3', { is_own: false, created_at: '2026-03-01T10:00:00.000Z' })]))
    expect(cells).toEqual(['Claude sedan 4 jan. 2026', 'Claude Ansluten av Anna Ek sedan 12 feb. 2026', 'Claude Kollega sedan 1 mars 2026'])
  })

  it('says it in English too', () => {
    const cells = nameCells(render([row('c1'), row('c2', { is_own: false, owner_name: 'Anna Ek', created_at: '2026-02-12T10:00:00.000Z' }), row('g1', { client: 'chatgpt' })], 'en'))
    expect(cells).toEqual(['Claude since Jan 4, 2026', 'Claude Connected by Anna Ek since Feb 12, 2026', 'ChatGPT'])
  })

  it('tells two hand-made keys with one name apart the same way, and leaves a key with its own name alone', () => {
    const key = (id: string, name: string, created_at: string) => row(id, { name, client: null, source: 'manual', created_at })
    const cells = nameCells(render([key('k1', 'Nattjobbet', '2026-01-04T10:00:00.000Z'), key('k2', 'Nattjobbet', '2026-01-05T10:00:00.000Z'), key('k3', 'Rapporter', '2026-01-06T10:00:00.000Z')]))
    expect(cells).toEqual(['Nattjobbet sedan 4 jan. 2026', 'Nattjobbet sedan 5 jan. 2026', 'Rapporter'])
  })
})

describe('the room for the quiet text', () => {
  /** A day late in each month of the year: the longest date a row can show. */
  const LATE_DAYS: string[] = Array.from({ length: 12 }, (_, month) => `2026-${String(month + 1).padStart(2, '0')}-28T10:00:00.000Z`)
  /** Every kind of row that carries the text, all under one name: the viewer's own, a named and an unnamed colleague's, a service account's. */
  const sharedRows = (created_at: string): ApiKeyRow[] => [
    row('own-1', { created_at }),
    row('own-2', { created_at }),
    row('colleague-named', { created_at, is_own: false, owner_name: 'Anna Ek' }),
    row('colleague', { created_at, is_own: false }),
    row('service', { created_at, is_own: false, service_account: { id: 'sa-1', name: 'Nattjobb' } }),
  ]

  it.each(['sv', 'en'] as const)('holds the longest text every kind of row can show, in %s', (locale) => {
    const texts: string[] = LATE_DAYS.flatMap((created_at) => quietTexts(render(sharedRows(created_at), locale)).map((quiet) => quiet.text))
    // Five rows a month, each with its text.
    expect(texts).toHaveLength(60)
    const longest = texts.reduce((a, b) => (b.length > a.length ? b : a))
    expect(longest.length, longest).toBeLessThanOrEqual(SHARED_NAME_TEXT_BUDGET)
  })

  it('gives way with the badge before the text, on a row that has both', () => {
    const [named, unnamed, service] = ownerBadges(render(sharedRows('2026-03-28T10:00:00.000Z')))
    for (const badge of [named, unnamed, service]) expect(badge.split(' ')).toContain('shrink-[100]')
  })

  it('gives way with the name of a hand-made key before the text', () => {
    const key = (id: string) => row(id, { name: 'Nattjobbet', client: null, source: 'manual' })
    const html = render([key('k1'), key('k2')])
    expect(html).toContain('<span class="truncate shrink-[100]">Nattjobbet</span>')
  })

  it('leaves a row with a name of its own as it was: no text, and the badge shrinks as before', () => {
    const html = render([row('c1'), row('g1', { client: 'chatgpt', is_own: false, owner_name: 'Anna Ek' }), row('k1', { name: 'Rapporter', client: null, source: 'manual' })])
    expect(quietTexts(html)).toEqual([])
    expect(ownerBadges(html).map((badge) => badge.split(' ').filter((name) => name.startsWith('shrink')))).toEqual([['shrink']])
    expect(html).toContain('<span class="truncate">Rapporter</span>')
    expect(html).not.toContain('shrink-[100]')
  })
})
