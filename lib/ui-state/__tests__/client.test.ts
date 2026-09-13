/**
 * Tests for the client-side ui_state helpers: persistence POST shape,
 * silent failure, and last-used split-button mode resolution.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  isPwaWorklistBadgeEnabled,
  mergeUiStatePatch,
  persistUiState,
  rememberCreateMode,
  resolveInitialMode,
} from '../client'

const fetchMock = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()
  fetchMock.mockResolvedValue({ ok: true })
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('persistUiState', () => {
  it('POSTs the patch to /api/user/ui-state', () => {
    persistUiState({ nav_collapsed: true })
    expect(fetchMock).toHaveBeenCalledWith('/api/user/ui-state', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nav_collapsed: true }),
    })
  })

  it('swallows network failures', () => {
    fetchMock.mockRejectedValue(new Error('offline'))
    expect(() => persistUiState({ nav_collapsed: false })).not.toThrow()
  })
})

describe('isPwaWorklistBadgeEnabled', () => {
  it('defaults off when the key is missing', () => {
    expect(isPwaWorklistBadgeEnabled(undefined)).toBe(false)
    expect(isPwaWorklistBadgeEnabled({})).toBe(false)
  })

  it('is on only for an explicit true', () => {
    expect(isPwaWorklistBadgeEnabled({ pwa_worklist_badge: false })).toBe(false)
    expect(isPwaWorklistBadgeEnabled({ pwa_worklist_badge: true })).toBe(true)
  })
})

describe('mergeUiStatePatch', () => {
  it('keeps sibling create_mode surfaces when one surface is patched', () => {
    const merged = mergeUiStatePatch(
      { create_mode: { bookkeeping: 'mall', invoices: 'tomt' } },
      { create_mode: { bookkeeping: 'assistent' } },
    )
    expect(merged.create_mode).toEqual({
      bookkeeping: 'assistent',
      invoices: 'tomt',
    })
  })

  it('merges nested bags without wiping unrelated top-level keys', () => {
    const merged = mergeUiStatePatch(
      {
        nav_collapsed: true,
        nav_folds: { register: true, bokslut: false },
        pwa_worklist_badge: true,
      },
      { nav_folds: { bokslut: true } },
    )
    expect(merged).toEqual({
      nav_collapsed: true,
      nav_folds: { register: true, bokslut: true },
      pwa_worklist_badge: true,
    })
  })
})

describe('rememberCreateMode', () => {
  it('nests the mode under the surface key', () => {
    rememberCreateMode('bookkeeping', 'mall')
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body).toEqual({ create_mode: { bookkeeping: 'mall' } })
  })
})

describe('resolveInitialMode', () => {
  const keys = ['tomt', 'mall', 'assistent'] as const

  it('returns the persisted mode when valid', () => {
    const uiState = { create_mode: { bookkeeping: 'mall' } }
    expect(resolveInitialMode(uiState, 'bookkeeping', keys, 'tomt')).toBe('mall')
  })

  it('falls back when the persisted mode is stale', () => {
    const uiState = { create_mode: { bookkeeping: 'removed-mode' } }
    expect(resolveInitialMode(uiState, 'bookkeeping', keys, 'tomt')).toBe('tomt')
  })

  it('falls back when nothing is persisted', () => {
    expect(resolveInitialMode(undefined, 'bookkeeping', keys, 'tomt')).toBe('tomt')
    expect(resolveInitialMode({}, 'other', keys, 'assistent')).toBe('assistent')
  })
})
