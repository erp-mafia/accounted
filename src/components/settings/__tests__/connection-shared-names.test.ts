/**
 * The connection list (Settings, API and MCP): a row whose shown name
 * another row carries too says who connected it and since when, as quiet
 * text after the name; a row with a name of its own shows nothing more.
 * Rendered with the real message files.
 */
import { describe, expect, it, vi } from 'vitest'
import { createElement, type ComponentProps } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { NextIntlClientProvider } from 'next-intl'
import sv from '@/messages/sv.json'
import en from '@/messages/en.json'
import { TooltipProvider } from '@/components/ui/info-tooltip'
import { sharedNames } from '@/lib/settings/mcp-connections'

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
    m[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(),
  )

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
      'Claude Ansluten av dig sedan 4 jan. 2026',
      'Claude Ansluten av dig sedan 12 feb. 2026',
      // The one ChatGPT row is told apart by its name.
      'ChatGPT',
      'MCP-klient Ansluten av dig sedan 30 nov. 2025',
      'MCP-klient Ansluten av dig sedan 24 dec. 2025',
    ])
  })

  it('leaves the owner to the badge on a colleague\'s row and adds since when', () => {
    const cells = nameCells(render([row('c1'), row('c2', { is_own: false, owner_name: 'Anna Ek', created_at: '2026-02-12T10:00:00.000Z' }), row('c3', { is_own: false, created_at: '2026-03-01T10:00:00.000Z' })]))
    expect(cells).toEqual(['Claude Ansluten av dig sedan 4 jan. 2026', 'Claude Ansluten av Anna Ek sedan 12 feb. 2026', 'Claude Kollega sedan 1 mars 2026'])
  })

  it('says it in English too', () => {
    const cells = nameCells(render([row('c1'), row('c2', { is_own: false, owner_name: 'Anna Ek', created_at: '2026-02-12T10:00:00.000Z' }), row('g1', { client: 'chatgpt' })], 'en'))
    expect(cells).toEqual(['Claude Connected by you since Jan 4, 2026', 'Claude Connected by Anna Ek since Feb 12, 2026', 'ChatGPT'])
  })

  it('tells two hand-made keys with one name apart the same way, and leaves a key with its own name alone', () => {
    const key = (id: string, name: string, created_at: string) => row(id, { name, client: null, source: 'manual', created_at })
    const cells = nameCells(render([key('k1', 'Nattjobbet', '2026-01-04T10:00:00.000Z'), key('k2', 'Nattjobbet', '2026-01-05T10:00:00.000Z'), key('k3', 'Rapporter', '2026-01-06T10:00:00.000Z')]))
    expect(cells).toEqual(['Nattjobbet Ansluten av dig sedan 4 jan. 2026', 'Nattjobbet Ansluten av dig sedan 5 jan. 2026', 'Rapporter'])
  })
})
