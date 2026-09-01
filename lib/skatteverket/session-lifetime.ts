/**
 * Lifetime rules for Skatteverket's personal (`per` / BankID) OAuth2 session.
 *
 * Skatteverket issues the access token for 60 minutes and the refresh token
 * for 65 minutes, counted from the same issue moment, and allows at most 10
 * refreshes per BankID consent. A stored refresh token is therefore only
 * usable inside a five-minute window after the access token expires: after
 * that, nothing on our side can revive the session and only a fresh BankID
 * consent helps.
 *
 * Every surface that decides "can this connection still refresh itself"
 * (the extension's /status route, the skv_disconnected notice, the settings
 * panel) must agree on this rule. Before it lived here, /status and the
 * notice both answered "yes, it can refresh" for as long as a refresh token
 * existed, so a connection dead for days still showed as healthy and the
 * reconnect banner never fired until a submission failed live.
 *
 * Core code (lib/notices) consumes this, so it lives in lib/, not in the
 * extension.
 */

/** Access-token lifetime Skatteverket grants in the per flow. */
export const SKV_ACCESS_TOKEN_LIFETIME_MS = 60 * 60 * 1000

/** Refresh-token lifetime Skatteverket grants in the per flow. */
export const SKV_REFRESH_TOKEN_LIFETIME_MS = 65 * 60 * 1000

/**
 * How long past access-token expiry the refresh token still works: the
 * difference between the two lifetimes above.
 */
export const SKV_REFRESH_WINDOW_AFTER_EXPIRY_MS =
  SKV_REFRESH_TOKEN_LIFETIME_MS - SKV_ACCESS_TOKEN_LIFETIME_MS

/** Maximum refreshes Skatteverket allows per BankID consent. */
export const SKV_MAX_REFRESH_COUNT = 10

export interface SkvSessionLike {
  /** Access-token expiry as epoch ms, ISO string, or Date. */
  expiresAt: number | string | Date | null | undefined
  /** Whether a refresh token is stored at all (ciphertext presence is enough). */
  hasRefreshToken: boolean
  refreshCount: number | null | undefined
}

function toEpochMs(value: number | string | Date | null | undefined): number | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  const ms = value instanceof Date ? value.getTime() : new Date(value).getTime()
  return Number.isFinite(ms) ? ms : null
}

/**
 * True when the stored session can still be refreshed without a new BankID
 * consent: a refresh token exists, the refresh cap is not reached, and the
 * refresh token itself has not expired (65 minutes from issue, i.e. five
 * minutes past access-token expiry).
 *
 * A session with no parsable expiry is treated as unrefreshable: claiming
 * health for a row we cannot reason about is exactly the bug this replaces.
 */
export function isSkvSessionRefreshable(session: SkvSessionLike, now: number | Date = Date.now()): boolean {
  if (!session.hasRefreshToken) return false
  if ((session.refreshCount ?? 0) >= SKV_MAX_REFRESH_COUNT) return false
  const expiresAt = toEpochMs(session.expiresAt)
  if (expiresAt === null) return false
  const nowMs = now instanceof Date ? now.getTime() : now
  return nowMs < expiresAt + SKV_REFRESH_WINDOW_AFTER_EXPIRY_MS
}
