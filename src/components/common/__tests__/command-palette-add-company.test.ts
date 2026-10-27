import { describe, expect, it } from 'vitest'
import sv from '@/messages/sv.json'
import en from '@/messages/en.json'
import { actionEntries, matches } from '../CommandPalette'

/**
 * PH 216, PH 202: new users could not find how to add another company. ⌘K
 * offers the user menu's "Lägg till företag" under the words they typed.
 */
describe('CommandPalette, adding a company', () => {
  const entryFor = (messages: typeof sv | typeof en) =>
    actionEntries({
      label: messages.company_switcher.add_company,
      keywords: messages.company_switcher.add_company_keywords,
    }).find((e) => e.id === 'add-company')

  it('offers the user menu door under its menu label', () => {
    expect(entryFor(sv)?.label).toBe('Lägg till företag')
    expect(entryFor(sv)?.href).toBe('/select-company?choose=1')
    expect(entryFor(en)?.label).toBe('Add company')
  })

  it('is found by the words the tickets used', () => {
    const entry = entryFor(sv)!
    for (const query of ['lägg till bolag', 'lägg till företag', 'nytt bolag', 'ytterligare ett bolag', 'fler företag']) {
      expect(matches(entry, query), query).toBe(true)
    }
    for (const query of ['add company', 'new company', 'another business']) {
      expect(matches(entryFor(en)!, query), query).toBe(true)
    }
  })

  it('is left out where there is no door to it (a sandbox)', () => {
    expect(actionEntries(null).some((e) => e.id === 'add-company')).toBe(false)
    // The other actions stay as they were.
    expect(actionEntries(null).map((e) => e.id)).toEqual(
      actionEntries({ label: 'x', keywords: '' }).filter((e) => e.id !== 'add-company').map((e) => e.id),
    )
  })
})
