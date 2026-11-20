import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

/*
 * crm#1380: a surface that already labels the value "Räkenskapsår" showed the
 * stored name under it, so the new-verifikat line read "Räkenskapsår:
 * Räkenskapsår 2026" and every settings row repeated the section heading.
 * These surfaces render the name through fiscalYearShortName (the year part of
 * a generated name, a hand-written name whole); a bare `.name` / `{periodName}`
 * here is the doubling coming back.
 */
describe('labelled fiscal-year values show the short name', () => {
  const root = path.resolve(__dirname, '../../../')
  const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8')

  it('the "Räkenskapsår:" line of a new verifikat', () => {
    const src = read('components/bookkeeping/JournalEntryForm.tsx')
    expect(src).toContain('{fiscalYearShortName(selectedPeriodObj.name)}')
    expect(src).not.toContain('<span className="text-foreground">{selectedPeriodObj.name}</span>')
  })

  it('the Räkenskapsår cell of the review step', () => {
    const src = read('components/bookkeeping/JournalEntryReviewContent.tsx')
    expect(src).toContain('{fiscalYearShortName(periodName)}')
    expect(src).not.toMatch(/>\{periodName\}</)
  })

  it('the rows under the Räkenskapsår settings heading', () => {
    const src = read('components/settings/FiscalYearsManager.tsx')
    expect(src).toContain('{fiscalYearShortName(p.name)}')
    expect(src).not.toContain('<span className="text-sm font-medium">{p.name}</span>')
  })

  it('the FyPicker chip, which prefixes its own Räkenskapsår / Fiscal year label', () => {
    // English read "Fiscal year Räkenskapsår 2026"; Swedish "Räkenskapsår FY 2026".
    const src = read('components/common/FyPicker.tsx')
    const chip = /const chipLabel = \(p: FiscalPeriod\) => \{([\s\S]*?)\n {2}\}/.exec(src)
    expect(chip).not.toBeNull()
    expect(chip![1]).toContain('fiscalYearShortName(p.name)')
    expect(chip![1]).toContain("`${t('label')} ${name}`")
    expect(chip![1]).not.toMatch(/\$\{p\.name\}/)
  })
})
