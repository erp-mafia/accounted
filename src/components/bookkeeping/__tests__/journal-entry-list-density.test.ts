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

  it('keeps the choice on the person, so a sign-out does not drop it', () => {
    // A key in localStorage named after the company was emptied by every
    // sign-out (lib/auth/clear-browser-storage.ts) and held for one company
    // and one browser only. The choice is the person's: ui_state.
    expect(SRC).toContain("uiState?.journal_density === 'compact'")
    expect(SRC).toContain("saveDensity(next ? 'compact' : 'comfortable'")
    expect(SRC).not.toContain('journal-density')
  })

  it('puts a press in the shared ui_state cache only once the first read has landed', () => {
    // A press before the first read lands would put the density alone in
    // the cache and drop the read: the page's create button would lose its
    // saved mode, and the bank list its hidden columns, until a refresh.
    // Keyed on the load too, so a read that left before the save cannot
    // keep the older choice in the cache.
    const start = SRC.indexOf('if (!uiStateLoaded || densityPressed === null) return')
    expect(start).toBeGreaterThan(-1)
    const effect = SRC.slice(start, SRC.indexOf('}, [', start) + 60)
    expect(effect).toContain('mutateUiState(')
    expect(effect).toContain('[uiStateLoaded, densityPressed, mutateUiState]')
  })

  it('stores the presses one at a time, in the order they were made', () => {
    // Two saves in flight could land in either order and leave the older
    // choice stored for the next session.
    expect(SRC).toContain('createOrderedSave<')
    expect(SRC).toContain('saveUiState({ journal_density })')
    expect(SRC).not.toContain('persistUiState(')
  })

  it('has the label in both locales', () => {
    expect(readMessages('sv').journal_list.density_compact).toBe('Kompakta rader')
    expect(readMessages('en').journal_list.density_compact).toBe('Compact rows')
  })
})
