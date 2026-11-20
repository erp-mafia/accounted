/**
 * Core <-> Enable Banking extension boundary for the agent-triggered sync.
 *
 * `lib/` and `app/api/v1/` cannot import from `@/extensions/` (CI guard), so the v1 REST endpoint
 * POST /companies/{id}/bank-connections/{connectionId}/sync reaches the
 * runner only through the registry-resolved `services` channel: same
 * pattern as lib/skatteverket/declaration-status.ts. This module holds the
 * SHARED shapes so the extension (which may import core freely) and the v1
 * route agree on the contract without core ever importing the extension.
 */
import type { SupabaseClient } from '@supabase/supabase-js'

/** A connection synced more recently than this answers with a cooldown. */
export const SYNC_COOLDOWN_MS = 15 * 60 * 1000

export interface TriggerSyncLogger {
  info: (message: string, meta?: Record<string, unknown>) => void
  warn: (message: string, meta?: Record<string, unknown>) => void
  error: (message: string, meta?: Record<string, unknown>) => void
}

export interface TriggerSyncInput {
  companyId: string
  userId: string
  connectionId: string
  log: TriggerSyncLogger
  /** Clock override for tests. */
  now?: number
}

export type TriggerSyncFailureCode =
  | 'NOT_FOUND'
  | 'BANK_SYNC_NOT_ACTIVE'
  | 'BANK_SYNC_NO_ACCOUNTS'
  | 'BANK_SYNC_COOLDOWN'
  | 'BANK_RATE_LIMITED'
  /** The bank's short throttle (Open Payments): try again in a minute, the daily cap is untouched. */
  | 'BANK_THROTTLED'
  | 'BANK_SESSION_EXPIRED'
  | 'BANK_SYNC_FAILED'
  /** The Enable Banking feed is over (lib/bank-feed/switch-campaign.ts enableBankingSunset): switch, do not retry. */
  | 'ENABLE_BANKING_SUNSET'

export type TriggerSyncResult =
  | {
      ok: true
      connection_id: string
      bank: string | null
      imported: number
      duplicates: number
      from_date: string
      to_date: string
      last_synced_at: string
      /**
       * A first import only (Open Payments): whether the bank's extended history
       * was asked for, or the ordinary window because the extended one had closed
       * before the import ran (lib/bank-feed/feed.ts).
       */
      history_window?: 'extended' | 'ordinary'
      /**
       * Open Payments only: stored rows the re-read updated with the bank's
       * daily enrichment (a reference, a payer, an organisationsnummer), and
       * whether the window carried today's enrichment (null when the bank
       * reports nothing about it).
       */
      enriched_updated?: number
      window_enriched?: boolean | null
    }
  | {
      ok: false
      code: TriggerSyncFailureCode
      connection_id: string
      status?: string
      /** ISO timestamp after which a sync is accepted again (cooldown and bank rate limit). */
      next_allowed_at?: string
      /** Seconds until next_allowed_at (cooldown and bank rate limit). */
      retry_after_seconds?: number
      /**
       * Only from the Open Payments cron, which passes a deadline: the run's
       * time budget stopped the sync before every account was read. Nothing
       * was stamped, so the connection is still due (lib/bank-feed/feed.ts).
       */
      deadline_reached?: true
    }

/** Services the enable-banking extension registers for core callers. */
export interface EnableBankingServices {
  triggerConnectionSync: (
    supabase: SupabaseClient,
    input: TriggerSyncInput,
  ) => Promise<TriggerSyncResult>
}
