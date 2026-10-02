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

  it('sends a resumed job, even a paused or failed one, to the history where it is continued or undone', () => {
    expect(booksSkip({ ...base, step: 'resume', working: false, path: 'migration' }, false)).toMatchObject({
      notice: 'running',
      href: IMPORT_HISTORY_HREF,
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
