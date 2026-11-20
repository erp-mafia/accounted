/**
 * The AI assistant's panel in the support dialog, rendered under both
 * catalogues: a missing key or a broken ICU argument fails here, English
 * shows no Swedish, and the way to a person is on screen in every state.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement, type ReactNode } from 'react'
import { looksSwedish } from '@/scripts/checks/swedish-ui-literal.mjs'
import { renderInLocale, visibleText } from '@/tests/i18n-render'
import sv from '@/messages/sv.json'
import en from '@/messages/en.json'
import { clearSupportAskSession, writeSupportAskSession } from '@/lib/support/assistant-session'

type Children = { children?: ReactNode }

vi.mock('next/navigation', () => ({ usePathname: () => '/invoices' }))
vi.mock('@/components/ui/dialog', () => ({
  DialogFooter: ({ children }: Children) => createElement('div', null, children),
}))
vi.mock('@/components/agent/lazy-markdown', () => ({
  MarkdownMessage: ({ text }: { text: string }) => createElement('p', null, text),
  useMarkdownReady: () => true,
}))
vi.mock('@/lib/analytics/client', () => ({ captureAnalyticsEvent: vi.fn() }))

import { SupportAsk } from '../SupportAsk'

const COMPANY = 'company-1'
const noop = () => undefined

function render(locale: 'sv' | 'en', props: { ticketCount?: number } = {}): string[] {
  return visibleText(
    renderInLocale(
      createElement(SupportAsk, {
        companyId: COMPANY,
        ticketCount: props.ticketCount ?? 0,
        onShowTickets: noop,
        onWriteToSupport: noop,
        onHandoff: noop,
        onNavigate: noop,
      }),
      locale,
    ),
  )
}

beforeEach(() => clearSupportAskSession())

describe('SupportAsk, before the first question', () => {
  it('shows the question box, what the assistant is and is not, and the way to a person', () => {
    const text = render('sv')
    expect(text).toContain(sv.support_link.ask_placeholder)
    expect(text).toContain(sv.support_link.ask_disclaimer)
    expect(text).toContain(sv.support_link.ask_send)
    expect(text).toContain(sv.support_link.ask_write_to_support)
    // No conversation yet: nothing to rate, send on or start over.
    expect(text).not.toContain(sv.support_link.ask_send_to_support)
    expect(text).not.toContain(sv.support_link.ask_start_over)
  })

  it('names the tickets the user already has with the staff, one and many', () => {
    expect(render('sv', { ticketCount: 1 })).toContain('Du har 1 ärende hos supporten.')
    expect(render('sv', { ticketCount: 3 })).toContain('Du har 3 ärenden hos supporten.')
    expect(render('en', { ticketCount: 1 })).toContain('You have 1 ticket with support.')
    expect(render('sv')).not.toContain(sv.support_link.ask_show_tickets)
  })
})

describe('SupportAsk, with a conversation', () => {
  const conversation = () =>
    writeSupportAskSession({
      companyId: COMPANY,
      conversationId: '11111111-2222-4333-8444-555555555555',
      turns: [
        { role: 'user', text: 'Where do I create an invoice?' },
        { role: 'assistant', text: 'Under Invoices.', handoff: null },
        { role: 'user', text: 'The button is missing.' },
        { role: 'assistant', text: 'Support can look at that.', handoff: { reason: 'problem_report', summary: 'Button missing.' } },
      ],
    })

  it('shows the turns it was closed with, a rating on each answer, and sending on and starting over on the last', () => {
    conversation()
    const text = render('sv')
    expect(text).toContain('Where do I create an invoice?')
    expect(text).toContain('Under Invoices.')
    expect(text.filter((line) => line === sv.support_link.ask_good_answer)).toHaveLength(2)
    expect(text.filter((line) => line === sv.support_link.ask_bad_answer)).toHaveLength(2)
    expect(text.filter((line) => line === sv.support_link.ask_send_to_support)).toHaveLength(1)
    expect(text.filter((line) => line === sv.support_link.ask_start_over)).toHaveLength(1)
    expect(text).toContain(sv.support_link.ask_write_to_support)
  })

  it('shows another company nothing of it', () => {
    conversation()
    const text = visibleText(
      renderInLocale(
        createElement(SupportAsk, {
          companyId: 'company-2',
          ticketCount: 0,
          onShowTickets: noop,
          onWriteToSupport: noop,
          onHandoff: noop,
          onNavigate: noop,
        }),
        'sv',
      ),
    )
    expect(text).not.toContain('Under Invoices.')
  })

  it('is English throughout under the English catalogue', () => {
    conversation()
    const text = render('en', { ticketCount: 2 })
    expect(text).toContain(en.support_link.ask_send_to_support)
    expect(text).toContain(en.support_link.ask_disclaimer)
    expect(text.filter((line) => looksSwedish(line))).toEqual([])
  })
})
