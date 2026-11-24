import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const read = (rel: string) => fs.readFileSync(path.resolve(__dirname, rel), 'utf8')
const LIST = read('../JournalEntryList.tsx')
const TO_BOOK = read('../ToBookList.tsx')
const PAIRS = read('../../reconciliation/ReconciliationPairs.tsx')
const BOOKING_SCREEN = read('../BookingScreen.tsx')
const BOOKING_DIALOG = read('../../transactions/TransactionBookingDialog.tsx')
const BOOK_DIRECTLY = read('../../extensions/general/BookDirectlyDialog.tsx')

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

/**
 * Account reconciliation: the pairs table had seven columns (about 600px of
 * fixed widths) and scrolled sideways inside its box on a phone, so the
 * amount and the row's Koppla or Bokför sat past the screen's edge.
 */
describe('Reconciliation pairs on a phone', () => {
  const head = PAIRS.slice(PAIRS.indexOf('export function PairsHead'), PAIRS.indexOf('function Chip'))
  const row = PAIRS.slice(PAIRS.indexOf('const ledgerMoney ='), PAIRS.indexOf('{primary}'))

  it('hides both dates and the ledger columns below sm, and keeps the text, the amount and the action', () => {
    expect(PAIRS).toContain("const DESKTOP_ONLY = 'hidden sm:table-cell'")
    expect(head.match(/DESKTOP_ONLY/g)).toHaveLength(4)
    expect(row.match(/DESKTOP_ONLY/g)).toHaveLength(4)
    // The fixed widths start at sm, so the kept columns shrink to fit a phone.
    expect(head).toContain("'w-full max-sm:pl-0 sm:w-[30%]'")
    expect(head).toContain("'text-right sm:w-[120px]'")
    expect(head).toContain("'!pr-0 sm:w-[150px]'")
  })

  it('stacks the ledger side into the first cell and a ledger row amount into the second', () => {
    expect(row).toContain("{ledgerText && <span className={cn('block overflow-hidden sm:hidden', external && 'mt-0.5')}>{ledgerText}</span>}")
    expect(row).toContain('{external ? money(item.amount) : <span className="sm:hidden">{ledgerMoney}</span>}')
  })
})

/**
 * Booking with a receipt: below lg the viewer stacks above the form, and a
 * multi-page PDF scrolls inside it. At 45-60vh it took most vertical swipes
 * on a phone, so the form under it was hard to reach. Desktop keeps lg:.
 */
describe('Stacked receipt viewers on a phone', () => {
  it('are 35vh below lg and keep their desktop height', () => {
    expect(BOOKING_SCREEN).toContain(
      "const VIEWER_CLASS = 'h-[35vh] rounded-lg bg-control shadow-raised lg:h-auto lg:min-h-0 lg:flex-1'",
    )
    expect(BOOKING_SCREEN.match(/className=\{VIEWER_CLASS\}/g)).toHaveLength(2)
    expect(BOOKING_DIALOG).toContain(
      'className="h-[35vh] rounded-lg bg-control shadow-raised lg:h-auto lg:min-h-0 lg:flex-1"',
    )
    expect(BOOK_DIRECTLY).toContain('<div className="h-[35vh] lg:sticky lg:top-0 lg:h-[72vh] lg:self-start">')
    for (const src of [BOOKING_SCREEN, BOOKING_DIALOG, BOOK_DIRECTLY]) {
      expect(src).not.toMatch(/className="h-\[(45|60)vh\]/)
    }
  })
})

/**
 * Bokför direkt: a line (account, Debet, Kredit, remove) needed about 404px
 * in a dialog about 320px wide on a phone, so it scrolled sideways.
 */
describe('Bokför direkt lines on a phone', () => {
  const lines = BOOK_DIRECTLY.slice(BOOK_DIRECTLY.indexOf('<th className={cn(VTH_CLASS, \'pr-3\')}>Konto</th>'), BOOK_DIRECTLY.indexOf('<tfoot>'))

  it('narrow the amount fields and the account field below sm, and keep the account number', () => {
    expect(lines.match(/'w-\[88px\] pr-2 text-right sm:w-\[112px\]'/g)).toHaveLength(2)
    expect(lines).toContain('<div className="w-[80px] shrink-0 sm:w-[120px]">')
  })

  it('hide the account name beside the number below sm', () => {
    expect(lines).toContain('<span className="hidden min-w-0 flex-1 truncate text-muted-foreground sm:block">')
  })
})
