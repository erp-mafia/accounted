/**
 * Favoriter: which stored hrefs the sidebar draws, and what a press on a
 * row's star stores. The stored list is the person's; the menu the active
 * company sees decides what is drawn, never what is kept.
 */
import { describe, expect, it } from 'vitest'
import { NAV_V3_AREAS, areaItems, gateAreas } from '@/components/dashboard/nav-v3'
import { passesNavGates, type NavGateContext } from '../nav-gates'
import { NAV_FAVORITES_CAP, resolveFavorites, storedFavorites, toggleFavorite } from '../favorites'

const row = (href: string) => ({ href, label: `row ${href}` })
const MENU = [row('/transactions'), row('/accounts'), row('/invoices'), row('/reports/vat-declaration')]

function ctx(overrides: Partial<NavGateContext> = {}): NavGateContext {
  return {
    entityType: 'aktiebolag',
    surface: { hidden: [], notForLegalForm: [] },
    dimensionsEnabled: true,
    salesOrdersEnabled: true,
    quotesEnabled: true,
    hasWebshop: true,
    hasMileage: true,
    hasExpenseClaims: true,
    hasPosSales: true,
    arkivEnabled: true,
    agentsEnabled: true,
    inkorgV2Enabled: true,
    autogiroEnabled: true,
    capabilities: [],
    hiddenNavHrefs: new Set(),
    ...overrides,
  }
}

/** The rows of the real menu as a company with these gates sees them. */
const menuRows = (gate: NavGateContext) =>
  gateAreas(NAV_V3_AREAS, (item) => passesNavGates(item, gate)).flatMap(areaItems)

describe('storedFavorites', () => {
  it('reads the stored list as it was saved', () => {
    expect(storedFavorites(['/accounts', '/invoices'])).toEqual(['/accounts', '/invoices'])
  })

  it('reads a missing or malformed value as no favourites', () => {
    expect(storedFavorites(undefined)).toEqual([])
    expect(storedFavorites(null)).toEqual([])
    expect(storedFavorites('/accounts')).toEqual([])
    expect(storedFavorites({ 0: '/accounts' })).toEqual([])
  })

  it('drops an entry that is not a route path, and a repeat', () => {
    expect(storedFavorites(['/accounts', 7, null, 'accounts', 'https://example.com', '/accounts', '/invoices'])).toEqual([
      '/accounts',
      '/invoices',
    ])
  })
})

describe('resolveFavorites', () => {
  it('draws the favourites in the order they were added, not in menu order', () => {
    expect(resolveFavorites(['/reports/vat-declaration', '/accounts', '/transactions'], MENU)).toEqual([
      row('/reports/vat-declaration'),
      row('/accounts'),
      row('/transactions'),
    ])
  })

  it('hands back the menu row itself, so the favourite carries its icon and label', () => {
    const [favourite] = resolveFavorites(['/accounts'], MENU)
    expect(favourite).toBe(MENU[1])
  })

  it('leaves out a row the menu does not show right now', () => {
    expect(resolveFavorites(['/dimensions', '/accounts'], MENU)).toEqual([row('/accounts')])
  })

  it('ignores an href no menu row has', () => {
    expect(resolveFavorites(['/a-page-that-was-removed', '/invoices', '//example.com'], MENU)).toEqual([row('/invoices')])
  })

  it('draws a repeated href once', () => {
    expect(resolveFavorites(['/accounts', '/invoices', '/accounts'], MENU)).toEqual([row('/accounts'), row('/invoices')])
  })

  it('draws nothing without favourites', () => {
    expect(resolveFavorites([], MENU)).toEqual([])
  })

  it('follows the gates of the real menu: a favourite hides with its row and returns with it', () => {
    const stored = ['/dimensions', '/accounts']
    const hrefs = (gate: NavGateContext) => resolveFavorites(stored, menuRows(gate)).map((item) => item.href)

    expect(hrefs(ctx({ dimensionsEnabled: false }))).toEqual(['/accounts'])
    expect(hrefs(ctx())).toEqual(['/dimensions', '/accounts'])
  })

  it('takes icon and label from the menu definition', () => {
    const accounts = NAV_V3_AREAS.flatMap(areaItems).find((item) => item.href === '/accounts')
    expect(accounts).toBeDefined()
    expect(resolveFavorites(['/accounts'], menuRows(ctx()))).toEqual([accounts])
  })
})

describe('toggleFavorite', () => {
  it('adds a row last', () => {
    expect(toggleFavorite(['/accounts'], '/invoices')).toEqual(['/accounts', '/invoices'])
  })

  it('removes just that row and keeps the order of the rest', () => {
    expect(toggleFavorite(['/accounts', '/invoices', '/transactions'], '/invoices')).toEqual(['/accounts', '/transactions'])
  })

  it('goes on and off again', () => {
    const on = toggleFavorite([], '/accounts')
    expect(on).toEqual(['/accounts'])
    expect(toggleFavorite(on ?? [], '/accounts')).toEqual([])
  })

  it('keeps a favourite the open company does not show when another row is added or removed', () => {
    const stored = ['/dimensions', '/accounts']
    const menu = menuRows(ctx({ dimensionsEnabled: false }))
    expect(resolveFavorites(stored, menu).map((item) => item.href)).toEqual(['/accounts'])

    const added = toggleFavorite(stored, '/invoices')
    expect(added).toEqual(['/dimensions', '/accounts', '/invoices'])
    expect(toggleFavorite(added ?? [], '/accounts')).toEqual(['/dimensions', '/invoices'])
  })

  it('refuses one more than the cap, and still removes at the cap', () => {
    const full = Array.from({ length: NAV_FAVORITES_CAP }, (_, index) => `/page-${index}`)
    expect(NAV_FAVORITES_CAP).toBe(12)
    expect(toggleFavorite(full, '/one-too-many')).toBeNull()
    expect(toggleFavorite(full, '/page-3')).toHaveLength(NAV_FAVORITES_CAP - 1)
    expect(toggleFavorite(full.slice(1), '/fits')).toHaveLength(NAV_FAVORITES_CAP)
  })

  it('counts a favourite the open company does not show toward the cap', () => {
    const full = ['/dimensions', ...Array.from({ length: NAV_FAVORITES_CAP - 1 }, (_, index) => `/page-${index}`)]
    expect(toggleFavorite(full, '/accounts')).toBeNull()
  })

  it('takes a cap of its own', () => {
    expect(toggleFavorite(['/accounts', '/invoices'], '/transactions', 2)).toBeNull()
    expect(toggleFavorite(['/accounts'], '/transactions', 2)).toEqual(['/accounts', '/transactions'])
  })

  it('stores a repeated href once', () => {
    expect(toggleFavorite(['/accounts', '/accounts', '/invoices'], '/transactions')).toEqual(['/accounts', '/invoices', '/transactions'])
    expect(toggleFavorite(['/accounts', '/accounts', '/invoices'], '/accounts')).toEqual(['/invoices'])
  })
})
