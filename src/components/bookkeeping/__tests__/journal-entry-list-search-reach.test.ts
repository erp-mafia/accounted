import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { TOOLBAR_SEARCH_END_CLASS } from '@/components/ui/toolbar-search'
import { cn } from '@/lib/utils'

const SRC = fs.readFileSync(path.resolve(__dirname, '../JournalEntryList.tsx'), 'utf8')
const readMessages = (locale: string) =>
  JSON.parse(fs.readFileSync(path.resolve(__dirname, `../../../messages/${locale}.json`), 'utf8'))

/**
 * The verifikat list's search box says what the request it sends can find.
 *
 * The list is read three ways. Inside a fiscal year the route reads the
 * needle as text, a voucher label, an account, an amount and a date. With no
 * year on the request (all years, or the drafts view) it reads no amount: an
 * amount is looked up on the lines, a probe per verifikat, and that needs a
 * bounded set (isBoundedVerifikatScope). With "Visa saknade underlag" on, an
 * RPC reads the list and takes the text and the voucher label only. A
 * placeholder that promised amounts in all three sent people looking for
 * verifikat the box could not find. This component is not rendered in a
 * test, so pin the source shape and the texts.
 */
describe('JournalEntryList search box', () => {
  it('takes its placeholder, tooltip and accessible name from the state of the list', () => {
    expect(SRC).toContain('placeholder={searchPlaceholder}')
    expect(SRC).toContain('aria-label={searchHint}')
    expect(SRC).toContain('title={searchHint}')
    // Never the full promise unconditionally.
    expect(SRC).not.toContain("placeholder={t('search_placeholder')}")
    expect(SRC).not.toContain("aria-label={t('search_hint')}")
  })

  it('promises an amount only when its request carries a fiscal year', () => {
    expect(SRC).toContain("const searchReadsAmounts = listMode === 'committed' && isBoundedVerifikatScope({ periodId })")
    // The request it mirrors: a year goes along in the committed view only.
    const committed = SRC.slice(SRC.indexOf("params.set('exclude_draft', 'true')"), SRC.indexOf("if (search) params.set('search', search)"))
    expect(committed).toContain("if (periodId) params.set('period_id', periodId)")
    const drafts = SRC.slice(SRC.indexOf("if (listMode === 'drafts') {"), SRC.indexOf("params.set('exclude_draft', 'true')"))
    expect(drafts).not.toContain('period_id')
  })

  it('picks the texts of the missing-underlag path first, then by whether amounts are read', () => {
    for (const kind of ['placeholder', 'hint']) {
      const start = SRC.indexOf(`const search${kind === 'placeholder' ? 'Placeholder' : 'Hint'} = showMissingOnly`)
      expect(start, kind).toBeGreaterThan(-1)
      const decision = SRC.slice(start, start + 260).replace(/\s+/g, ' ')
      expect(decision, kind).toContain(
        `showMissingOnly ? t('search_${kind}_missing') : searchReadsAmounts ? t('search_${kind}') : t('search_${kind}_all_years')`,
      )
    }
  })

  it('names in each text only what that state finds, in both locales', () => {
    const words = {
      sv: { amount: 'belopp', date: 'datum', account: 'konto', number: /ver\.nr|verifikatnummer/, text: 'text' },
      en: { amount: 'amount', date: 'date', account: 'account', number: /voucher/, text: 'text' },
    }
    for (const locale of ['sv', 'en'] as const) {
      const list = readMessages(locale).journal_list as Record<string, string>
      const w = words[locale]
      const lower = (key: string) => {
        expect(typeof list[key], `${locale}.${key}`).toBe('string')
        return list[key].toLowerCase()
      }

      // Inside a fiscal year: everything. The tooltip names it all; the
      // placeholder has room for the number and the two readings a person
      // would not guess, and leaves the text and the account to the tooltip.
      for (const word of [w.amount, w.date, w.account, w.text]) {
        expect(lower('search_hint'), locale).toContain(word)
      }
      for (const word of [w.amount, w.date]) {
        expect(lower('search_placeholder'), locale).toContain(word)
      }
      expect(lower('search_placeholder'), locale).toMatch(w.number)

      // With no year: no amount, the rest stays.
      for (const key of ['search_placeholder_all_years', 'search_hint_all_years']) {
        expect(lower(key), `${locale}.${key}`).not.toContain(w.amount)
        expect(lower(key), `${locale}.${key}`).toContain(w.date)
        expect(lower(key), `${locale}.${key}`).toMatch(w.number)
      }
      expect(lower('search_hint_all_years'), locale).toContain(w.account)
      expect(lower('search_hint_all_years'), locale).toContain(w.text)

      // Missing underlag: the voucher label and the text, nothing else.
      for (const key of ['search_placeholder_missing', 'search_hint_missing']) {
        for (const word of [w.amount, w.date, w.account]) {
          expect(lower(key), `${locale}.${key}`).not.toContain(word)
        }
        expect(lower(key), `${locale}.${key}`).toMatch(w.number)
        expect(lower(key), `${locale}.${key}`).toContain(w.text)
      }
    }
  })

  it('keeps the box at its 240 px on every screen, on a row of its own where the first has no room', () => {
    // The shared toolbar class lets a search box share a row from 160 px
    // below 640 px, which leaves its text 100 px. Between about 440 and
    // 550 px that cut this placeholder (measured 2026-11-18: in a 160 px box
    // "Ver.nr, belopp, datum" needs 162 px at 16 px and has 100). This list's
    // box keeps 240 px and wraps instead, as it already did at 400 px.
    expect(SRC).toContain("<div className={cn('relative', TOOLBAR_SEARCH_END_CLASS, 'min-w-60')}>")
    const classes = cn('relative', TOOLBAR_SEARCH_END_CLASS, 'min-w-60').split(' ')
    expect(classes).toContain('min-w-60')
    expect(classes).not.toContain('min-w-40')
    // The shared rule otherwise: it fills its row on a phone, and is 240 px from 640 px up.
    expect(classes).toEqual(expect.arrayContaining(['flex-1', 'sm:w-60', 'sm:flex-none']))
  })

  it('keeps every placeholder short enough for the 240 px box, also at the 16 px of a touch screen', () => {
    // The box is 240 px or wider and leaves 180 px for the text (32 px for
    // the magnifier, 28 px for the clear button). A field renders at
    // 13 px, and at 16 px on a touch screen (globals.css, pointer: coarse).
    // Measured in the app's Inter as Chrome lays it out, at 16 px:
    // "Ver.nr, belopp, datum" is 162 px and "Voucher, amount, date" 170 px,
    // 21 characters each. The 25 of "Sök ver.nr, belopp, datum" were 193 px
    // there and lost their last letter, and the 32 of "Sök ver.nr, belopp,
    // datum, konto" were 199 px already at 13 px. The magnifier in the box
    // says "search", so the verb is what went. A count of characters is a
    // tripwire, not a measure: measure a longer text before raising it.
    for (const locale of ['sv', 'en']) {
      const list = readMessages(locale).journal_list as Record<string, string>
      for (const key of ['search_placeholder', 'search_placeholder_all_years', 'search_placeholder_missing']) {
        expect(list[key].length, `${locale}.${key}: ${list[key]}`).toBeLessThanOrEqual(21)
      }
    }
  })
})
