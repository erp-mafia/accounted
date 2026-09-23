import type { SupabaseClient } from '@supabase/supabase-js'
import { dbError } from '@/lib/errors/db-error'

/** Provider results only. Routing and user configuration belong to other writers. */
export interface BankSyncAccountResult {
  uid: string
  balance?: number | null
  available_balance?: number | null
  balance_updated_at?: string | null
  accepted_history_days?: number
  dedup_scope?: string
}

export interface BankSyncInitialResult {
  requestedFrom: string
  returnedMin: string | null
  returnedMax: string | null
  lookbackDays: number
}

interface BankSyncResultInput<T extends BankSyncAccountResult> {
  companyId: string
  connectionId: string
  sessionId: string | null
  startedAt: string
  completedAt: string
  accounts: readonly T[]
  initialSync?: BankSyncInitialResult
}

export class BankSyncResultObsoleteError extends Error {
  constructor(reason: string) {
    super(`Bank sync result not persisted: ${reason}`)
    this.name = 'BankSyncResultObsoleteError'
  }
}

/**
 * Persist a fetched batch without replacing the connection's routing snapshot.
 * The RPC locks the current connection, rejects obsolete sessions/results and
 * patches sync-owned fields in both stores atomically. A refusal is a failure:
 * callers must not claim success while the stored sync watermark stayed put.
 */
export async function persistBankSyncResult<T extends BankSyncAccountResult>(
  supabase: SupabaseClient,
  input: BankSyncResultInput<T>,
): Promise<void> {
  const accounts = input.accounts.map((account) => ({
    uid: account.uid,
    ...(account.balance !== undefined ? { balance: account.balance } : {}),
    ...(account.available_balance !== undefined ? { available_balance: account.available_balance } : {}),
    ...(account.balance_updated_at !== undefined ? { balance_updated_at: account.balance_updated_at } : {}),
    ...(account.accepted_history_days !== undefined ? { accepted_history_days: account.accepted_history_days } : {}),
    ...(account.dedup_scope !== undefined ? { dedup_scope: account.dedup_scope } : {}),
  }))
  const initial = input.initialSync
  const { data, error } = await supabase.rpc('persist_bank_sync_result', {
    p_company_id: input.companyId,
    p_connection_id: input.connectionId,
    p_session_id: input.sessionId,
    p_started_at: input.startedAt,
    p_completed_at: input.completedAt,
    p_accounts: accounts,
    p_initial_sync: initial ? {
      requested_from: initial.requestedFrom,
      returned_min: initial.returnedMin,
      returned_max: initial.returnedMax,
      lookback_days: initial.lookbackDays,
    } : null,
  })
  if (error) throw dbError(error, 'Bank sync persistence')
  const result = data as { applied?: boolean; reason?: string } | null
  if (result?.applied !== true) {
    throw new BankSyncResultObsoleteError(result?.reason ?? 'missing_acknowledgement')
  }
}

/** A failed request may only change the session and attempt it actually read. */
export async function persistBankSyncFailure(
  supabase: SupabaseClient,
  input: {
    companyId: string
    connectionId: string
    sessionId: string | null
    startedAt: string
    status: 'expired' | 'error'
    message: string
  },
): Promise<boolean> {
  const { data, error } = await supabase.rpc('persist_bank_sync_failure', {
    p_company_id: input.companyId,
    p_connection_id: input.connectionId,
    p_session_id: input.sessionId,
    p_started_at: input.startedAt,
    p_status: input.status,
    p_message: input.message,
  })
  if (error) throw dbError(error, 'Bank sync failure persistence')
  if (typeof data !== 'boolean') throw new Error('Bank sync failure persistence: missing acknowledgement')
  return data
}
