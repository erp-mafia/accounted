import { describe, expect, it } from 'vitest'
import { DRAFT_TTL_MS, readNavigationDraft, recordNavigation } from '../navigation'

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
