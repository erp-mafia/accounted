/**
 * Read-only preview of the ingest dedup decision: "which of these rows will
 * ingest skip as already stored, and why?", answered BEFORE anything is
 * written.
 *
 * It does not re-implement the decision. It runs the same preparation and the
 * same per-row function the commit loop runs (`lib/transactions/ingest.ts`:
 * buildExistingTransactionMaps, rekeyIncomingExternalIds,
 * fetchStoredExternalIds, readBatchCashAccount, buildIngestDedupState,
 * decideIngestRow), over the same rows in the same order. Given the same
 * stored state, the same rows and the same options, the preview and the commit
 * therefore agree row by row: Layer 1 (external_id), the content bridge with
 * its account and currency guards, both mirrors, counting semantics and id
 * re-keying.
 *
 * What a preview cannot know:
 * - Rows another writer stores between the preview and the commit.
 * - Anything the caller leaves out. The bank-file wizard asks before the user
 *   has picked the settlement account, so unless the file's own account
 *   already is a cash account (crm#1204, the wizard then sends that ledger)
 *   its account guard runs with a null batch account and never rejects: a
 *   same-(date, öre, description) row on a DIFFERENT bank account of the same
 *   company is flagged there although execute inserts it once the account is
 *   known. The wizard copy therefore never promises an exact final number.
 *
 * Nothing is written: no inserts, no account re-enable, no hand-mirror
 * adoption stamps.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { IngestSkipReason } from '@/types'
import {
  buildExistingTransactionMaps,
  buildIngestDedupState,
  decideIngestRow,
  fetchStoredExternalIds,
  readBatchCashAccount,
  rekeyIncomingExternalIds,
  type DedupRow,
} from '@/lib/transactions/ingest'
import { normalizeImportedDescription } from '@/lib/transactions/external-id'

/** The options of an ingest call that change which rows are skipped. */
export interface IngestDedupPreviewOptions {
  /** IngestOptions.settlementAccount: the ledger account the batch settles on. */
  settlementAccount?: string
  /** IngestOptions.stableExternalIds: the batch's ids identify bookings. */
  stableExternalIds?: boolean
}

/** What the commit will do with one row, in input order. */
export interface IngestDedupPreviewRow {
  /** The external_id the caller sent. */
  external_id: string
  would_skip: boolean
  skip_reason: IngestSkipReason | null
  /** external_id of the stored row that stands for this one (null when not skipped). */
  matched_external_id: string | null
  /** id of that stored row. */
  matched_transaction_id: string | null
}

/**
 * Predict, row by row, what `ingestTransactions` will do with `rows` under
 * the same options. One entry per input row, in input order.
 */
export async function previewIngestDedup(
  supabase: SupabaseClient,
  companyId: string,
  rows: DedupRow[],
  options?: IngestDedupPreviewOptions,
): Promise<IngestDedupPreviewRow[]> {
  if (rows.length === 0) return []

  // The same stored-row universe, in the same read order, as the commit.
  const existingMaps = await buildExistingTransactionMaps(supabase, companyId, rows)
  const rekeyed = rekeyIncomingExternalIds(rows, existingMaps, options?.stableExternalIds)
  const storedExternalIds = await fetchStoredExternalIds(
    supabase,
    companyId,
    rekeyed.map((row) => row.external_id),
  )
  const account = await readBatchCashAccount(supabase, companyId, options?.settlementAccount)
  const state = buildIngestDedupState({
    rows: rekeyed,
    existingMaps,
    storedExternalIds,
    cashAccountId: account.cashAccountId,
    physicalKeyById: account.physicalKeyById,
    stableExternalIds: options?.stableExternalIds,
  })

  return rekeyed.map((row, index) => {
    const decision = decideIngestRow(state, row, normalizeImportedDescription(row.description))
    return {
      external_id: rows[index].external_id,
      would_skip: decision.skip,
      skip_reason: decision.skip ? decision.reason : null,
      matched_external_id: decision.skip ? decision.matchedExternalId : null,
      matched_transaction_id: decision.skip ? decision.matchedTransactionId : null,
    }
  })
}

/** Minimal per-row input for the bank-file wizard's preview. */
export interface PreviewTransaction {
  date: string
  amount: number
  description: string
  /** Must be derived EXACTLY like execute derives it (generateExternalId). */
  external_id: string
  currency?: string | null
  /**
   * Must be the import_source execute will stamp ('camt053' / 'csv_<format>').
   * It identifies the batch's channel, which the cross-channel and
   * hand-entered mirrors are gated on.
   */
  import_source?: string | null
}

export interface DuplicatePreviewResult {
  /** Indexes into the input array, ascending. */
  duplicate_row_indexes: number[]
  duplicate_count: number
  by_reason: {
    /** Exact `external_id` collision (Layer 1). */
    external_id: number
    /** Content bridge: same (date, öre) and a bridging description or a mirror (Layer 2). */
    content_bridge: number
  }
}

/**
 * The bank-file import wizard's duplicate preview: which parsed rows execute
 * will skip. ADVISORY while the settlement account is not known (see the
 * module note); `ingestTransactions`' own result stays the truth. The wizard
 * passes the settlement account when the file's own account already is a
 * cash account (crm#1204), and the preview then guards accounts as execute does.
 */
export async function previewDuplicates(
  supabase: SupabaseClient,
  companyId: string,
  raws: PreviewTransaction[],
  options?: Pick<IngestDedupPreviewOptions, 'settlementAccount'>,
): Promise<DuplicatePreviewResult> {
  const result: DuplicatePreviewResult = {
    duplicate_row_indexes: [],
    duplicate_count: 0,
    by_reason: { external_id: 0, content_bridge: 0 },
  }
  const rows = await previewIngestDedup(supabase, companyId, raws, options)
  rows.forEach((row, index) => {
    if (!row.would_skip) return
    result.duplicate_row_indexes.push(index)
    result.duplicate_count++
    result.by_reason[row.skip_reason === 'external_id_match' ? 'external_id' : 'content_bridge']++
  })
  return result
}
