import { describe, it, expect } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Button } from '../button'

/**
 * crm#1046: a refused booking dropped the transactions page into the error
 * boundary for a user reading the app through Chrome's page translation. The
 * translator swaps a label's text node for its own <font> wrapper; the row's
 * Bokför button then stopped loading, and the old loading toggle re-parented
 * the label, so React removed a text node that was no longer in the button
 * (NotFoundError on removeChild).
 *
 * The contract that prevents it: toggling `loading` changes attributes only.
 * The spinner is always rendered (hidden when idle) in front of the label, so
 * no DOM node is ever inserted or removed next to the label.
 */
function markup(loading: boolean): string {
  return renderToStaticMarkup(createElement(Button, { loading }, 'Bokför'))
}

/** The markup with the classes and state attributes stripped: the bare node structure. */
function structure(html: string): string {
  return html
    .replace(/\s(class|disabled|aria-busy|data-ph-unmask)(="[^"]*")?/g, '')
    .replace(/\s+/g, ' ')
}

describe('Button loading toggle', () => {
  it('renders the same node structure whether or not it is loading', () => {
    expect(structure(markup(false))).toBe(structure(markup(true)))
  })

  it('keeps the spinner mounted but hidden while idle, and shows it while loading', () => {
    const idle = markup(false)
    const busy = markup(true)
    // The spinner's box is the icon module's <span data-icon>, which carries the class.
    expect(idle).toMatch(/<span data-icon=""[^>]*class="[^"]*\bhidden\b/)
    expect(busy).not.toMatch(/<span data-icon=""[^>]*class="[^"]*\bhidden\b/)
    expect(busy).toMatch(/<span data-icon=""[^>]*class="[^"]*\banimate-spin\b/)
    expect(busy).toContain('aria-busy="true"')
    expect(idle).toContain('Bokför')
    expect(busy).toContain('Bokför')
  })

  it('renders no spinner for asChild buttons (Slot takes exactly one child)', () => {
    const html = renderToStaticMarkup(
      createElement(Button, { asChild: true, loading: true }, createElement('a', { href: '/x' }, 'Länk')),
    )
    expect(html).not.toContain('<svg')
    expect(html).toContain('Länk')
  })
})
