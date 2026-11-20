import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  VIEW_MODE_STORAGE_PREFIX,
  isRememberedViewMode,
  readStoredViewMode,
  resolveInitialViewMode,
  writeStoredViewMode,
} from '@/components/transactions/view-mode-storage'

function stubLocalStorage(initial: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(initial))
  vi.stubGlobal('window', {
    localStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => {
        store.set(key, value)
      },
    },
  })
  return store
}

function stubThrowingLocalStorage() {
  const boom = () => {
    throw new Error('storage disabled')
  }
  vi.stubGlobal('window', { localStorage: { getItem: boom, setItem: boom } })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('isRememberedViewMode', () => {
  it('accepts the two views a person can come back to', () => {
    expect(isRememberedViewMode('inbox')).toBe(true)
    expect(isRememberedViewMode('history')).toBe(true)
  })

  it('rejects the review view, null and unknown values', () => {
    expect(isRememberedViewMode('review')).toBe(false)
    expect(isRememberedViewMode(null)).toBe(false)
    expect(isRememberedViewMode(undefined)).toBe(false)
    expect(isRememberedViewMode('')).toBe(false)
    expect(isRememberedViewMode('all')).toBe(false)
  })
})

describe('resolveInitialViewMode', () => {
  it('opens on the to-book view for someone who never chose', () => {
    expect(resolveInitialViewMode({ urlView: null, hasHighlight: false, stored: null })).toBe('inbox')
  })

  it('opens on the remembered view', () => {
    expect(resolveInitialViewMode({ urlView: null, hasHighlight: false, stored: 'history' })).toBe('history')
    expect(resolveInitialViewMode({ urlView: null, hasHighlight: false, stored: 'inbox' })).toBe('inbox')
  })

  it('lets a link that names a view win over the remembered one', () => {
    expect(resolveInitialViewMode({ urlView: 'inbox', hasHighlight: false, stored: 'history' })).toBe('inbox')
    expect(resolveInitialViewMode({ urlView: 'history', hasHighlight: false, stored: 'inbox' })).toBe('history')
    expect(resolveInitialViewMode({ urlView: 'history', hasHighlight: true, stored: null })).toBe('history')
  })

  it('opens a highlight link on the to-book view whatever was remembered', () => {
    expect(resolveInitialViewMode({ urlView: null, hasHighlight: true, stored: 'history' })).toBe('inbox')
  })

  it('ignores an unknown view in the link or in storage', () => {
    expect(resolveInitialViewMode({ urlView: 'review', hasHighlight: false, stored: 'history' })).toBe('history')
    expect(resolveInitialViewMode({ urlView: 'bogus', hasHighlight: false, stored: 'review' })).toBe('inbox')
  })
})

describe('stored view per company', () => {
  it('reads back what was written, per company', () => {
    const store = stubLocalStorage()
    writeStoredViewMode('company-a', 'history')
    expect(store.get(VIEW_MODE_STORAGE_PREFIX + 'company-a')).toBe('history')
    expect(readStoredViewMode('company-a')).toBe('history')
    expect(readStoredViewMode('company-b')).toBeNull()
  })

  it('never stores the review view', () => {
    const store = stubLocalStorage({ [VIEW_MODE_STORAGE_PREFIX + 'company-a']: 'history' })
    writeStoredViewMode('company-a', 'review')
    expect(store.get(VIEW_MODE_STORAGE_PREFIX + 'company-a')).toBe('history')
  })

  it('reads an unknown stored value as no choice', () => {
    stubLocalStorage({ [VIEW_MODE_STORAGE_PREFIX + 'company-a']: 'review' })
    expect(readStoredViewMode('company-a')).toBeNull()
  })

  it('works without localStorage: no choice on read, no throw on write', () => {
    stubThrowingLocalStorage()
    expect(readStoredViewMode('company-a')).toBeNull()
    expect(() => writeStoredViewMode('company-a', 'history')).not.toThrow()
  })
})
