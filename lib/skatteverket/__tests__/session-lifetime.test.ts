import { describe, it, expect } from 'vitest'
import {
  isSkvSessionRefreshable,
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
