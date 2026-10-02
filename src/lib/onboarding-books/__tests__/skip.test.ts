import { describe, expect, it } from 'vitest'
import { booksSkip, IMPORT_HISTORY_HREF } from '../skip'
import type { BooksState } from '../reducer'

const base: Pick<BooksState, 'step' | 'working' | 'imported' | 'path'> = {
  step: 'source',
  working: false,
  imported: false,
  path: null,
}

describe('booksSkip', () => {
  it('lets the user out while an import runs, landing on the SIE history with a full page load', () => {
    for (const step of ['sie', 'provider'] as const) {
      expect(booksSkip({ ...base, step, working: true, path: 'migration' }, false)).toEqual({
        notice: 'running',
        href: IMPORT_HISTORY_HREF,
        hardNavigation: true,
      })
    }
  })

  it('sends a resumed job, even a paused or failed one, to the history without promising it finishes', () => {
    // Paused or failed: the step stopped working, and the job waits for the user.
    expect(booksSkip({ ...base, step: 'resume', working: false, path: 'migration' }, false)).toEqual({
      notice: 'resume',
      href: IMPORT_HISTORY_HREF,
      hardNavigation: false,
    })
    expect(booksSkip({ ...base, step: 'resume', working: true, path: 'migration' }, false)).toEqual({
      notice: 'resume',
      href: IMPORT_HISTORY_HREF,
      hardNavigation: true,
    })
  })

  it('does not speak of an import while the bank or Skatteverket step works', () => {
    expect(booksSkip({ ...base, step: 'bank', working: true }, false)).toEqual({ notice: 'empty', href: '/', hardNavigation: false })
    expect(booksSkip({ ...base, step: 'skv', working: true, imported: true, path: 'migration' }, false)).toEqual({
      notice: 'later',
      href: '/',
      hardNavigation: false,
    })
  })

  it('warns that the app is empty when no books came in', () => {
    expect(booksSkip(base, false)).toEqual({ notice: 'empty', href: '/', hardNavigation: false })
    // A failed import left nothing behind either.
    expect(booksSkip({ ...base, step: 'sie', path: 'migration' }, false).notice).toBe('empty')
  })

  it('does not call the app empty once the books are in, already there, or the business is new', () => {
    expect(booksSkip({ ...base, step: 'bank', imported: true, path: 'migration' }, false).notice).toBe('later')
    expect(booksSkip({ ...base, step: 'bank' }, true).notice).toBe('later')
    expect(booksSkip({ ...base, step: 'skv', path: 'fresh' }, false)).toEqual({ notice: 'later', href: '/', hardNavigation: false })
  })
})
