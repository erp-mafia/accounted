import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { SUPPORT_DRAFT_KEY, clearSupportDraft, readSupportDraft, writeSupportDraft } from '../draft'

// A minimal sessionStorage double on a fake window; the helpers must also be
// inert when neither exists (server render) or when access throws.
function installStorage(opts: { throwOnAccess?: boolean; throwOnWrite?: boolean } = {}) {
  const map = new Map<string, string>()
  const store = {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => {
      if (opts.throwOnWrite) throw new Error('QuotaExceededError')
      map.set(k, v)
    },
    removeItem: (k: string) => {
      map.delete(k)
    },
  }
  const win: Record<string, unknown> = {}
  if (opts.throwOnAccess) {
    Object.defineProperty(win, 'sessionStorage', {
      get() {
        throw new Error('SecurityError')
      },
    })
  } else {
    win.sessionStorage = store
  }
  ;(globalThis as { window?: unknown }).window = win
  return map
}

const saved = (globalThis as { window?: unknown }).window
beforeEach(() => {
  delete (globalThis as { window?: unknown }).window
})
afterEach(() => {
  if (saved === undefined) delete (globalThis as { window?: unknown }).window
  else (globalThis as { window?: unknown }).window = saved
})

describe('support draft', () => {
  it('round-trips the typed text through sessionStorage', () => {
    const map = installStorage()
    writeSupportDraft('Hej, momsrapporten visar fel belopp')
    expect(map.get(SUPPORT_DRAFT_KEY)).toBe('Hej, momsrapporten visar fel belopp')
    expect(readSupportDraft()).toBe('Hej, momsrapporten visar fel belopp')
  })

  it('keeps the text verbatim, including surrounding whitespace', () => {
    installStorage()
    writeSupportDraft('  rad ett\nrad två  ')
    expect(readSupportDraft()).toBe('  rad ett\nrad två  ')
  })

  it('removes the entry for blank text and on clear', () => {
    const map = installStorage()
    writeSupportDraft('något')
    writeSupportDraft('   ')
    expect(map.has(SUPPORT_DRAFT_KEY)).toBe(false)
    writeSupportDraft('något')
    clearSupportDraft()
    expect(map.has(SUPPORT_DRAFT_KEY)).toBe(false)
    expect(readSupportDraft()).toBe('')
  })

  it('reads empty without a window (server) and never throws', () => {
    expect(readSupportDraft()).toBe('')
    expect(() => writeSupportDraft('x')).not.toThrow()
    expect(() => clearSupportDraft()).not.toThrow()
  })

  it('treats storage that throws on access or write as empty', () => {
    installStorage({ throwOnAccess: true })
    expect(readSupportDraft()).toBe('')
    expect(() => writeSupportDraft('x')).not.toThrow()

    installStorage({ throwOnWrite: true })
    expect(() => writeSupportDraft('x')).not.toThrow()
    expect(readSupportDraft()).toBe('')
  })
})
