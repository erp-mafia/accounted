/**
 * What the import screens say about voucher numbers, held against what the
 * importer does. The texts live in the message files, apart from the
 * importer, and drifted from it once: crm#1599 made a skipped source voucher
 * keep its number while the review step still said every voucher got a new
 * number and the underlag step still said the import closed the gap. Each
 * claim below sits next to the behavior that backs it, so changing either
 * side fails here.
 */
import { describe, expect, it } from 'vitest'
import { createTranslator } from 'next-intl'
import sv from '@/messages/sv.json'
import en from '@/messages/en.json'
import { parseSIEFile } from '../sie-parser'
import { prepareSIEVouchers } from '../sie-import'
import { selectSIEAppendEntries } from '../sie-append'

const tSv = createTranslator({ locale: 'sv', messages: sv, namespace: 'import' })
const tEn = createTranslator({ locale: 'en', messages: en, namespace: 'import' })

// A Fortnox year where A2 was cancelled in the source: every row struck, nothing to book.
const FILE = [
  '#FLAGGA 0', '#PROGRAM "Fortnox" "3.0"', '#SIETYP 4', '#RAR 0 20260101 20261231',
  '#VER A 1 20260304 "Faktura 1"', '{', '#TRANS 1930 {} 100.00', '#TRANS 3001 {} -100.00', '}',
  '#VER A 2 20260305 "Makulerad"', '{', '#BTRANS 1930 {} 200.00', '#BTRANS 3001 {} -200.00', '}',
  '#VER A 3 20260306 "Faktura 3"', '{', '#TRANS 1930 {} 300.00', '#TRANS 3001 {} -300.00', '}',
].join('\n')
const ACCOUNTS = new Map([['1930', '1930'], ['3001', '3001']])

function prepared() {
  const parsed = parseSIEFile(FILE)
  const result = prepareSIEVouchers(parsed, ACCOUNTS, 'B', 'import-1', { startOrdinal: 0, accountIds: new Map() })
  return { parsed, entries: result.preparedEntries }
}

describe('the texts that describe SIE voucher numbering (crm#1599)', () => {
  it('an import keeps a skipped voucher\'s number as an explained gap, and the review step says so', () => {
    const { entries } = prepared()
    expect(entries.map((e) => [e.sourceId, e.numberGap?.count ?? 0])).toEqual([['A1', 0], ['A3', 1]])
    expect(entries[1].numberGap?.explanation).toContain('A2 (makulerat i källsystemet)')

    expect(tSv('sie_review.what_vouchers')).toContain('behåller sitt nummer som en förklarad lucka')
    expect(tEn('sie_review.what_vouchers')).toContain('keeps its number as an explained gap')
  })

  it('an append holds no numbers, and the review step says so', () => {
    const { parsed, entries } = prepared()
    const verdicts = new Map(entries.map((e) => [e.sourceOrdinal, { sourceOrdinal: e.sourceOrdinal, verdict: 'new' as const, entryId: null, voucher: null }]))
    const appended = selectSIEAppendEntries(entries, verdicts, (ordinal) => parsed.vouchers[ordinal], ACCOUNTS, {})
    expect(appended.entries.map((e) => e.sourceId)).toEqual(['A1', 'A3'])
    expect(appended.entries.every((e) => e.numberGap === undefined)).toBe(true)

    expect(tSv('sie_review.what_vouchers')).toContain('behåller inte sitt nummer')
    expect(tEn('sie_review.what_vouchers')).toContain('does not keep its number')
  })

  it('no text promises new numbers for every voucher any more, and the underlag step dates the old behavior', () => {
    expect(tSv('sie_review.what_vouchers')).not.toMatch(/nya verifikationsnummer/i)
    expect(tEn('sie_review.what_vouchers')).not.toMatch(/new voucher number/i)
    expect(tSv('underlag_renumbered_hint')).not.toMatch(/numrerar om/i)
    expect(tEn('underlag_renumbered_hint')).not.toMatch(/renumbers/i)
    expect(tSv('underlag_renumbered_hint')).toContain('senast 2 november 2026')
    expect(tEn('underlag_renumbered_hint')).toContain('on or before 2 November 2026')
  })

  it('the selected series fills only a missing source series, and the review text says so', () => {
    const parsed = parseSIEFile([
      FILE,
      '#VER "" 4 20260307 "Utan serie"',
      '{',
      '#TRANS 1930 {} 400.00',
      '#TRANS 3001 {} -400.00',
      '}',
    ].join('\n'))
    const result = prepareSIEVouchers(parsed, ACCOUNTS, 'B', 'import-1', { startOrdinal: 0, accountIds: new Map() })

    expect(result.preparedEntries.map((entry) => entry.series)).toEqual(['A', 'A', 'B'])
    expect(tSv('sie_review.voucher_series_hint')).toContain('bara för verifikationer som saknar serie i filen')
    expect(tSv('sie_review.voucher_series_hint')).toContain('behåller den')
    expect(tEn('sie_review.voucher_series_hint')).toContain('only to vouchers without a series in the file')
    expect(tEn('sie_review.voucher_series_hint')).toContain('keep it')
  })
})
