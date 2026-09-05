/**
 * Core <-> Enable Banking extension boundary for the agent-triggered sync.
 *
 * `lib/` and `app/api/v1/` cannot import from `@/extensions/` (CI guard,
 * core-build.yml), so the v1 REST endpoint
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
  | 'BANK_SESSION_EXPIRED'
  | 'BANK_SYNC_FAILED'

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
    }
  | {
      ok: false
      code: TriggerSyncFailureCode
      connection_id: string
      status?: string
      /** ISO timestamp after which a sync is accepted again (cooldown only). */
      next_allowed_at?: string
      /** Seconds until next_allowed_at (cooldown only). */
      retry_after_seconds?: number
    }

/** Services the enable-banking extension registers for core callers. */
export interface EnableBankingServices {
  triggerConnectionSync: (
    supabase: SupabaseClient,
    input: TriggerSyncInput,
  ) => Promise<TriggerSyncResult>
}
