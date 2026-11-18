import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

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
 * verifikat the box could not find. The repo does not render components in
 * tests, so pin the source shape and the texts.
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
      en: { amount: 'amount', date: 'date', account: 'account', number: /no\.|voucher number/, text: 'text' },
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

  it('keeps every placeholder short enough for the 240 px box', () => {
    // The box leaves 180 px for the text (32 px for the magnifier, 28 px for
    // the clear button). Measured in the app's Inter at 13 px: the 25
    // characters of "Sök ver.nr, belopp, datum" are 157 px, and the 32 of
    // "Sök ver.nr, belopp, datum, konto" were 199 px, cut off at the end.
    for (const locale of ['sv', 'en']) {
      const list = readMessages(locale).journal_list as Record<string, string>
      for (const key of ['search_placeholder', 'search_placeholder_all_years', 'search_placeholder_missing']) {
        expect(list[key].length, `${locale}.${key}: ${list[key]}`).toBeLessThanOrEqual(26)
      }
    }
  })
})
