/**
 * Server-side execution of a skattekontoutdrag file import.
 *
 * Writes to skattekonto_transactions directly (RLS-scoped): imported rows
 * then flow through the exact same booking/matching pipeline as API-synced
 * rows. The API sync's takeover step (skattekonto-sync.ts) reconciles these
 * hash-keyed rows if the company later connects Skatteverket.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import {
  assignFileDedupKeys,
  partitionFileRows,
  type ExistingSkattekontoRow,
  type SkattekontoFileRowIdentity,
} from '@/lib/skatteverket/skattekonto-dedup'

/**
 * Existing rows in the statement's date span, for partitioning. Paged: a
 * statement can cover years and PostgREST caps unpaged reads at 1000 rows.
 */
export async function fetchExistingSkattekontoRows(
  supabase: SupabaseClient,
  companyId: string,
  dateFrom: string,
  dateTo: string,
): Promise<ExistingSkattekontoRow[]> {
  return fetchAllRows<ExistingSkattekontoRow>(({ from, to }) =>
    supabase
      .from('skattekonto_transactions')
      .select('id, dedup_key, status, transaktionsdatum, transaktionstext, belopp_skatteverket')
      .eq('company_id', companyId)
      .gte('transaktionsdatum', dateFrom)
      .lte('transaktionsdatum', dateTo)
      .order('id', { ascending: true })
      .range(from, to),
  )
}

export interface SkattekontoFileImportOutcome {
  imported: number
  duplicates: number
  promoted: number
  /** Rows that failed to write for reasons other than being duplicates. */
  errors: number
  first_error: string | null
}

const INSERT_BATCH_SIZE = 200
/** Postgres unique_violation */
const UNIQUE_VIOLATION = '23505'

/**
 * Partition the confirmed rows against the table and write them:
 * inserts for new rows, in-place status promotions for upcoming rows the
 * statement proves settled, skips for rows already booked.
 *
 * Batched inserts fall back to per-row on unique violations so one residual
 * conflict (e.g. a concurrent sync) degrades to a counted duplicate instead
 * of failing the whole import.
 */
export async function executeSkattekontoFileImport(
  supabase: SupabaseClient,
  companyId: string,
  fileImportId: string,
  rows: SkattekontoFileRowIdentity[],
): Promise<SkattekontoFileImportOutcome> {
  const dates = rows.map((r) => r.transaktionsdatum).sort()
  const existing = await fetchExistingSkattekontoRows(
    supabase,
    companyId,
    dates[0],
    dates[dates.length - 1],
  )
  const partition = partitionFileRows(assignFileDedupKeys(rows), existing)

  const outcome: SkattekontoFileImportOutcome = {
    imported: 0,
    duplicates: partition.duplicates.length,
    promoted: 0,
    errors: 0,
    first_error: null,
  }

  const toRow = (entry: { row: SkattekontoFileRowIdentity; dedupKey: string }) => ({
    company_id: companyId,
    transaktionsidentitet: null,
    dedup_key: entry.dedupKey,
    transaktionsdatum: entry.row.transaktionsdatum,
    forfallodatum: null,
    ranteberakningsdatum: null,
    transaktionstext: entry.row.transaktionstext,
    belopp_skatteverket: entry.row.belopp,
    belopp_kronofogden: null,
    status: 'booked' as const,
    source: 'file_import' as const,
    file_import_id: fileImportId,
  })

  for (let i = 0; i < partition.toInsert.length; i += INSERT_BATCH_SIZE) {
    const batch = partition.toInsert.slice(i, i + INSERT_BATCH_SIZE)
    const { error } = await supabase
      .from('skattekonto_transactions')
      .insert(batch.map(toRow))
    if (!error) {
      outcome.imported += batch.length
      continue
    }
    if (error.code !== UNIQUE_VIOLATION) {
      outcome.errors += batch.length
      outcome.first_error = outcome.first_error ?? error.message
      continue
    }
    for (const entry of batch) {
      const { error: rowError } = await supabase
        .from('skattekonto_transactions')
        .insert(toRow(entry))
      if (!rowError) {
        outcome.imported++
      } else if (rowError.code === UNIQUE_VIOLATION) {
        outcome.duplicates++
      } else {
        outcome.errors++
        outcome.first_error = outcome.first_error ?? rowError.message
      }
    }
  }

  for (const promotion of partition.promotions) {
    // Return the updated rows: when a concurrent sync already flipped the
    // row, zero rows match and the promotion must not be counted.
    const { data: updated, error } = await supabase
      .from('skattekonto_transactions')
      .update({ status: 'booked' })
      .eq('id', promotion.existingId)
      .eq('company_id', companyId)
      .eq('status', 'upcoming')
      .select('id')
    if (error) {
      outcome.errors++
      outcome.first_error = outcome.first_error ?? error.message
    } else if (updated && updated.length > 0) {
      outcome.promoted++
    }
  }

  return outcome
}
