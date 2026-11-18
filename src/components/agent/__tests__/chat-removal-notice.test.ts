import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderInLocale, visibleText } from '@/tests/i18n-render'

// The built-in chat's own line about its removal (founder decisions
// 2026-11-17 and 2026-11-18): what it says in each language and where its
// link leads.

const { enabledExtensions } = vi.hoisted(() => ({ enabledExtensions: new Set<string>(['mcp-server']) }))
vi.mock('@/lib/extensions/_generated/enabled-extensions', () => ({ ENABLED_EXTENSION_IDS: enabledExtensions }))

import { ChatRemovalNotice } from '../ChatRemovalNotice'

const render = (locale: 'sv' | 'en') => renderInLocale(createElement(ChatRemovalNotice), locale)

/** The line as a person reads it: one string, the link's label in its place. */
const sentence = (html: string) => visibleText(html).join(' ').replace(/ \./g, '.')

afterEach(() => {
  enabledExtensions.clear()
  enabledExtensions.add('mcp-server')
})

describe('ChatRemovalNotice', () => {
  it('says in Swedish that the chat will be removed, where the bookkeeping goes and where questions go', () => {
    const html = render('sv')
    expect(sentence(html)).toBe(
      'Den här chatten kommer att tas bort. Bokföringen sköter du med din egen assistent, till exempel Claude, som du kopplar under Agenter > Koppla en agent. Frågor om appen ställer du till supporten.',
    )
  })

  it('says the same in English', () => {
    const html = render('en')
    expect(sentence(html)).toBe(
      'This chat will be removed. You do the bookkeeping with your own assistant, for example Claude, which you connect under Agents > Connect an agent. Questions about the app go to support.',
    )
  })

  it('links the menu\'s own two labels, and nothing else, to Koppla en agent', () => {
    for (const [locale, label] of [['sv', 'Agenter > Koppla en agent'], ['en', 'Agents > Connect an agent']] as const) {
      const html = render(locale)
      const links = [...html.matchAll(/<a [^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/g)].map((m) => [m[1], visibleText(m[2]).join(' ')])
      expect(links).toEqual([['/settings/api', label]])
    }
  })

  it('names no day and no "soon", and does not apologise: it stays true for as long as the chat is there', () => {
    for (const locale of ['sv', 'en'] as const) {
      const text = visibleText(render(locale)).join(' ')
      expect(text).not.toMatch(/\d/)
      expect(text).not.toMatch(/snart|inom kort|soon|shortly|tyvärr|beklagar|ledsen|sorry|unfortunately/i)
    }
  })

  it('points nowhere on an installation without Koppla en agent (no MCP server extension)', () => {
    enabledExtensions.clear()
    const html = render('sv')
    expect(visibleText(html)).toEqual(['Den här chatten kommer att tas bort.'])
    expect(html).not.toContain('href=')
    expect(visibleText(render('en'))).toEqual(['This chat will be removed.'])
  })
})
