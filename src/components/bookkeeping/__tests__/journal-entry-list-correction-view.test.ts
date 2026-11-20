import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { DEFAULT_VERIFIKAT_LIST_QUERY, readVerifikatListQuery } from '@/lib/bookkeeping/verifikat-list-query'

const SRC = fs.readFileSync(
  path.resolve(__dirname, '../JournalEntryList.tsx'),
  'utf8',
)
const readMessages = (locale: string) =>
  JSON.parse(fs.readFileSync(path.resolve(__dirname, `../../../messages/${locale}.json`), 'utf8'))

/**
 * Storno and Omförd rows in the verifikat list (PH 231).
 *
 * The old switch "Visa storno- och rättade poster" only folded correction
 * groups, so with it off a pure storno pair (original + its storno) still
 * showed. The dialog now offers three named states; 'hide' asks the route to
 * drop every storno and reversed original, 'collapse' stays the default so
 * the series stays gapless (#3149). The repo does not render components in
 * tests, so pin the source shape.
 */
describe('JournalEntryList storno and Omförd view', () => {
  it('defaults to collapsing correction groups only', () => {
    // The list opens on the view its address holds (crm#1998); an address
    // without one is the default view.
    expect(SRC).toContain("useState<'all' | 'collapse' | 'hide'>(initialQuery.correctionView)")
    expect(DEFAULT_VERIFIKAT_LIST_QUERY.correctionView).toBe('collapse')
    expect(readVerifikatListQuery(new URLSearchParams('')).correctionView).toBe('collapse')
  })

  it('maps each state to its route parameter', () => {
    expect(SRC).toContain("if (correctionView === 'hide') params.set('hide_reversed', 'true')")
    expect(SRC).toContain("else if (correctionView === 'collapse') params.set('collapse_corrections', 'true')")
  })

  it('counts hidden pairs as an active filter and clears them with the other filters', () => {
    const start = SRC.indexOf('const dialogFilterCount =')
    expect(SRC.slice(start, SRC.indexOf('const activeFilterCount', start))).toContain("correctionView === 'hide' ? 1 : 0")
    expect(SRC).toContain("setCorrectionView((v) => (v === 'hide' ? 'collapse' : v))")
  })

  it('never reads an all-hidden total as an empty ledger', () => {
    // With every makulerat pair hidden, a total of 0 never short-circuits the
    // all-years probe (lib/bookkeeping/ledger-probe.ts plans the rest).
    const start = SRC.indexOf('const basePlan = planLedgerProbe(')
    expect(start).toBeGreaterThan(-1)
    expect(SRC.slice(start, SRC.indexOf('await Promise.all', start))).toContain(
      "basePlan === 'from_total' && correctionView === 'hide' ? 'probe' : basePlan",
    )
  })

  it('offers all three states, labelled in both locales', () => {
    for (const value of ['collapse', 'hide', 'all']) {
      expect(SRC).toContain(`<SelectItem value="${value}">{t('corrections_${value}')}</SelectItem>`)
    }
    expect(SRC).not.toContain('show_correction_chain')
    for (const locale of ['sv', 'en']) {
      const list = readMessages(locale).journal_list
      for (const key of ['filter_section_corrections', 'corrections_collapse', 'corrections_hide', 'corrections_all', 'corrections_hide_hint']) {
        expect(typeof list[key], `${locale}.${key}`).toBe('string')
      }
      expect(list.show_correction_chain).toBeUndefined()
    }
    expect(readMessages('sv').journal_list.corrections_hide).toBe('Dölj alla')
  })
})
