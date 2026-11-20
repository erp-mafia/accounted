import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const SRC = fs.readFileSync(
  path.resolve(__dirname, '../JournalEntryList.tsx'),
  'utf8',
)
const readMessages = (locale: string) =>
  JSON.parse(fs.readFileSync(path.resolve(__dirname, `../../../messages/${locale}.json`), 'utf8'))

/**
 * Regression pin for the compact-rows toggle (crm#1323).
 *
 * It shipped in #1071 and was dropped in the #1123 row-language rewrite, the
 * same rewrite that lost the copy icon (see journal-entry-list-copy-
 * affordance.test.ts), and customers asked for it again. The repo does not
 * render components in tests, so pin the source shape instead.
 */
describe('JournalEntryList compact rows', () => {
  it('renders a labelled toggle that reports its state', () => {
    const start = SRC.indexOf('onClick={toggleDensity}')
    expect(start).toBeGreaterThan(-1)
    const button = SRC.slice(start, SRC.indexOf('</Button>', start))
    expect(button).toContain('aria-pressed={compact}')
    expect(button).toContain("aria-label={t('density_compact')}")
  })

  it('says what it does without being pressed: the name is on the button, and on is a check', () => {
    const start = SRC.indexOf('onClick={toggleDensity}')
    const button = SRC.slice(start, SRC.indexOf('</Button>', start))
    // A bare icon had to be pressed to learn what it did (usage review 2026-11-13).
    expect(button).toContain("{t('density_compact')}</span>")
    expect(button).toContain('compact ? <CheckIcon')
    expect(button).not.toContain('size="icon-sm"')
  })

  it('persists the choice per company', () => {
    expect(SRC).toContain("DENSITY_STORAGE_KEY_PREFIX = 'Accounted:journal-density:'")
    expect(SRC).toContain("DENSITY_STORAGE_KEY_PREFIX + (company?.id ?? 'default')")
  })

  it('has the label in both locales', () => {
    expect(readMessages('sv').journal_list.density_compact).toBe('Kompakta rader')
    expect(readMessages('en').journal_list.density_compact).toBe('Compact rows')
  })
})
