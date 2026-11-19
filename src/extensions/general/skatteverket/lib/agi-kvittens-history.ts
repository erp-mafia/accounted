import type { SupabaseClient } from '@supabase/supabase-js'
import type { AgiKvittensReceipt } from '@/lib/salary/agi-submission-state'
import type { SkatteverketAGIKvittens } from '../types'

/**
 * Every AGI kvittens Skatteverket returns, kept (agi_kvittenser, migration
 * 20261014150000).
 *
 * agi_declarations holds one row per redovisningsperiod and so one receipt:
 * the period's current state, where the latest kvittens wins. A correction is
 * a complete replacement declaration that gets its own kvittens, and before
 * this table recording it wrote over the original filing's receipt. A
 * received document is kept as received (BFL 7 kap. 1 §), so every read of
 * the kvittenser endpoint records ALL the receipts it returns here first,
 * idempotently on the receipt's own uuidKvittens, and only then moves
 * agi_declarations on.
 */

export type AgiKvittensRecorder = 'cron' | 'post-connect' | 'interactive'

export type RecordAgiKvittenserResult = { ok: true; recorded: number } | { ok: false; error: string }

/** signeradTid when it is a timestamp Postgres will take; the raw value stays in `receipt`. */
function signedAt(value: string | undefined): string | null {
  if (!value) return null
  return Number.isNaN(Date.parse(value)) ? null : value
}

/**
 * Record every kvittens with a uuidKvittens. Re-reads are no-ops (UNIQUE on
 * company and uuidKvittens, ON CONFLICT DO NOTHING), so the cron, the
 * post-connect refresh and the panel's check can all call it.
 */
export async function recordAgiKvittenser(
  supabase: SupabaseClient,
  companyId: string,
  period: { year: number; month: number },
  kvittenser: readonly SkatteverketAGIKvittens[] | null | undefined,
  recordedBy: AgiKvittensRecorder,
): Promise<RecordAgiKvittenserResult> {
  const byId = new Map<string, SkatteverketAGIKvittens>()
  for (const kvittens of kvittenser ?? []) {
    const id = kvittens?.uuidKvittens
    if (typeof id === 'string' && id.length > 0 && !byId.has(id)) byId.set(id, kvittens)
  }
  if (byId.size === 0) return { ok: true, recorded: 0 }

  const rows = [...byId.entries()].map(([uuidKvittens, kvittens]) => ({
    company_id: companyId,
    period_year: period.year,
    period_month: period.month,
    uuid_kvittens: uuidKvittens,
    signerad_tid: signedAt(kvittens.signeradTid),
    receipt: kvittens,
    recorded_by: recordedBy,
  }))
  const { error } = await supabase
    .from('agi_kvittenser')
    .upsert(rows, { onConflict: 'company_id,uuid_kvittens', ignoreDuplicates: true })
  if (error) return { ok: false, error: error.message }
  return { ok: true, recorded: rows.length }
}

interface AgiKvittensRow {
  uuid_kvittens: string
  signerad_tid: string | null
  receipt: { signeradAv?: string | null; signeradTid?: string | null } | null
}

/**
 * The period's recorded receipts, newest signing first. A failed read answers
 * none: the receipts complete the run-scoped view, they never gate it.
 */
export async function readAgiKvittensReceipts(
  supabase: SupabaseClient,
  companyId: string,
  periodYear: number,
  periodMonth: number,
): Promise<AgiKvittensReceipt[]> {
  const { data, error } = await supabase
    .from('agi_kvittenser')
    .select('uuid_kvittens, signerad_tid, receipt')
    .eq('company_id', companyId)
    .eq('period_year', periodYear)
    .eq('period_month', periodMonth)
    .order('signerad_tid', { ascending: false, nullsFirst: false })
  if (error || !Array.isArray(data)) return []
  return (data as AgiKvittensRow[]).filter((row) => typeof row?.uuid_kvittens === 'string').map((row) => {
    const receipt: AgiKvittensReceipt = { kvittensnummer: row.uuid_kvittens }
    const signeradAv = row.receipt?.signeradAv
    // The raw string Skatteverket sent: it is what stamped agi_submitted_at.
    const signeradTid = row.receipt?.signeradTid ?? row.signerad_tid
    if (signeradAv) receipt.signeradAv = signeradAv
    if (signeradTid) receipt.signeradTid = signeradTid
    return receipt
  })
}
