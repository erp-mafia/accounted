import { describe, it, expect, beforeEach } from 'vitest'
import type { MessageTree, PageTextIndex } from '../page-text-index'
import { isPageTextIndex } from '../page-text-index'
import {
  examplePath,
  matchRoute,
  pageParts,
  plainText,
  renderPageTexts,
  resetPageTextIndexCache,
  searchAppTexts,
} from '../page-texts'

const MESSAGES: MessageTree = {
  invoices: {
    title: 'Fakturor',
    new_invoice: 'Ny faktura',
    booked: '{count, plural, one {# faktura bokfördes} other {# fakturor bokfördes}}',
    help: 'Skapas <b>automatiskt</b>,\n  till exempel varje månad',
    status: 'Status',
  },
  rot: { request_payout: 'Begär utbetalning', status: 'Status' },
  salary: { new_run: 'Ny lönekörning' },
}

const INDEX: PageTextIndex = {
  files: [
    'app/(dashboard)/invoices/page.tsx',
    'components/invoices/RotRutPayoutDialog.tsx',
    'app/(dashboard)/invoices/[id]/page.tsx',
    'app/(dashboard)/salary/page.tsx',
  ],
  keys: [
    ['invoices.title', 'invoices.new_invoice', 'invoices.booked', 'invoices.help', 'invoices.status', 'invoices.gone'],
    ['rot.request_payout', 'rot.status'],
    ['invoices.title'],
    ['salary.new_run'],
  ],
  // What each key is, one character per key: a heading, a button, three
  // texts the source does not place, a key the messages no longer have; a
  // button and a column; a heading; a button.
  roles: ['hb----', 'bc', 'h', 'b'],
  routes: {
    '/invoices': [0, 1],
    '/invoices/[id]': [2, 1],
    '/salary': [3],
    '/reports/[...slug]': [3],
  },
}

beforeEach(() => resetPageTextIndexCache())

describe('plainText', () => {
  it('shows the general plural form, drops markup tags and joins lines', () => {
    expect(plainText('{count, plural, one {# faktura bokfördes} other {# fakturor bokfördes}}')).toBe('# fakturor bokfördes')
    expect(plainText('Skapas <b>automatiskt</b>,\n  till exempel varje månad')).toBe(
      'Skapas automatiskt, till exempel varje månad',
    )
  })

  it('keeps a plain placeholder, which shows where a value goes', () => {
    expect(plainText('Utkast ({count})')).toBe('Utkast ({count})')
    expect(plainText('{kind, select, a {Kund} other {Leverantör}} saknas för {name}')).toBe('Leverantör saknas för {name}')
  })
})

describe('matchRoute', () => {
  it('finds a page by its path, with or without a trailing slash, query or hash', () => {
    expect(matchRoute(INDEX, '/invoices')).toBe('/invoices')
    expect(matchRoute(INDEX, '/invoices/?status=draft#top')).toBe('/invoices')
  })

  it('finds the pattern a record page belongs to, and prefers the more exact one', () => {
    expect(matchRoute(INDEX, '/invoices/2f0c')).toBe('/invoices/[id]')
    expect(matchRoute(INDEX, '/reports/vat/2026')).toBe('/reports/[...slug]')
  })

  it('answers null for a path no page has', () => {
    expect(matchRoute(INDEX, '/nowhere')).toBeNull()
    expect(matchRoute(INDEX, '/invoices/1/2')).toBeNull()
    expect(matchRoute(INDEX, '/reports')).toBeNull()
  })

  it('turns a pattern into a path the menu can be asked about', () => {
    expect(examplePath('/invoices/[id]/edit')).toBe('/invoices/id/edit')
    expect(examplePath('/reports/[...slug]')).toBe('/reports/slug')
    expect(examplePath('/x/[[...rest]]')).toBe('/x/rest')
  })
})

describe('pageParts and renderPageTexts', () => {
  it('lists the page first, then each component, each text once, and skips keys the messages no longer have', () => {
    const parts = pageParts(INDEX, '/invoices', MESSAGES)
    expect(parts).toEqual([
      {
        name: 'page',
        texts: [
          { text: 'Fakturor', role: 'h' },
          { text: 'Ny faktura', role: 'b' },
          { text: '# fakturor bokfördes' },
          { text: 'Skapas automatiskt, till exempel varje månad' },
          { text: 'Status' },
        ],
      },
      // "Status" is already listed with the page.
      { name: 'RotRutPayoutDialog', texts: [{ text: 'Begär utbetalning', role: 'b' }] },
    ])
  })

  it('renders one line per part, each text followed by what it is when the source shows it', () => {
    const text = renderPageTexts(pageParts(INDEX, '/invoices', MESSAGES))
    expect(text.split('\n')).toEqual([
      '[page] Fakturor (rubrik) | Ny faktura (knapp) | # fakturor bokfördes | Skapas automatiskt, till exempel varje månad | Status',
      '[RotRutPayoutDialog] Begär utbetalning (knapp)',
    ])
  })

  it('reads an index written before roles existed: every text without a role', () => {
    const { roles: _roles, ...older } = INDEX
    resetPageTextIndexCache()
    expect(renderPageTexts(pageParts(older, '/invoices', MESSAGES)).split('\n')[0]).toBe(
      '[page] Fakturor | Ny faktura | # fakturor bokfördes | Skapas automatiskt, till exempel varje månad | Status',
    )
  })

  it('finds the texts of one role by its word', () => {
    const parts = pageParts(INDEX, '/invoices', MESSAGES)
    expect(renderPageTexts(parts, { search: 'knapp' }).split('\n')).toEqual([
      '[page] Ny faktura (knapp)',
      '[RotRutPayoutDialog] Begär utbetalning (knapp)',
    ])
  })

  it('reads one part by name, and says which parts exist when the name is wrong', () => {
    const parts = pageParts(INDEX, '/invoices', MESSAGES)
expect(renderPageTexts(parts, { part: 'rotrutpayoutdialog' })).toBe('[RotRutPayoutDialog] Begär utbetalning (knapp)')
    expect(renderPageTexts(parts, { part: 'Nope' })).toContain('page, RotRutPayoutDialog')
  })

  it('filters by every word of a search', () => {
    const parts = pageParts(INDEX, '/invoices', MESSAGES)
expect(renderPageTexts(parts, { search: 'ny faktura' })).toBe('[page] Ny faktura (knapp)')
    expect(renderPageTexts(parts, { search: 'moms' })).toContain('Ingen text på sidan')
  })

  it('cuts a long page at a part boundary and names what was left out', () => {
    const parts = [
      { name: 'page', texts: [{ text: 'a'.repeat(60) }] },
      { name: 'BigDialog', texts: [{ text: 'b'.repeat(80) }, { text: 'c'.repeat(80) }] },
      { name: 'Small', texts: [{ text: 'kort' }] },
    ]
    const text = renderPageTexts(parts, { maxChars: 100 })
    const lines = text.split('\n')
    expect(lines[0]).toBe(`[page] ${'a'.repeat(60)}`)
    expect(lines[1]).toBe('[Small] kort')
    expect(lines[2]).toContain('BigDialog (2 texter)')
  })

  it('keeps whole texts when one part alone is longer than the budget', () => {
const parts = [{ name: 'page', texts: [{ text: 'x'.repeat(40) }, { text: 'y'.repeat(40) }, { text: 'z'.repeat(40) }] }]
    const text = renderPageTexts(parts, { maxChars: 100 })
    expect(text).toContain('x'.repeat(40))
    expect(text).not.toContain('z'.repeat(40))
    expect(text).toContain('texter till i den här delen')
  })
})

describe('searchAppTexts', () => {
  it('finds a word across the pages it may look at, one hit per text, short texts first', () => {
    const hits = searchAppTexts(INDEX, MESSAGES, 'utbetalning', () => true)
    expect(hits).toEqual([
      {
        text: 'Begär utbetalning',
        role: 'b',
        places: [
          { route: '/invoices', part: 'RotRutPayoutDialog' },
          { route: '/invoices/[id]', part: 'RotRutPayoutDialog' },
        ],
      },
    ])
    expect(searchAppTexts(INDEX, MESSAGES, 'faktur', () => true).map((h) => h.text)).toEqual([
      'Fakturor',
      'Ny faktura',
      '# fakturor bokfördes',
    ])
  })

  it('never answers from a page the company does not have', () => {
    const hits = searchAppTexts(INDEX, MESSAGES, 'lönekörning', (pattern) => pattern !== '/salary' && pattern !== '/reports/[...slug]')
    expect(hits).toEqual([])
  })

  it('answers nothing for a query of one letter', () => {
    expect(searchAppTexts(INDEX, MESSAGES, 'a', () => true)).toEqual([])
  })
})

describe('isPageTextIndex', () => {
  it('accepts the shape the generator writes and nothing else', () => {
    expect(isPageTextIndex(INDEX)).toBe(true)
expect(isPageTextIndex({ files: ['a'], keys: [], routes: {} })).toBe(false)
    expect(isPageTextIndex({ ...INDEX, roles: ['h'] })).toBe(false)
    expect(isPageTextIndex(null)).toBe(false)
    expect(isPageTextIndex('[]')).toBe(false)
  })
})
