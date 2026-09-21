/**
 * Per-category notice predicates: the single owner of every degraded-state
 * detection. Surfaces (Hem, /api/notices, per-page attn lines) must call
 * these, or the exported pure helpers, instead of inlining their own checks;
 * see lib/notices/types.ts for each category's pending/done definition.
 *
 * Every predicate soft-fails to null with a logged error: a broken health
 * check must never take down the dashboard or the home page.
 */

import { createHash } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createLogger } from '@/lib/logger'
import { ENABLED_EXTENSION_IDS } from '@/lib/extensions/_generated/enabled-extensions'
import { shouldShowOtherAccountHint } from '@/lib/company/other-account-hint'
import { formatCurrency } from '@/lib/utils'
import {
  DEFAULT_SKATTEKONTO_TOLERANCE_SEK,
  SKATTEKONTO_DRIFT_TOLERANCE_KEY,
  SKATTEKONTO_EXTENSION_ID,
  SKATTEKONTO_LAST_SYNCED_AT_KEY,
  SKATTEKONTO_RECONCILIATION_LATEST_KEY,
  skattekontoUnexplainedFrom,
  type SkattekontoReconciliationLatest,
} from '@/lib/reconciliation/skattekonto-latest'
import { expiringBankConnectionsFrom, skvDataIsStale, skvStatusNeedsReconnect } from './predicates'
import { isSkvSessionRefreshable, isTerminalReconsentState } from '@/lib/skatteverket/session-lifetime'
import type { Notice } from './types'

// The pure decision layer lives in ./predicates (client-safe: 'use client'
// pages import it directly, since this file pulls in server-only modules).
// Re-exported here so server code has one import path for the whole domain.
export * from './predicates'

const log = createLogger('notices')

function logAndNull(
  category: string,
  companyId: string,
  error: { message?: string } | null,
): null {
  // companyId is a structured field so repeated failures can be correlated
  // to a tenant in monitoring (mirrors lib/worklist logAndZero).
  log.error(`notice predicate failed: ${category}`, { companyId, reason: error?.message })
  return null
}

/**
 * Bound a multi-part id discriminator. A single part stays human-readable
 * (a connection id plus its status/expiry); several parts, each embedding a
 * uuid, collapse to `<count>@<first 8 hex of sha256 over the sorted parts>`,
 * so the id stays far below the dismiss schema cap (lib/api/schemas.ts) no
 * matter how many connections fold into one notice, and is stable across
 * row orderings. Server-only (node:crypto), which this module already is.
 */
function boundedDiscriminator(parts: string[]): string {
  if (parts.length === 1) return parts[0]
  const digest = createHash('sha256')
    .update([...parts].sort().join(','))
    .digest('hex')
    .slice(0, 8)
  return `${parts.length}@${digest}`
}

// ── Predicates (one query each; soft-fail to null) ──

/**
 * no_fiscal_year: the company has no fiscal period at all. A head count, so
 * it costs one index probe on every other company. A FAILED count is never
 * read as zero: telling a company with real books that it has no fiscal year
 * would be worse than saying nothing, so errors soft-fail to null like every
 * other predicate. The discriminator is constant: the state has one shape,
 * and the `category:` prefix lets the dismissal be reaped once a year exists.
 */
export async function detectNoFiscalYear(
  supabase: SupabaseClient,
  companyId: string,
): Promise<Notice | null> {
  try {
    const { count, error } = await supabase
      .from('fiscal_periods')
      .select('id', { count: 'exact', head: true })
      .eq('company_id', companyId)
    if (error) return logAndNull('no_fiscal_year', companyId, error)
    if (count === null || count > 0) return null
    return {
      id: 'no_fiscal_year:0',
      category: 'no_fiscal_year',
      severity: 'warning',
      messageKey: 'no_fiscal_year',
      actionKey: 'no_fiscal_year_action',
      actionHref: '/settings/bookkeeping',
    }
  } catch (err) {
    return logAndNull(
      'no_fiscal_year',
      companyId,
      err instanceof Error ? { message: err.message } : null,
    )
  }
}

/**
 * bank_connection_broken: connections whose status is already terminal
 * ('expired' | 'error'): same predicate as BankSyncStatusChip's "attention"
 * state. Disjoint from bank_connection_expiring by the status filter.
 */
export async function detectBrokenBankConnections(
  supabase: SupabaseClient,
  companyId: string,
): Promise<Notice | null> {
  try {
    const { data, error } = await supabase
      .from('bank_connections')
      .select('id, status, bank_name')
      .eq('company_id', companyId)
      .in('status', ['expired', 'error'])
    if (error) return logAndNull('bank_connection_broken', companyId, error)
    const rows = data ?? []
    if (rows.length === 0) return null
    const discriminator = boundedDiscriminator(rows.map((r) => `${r.id}=${r.status}`))
    // A NULL bank_name switches to the unnamed message variant instead of
    // interpolating a fallback word, which would leak Swedish into English.
    const bankName = rows.length === 1 ? ((rows[0].bank_name as string | null) || null) : null
    return {
      id: `bank_connection_broken:${discriminator}`,
      category: 'bank_connection_broken',
      severity: 'error',
      messageKey:
        rows.length === 1
          ? bankName
            ? 'bank_broken_one'
            : 'bank_broken_one_unnamed'
          : 'bank_broken_many',
      messageParams:
        rows.length === 1
          ? bankName
            ? { bank: bankName }
            : undefined
          : { count: rows.length },
      actionKey: 'bank_broken_action',
      actionHref: '/settings/banking',
    }
  } catch (err) {
    return logAndNull(
      'bank_connection_broken',
      companyId,
      err instanceof Error ? { message: err.message } : null,
    )
  }
}

/**
 * bank_connection_expiring: active connections whose PSD2 consent runs out
 * within 14 days. Only status = 'active' rows are considered, so a
 * connection that has ALREADY failed never shows as both broken and
 * expiring (broken supersedes expiring for the same connection).
 */
export async function detectExpiringBankConnections(
  supabase: SupabaseClient,
  companyId: string,
  now: Date = new Date(),
): Promise<Notice | null> {
  try {
    const { data, error } = await supabase
      .from('bank_connections')
      .select('id, bank_name, consent_expires')
      .eq('company_id', companyId)
      .eq('status', 'active')
      .not('consent_expires', 'is', null)
    if (error) return logAndNull('bank_connection_expiring', companyId, error)
    const expiring = expiringBankConnectionsFrom(data ?? [], now)
    if (expiring.length === 0) return null
    // The consent date, not days_left, discriminates the id: the countdown
    // ticking from 14 to 13 days must not resurrect a dismissed notice.
    const consentByid = new Map(
      (data ?? []).map((r) => [r.id as string, r.consent_expires as string | null]),
    )
    const discriminator = boundedDiscriminator(
      expiring.map((c) => `${c.id}=${consentByid.get(c.id) ?? ''}`),
    )
    return {
      id: `bank_connection_expiring:${discriminator}`,
      category: 'bank_connection_expiring',
      severity: 'warning',
      messageKey: expiring.length === 1 ? 'bank_expiring_one' : 'bank_expiring_many',
      messageParams:
        expiring.length === 1
          ? { bank: expiring[0].bank_name, days: expiring[0].days_left }
          : { count: expiring.length },
      actionKey: 'bank_expiring_action',
      actionHref: '/settings/banking',
    }
  } catch (err) {
    return logAndNull(
      'bank_connection_expiring',
      companyId,
      err instanceof Error ? { message: err.message } : null,
    )
  }
}

/**
 * skv_disconnected: a stored Skatteverket connection the user has to act on.
 * Two states, because they are two different facts (#2567):
 *
 *   1. Terminal. The row is latched needs_reconsent with a code only a fresh
 *      BankID consent clears (missing behorighet, refresh budget spent,
 *      unreadable ciphertext). Warned about immediately.
 *   2. Expired with nothing left to refresh, which is where EVERY connected
 *      company sits between consents: Skatteverket's per-flow BankID session
 *      lasts about an hour. Saying "the connection needs renewing" about that
 *      state every day is what made three reporters think the integration was
 *      broken, so it is only mentioned once the data it feeds has actually
 *      gone stale (a week without a successful skattekonto sync). The
 *      immediate, contextual version of this line lives on the Skattekonto
 *      and Transaktioner pages, where the user is looking at the numbers.
 *
 * Connections are per (user, company), so the predicate needs the caller's
 * user id. Refresh-token ciphertext is read only for a null check and never
 * returned.
 */
export async function detectSkvDisconnected(
  supabase: SupabaseClient,
  userId: string,
  companyId: string,
  now: Date = new Date(),
): Promise<Notice | null> {
  try {
    if ((process.env.SKATTEVERKET_DISABLED ?? '').toLowerCase() === 'true') return null
    const { data, error } = await supabase
      .from('skatteverket_tokens')
      .select('status, expires_at, refresh_token, refresh_count, last_error_at, last_error_code')
      .eq('user_id', userId)
      .eq('company_id', companyId)
      .maybeSingle()
    if (error) return logAndNull('skv_disconnected', companyId, error)
    if (!data) return null

    const expiresAt = data.expires_at as string | null
    const expired = expiresAt !== null && new Date(expiresAt).getTime() < now.getTime()
    // Same rule as the extension's /status route: a refresh token past its
    // 65-minute life does not count as refreshable (lib/skatteverket/session-lifetime).
    const canRefresh = isSkvSessionRefreshable(
      {
        expiresAt,
        hasRefreshToken: data.refresh_token !== null,
        refreshCount: data.refresh_count as number | null,
      },
      now,
    )
    // A row latched SESSION_EXPIRED before #2567 is not terminal: that was
    // the hourly expiry being recorded as a fault, and the time math above
    // reports it without any stored flag.
    const needsReconsent = isTerminalReconsentState(
      data.status as string | null,
      data.last_error_code as string | null,
    )
    if (!skvStatusNeedsReconnect({ connected: true, needsReconsent, expired, canRefresh })) {
      return null
    }

    if (needsReconsent) {
      // Discriminated by when the terminal error was detected, so a NEW
      // failure after a successful re-consent mints a new id.
      return {
        id: `skv_disconnected:needs_reconsent@${(data.last_error_at as string | null) ?? ''}`,
        category: 'skv_disconnected',
        severity: 'warning',
        messageKey: 'skv_disconnected',
        actionKey: 'skv_disconnected_action',
        actionHref: '/settings/tax',
      }
    }

    // Merely expired: worth a line only once the data went stale. Fall back
    // to the end of the last BankID session when nothing ever synced, so a
    // company that connected and never got data is not silently ignored.
    const lastSyncedAt = await readSkattekontoLastSyncedAt(supabase, companyId)
    const lastFreshAt = lastSyncedAt ?? expiresAt
    if (!skvDataIsStale(lastFreshAt, now)) return null
    return {
      // Stable while the same stale spell lasts (the timestamp only moves
      // when a sync succeeds, which also clears the notice).
      id: `skv_disconnected:stale@${lastFreshAt ?? ''}`,
      category: 'skv_disconnected',
      severity: 'warning',
      messageKey: 'skv_session_expired',
      actionKey: 'skv_disconnected_action',
      actionHref: '/settings/tax',
    }
  } catch (err) {
    return logAndNull(
      'skv_disconnected',
      companyId,
      err instanceof Error ? { message: err.message } : null,
    )
  }
}

/**
 * The last successful skattekonto sync for a company, or null when it never
 * synced. Read straight from extension_data, like detectSkvUnexplained: core
 * must not import from @/extensions/.
 *
 * A failed lookup THROWS rather than answering null: null means "no sync has
 * ever happened" and sends the caller to the much older session expiry, which
 * would turn a transient query failure into a false stale-data warning. The
 * detector's own catch turns the throw into no notice at all, which is the
 * honest answer while we cannot see the data.
 */
async function readSkattekontoLastSyncedAt(
  supabase: SupabaseClient,
  companyId: string,
): Promise<string | null> {
  const { data, error } = await supabase
    .from('extension_data')
    .select('value')
    .eq('company_id', companyId)
    .eq('extension_id', SKATTEKONTO_EXTENSION_ID)
    .eq('key', SKATTEKONTO_LAST_SYNCED_AT_KEY)
    .maybeSingle()
  if (error) throw new Error(error.message)
  if (!data) return null
  const value = data.value
  return typeof value === 'string' ? value : null
}

/** Brand names stay untranslated; the sentence around them is localised. */
const BACKUP_PROVIDER_LABELS: Record<string, string> = {
  google_drive: 'Google Drive',
  dropbox: 'Dropbox',
}

interface BackupConnectionValue {
  status?: 'active' | 'needs_reauth'
  needs_reauth_at?: string
}

interface BackupScheduleValue {
  last_auto_sync_status?: 'success' | 'error' | null
  last_auto_sync_at?: string | null
}

/**
 * backup_failing: a connected cloud-backup destination with a dead token or
 * an errored last auto-sync. Reads the cloud-backup extension's rows in
 * extension_data directly (core must not import from @/extensions/, so the
 * keys and value shapes are mirrored here, same as the old
 * BackupHealthBanner mirrored the status API's shape). Multiple failing
 * providers fold into ONE notice: a working Drive backup does not make a
 * broken Dropbox backup acceptable, but two failures must not stack two
 * lines either.
 */
export async function detectBackupFailing(
  supabase: SupabaseClient,
  companyId: string,
): Promise<Notice | null> {
  try {
    if (!ENABLED_EXTENSION_IDS.has('cloud-backup')) return null
    const { data, error } = await supabase
      .from('extension_data')
      .select('key, value')
      .eq('company_id', companyId)
      .eq('extension_id', 'cloud-backup')
      .in('key', [
        'google_drive_connection',
        'google_drive_schedule',
        'dropbox_connection',
        'dropbox_schedule',
      ])
    if (error) return logAndNull('backup_failing', companyId, error)
    const byKey = new Map((data ?? []).map((r) => [r.key as string, r.value]))

    const failing: { provider: string; reason: 'reauth' | 'sync_error' }[] = []
    for (const provider of ['google_drive', 'dropbox']) {
      const connection = byKey.get(`${provider}_connection`) as BackupConnectionValue | undefined
      if (!connection) continue
      const schedule = byKey.get(`${provider}_schedule`) as BackupScheduleValue | undefined
      if (connection.status === 'needs_reauth') {
        failing.push({ provider, reason: 'reauth' })
      } else if (schedule?.last_auto_sync_status === 'error') {
        failing.push({ provider, reason: 'sync_error' })
      }
    }
    if (failing.length === 0) return null

    const names = failing
      .map((f) => BACKUP_PROVIDER_LABELS[f.provider] ?? f.provider)
      .join(' + ')
    const allNeedReauth = failing.every((f) => f.reason === 'reauth')
    // Deliberately NO timestamp in the discriminator: the cron re-stamps
    // last_auto_sync_at on every failed run (and can re-stamp needs_reauth_at
    // on retries), which would resurrect a dismissed notice daily while the
    // SAME incident persists. The id is stable per (provider, reason) and the
    // opposite direction (a NEW failure after a healthy spell must resurface)
    // is guaranteed by the stale-dismissal reaping in aggregate.ts; contract
    // in lib/notices/types.ts.
    const discriminator = failing
      .map((f) => `${f.provider}=${f.reason}`)
      .sort()
      .join(',')
    return {
      id: `backup_failing:${discriminator}`,
      category: 'backup_failing',
      severity: 'error',
      messageKey: allNeedReauth ? 'backup_reauth' : 'backup_failing',
      messageParams: { provider: names },
      actionKey: 'backup_action',
      actionHref: '/import#cloud-backup',
    }
  } catch (err) {
    return logAndNull(
      'backup_failing',
      companyId,
      err instanceof Error ? { message: err.message } : null,
    )
  }
}

/**
 * other_account_hint: the wrong-login nudge (#1231). Delegates the detection
 * to lib/company/other-account-hint (which already fails soft to false); this
 * wrapper only shapes it as the lowest-priority notice. The id carries no
 * state discriminator: the condition is "this account is empty while another
 * holds the bookkeeping", which either holds or stops holding.
 */
export async function detectOtherAccountHint(
  supabase: SupabaseClient,
  companyId: string,
): Promise<Notice | null> {
  try {
    const show = await shouldShowOtherAccountHint(supabase)
    if (!show) return null
    return {
      id: 'other_account_hint',
      category: 'other_account_hint',
      severity: 'warning',
      messageKey: 'other_account_hint',
      actionKey: 'other_account_hint_action',
      // Client surfaces override this with a sign-out handler; the href is
      // the no-JS fallback destination.
      actionHref: '/login',
    }
  } catch (err) {
    return logAndNull(
      'other_account_hint',
      companyId,
      err instanceof Error ? { message: err.message } : null,
    )
  }
}

/**
 * skv_unexplained: the skattekonto's latest reconciliation summary (written
 * by the skatteverket extension on every sync) shows an unexplained
 * difference above the drift tolerance. Reads extension_data directly (core
 * must not import from @/extensions/; the key and value shape live in
 * lib/reconciliation/skattekonto-latest.ts, which the extension imports).
 * The id carries the signed whole-krona amount, so öre-level movement does
 * not resurface a dismissed notice while a materially different difference
 * does.
 */
export async function detectSkvUnexplained(
  supabase: SupabaseClient,
  companyId: string,
): Promise<Notice | null> {
  try {
    if (!ENABLED_EXTENSION_IDS.has(SKATTEKONTO_EXTENSION_ID)) return null
    const { data, error } = await supabase
      .from('extension_data')
      .select('key, value')
      .eq('company_id', companyId)
      .eq('extension_id', SKATTEKONTO_EXTENSION_ID)
      .in('key', [SKATTEKONTO_RECONCILIATION_LATEST_KEY, SKATTEKONTO_DRIFT_TOLERANCE_KEY])
    if (error) return logAndNull('skv_unexplained', companyId, error)
    const byKey = new Map((data ?? []).map((r) => [r.key as string, r.value]))
    const latest = byKey.get(SKATTEKONTO_RECONCILIATION_LATEST_KEY) as SkattekontoReconciliationLatest | undefined
    const toleranceRaw = byKey.get(SKATTEKONTO_DRIFT_TOLERANCE_KEY)
    const tolerance = typeof toleranceRaw === 'number' ? toleranceRaw : DEFAULT_SKATTEKONTO_TOLERANCE_SEK
    const unexplained = skattekontoUnexplainedFrom(latest, tolerance)
    if (unexplained == null) return null
    const whole = Math.round(unexplained)
    return {
      id: `skv_unexplained:${whole >= 0 ? '+' : '-'}${Math.abs(whole)}`,
      category: 'skv_unexplained',
      severity: 'warning',
      messageKey: 'skv_unexplained',
      messageParams: { amount: formatCurrency(unexplained, 'SEK') },
      actionKey: 'skv_unexplained_action',
      actionHref: '/reconciliation?account=skattekonto',
    }
  } catch (err) {
    return logAndNull(
      'skv_unexplained',
      companyId,
      err instanceof Error ? { message: err.message } : null,
    )
  }
}
