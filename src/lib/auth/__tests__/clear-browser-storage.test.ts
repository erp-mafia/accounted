import { describe, expect, it } from 'vitest'
import { clearBrowserStorage, PRESERVED_LOCAL_STORAGE_KEYS } from '../clear-browser-storage'

/** Minimal Web Storage with the index semantics removeItem re-indexing depends on. */
class MemoryStorage {
  private items = new Map<string, string>()
  get length() {
    return this.items.size
  }
  key(index: number): string | null {
    return [...this.items.keys()][index] ?? null
  }
  getItem(key: string): string | null {
    return this.items.get(key) ?? null
  }
  setItem(key: string, value: string) {
    this.items.set(key, value)
  }
  removeItem(key: string) {
    this.items.delete(key)
  }
  clear() {
    this.items.clear()
  }
  keys() {
    return [...this.items.keys()]
  }
}

function seededLocal(): MemoryStorage {
  const local = new MemoryStorage()
  // Display preferences (kept).
  local.setItem('theme', 'dark')
  local.setItem('accounted-palette', 'sand')
  local.setItem('Accounted:chat-sidebar-collapsed', 'true')
  local.setItem('accounted_claude_open_in', 'desktop')
  local.setItem('Accounted:system-notice-dismissed', '1790000000000')
  // Company- and user-bound state (removed).
  local.setItem('gnubok-active-company', '{"companyId":"c-1"}')
  local.setItem('journal-entries:fiscal-year:c-1', 'fy-2026')
  local.setItem('ef-declaration-overrides:c-1:2026', '{"R5":125000}')
  local.setItem('reports:recent:c-1', '["balance-sheet"]')
  local.setItem('bank-sync:last-visit:c-1', '2026-09-28T08:00:00Z')
  local.setItem('seenSurvey_abc', 'true')
  return local
}

describe('clearBrowserStorage (CASA 6.6.1)', () => {
  it('keeps only the display-preference allowlist in localStorage', () => {
    const local = seededLocal()
    const session = new MemoryStorage()

    const removed = clearBrowserStorage({ local, session })

    expect(local.keys().sort()).toEqual([...PRESERVED_LOCAL_STORAGE_KEYS].sort())
    expect(removed).toContain('ef-declaration-overrides:c-1:2026')
    expect(removed).toContain('gnubok-active-company')
    expect(removed).not.toContain('theme')
  })

  it('empties sessionStorage completely', () => {
    const session = new MemoryStorage()
    session.setItem('accounted-support-draft', 'Hej, min faktura...')
    session.setItem('accounted-agent-sheet', '{"conversationId":"x"}')

    clearBrowserStorage({ local: new MemoryStorage(), session })

    expect(session.length).toBe(0)
  })

  it('never throws when storage is blocked', () => {
    const throwing = {
      get length(): number {
        throw new Error('SecurityError')
      },
      key: () => null,
      removeItem: () => {
        throw new Error('SecurityError')
      },
      clear: () => {
        throw new Error('SecurityError')
      },
    }
    expect(() => clearBrowserStorage({ local: throwing, session: throwing })).not.toThrow()
  })

  it('is a no-op outside a browser', () => {
    expect(clearBrowserStorage({ local: null, session: null })).toEqual([])
  })
})
