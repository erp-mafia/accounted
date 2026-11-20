/**
 * /chat for a company without the built-in chat: what took its place, in
 * both languages, and only the ways forward that exist for the company.
 */
import { createElement, type ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { looksSwedish } from '@/scripts/checks/swedish-ui-literal.mjs'
import { renderInLocale, visibleText } from '@/tests/i18n-render'
import sv from '@/messages/sv.json'
import en from '@/messages/en.json'

const { enabledExtensions } = vi.hoisted(() => ({ enabledExtensions: new Set<string>(['mcp-server']) }))
vi.mock('@/lib/extensions/_generated/enabled-extensions', () => ({ ENABLED_EXTENSION_IDS: enabledExtensions }))
// The support dialog is the shell's own; here it is only opened.
const supportLinks = vi.fn((_props: Record<string, unknown>) => null)
vi.mock('@/components/ui/support-link', () => ({ SupportLink: (props: Record<string, unknown>) => supportLinks(props) }))
vi.mock('@/components/ui/page-header', () => ({
  PageHeader: ({ title }: { title: string }) => createElement('h1', null, title),
}))
vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) => createElement('a', { href }, children),
}))

import { CompanyProvider } from '@/contexts/CompanyContext'
import { ChatReplaced } from '../ChatReplaced'

// createElement takes the page as its third argument: the provider's own props type asks for it as a prop.
const Provider = CompanyProvider as (props: { value: never; children?: ReactNode }) => ReturnType<typeof CompanyProvider>

function render(locale: 'sv' | 'en', props: { until?: string | null; supportAssistant?: boolean } = {}): string {
  return renderInLocale(
    createElement(
      Provider,
      { value: { supportAssistant: props.supportAssistant ?? true } as never },
      createElement(ChatReplaced, { until: props.until ?? null }),
    ),
    locale,
  )
}

const links = (html: string) =>
  [...html.matchAll(/<a [^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/g)].map((m) => [m[1], visibleText(m[2]).join(' ')])

afterEach(() => {
  enabledExtensions.clear()
  enabledExtensions.add('mcp-server')
  vi.clearAllMocks()
})

describe('ChatReplaced', () => {
  it('says what took the chat\'s place: questions in support, the bookkeeping with a person\'s own AI', () => {
    const text = visibleText(render('sv'))
    expect(text).toContain(sv.nav.v3_chat)
    expect(text).toContain(sv.agent_chat.replaced_title)
    expect(text).toContain(sv.agent_chat.replaced_body)
    expect(text).toContain(sv.agent_chat.replaced_ask_body)
    expect(text).toContain(sv.agent_chat.replaced_do_body)
    // Both assistants a person can connect are named.
    expect(sv.agent_chat.replaced_do_body).toMatch(/Claude eller ChatGPT/)
  })

  it('leads to Koppla en agent, from the card and from its own section', () => {
    expect(links(render('sv'))).toEqual([
      ['/settings/api', sv.agent_chat.replaced_do_action],
      ['/settings/api', sv.agent_chat.replaced_do_action],
    ])
  })

  it('says how to keep the chat a while, and names the last day only when one is set', () => {
    const withDay = visibleText(render('sv', { until: '2027-01-31' }))
    expect(withDay).toContain('Skriv till oss så slår vi på den igen. Den tas bort helt den 31 jan. 2027.')
    const without = visibleText(render('sv'))
    expect(without).toContain(sv.agent_chat.replaced_keep_body)
    expect(without.join(' ')).not.toMatch(/\d{4}/)
  })

  it('asks for the chat back from a person, never the assistant, with the subject filled in', () => {
    render('sv')
    const [ask, keep] = supportLinks.mock.calls.map(([props]) => props)
    expect(ask).toMatchObject({ variant: 'hidden', open: false })
    expect(ask.assistant).toBeUndefined()
    expect(keep).toMatchObject({ variant: 'hidden', open: false, assistant: false, subject: sv.agent_chat.replaced_keep_subject })
  })

  it('offers the support form where the company has no AI assistant in support', () => {
    const text = visibleText(render('sv', { supportAssistant: false }))
    expect(text).toContain(sv.agent_chat.replaced_ask_body_staff)
    expect(text).not.toContain(sv.agent_chat.replaced_ask_body)
    expect(text).not.toContain(sv.agent_chat.replaced_ask_action)
  })

  it('offers no connection on an installation without Koppla en agent (no MCP server extension)', () => {
    enabledExtensions.clear()
    const html = render('sv')
    expect(links(html)).toEqual([])
    const text = visibleText(html)
    expect(text).toContain(sv.agent_chat.replaced_body_ask_only)
    expect(text).not.toContain(sv.agent_chat.replaced_do_title)
  })

  it('is English throughout under the English catalogue', () => {
    const text = visibleText(render('en', { until: '2027-01-31' }))
    expect(text).toContain(en.agent_chat.replaced_title)
    expect(text.filter((line) => looksSwedish(line))).toEqual([])
  })
})
