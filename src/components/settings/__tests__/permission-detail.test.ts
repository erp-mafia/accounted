import { describe, expect, it } from 'vitest'
import { createElement, type ComponentProps } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { NextIntlClientProvider } from 'next-intl'
import sv from '@/messages/sv.json'
import en from '@/messages/en.json'
import { ALL_SCOPES } from '@/lib/auth/scope-catalog'
import { PermissionDetail } from '../McpConnectionsPanel'
import { grantedScopeGroups, scopeVerb } from '../scope-labels'

const IntlProvider = NextIntlClientProvider as (
  props: Omit<ComponentProps<typeof NextIntlClientProvider>, 'children'>,
) => ReturnType<typeof NextIntlClientProvider>

function render(props: ComponentProps<typeof PermissionDetail>, locale: 'sv' | 'en' = 'sv'): string {
  return renderToStaticMarkup(
    createElement(
      IntlProvider,
      { locale, messages: locale === 'sv' ? sv : en },
      createElement(PermissionDetail, props),
    ),
  )
}

/** The text of every <li>, tags stripped. */
function items(html: string): string[] {
  return [...html.matchAll(/<li>(.*?)<\/li>/g)].map((m) => m[1].replace(/<[^>]+>/g, ''))
}

describe('grantedScopeGroups', () => {
  it('groups held scopes in the picker order and leaves out groups with nothing held', () => {
    const groups = grantedScopeGroups(['invoices:write', 'transactions:read', 'invoices:read'])
    expect(groups.map((g) => g.group.domain)).toEqual(['transactions', 'invoices'])
    expect(groups[1].scopes).toEqual(['invoices:read', 'invoices:write'])
  })

  it('drops a stored scope the catalogue no longer knows', () => {
    expect(grantedScopeGroups(['retired:scope'])).toEqual([])
  })
})

describe('scopeVerb', () => {
  it('is the part of a scope label before ": "', () => {
    expect(scopeVerb('Skriv: skapa kunder')).toBe('Skriv')
    expect(scopeVerb('Läs')).toBe('Läs')
  })
})

describe('PermissionDetail', () => {
  it('lists each held group with its verbs', () => {
    const html = render({ scopes: ['invoices:read', 'invoices:write', 'reports:read'], source: 'manual' })
    expect(items(html)).toEqual(['Fakturor: läs, skriv', 'Rapporter: läs'])
  })

  it('tells a key how to get other permissions: a new key, since a key cannot be edited', () => {
    const html = render({ scopes: ['reports:read'], source: 'manual' })
    expect(html).toContain(sv.settings_api_keys.permissions_change_key)
    expect(html).not.toContain(sv.settings_api_keys.permissions_change_signin)
  })

  it('tells a sign-in connection to reconnect instead', () => {
    const html = render({ scopes: ['reports:read'], source: 'signin' })
    expect(html).toContain(sv.settings_api_keys.permissions_change_signin)
  })

  it('shows only the hint when every scope is held: the summary already says it', () => {
    const html = render({ scopes: ALL_SCOPES, source: 'manual' })
    expect(items(html)).toEqual([])
    expect(html).toContain(sv.settings_api_keys.permissions_change_key)
  })

  it('reads in English too', () => {
    const html = render({ scopes: ['customers:read', 'customers:write'], source: 'manual' }, 'en')
    expect(items(html)).toEqual(['Customers: read, write'])
  })
})
