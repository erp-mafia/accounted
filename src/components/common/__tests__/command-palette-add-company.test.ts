import { describe, expect, it } from 'vitest'
import sv from '@/messages/sv.json'
import en from '@/messages/en.json'
import { actionEntries, localizeEntry, matches } from '../CommandPalette'

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

  it('links the href the layout chose for this user, else the picker door', () => {
    const entry = (href?: string) =>
      actionEntries({ label: 'x', keywords: '', href }).find((e) => e.id === 'add-company')
    expect(entry('/onboarding')?.href).toBe('/onboarding')
    expect(entry(undefined)?.href).toBe('/select-company?choose=1')
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

describe('the booking action with the booking screen switched on', () => {
  it('opens Att bokföra, still found by the words for booking a transaction', () => {
    const entry = actionEntries(null, { bookingScreen: true }).find((e) => e.id === 'to-book')
    expect(entry).toMatchObject({ href: '/att-bokfora' })
    const shown = localizeEntry(entry!, (key) => (sv.command_palette as Record<string, string>)[key])
    expect(shown.label).toBe('Att bokföra')
    expect(matches(shown, 'bokför')).toBe(true)
    expect(matches(shown, 'boka transaktion')).toBe(true)
    expect(actionEntries(null, { bookingScreen: true }).some((e) => e.id === 'book-transaction')).toBe(false)
  })

  it('keeps Bankrader without it', () => {
    expect(actionEntries(null).find((e) => e.id === 'book-transaction')).toMatchObject({ href: '/transactions' })
  })
})
