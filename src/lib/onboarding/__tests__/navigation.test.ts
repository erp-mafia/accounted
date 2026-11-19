import { describe, expect, it } from 'vitest'
import {
  DRAFT_TTL_MS,
  backMove,
  previousStepIndex,
  readHistoryMarker,
  readNavigationDraft,
  recordNavigation,
  replaceNavigation,
  resumeDraft,
  type NavigationDraft,
} from '../navigation'

const KEY = 'accounted:onboarding:v1:company:user:team:first:'

function trail(...steps: string[]): NavigationDraft<{ step: string }> {
  let draft: NavigationDraft<{ step: string }> | null = null
  steps.forEach((step, i) => { draft = recordNavigation(draft, step, { step }, 100 + i) })
  return draft as unknown as NavigationDraft<{ step: string }>
}

describe('onboarding Back', () => {
  it('walks the browser back across entries the flow pushed itself', () => {
    const draft = trail('orgnr', 'name', 'fiscal-year')
    expect(backMove(draft.index, 2, previousStepIndex(draft))).toEqual({ kind: 'history', distance: 1 })
  })

  it('restores in place when what lies behind is another page', () => {
    // A draft restored after /login sent the user back here: nothing behind
    // this entry is the flow's own, and history.back() would land on /login,
    // which redirects straight back (the dead Tillbaka).
    const draft = trail('orgnr', 'name', 'fiscal-year')
    expect(backMove(draft.index, 0, previousStepIndex(draft))).toEqual({ kind: 'restore', index: 1 })
  })

  it('never lands on a copy of the current step', () => {
    // reconcileBooksDraft retires import screens as genomlysning copies.
    const draft: NavigationDraft<{ step: string }> = {
      version: 1,
      updatedAt: 100,
      index: 3,
      entries: ['insight', 'insight', 'insight', 'bank'].map((step) => ({ step, state: { step } })),
    }
    expect(previousStepIndex(draft)).toBe(2)
    expect(previousStepIndex({ ...draft, index: 2 })).toBe(-1)
    expect(backMove(3, 3, 2)).toEqual({ kind: 'history', distance: 1 })
    expect(backMove(2, 2, -1)).toEqual({ kind: 'fallback' })
  })

  it('reaches an entry beyond its own ones in place', () => {
    expect(backMove(4, 1, 2)).toEqual({ kind: 'restore', index: 2 })
  })

  it('lets a fallback step back replace the entry, so the next Back moves on instead of undoing it', () => {
    // The bank callback lands on the accounts list with no draft behind it;
    // Back to the bank list used to be pushed as a new entry, and the next
    // Back returned to the accounts list.
    const landed = trail('bank-accounts')
    const back = replaceNavigation(landed, 'bank', { step: 'bank' }, 200)
    expect(back.entries.map((entry) => entry.step)).toEqual(['bank'])
    expect(back.index).toBe(0)
    expect(previousStepIndex(back)).toBe(-1)
  })

  it('drops the forward branch when a step back replaces an entry', () => {
    const draft = { ...trail('insight', 'bank', 'skv'), index: 0 }
    const back = replaceNavigation(draft, 'source', { step: 'source' }, 200)
    expect(back.entries.map((entry) => entry.step)).toEqual(['source'])
    expect(back.index).toBe(0)
  })

  it('reads only its own markers and caps the depth at the index', () => {
    expect(readHistoryMarker({ onboarding: { key: KEY, index: 2, depth: 2 } }, KEY)).toEqual({ index: 2, depth: 2 })
    expect(readHistoryMarker({ onboarding: { key: KEY, index: 1, depth: 5 } }, KEY)).toEqual({ index: 1, depth: 1 })
    // Entries written before the depth existed vouch for nothing behind them.
    expect(readHistoryMarker({ onboarding: { key: KEY, index: 3 } }, KEY)).toEqual({ index: 3, depth: 0 })
    for (const state of [null, {}, { onboarding: { key: 'other', index: 1, depth: 1 } }, { onboarding: { key: KEY, index: -1 } }, { onboarding: { key: KEY, index: 1.5 } }]) {
      expect(readHistoryMarker(state, KEY)).toBeNull()
    }
  })

  it('resumes a page load on the question its entry names', () => {
    // After a reload, Back reaches an entry of the earlier page load: that
    // load starts over and must show that entry's question, not the latest.
    const saved = trail('orgnr', 'name', 'fiscal-year')
    expect(resumeDraft(saved, { index: 1, depth: 1 })).toEqual({ draft: { ...saved, index: 1 }, depth: 1 })
    expect(resumeDraft(saved, null)).toEqual({ draft: saved, depth: 0 })
    expect(resumeDraft(saved, { index: 7, depth: 7 })).toEqual({ draft: saved, depth: 0 })
    expect(resumeDraft(null, { index: 1, depth: 1 })).toEqual({ draft: null, depth: 0 })
  })
})

describe('onboarding navigation drafts', () => {
  it('restores the active question and replaces edits without adding browser steps', () => {
    let draft = recordNavigation(null, 'name', { name: 'Acme AB' }, 100)
    draft = recordNavigation(draft, 'name', { name: 'Acme Holdings AB' }, 200)
    draft = recordNavigation(draft, 'address', { name: 'Acme Holdings AB' }, 300)
    expect(draft.entries).toHaveLength(2)
    expect(readNavigationDraft(JSON.stringify(draft), 400)).toEqual(draft)
    expect(draft.entries[0].state.name).toBe('Acme Holdings AB')
  })

  it('keeps the submitted answer on the question being left', () => {
    const draft = recordNavigation(null, 'name', { name: '' }, 100)
    const moved = recordNavigation(draft, 'address', { name: 'Acme AB' }, 200, (previous, current) => ({ ...previous, name: current.name }))
    expect(moved.entries[0]).toEqual({ step: 'name', state: { name: 'Acme AB' } })
  })

  it('replaces the abandoned forward branch after going back and choosing differently', () => {
    let draft = recordNavigation(null, 'source', { provider: '' }, 100)
    draft = recordNavigation(draft, 'provider', { provider: 'bokio' }, 200)
    draft = recordNavigation({ ...draft, index: 0 }, 'bank', { provider: '' }, 300)
    expect(draft.entries.map((entry) => entry.step)).toEqual(['source', 'bank'])
    expect(draft.index).toBe(1)
  })

  it('rejects expired, invalid and future drafts', () => {
    const draft = recordNavigation(null, 'name', { name: 'Jane Doe' }, 100)
    expect(readNavigationDraft(JSON.stringify(draft), 101 + DRAFT_TTL_MS)).toBeNull()
    expect(readNavigationDraft(JSON.stringify(draft), 99)).toBeNull()
    for (const raw of [null, 'invalid', '{}', JSON.stringify({ ...draft, index: 10 }), JSON.stringify({ ...draft, entries: [null] })]) {
      expect(readNavigationDraft(raw, 200)).toBeNull()
    }
  })
})
