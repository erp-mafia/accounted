import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const read = (rel: string) => fs.readFileSync(path.resolve(__dirname, rel), 'utf8')
const LIST = read('../JournalEntryList.tsx')
const TO_BOOK = read('../ToBookList.tsx')

/**
 * Phone-width pins (390px measurements). The repo does not render components
 * in tests, so the source shape is pinned.
 *
 * Verifikationer: a tap on a row opens its foldout under the row. On a phone
 * the table was wider than the screen (the foldout with it) and the foldout
 * often opened below the fold, so most taps looked like they did nothing.
 */
describe('Verifikationer rows on a phone', () => {
  it('scrolls the opened row to the top of a phone, and only when it opens', () => {
    expect(LIST).toContain("const PHONE_QUERY = '(max-width: 639px)'")
    const toggle = LIST.slice(LIST.indexOf('const toggleExpand = '), LIST.indexOf('function switchMode'))
    expect(toggle).toContain('if (opening) revealOpenedRowOnPhone(row)')
    const reveal = LIST.slice(LIST.indexOf('function revealOpenedRowOnPhone'), LIST.indexOf('// Column-header sorting'))
    expect(reveal).toContain('if (!window.matchMedia(PHONE_QUERY).matches) return')
    expect(reveal).toContain("block: 'start'")
    expect(reveal).toContain("'(prefers-reduced-motion: reduce)'")
  })

  it('opens from a tap and from Enter or Space, and lands under the sticky top bar', () => {
    expect(LIST).toContain('onClick={(e) => toggleExpand(entry.id, e.currentTarget)}')
    expect(LIST).toContain('toggleExpand(entry.id, e.currentTarget)\n')
    expect(LIST).toContain("'group cursor-pointer scroll-mt-14 transition-colors duration-150'")
  })

  it('keeps the missing-underlag mark on a phone as the amber glyph, with the chip words for screen readers', () => {
    const start = LIST.indexOf("t('missing_attachment_chip')")
    const block = LIST.slice(LIST.lastIndexOf('<Badge', start), LIST.indexOf('</>', start))
    expect(block).toContain('className="hidden sm:inline-flex"')
    expect(block).toContain('<span className="inline-flex sm:hidden"')
    expect(block).toContain('<StatusGlyph tone="warning" />')
    expect(block).toContain("<span className=\"sr-only\">{t('missing_attachment_chip')}</span>")
  })

  it('keeps Bokför and Kopiera in the foldout, where a phone reaches them', () => {
    const foldout = LIST.slice(LIST.indexOf('<RowFoldout>'), LIST.indexOf('</RowFoldout>'))
    expect(foldout).toContain('onClick={() => openCommitConfirm(entry)}')
    expect(foldout).toContain("{t('copy')}")
  })
})

/**
 * Att bokföra: the chip row was 492px wide at 390px and scrolled the whole
 * page sideways, with the labels wrapped onto two lines.
 */
describe('Att bokföra chips on a phone', () => {
  it('keep one line each and scroll in their own row', () => {
    const start = TO_BOOK.indexOf('<SegmentedControl')
    const wrapper = TO_BOOK.slice(TO_BOOK.lastIndexOf('<div', start), start)
    expect(wrapper).toContain('<div className="overflow-x-auto">')
    const control = TO_BOOK.slice(start, TO_BOOK.indexOf('/>', start))
    expect(control).toContain('className="whitespace-nowrap"')
  })
})
