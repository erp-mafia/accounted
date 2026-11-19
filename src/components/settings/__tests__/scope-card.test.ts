import { describe, expect, it } from 'vitest'
import { createElement, type ComponentProps } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { NextIntlClientProvider } from 'next-intl'
import sv from '@/messages/sv.json'
import { ScopeCard } from '../ApiKeysPanel'

const IntlProvider = NextIntlClientProvider as (
  props: Omit<ComponentProps<typeof NextIntlClientProvider>, 'children'>,
) => ReturnType<typeof NextIntlClientProvider>

function render(props: Partial<ComponentProps<typeof ScopeCard>>): string {
  const card = createElement(ScopeCard, {
    scope: 'invoices:read',
    checked: true,
    onCheckedChange: () => {},
    groupLabelId: 'grp-invoices',
    ...props,
  })
  return renderToStaticMarkup(createElement(IntlProvider, { locale: 'sv', messages: sv }, card))
}

/** The disabled attribute, not the disabled: class variants. */
const DISABLED_ATTR = /\sdisabled(="")?[\s>]/

/** The checkbox <button> tag of the card. */
function checkboxTag(html: string): string {
  const tag = html.match(/<button[^>]*role="checkbox"[^>]*>/)
  expect(tag).not.toBeNull()
  return tag![0]
}

describe('ScopeCard', () => {
  it('is one label: the verb and the description toggle the checkbox', () => {
    const html = render({})
    expect(html.startsWith('<label')).toBe(true)
    expect(html).toContain('cursor-pointer')
    expect(checkboxTag(html)).not.toMatch(DISABLED_ATTR)
  })

  it('names the checkbox by group and verb and describes it by the description', () => {
    const tag = checkboxTag(render({}))
    const labelledby = tag.match(/aria-labelledby="([^"]+)"/)![1].split(' ')
    expect(labelledby[0]).toBe('grp-invoices')
    const html = render({})
    expect(html).toContain(`id="${labelledby[1]}"`)
    const describedby = tag.match(/aria-describedby="([^"]+)"/)![1]
    expect(html).toMatch(new RegExp(`<p id="${describedby}"`))
  })

  it('a locked read card is disabled and says what holds it, on the verb line', () => {
    const html = render({ lockedNote: 'krävs för Skriv' })
    const tag = checkboxTag(html)
    expect(tag).toMatch(DISABLED_ATTR)
    expect(html).toContain('cursor-default')
    expect(html).not.toContain('cursor-pointer')
    const ids = tag.match(/aria-describedby="([^"]+)"/)![1].split(' ')
    expect(ids).toHaveLength(2)
    expect(html).toMatch(new RegExp(`id="${ids[1]}"[^>]*>krävs för Skriv<`))
  })
})
