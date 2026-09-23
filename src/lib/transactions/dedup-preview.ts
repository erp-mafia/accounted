/**
 * Read-only duplicate PREVIEW for the bank-file import wizard.
 *
 * Answers "which of these parsed rows will ingest skip as duplicates?" BEFORE
 * the user confirms the import, reusing the real execute-side machinery:
 *
 * - Layer 1: exact `external_id` collisions, against ids prefetched with the
 *   same chunked `.in()` pattern `ingestTransactions` uses.
 * - Layer 2: the content bridge, against the SAME stored-row maps ingest
 *   builds (`buildExistingTransactionMaps`), matched with the same
 *   (date, öre) bucketing (`contentBucketKey`), the same prefix-containment
 *   (`descriptionsBridge`), the same currency guard, and the same COUNTING
 *   semantics (each stored twin is consumed once, so two identical incoming
 *   rows against one stored row flag exactly one).
 *
 * Deliberate differences from execute (both make the preview ADVISORY, never
 * authoritative; `ingestTransactions`' own result.duplicates remains the
 * truth):
 *
 * - No cross-channel / hand-entered mirrors: they need the batch settlement
 *   account and import source, neither of which is known at preview time.
 *   Skipping them can only UNDER-count (execute may skip more than previewed),
 *   which the UI copy accounts for by never promising an exact final number.
 * - No settlement account means the cash-account guard runs with a null batch
 *   account, i.e. it never rejects. A same-(date, öre, description) row on a
 *   DIFFERENT bank account of the same company is therefore flagged here even
 *   though execute could insert it once both accounts are known. Rare today
 *   (CSV rows store cash_account_id NULL for the default 1930) and safe: the
 *   warning is advisory.
 * - Nothing is written: no inserts, no hand-mirror adoption stamps.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { buildExistingTransactionMaps, type DescBucket } from '@/lib/transactions/ingest'
import {
  contentBucketKey,
  descriptionsBridge,
  normalizeImportedDescription,
} from '@/lib/transactions/external-id'

/** Minimal per-row input: what the two dedup layers actually read. */
export interface PreviewTransaction {
  date: string
  amount: number
  description: string
  /** Must be derived EXACTLY like execute derives it (generateExternalId). */
  external_id: string
  currency?: string | null
}

export interface DuplicatePreviewResult {
  /** Indexes into the input array, ascending. */
  duplicate_row_indexes: number[]
  duplicate_count: number
  by_reason: {
    /** Exact `external_id` collision (Layer 1). */
    external_id: number
    /** Content bridge: same (date, öre), bridging description (Layer 2). */
    content_bridge: number
  }
}

export async function previewDuplicates(
  supabase: SupabaseClient,
  companyId: string,
  raws: PreviewTransaction[],
): Promise<DuplicatePreviewResult> {
  const result: DuplicatePreviewResult = {
    duplicate_row_indexes: [],
    duplicate_count: 0,
    by_reason: { external_id: 0, content_bridge: 0 },
  }
  if (raws.length === 0) return result

  // The same stored-row universe execute-side ingest dedups against.
  const existingMaps = await buildExistingTransactionMaps(supabase, companyId, raws)

  // Layer-1 prefetch: chunked to stay clear of URL length limits, same shape
  // as ingestTransactions.
  const existingExternalIds = new Set<string>()
  const externalIds = raws.map((t) => t.external_id)
  for (let i = 0; i < externalIds.length; i += 500) {
    const chunk = externalIds.slice(i, i + 500)
    const { data } = await supabase
      .from('transactions')
      .select('external_id')
      .eq('company_id', companyId)
      .in('external_id', chunk)
    data?.forEach((r) => existingExternalIds.add(r.external_id))
  }

  const flag = (index: number, reason: 'external_id' | 'content_bridge') => {
    result.duplicate_row_indexes.push(index)
    result.duplicate_count++
    result.by_reason[reason]++
  }

  for (let index = 0; index < raws.length; index++) {
    const raw = raws[index]

    // Layer 1: exact id collision, identical to ingest's first check.
    if (existingExternalIds.has(raw.external_id)) {
      flag(index, 'external_id')
      continue
    }

    // Layer 2: text bridge with counting semantics. Booked map first, then
    // unbooked imports, mirroring ingest's consume order. LONGEST bridging
    // description wins so a more-specific twin is consumed before a generic
    // one, exactly like consumeBridgingTwin in ingest.ts.
    const description = normalizeImportedDescription(raw.description)
    const bucketKey = contentBucketKey(raw.date, raw.amount)
    const rawCurrency = raw.currency ?? null
    const consumeTextBridgeTwin = (bucket: DescBucket): boolean => {
      const entries = bucket.get(bucketKey)
      if (!entries || entries.length === 0) return false
      let bestIdx = -1
      let bestLen = -1
      for (let i = 0; i < entries.length; i++) {
        const entry = entries[i]
        // Currency guard, same null-tolerance as ingest: the bucket key
        // carries no currency, so 250,00 SEK and 250,00 EUR on one date share
        // a bucket; a known mismatch means two different movements.
        const sameCurrency =
          entry.currency === null || rawCurrency === null || entry.currency === rawCurrency
        if (!sameCurrency) continue
        if (descriptionsBridge(description, entry.desc) && entry.desc.length > bestLen) {
          bestIdx = i
          bestLen = entry.desc.length
        }
      }
      if (bestIdx === -1) return false
      entries.splice(bestIdx, 1)
      return true
    }
    if (
      consumeTextBridgeTwin(existingMaps.booked) ||
      consumeTextBridgeTwin(existingMaps.unbookedImported)
    ) {
      flag(index, 'content_bridge')
    }
  }

  return result
}
