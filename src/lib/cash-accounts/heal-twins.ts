import type { SupabaseClient } from '@supabase/supabase-js'
import type { ProcessingHistoryActor } from '@/types'
import { prepareProcessingHistoryRow } from '@/lib/processing-history/append'

export type TwinSkipReason =
  | 'split-ledgers'
  | 'no-live-row'
  | 'several-live-rows'
  | 'routing-outside-group'
  | 'retirement-dependencies'
  | 'identity-mismatch'
  /** Nothing would change: what a finished merge leaves behind. Not an error. */
  | 'already-merged'

export interface TwinRowReport {
  id: string
  ledger_account: string
  movable: number
  /** Transactions that stay bound (booked or anchored). */
  staying: number
  dependencies?: string[]
  outcome: 'rekeyed-into-keeper' | 'deleted' | 'demoted-to-manual' | 'kept-manual'
}

export interface TwinGroupReport {
  /** Present in the private dry run only; omitted from the durable receipt. */
  physicalKey?: string
  ledgers: string[]
  postedLedgers: string[]
  skipped: TwinSkipReason | null
  keeper: { id: string; ledger_account: string } | null
  liveRowId: string | null
  /** accounts_data ledger before the heal, when it differs from the keeper's. */
  accountsDataLedgerFrom: string | null
  retired: TwinRowReport[]
}

export interface HealTwinsResult {
  companyId: string
  dryRun: boolean
  /** Identifies this exact plan; a write run must echo it back. */
  fingerprint: string
  groups: TwinGroupReport[]
  operationId?: string
}

export type HealTwinsOptions =
  | { dryRun: true }
  | {
      dryRun: false
      /** `fingerprint` of the dry run the operator reviewed. */
      expectedFingerprint: string
      /** Stable across retries, including a lost response after commit. */
      operationId: string
      /** Recorded on every CashAccountTwinsMerged event. */
      actor: ProcessingHistoryActor
    }

/**
 * The database computes the reviewed plan and revalidates it under the same
 * locks used for promotion. Execution and its immutable completion receipt
 * commit together for the entire company. A retry returns that receipt.
 */
export async function healTwinCashAccounts(
  supabase: SupabaseClient,
  companyId: string,
  options: HealTwinsOptions,
): Promise<HealTwinsResult> {
  let rpcName: string
  let args: Record<string, unknown>
  if (options.dryRun) {
    rpcName = 'plan_cash_account_twins'
    args = { p_company_id: companyId }
  } else {
    // Reuse the processing-history PII boundary for the operator attribution.
    const event = prepareProcessingHistoryRow({
      companyId, correlationId: options.operationId, aggregateType: 'System', aggregateId: companyId,
      eventType: 'CashAccountTwinsMerged', payload: {}, actor: options.actor, occurredAt: new Date(),
    })
    rpcName = 'heal_cash_account_twins'
    args = {
      p_company_id: companyId, p_expected_fingerprint: options.expectedFingerprint,
      p_operation_id: options.operationId, p_actor: event.actor,
    }
  }
  const { data, error } = await supabase.rpc(rpcName, args)
  if (error) throw Object.assign(new Error(`cash account twin repair failed: ${error.message}`), { code: error.code })
  if (!data || data.companyId !== companyId || data.dryRun !== options.dryRun ||
    typeof data.fingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(data.fingerprint) || !Array.isArray(data.groups) ||
    (!options.dryRun && (data.operationId !== options.operationId || data.fingerprint !== options.expectedFingerprint))) {
    throw new Error('cash account twin repair failed: missing or invalid acknowledgement')
  }
  return data as HealTwinsResult
}

/** Read-only recovery, independent of whether any twin rows still exist. */
export async function getTwinRepairReceipt(
  supabase: SupabaseClient,
  companyId: string,
  operationId: string,
): Promise<HealTwinsResult | null> {
  const { data, error } = await supabase.from('processing_history')
    .select('payload').eq('company_id', companyId).eq('event_id', operationId)
    .eq('event_type', 'CashAccountTwinsMerged').maybeSingle()
  if (error) throw new Error(`cash account twin receipt read failed: ${error.message}`)
  if (!data) return null
  const result = data.payload?.result
  if (data.payload?.phase !== 'completed' || result?.operationId !== operationId || result.companyId !== companyId ||
    result.dryRun !== false || !Array.isArray(result.groups)) {
    throw new Error('cash account twin receipt is invalid')
  }
  return result as HealTwinsResult
}
