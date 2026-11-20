/**
 * The support as a panel docked beside the page: the same header as the
 * dialog without being one, and a dock that draws its button and panel from
 * the state every door shares.
 */
import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { looksSwedish } from '@/scripts/checks/swedish-ui-literal.mjs'
import { renderInLocale, visibleText } from '@/tests/i18n-render'
import sv from '@/messages/sv.json'
import en from '@/messages/en.json'

vi.mock('next/navigation', () => ({ usePathname: () => '/invoices', useRouter: () => ({ refresh: vi.fn() }) }))
vi.mock('@/components/ui/use-toast', () => ({ useToast: () => ({ toast: vi.fn() }) }))
// A server render reads the store's server snapshot, which is always closed
// (no panel is ever open in the first HTML). The test reads the live state.
vi.mock('@/lib/support/dock', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/support/dock')>()
  return { ...actual, useSupportDock: () => actual.supportDockState() }
})

import { SupportLink } from '@/components/ui/support-link'
import { closeSupportDock, mountSupportDock, openSupportDock } from '@/lib/support/dock'
import { SupportDock } from '../SupportDock'

let release: (() => void) | null = null

beforeEach(() => {
  vi.clearAllMocks()
  // The dock registers itself in an effect, which a server render never
  // runs: the test stands in for the mounted dock.
  release = mountSupportDock()
})

afterEach(() => {
  release?.()
  closeSupportDock()
})

describe('SupportLink as the docked panel', () => {
  const panel = (locale: 'sv' | 'en', open = true) =>
    renderInLocale(createElement(SupportLink, { variant: 'hidden', presentation: 'panel', open }), locale)

  it('carries the dialog header and a close button, in both languages', () => {
    const swedish = visibleText(panel('sv'))
    expect(swedish).toContain(sv.support_link.dialog_title)
    expect(swedish).toContain(sv.common.close)
    const english = visibleText(panel('en'))
    expect(english).toContain(en.support_link.dialog_title)
    expect(english.filter((line) => looksSwedish(line))).toEqual([])
  })

  it('is a labelled panel beside the page, not a modal dialog over it', () => {
    const html = panel('sv')
    expect(html).toContain('role="dialog"')
    expect(html).toMatch(/aria-labelledby="[^"]+"/)
    // A Radix dialog marks itself with data-state and dims the page.
    expect(html).not.toContain('data-state')
    expect(html).not.toContain('bg-veil')
    // A click in it never dismisses a dialog the user is filling in beside it.
    expect(html).toContain('data-agent-ui')
    // In the corner the floating button holds, from md up only.
    expect(html).toContain('bottom-4 right-4')
    expect(html).toContain('hidden')
    expect(html).toContain('md:grid')
  })

  it('draws nothing while closed', () => {
    expect(panel('sv', false)).toBe('')
  })
})

describe('SupportDock', () => {
  const dock = (props: { pillHidden?: boolean } = {}) => renderInLocale(createElement(SupportDock, props), 'sv')

  it('closed: the floating button for everyone, and nothing for a person who hid it', () => {
    expect(visibleText(dock())).toContain(sv.support_link.ask_fab)
    expect(dock({ pillHidden: true })).toBe('')
  })

  it('open: the panel in the place of the button, also for a person who hid the button', () => {
    openSupportDock({}, true)
    for (const pillHidden of [false, true]) {
      const text = visibleText(dock({ pillHidden }))
      expect(text).toContain(sv.support_link.dialog_title)
      expect(text).not.toContain(sv.support_link.ask_fab)
    }
  })
})
