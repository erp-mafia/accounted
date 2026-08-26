/**
 * Notices: the unified degraded-state model (system & integration health).
 *
 * One source of truth for "something the user relies on is broken or about
 * to break", shared by the Hem notice line and (via /api/notices) any client
 * surface. The sibling of lib/worklist, which owns actionable bookkeeping
 * work items; notices own connection/health state. Every surface that shows
 * degraded integration state MUST read it from lib/notices instead of
 * hand-rolling its own detection, so the same fact is never double-modeled
 * with diverging thresholds.
 *
 * Each category documents its pending ("notice active") and done conditions.
 */

export const NOTICE_CATEGORIES = [
  /**
   * A bank connection has already failed.
   * Pending:  bank_connections.status IN ('expired', 'error'): same predicate
   *           as BankSyncStatusChip's "attention" state.
   * Done:     the connection is renewed (status back to 'active') or removed.
   */
  'bank_connection_broken',
  /**
   * The Skatteverket connection can no longer authenticate.
   * Pending:  a skatteverket_tokens row exists for (user, company) with
   *           status = 'needs_reconsent', or its access token is expired with
   *           no usable refresh token (refresh_token NULL or refresh_count
   *           >= 10): mirrors the skatteverket extension's /status route.
   * Done:     the user re-consents with BankID (storeTokens resets the row)
   *           or disconnects entirely (no row = not connected = no notice).
   */
  'skv_disconnected',
  /**
   * A connected cloud backup is failing (dead token or errored auto-sync).
   * Pending:  a cloud-backup provider connection exists in extension_data
   *           with status = 'needs_reauth', or its schedule's
   *           last_auto_sync_status = 'error'.
   * Done:     reconnect/re-auth, or the next auto-sync succeeds.
   */
  'backup_failing',
  /**
   * A PSD2 bank consent expires within 14 days.
   * Pending:  bank_connections.status = 'active' AND consent_expires within
   *           (0, 14] days. A connection that has ALREADY failed is counted
   *           by bank_connection_broken instead (status filter makes the two
   *           categories disjoint: broken supersedes expiring by construction).
   * Done:     the consent is renewed (consent_expires moves out) or the
   *           connection expires (moves to bank_connection_broken).
   */
  'bank_connection_expiring',
  /**
   * The skattekonto does not agree with the ledger after the latest sync.
   * Pending:  the skatteverket extension's persisted reconciliation summary
   *           (extension_data key skattekonto_reconciliation_latest, written
   *           on every sync) has |unexplained_difference| above the drift
   *           tolerance (skattekonto_drift_tolerance, default 1 SEK).
   * Done:     the next sync computes an unexplained difference within
   *           tolerance (rows linked, booked or ignored), or the summary is
   *           gone (extension disconnected).
   */
  'skv_unexplained',
  /**
   * The signed-in account looks bookkeeping-empty while a same-orgnr company
   * with real bookkeeping exists in another account (#1231).
   * Pending:  lib/company/other-account-hint shouldShowOtherAccountHint().
   * Done:     the account gets bookkeeping of its own, or the user switches.
   */
  'other_account_hint',
] as const

export type NoticeCategory = (typeof NOTICE_CATEGORIES)[number]

export type NoticeSeverity = 'error' | 'warning'

/**
 * Fixed cross-category priority: surfaces that show a single notice show the
 * first active one in this order. Tune here, never per call site.
 */
export const NOTICE_PRIORITY: readonly NoticeCategory[] = [
  'bank_connection_broken',
  'skv_disconnected',
  'backup_failing',
  'bank_connection_expiring',
  'skv_unexplained',
  'other_account_hint',
]

export interface Notice {
  /**
   * Stable identity of THIS occurrence: the category plus a state
   * discriminator (connection id + status, expiry date). A dismissal is
   * stored against the id, so dismissals silence a state, never a category.
   *
   * Two invariants keep dismissals honest, and every id must satisfy both:
   *
   * 1. Stable per incident: the discriminator must not embed anything the
   *    system re-stamps while the SAME incident persists (a cron-updated
   *    last-attempt timestamp), or a dismissed notice resurrects daily.
   *    backup_failing therefore discriminates on (provider, reason) only.
   * 2. Reaped on recovery: the read path (getCompanyNotices) best-effort
   *    deletes the caller's stored dismissals for any category that is
   *    currently healthy, matched by the `category:` id prefix. That is what
   *    makes a NEW failure after a healthy spell resurface even when it mints
   *    the exact same id as the dismissed one: error -> dismiss (hidden while
   *    failing) -> healthy (dismissal reaped on the next read) -> new error
   *    -> visible again. Categories whose id changes per incident anyway
   *    (bank ids embed connection id + status/expiry, skv embeds the
   *    incident's first-error/expiry timestamp) get the same reaping as
   *    hygiene. other_account_hint has no `category:` prefix and is never
   *    reaped: dismissing it silences the condition itself.
   *
   * Ids are also bounded: multi-connection discriminators collapse to a
   * count + 8-char sha256 digest of the sorted parts (categories.ts), so an
   * id never grows with the number of connections and stays well under the
   * dismiss schema cap (lib/api/schemas.ts).
   */
  id: string
  category: NoticeCategory
  severity: NoticeSeverity
  /** Key in the `notices` i18n namespace. */
  messageKey: string
  /** ICU params for messageKey (bank names, counts, days). */
  messageParams?: Record<string, string | number>
  /** Key in the `notices` namespace for the action link label. */
  actionKey: string
  /** Where the action link goes (client surfaces may override per category). */
  actionHref: string
}
