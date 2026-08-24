import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  AGENT_SHEET_SESSION_KEY,
  clearAgentSheetSession,
  parseAgentSheetSession,
  readAgentSheetSession,
  writeAgentSheetSession,
} from '../session-restore'

// A minimal sessionStorage double on a fake window; the helpers must also be
// inert when neither exists (server render) or when access throws.
function installStorage(opts: { throwOnAccess?: boolean } = {}) {
  const map = new Map<string, string>()
  const store = {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => {
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

const session = {
  conversationId: 'conv-1',
  intentId: 'general.help',
  contextRef: 'report:vat:2026-07',
  collapsed: false,
}

describe('session-restore', () => {
  it('round-trips the open thread through sessionStorage', () => {
    const map = installStorage()
    writeAgentSheetSession(session)
    expect(map.has(AGENT_SHEET_SESSION_KEY)).toBe(true)
    expect(readAgentSheetSession()).toEqual(session)
    clearAgentSheetSession()
    expect(readAgentSheetSession()).toBeNull()
  })

  it('reads nothing without a window (server) and never throws', () => {
    expect(readAgentSheetSession()).toBeNull()
    expect(() => writeAgentSheetSession(session)).not.toThrow()
    expect(() => clearAgentSheetSession()).not.toThrow()
  })

  it('treats a storage that throws on access as empty', () => {
    installStorage({ throwOnAccess: true })
    expect(readAgentSheetSession()).toBeNull()
    expect(() => writeAgentSheetSession(session)).not.toThrow()
  })

  it('ignores malformed stored values', () => {
    const map = installStorage()
    map.set(AGENT_SHEET_SESSION_KEY, 'not json')
    expect(readAgentSheetSession()).toBeNull()
    map.set(AGENT_SHEET_SESSION_KEY, JSON.stringify({ intentId: 'general.help' }))
    expect(readAgentSheetSession()).toBeNull()
  })

  it('parses defensively: contextRef defaults to null, collapsed to false', () => {
    expect(parseAgentSheetSession({ conversationId: 'c', intentId: 'i' })).toEqual({
      conversationId: 'c',
      intentId: 'i',
      contextRef: null,
      collapsed: false,
    })
    expect(parseAgentSheetSession({ conversationId: 'c', intentId: 'i', collapsed: true, contextRef: 7 })).toEqual({
      conversationId: 'c',
      intentId: 'i',
      contextRef: null,
      collapsed: true,
    })
    expect(parseAgentSheetSession(null)).toBeNull()
    expect(parseAgentSheetSession({ conversationId: '', intentId: 'i' })).toBeNull()
  })
})
