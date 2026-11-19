/**
 * The account setting for the floating button in the corner names the button
 * the person has: the built-in assistant's, or the support's in a company
 * without that assistant.
 */
import { createElement } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { looksSwedish } from '@/scripts/checks/swedish-ui-literal.mjs'
import { renderInLocale, visibleText } from '@/tests/i18n-render'
import sv from '@/messages/sv.json'
import en from '@/messages/en.json'

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }))
vi.mock('@/components/ui/use-toast', () => ({ useToast: () => ({ toast: vi.fn() }) }))

import { FabVisibilityRow } from '../FabVisibilityRow'

const row = (locale: 'sv' | 'en', support?: boolean) =>
  visibleText(renderInLocale(createElement(FabVisibilityRow, support === undefined ? {} : { support }), locale))

describe('FabVisibilityRow', () => {
  it('names the assistant button by default', () => {
    const text = row('sv')
    expect(text).toContain(sv.settings_assistant.fab_title)
    expect(text).not.toContain(sv.settings_assistant.fab_support_title)
  })

  it('names the support button where the corner holds that one', () => {
    const text = row('sv', true)
    expect(text).toContain(sv.settings_assistant.fab_support_title)
    expect(text).not.toContain(sv.settings_assistant.fab_title)
  })

  it('shows no Swedish in the English locale, for either button', () => {
    for (const support of [false, true]) {
      const text = row('en', support)
      expect(text).toContain(support ? en.settings_assistant.fab_support_title : en.settings_assistant.fab_title)
      expect(text.filter((line) => looksSwedish(line))).toEqual([])
    }
  })

  it('the toast of a hidden support button says where it is turned on again', () => {
    expect(sv.support_link.ask_fab_hidden_description).toContain('Ditt konto')
    expect(en.support_link.ask_fab_hidden_description).toContain('Your account')
  })
})
