/**
 * The floating button that opens the support panel for a person whose
 * built-in assistant is gone: what it says in each language, where it is not
 * shown, and that it is another thing than the assistant's own button.
 */
import { createElement } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { looksSwedish } from '@/scripts/checks/swedish-ui-literal.mjs'
import { renderInLocale, visibleText } from '@/tests/i18n-render'
import sv from '@/messages/sv.json'
import en from '@/messages/en.json'

const pathname = vi.fn(() => '/invoices')
vi.mock('next/navigation', () => ({ usePathname: () => pathname(), useRouter: () => ({ refresh: vi.fn() }) }))
vi.mock('@/components/ui/use-toast', () => ({ useToast: () => ({ toast: vi.fn() }) }))

import { SupportAskTrigger } from '../SupportAskTrigger'

const render = (locale: 'sv' | 'en', props: { hidden?: boolean; open?: boolean } = {}) =>
  renderInLocale(createElement(SupportAskTrigger, { open: false, onOpen: () => {}, ...props }), locale)

beforeEach(() => {
  vi.clearAllMocks()
  pathname.mockReturnValue('/invoices')
})

describe('SupportAskTrigger', () => {
  it('says support, in both languages, with a way to hide it', () => {
    expect(visibleText(render('sv'))).toEqual([sv.support_link.ask_fab, sv.support_link.ask_fab_hide, sv.support_link.ask_fab_hide])
    const english = visibleText(render('en'))
    expect(english).toContain(en.support_link.ask_fab)
    expect(english.filter((line) => looksSwedish(line))).toEqual([])
  })

  it('is another thing than the built-in button: no name, no face, no dark pill', () => {
    const html = render('sv')
    expect(html).not.toContain('<img')
    expect(html).not.toContain('bg-foreground')
    expect(html).toContain('bg-popover')
    // It keeps the page clear of itself the way the assistant's button did.
    expect(html).toContain('data-agent-fab')
  })

  it('is not drawn for a person who hid the floating button', () => {
    expect(render('sv', { hidden: true })).toBe('')
  })

  it('is not drawn while the panel it opens is open: the panel sits in its place', () => {
    expect(render('sv', { open: true })).toBe('')
  })

  it.each(['/chat', '/chat/new', '/bookkeeping/11111111-1111-4111-8111-111111111111'])('is not drawn on %s', (path) => {
    pathname.mockReturnValue(path)
    expect(render('sv')).toBe('')
  })

  it.each(['/bookkeeping', '/bookkeeping/new', '/bookkeeping/year-end', '/'])('is drawn on %s', (path) => {
    pathname.mockReturnValue(path)
    expect(visibleText(render('sv'))).toContain(sv.support_link.ask_fab)
  })
})
