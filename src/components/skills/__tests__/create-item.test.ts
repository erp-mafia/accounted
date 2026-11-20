import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement, type ComponentProps } from 'react'
import { renderToString } from 'react-dom/server'
import { NextIntlClientProvider } from 'next-intl'
import sv from '@/messages/sv.json'

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(''),
  usePathname: () => '/skills/ny',
}))
const role = vi.hoisted(() => ({ value: 'owner' }))
vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => ({ company: { id: 'company-a', name: 'Bolaget' }, role: role.value }) }))

import { CreateItem, type EditTarget } from '../CreateItem'

// The provider's type lists children among its props; here they go in the usual third argument.
const IntlProvider = NextIntlClientProvider as (props: Omit<ComponentProps<typeof NextIntlClientProvider>, 'children'>) => ReturnType<typeof NextIntlClientProvider>

/** Skriv själv as the server renders it: what a screen reader, a test or an agent reads before any script runs. */
function render(edit?: Omit<EditTarget, 'onCancel' | 'onSaved'>) {
  const target = edit ? { ...edit, onCancel: () => {}, onSaved: async () => {} } : undefined
  const page = createElement(CreateItem, { backHref: '/skills', edit: target })
  return renderToString(createElement(IntlProvider, { locale: 'sv', messages: sv, timeZone: 'Europe/Stockholm' }, page))
}

beforeEach(() => { role.value = 'owner' })

describe('Skriv själv', () => {
  it('has one control per field, each named once by its visible label', () => {
    const html = render()
    expect(html.match(/<input\b/g)).toHaveLength(3)
    const labels = [...html.matchAll(/<label[^>]*for="([^"]+)"[^>]*>([^<]*)</g)].map((m) => ({ id: m[1], text: m[2] }))
    expect(labels.map((l) => l.text)).toEqual(['Namn', 'Kort beskrivning', 'Steg'])
    for (const { id } of labels) expect(html.match(new RegExp(`id="${id}"`, 'g'))).toHaveLength(1)
    // The label names the field; a second aria-label with the same words is what made every field read twice.
    expect(html).not.toContain('aria-label="Namn"')
    expect(html).not.toContain('aria-label="Kort beskrivning"')
  })

  it('shows a read-only member why, and does not let them type a flow they cannot save', () => {
    expect(render()).not.toMatch(/<fieldset[^>]*disabled/)
    role.value = 'viewer'
    const html = render()
    expect(html).toContain(sv.skills_registry.viewer_note)
    expect(html).toMatch(/<fieldset[^>]*disabled/)
  })

  it('opens an own flow filled in, without the kind switch, saving over it', () => {
    const html = render({ installationId: 'i', kind: 'workflow', name: 'Påminn', description: 'Efter 14 dagar', body: '# Påminn\n\nEfter 14 dagar\n\n## Steg\n\n1. Hämta\n2. Påminn\n' })
    expect(html).toContain('value="Påminn"')
    expect(html).toContain('value="Efter 14 dagar"')
    expect(html).toContain('value="Hämta"')
    expect(html).toContain(sv.skills_registry.edit_save)
    expect(html).toContain(sv.skills_registry.edit_back)
    expect(html).not.toContain('role="tablist"')
  })

  it('opens own knowledge with its text only: the heading and description are fields of their own', () => {
    const html = render({ installationId: 'i', kind: 'rules', name: 'Representation', description: 'Så bokför vi', body: '# Representation\n\nSå bokför vi\n\nMoms på högst 300 kr.\n' })
    expect(html).toMatch(/<textarea[^>]*>Moms på högst 300 kr\.<\/textarea>/)
  })
})
