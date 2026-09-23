import { describe, expect, it } from 'vitest'
import { reconcileBooksDraft, resolveBooksResume } from '../resume'
import { initialState, type BooksState, type BooksStep } from '../reducer'
import { recordNavigation } from '@/lib/onboarding/navigation'

describe('reconcileBooksDraft', () => {
  const entry = { station: null, provider: null, landedFromProvider: false, selectAccounts: null, skvConnected: false, resumeImportId: null, hasBooks: true }
  const state = initialState(entry)

  it.each(['source', 'sie', 'provider', 'resume'] as BooksStep[])('discards stale %s drafts after the import completes while the tab is closed', (step) => {
    const draft = recordNavigation(null, step, { ...state, step, imported: false }, 100)
    expect(reconcileBooksDraft(draft, entry)).toBeNull()
  })

  it.each(['bank', 'skv', 'done'] as BooksStep[])('preserves %s progress and retires old import screens without shifting browser indexes', (step) => {
    const before = recordNavigation(null, 'sie', { ...state, step: 'sie' as const, imported: false }, 100)
    const current: BooksState = { ...state, step, bankSkipped: true, bankDraft: { ticked: { account: true }, picks: { account: '1930' }, mode: '90', customDate: '' } }
    const draft = recordNavigation<BooksState>(before, step, current, 200)
    const reconciled = reconcileBooksDraft(draft, entry)!
    expect(reconciled.index).toBe(draft.index)
    expect(reconciled.entries[draft.index].state).toBe(current)
    expect(reconciled.entries[0]).toMatchObject({ step: 'insight', state: { step: 'insight', imported: true, working: false } })
    expect(draft.entries[0].step).toBe('sie')
  })

  it('keeps drafts for a fresh company or a still-active import', () => {
    const draft = recordNavigation(null, 'source', { ...state, step: 'source' as const }, 100)
    expect(reconcileBooksDraft(draft, { ...entry, hasBooks: false })).toBe(draft)
    expect(reconcileBooksDraft(draft, { ...entry, resumeImportId: 'job-1' })).toBe(draft)
  })
})

describe('resolveBooksResume', () => {
  it('follows a running or paused import job', () => {
    for (const state of ['queued', 'preparing', 'running', 'reconciling', 'paused', 'finalizing']) {
      expect(resolveBooksResume({ id: 'job-1', job_state: state, job_kind: 'import' }, 0)).toEqual({ kind: 'active', importId: 'job-1' })
    }
  })

  it('opens on the books when the latest job is over and entries exist', () => {
    expect(resolveBooksResume({ id: 'job-1', job_state: 'completed', job_kind: 'import' }, 2786)).toEqual({ kind: 'books' })
    expect(resolveBooksResume({ id: 'job-1', job_state: 'failed', job_kind: 'import' }, 1)).toEqual({ kind: 'books' })
    expect(resolveBooksResume(null, 12)).toEqual({ kind: 'books' })
  })

  it('asks where the books were for a fresh company', () => {
    expect(resolveBooksResume(null, 0)).toEqual({ kind: 'none' })
    expect(resolveBooksResume({ id: 'job-1', job_state: 'failed', job_kind: 'import' }, 0)).toEqual({ kind: 'none' })
  })

  it('a duplicate-repair job is not an import to follow', () => {
    expect(resolveBooksResume({ id: 'job-2', job_state: 'running', job_kind: 'duplicate_repair' }, 5)).toEqual({ kind: 'books' })
  })
})
