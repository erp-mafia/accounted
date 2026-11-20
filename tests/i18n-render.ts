/**
 * A component rendered as a browser gets it under one catalogue, and the
 * text a user sees in that HTML. Shared by the tests that check the English
 * locale shows no Swedish (crm#1356), so every one of them judges the same
 * text: text nodes plus placeholder, title, aria-label and alt.
 */
import { createElement, type ComponentProps, type ReactElement } from 'react'
import { renderToString } from 'react-dom/server'
import { NextIntlClientProvider } from 'next-intl'
import sv from '@/messages/sv.json'
import en from '@/messages/en.json'

const IntlProvider = NextIntlClientProvider as (
  props: Omit<ComponentProps<typeof NextIntlClientProvider>, 'children'>,
) => ReturnType<typeof NextIntlClientProvider>

const CATALOGUES = { sv, en } as const

export function renderInLocale(element: ReactElement, locale: 'sv' | 'en'): string {
  return renderToString(
    createElement(
      IntlProvider,
      {
        locale,
        messages: CATALOGUES[locale],
        timeZone: 'Europe/Stockholm',
        // A missing key or a broken ICU argument fails the test instead of
        // rendering the key path.
        onError: (error) => {
          throw error
        },
      },
      element,
    ),
  )
}

const ENTITIES: Record<string, string> = { amp: '&', quot: '"', '#x27': "'", '#39': "'", lt: '<', gt: '>', nbsp: ' ' }

/** Every text node and every placeholder, title, aria-label and alt in the HTML. */
export function visibleText(html: string): string[] {
  const decode = (s: string) => s.replace(/&(#x27|#39|amp|quot|lt|gt|nbsp);/g, (_, e: string) => ENTITIES[e])
  const attributes = [...html.matchAll(/\s(?:placeholder|title|aria-label|alt)="([^"]*)"/g)].map((m) => m[1])
  const text = html.replace(/<[^>]*>/g, '\n').split('\n')
  return [...text, ...attributes].map((s) => decode(s).replace(/\s+/g, ' ').trim()).filter(Boolean)
}
