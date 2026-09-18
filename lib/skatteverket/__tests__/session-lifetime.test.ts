import { describe, it, expect } from 'vitest'
import {
  isSkvSessionBeyondRecovery,
  isSkvSessionRefreshable,
  isTerminalReconsentState,
  SKV_REFRESH_WINDOW_AFTER_EXPIRY_MS,
  SKV_MAX_REFRESH_COUNT,
} from '../session-lifetime'

const T0 = Date.parse('2026-09-01T09:32:06.000Z')
const EXPIRES = T0 + 60 * 60 * 1000

describe('isSkvSessionRefreshable', () => {
  it('is refreshable while the access token is still valid', () => {
    expect(
      isSkvSessionRefreshable({ expiresAt: EXPIRES, hasRefreshToken: true, refreshCount: 0 }, T0 + 30 * 60 * 1000),
    ).toBe(true)
  })

  it('is refreshable inside the five-minute window after access-token expiry', () => {
    expect(
      isSkvSessionRefreshable(
        { expiresAt: EXPIRES, hasRefreshToken: true, refreshCount: 0 },
        EXPIRES + SKV_REFRESH_WINDOW_AFTER_EXPIRY_MS - 1,
      ),
    ).toBe(true)
  })

  it('is NOT refreshable once the 65-minute refresh token has died (the silent-drop case)', () => {
    expect(
      isSkvSessionRefreshable(
        { expiresAt: EXPIRES, hasRefreshToken: true, refreshCount: 0 },
        EXPIRES + SKV_REFRESH_WINDOW_AFTER_EXPIRY_MS,
      ),
    ).toBe(false)
    // A user coming back the next day: refresh token still stored, still dead.
    expect(
      isSkvSessionRefreshable(
        { expiresAt: new Date(EXPIRES).toISOString(), hasRefreshToken: true, refreshCount: 0 },
        EXPIRES + 24 * 60 * 60 * 1000,
      ),
    ).toBe(false)
  })

  it('is NOT refreshable without a refresh token', () => {
    expect(isSkvSessionRefreshable({ expiresAt: EXPIRES, hasRefreshToken: false, refreshCount: 0 }, T0)).toBe(false)
  })

  it('is NOT refreshable at the refresh cap', () => {
    expect(
      isSkvSessionRefreshable({ expiresAt: EXPIRES, hasRefreshToken: true, refreshCount: SKV_MAX_REFRESH_COUNT }, T0),
    ).toBe(false)
    expect(
      isSkvSessionRefreshable({ expiresAt: EXPIRES, hasRefreshToken: true, refreshCount: SKV_MAX_REFRESH_COUNT - 1 }, T0),
    ).toBe(true)
  })

  it('treats a missing or unparsable expiry as unrefreshable', () => {
    expect(isSkvSessionRefreshable({ expiresAt: null, hasRefreshToken: true, refreshCount: 0 }, T0)).toBe(false)
    expect(isSkvSessionRefreshable({ expiresAt: 'not a date', hasRefreshToken: true, refreshCount: 0 }, T0)).toBe(false)
  })

  it('accepts Date inputs for both expiry and now', () => {
    expect(
      isSkvSessionRefreshable({ expiresAt: new Date(EXPIRES), hasRefreshToken: true, refreshCount: 0 }, new Date(T0)),
    ).toBe(true)
  })
})

describe('isSkvSessionBeyondRecovery', () => {
  it('is false while the access token is still valid', () => {
    expect(isSkvSessionBeyondRecovery({ expiresAt: EXPIRES, refreshCount: 0 }, T0)).toBe(false)
  })

  it('is false inside the five-minute refresh window: the refresh call is still worth making', () => {
    expect(
      isSkvSessionBeyondRecovery(
        { expiresAt: EXPIRES, refreshCount: 0 },
        EXPIRES + SKV_REFRESH_WINDOW_AFTER_EXPIRY_MS - 1,
      ),
    ).toBe(false)
  })

  it('is true once the 65-minute refresh token has died: answer from the row, do not call SKV', () => {
    expect(
      isSkvSessionBeyondRecovery(
        { expiresAt: EXPIRES, refreshCount: 0 },
        EXPIRES + SKV_REFRESH_WINDOW_AFTER_EXPIRY_MS,
      ),
    ).toBe(true)
    // The nightly cron case: the token died hours before the run.
    expect(
      isSkvSessionBeyondRecovery(
        { expiresAt: new Date(EXPIRES).toISOString(), refreshCount: 1 },
        EXPIRES + 20 * 60 * 60 * 1000,
      ),
    ).toBe(true)
  })

  it('is false at the refresh cap while the access token still works on its own', () => {
    // A spent refresh budget cannot condemn a token the client would hand out
    // without refreshing: that session still syncs for its last minutes.
    expect(
      isSkvSessionBeyondRecovery({ expiresAt: EXPIRES, refreshCount: SKV_MAX_REFRESH_COUNT }, T0),
    ).toBe(false)
  })

  it('is true at the refresh cap once the access token needs a refresh', () => {
    expect(
      isSkvSessionBeyondRecovery(
        { expiresAt: EXPIRES, refreshCount: SKV_MAX_REFRESH_COUNT },
        EXPIRES - 60 * 1000,
      ),
    ).toBe(true)
    expect(
      isSkvSessionBeyondRecovery(
        { expiresAt: EXPIRES, refreshCount: SKV_MAX_REFRESH_COUNT },
        EXPIRES + 60 * 1000,
      ),
    ).toBe(true)
  })

  it('fails OPEN on a missing or unparsable expiry, unlike isSkvSessionRefreshable', () => {
    // Not provably dead, so the caller still makes the call and lets
    // Skatteverket decide. The health question fails the other way.
    expect(isSkvSessionBeyondRecovery({ expiresAt: null, refreshCount: 0 }, T0)).toBe(false)
    expect(isSkvSessionBeyondRecovery({ expiresAt: 'not a date', refreshCount: 0 }, T0)).toBe(false)
    expect(isSkvSessionRefreshable({ expiresAt: null, hasRefreshToken: true, refreshCount: 0 }, T0)).toBe(false)
  })
})

describe('isTerminalReconsentState', () => {
  it('is false for an active row whatever the last error code says', () => {
    expect(isTerminalReconsentState('active', null)).toBe(false)
    expect(isTerminalReconsentState('active', 'MISSING_SCOPE')).toBe(false)
    expect(isTerminalReconsentState(null, null)).toBe(false)
  })

  it('is true for the terminal codes: only a fresh BankID consent clears them', () => {
    expect(isTerminalReconsentState('needs_reconsent', 'REFRESH_EXHAUSTED')).toBe(true)
    expect(isTerminalReconsentState('needs_reconsent', 'MISSING_SCOPE')).toBe(true)
    expect(isTerminalReconsentState('needs_reconsent', 'TOKEN_CORRUPTED')).toBe(true)
  })

  it('is false for a legacy SESSION_EXPIRED latch: that is the hourly expiry, not a fault', () => {
    expect(isTerminalReconsentState('needs_reconsent', 'SESSION_EXPIRED')).toBe(false)
  })
})
