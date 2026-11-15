import { createHash } from 'node:crypto'

export const SIE_JOB_VERSION = 1
export const SIE_LIMITS = Object.freeze({
  fileBytes: 50 * 1024 * 1024,
  // A year's vouchers in one file. 50 000 refused a company's years of about
  // 50 000 to 113 000 vouchers (2026-11-10, estimated from file sizes), while
  // the job works in 200-voucher chunks and resumes across invocations: the
  // count only makes a run longer (about 20 s per 1 000 vouchers in
  // production). The vouchers take source ordinals 0 to 149 999, and no more:
  // an undo receipt is numbered by the lowest ordinal it reverses, and the
  // name and VAT restore receipts start at 150 000 (sieFinalOrdinals).
  fileVouchers: 150_000,
  chunkVouchers: 200,
  chunkLines: 2_000,
  chunkBytes: 1024 * 1024,
})

/** The source ordinals of the two entries a job writes after the file's vouchers. */
export interface SIEFinalOrdinals { openingBalance: number; adjustment: number }

const LEGACY_FINAL_ORDINALS: SIEFinalOrdinals = Object.freeze({ openingBalance: 50_000, adjustment: 50_001 })
const LARGE_FILE_FINAL_ORDINALS: SIEFinalOrdinals = Object.freeze({ openingBalance: 1_000_000, adjustment: 1_000_001 })

/**
 * Where a job puts its IB and its migration adjustment, given the first
 * source ordinal past the file's vouchers (they take 0 to vouchers - 1).
 *
 * Up to the old limit of 50 000 vouchers they keep 50 000 and 50 001, as every
 * job before it was raised, so a job prepared across that deploy saves the
 * same final chunk again (save_sie_import_chunk refuses a changed one). A
 * larger file would collide with them (journal_import_batch_ordinal_idx), so
 * it puts them at 1 000 000 and 1 000 001: past every voucher, and clear of
 * the undo receipts at 150 000 to 179 999 that restore account names and VAT
 * defaults. The job seals the pair in its manifest (sealedSIEFinalOrdinals),
 * where complete_sie_import_job reads it.
 */
export function sieFinalOrdinals(pastLastVoucher: number): SIEFinalOrdinals {
  return pastLastVoucher <= LEGACY_FINAL_ORDINALS.openingBalance ? LEGACY_FINAL_ORDINALS : LARGE_FILE_FINAL_ORDINALS
}

/** The pair a prepared job sealed; a job sealed before the manifest carried it used 50 000 and 50 001. */
export function sealedSIEFinalOrdinals(manifest: Record<string, unknown>): SIEFinalOrdinals {
  const sealed = manifest.finalOrdinals as { openingBalance?: unknown; adjustment?: unknown } | undefined
  return Number.isInteger(sealed?.openingBalance) && Number.isInteger(sealed?.adjustment)
    ? { openingBalance: sealed!.openingBalance as number, adjustment: sealed!.adjustment as number }
    : LEGACY_FINAL_ORDINALS
}

export type SIEJobState =
  | 'queued' | 'preparing' | 'running' | 'reconciling' | 'paused'
  | 'finalizing' | 'completed' | 'undoing' | 'undone' | 'failed'

export type SIEJobPhase = 'prepare' | 'vouchers' | 'finalize' | 'undo'

export interface SIEPreparedLine {
  account_number: string
  account_id: string | null
  debit_amount: number
  credit_amount: number
  currency: string
  line_description: string | null
  sort_order: number
  dimensions: Record<string, string>
}

export interface SIEPreparedEntry {
  sourceId: string
  sourceOrdinal: number
  series: string
  date: string
  description: string
  sourceSeries: string | null
  sourceNumber: number | null
  sourceType: 'import' | 'opening_balance'
  sieImportId: string
  /**
   * Source vouchers of this series the import skipped right before this one
   * (crm#1599): write_sie_job_entries holds that many numbers before it and
   * records them as one explained gap. Left out of source_content_hash: it
   * places the voucher, it is not its content.
   */
  numberGap?: { count: number; explanation: string }
  lines: SIEPreparedLine[]
  corrections?: {
    struck: unknown[]
    added: unknown[]
    signature: string | null
  }
}

export interface SIEChunkResult {
  inserted_entries: Array<{
    id: string
    sourceId: string
    sourceOrdinal: number
    series: string
    voucherNumber: number
    sourceType: 'import' | 'opening_balance'
  }>
}

export interface SIEJob {
  id: string
  company_id: string
  user_id: string
  execution_actor_id: string | null
  fiscal_period_id: string
  fiscal_year_start: string
  fiscal_year_end: string
  job_state: SIEJobState
  job_kind?: 'import' | 'duplicate_repair'
  job_phase: SIEJobPhase
  job_attempt: number
  worker_id: string | null
  lease_until: string | null
  chunks_total: number
  chunks_done: number
  transactions_count: number
  next_attempt_at: string | null
  consecutive_failures: number
  error_message: string | null
  manifest: Record<string, unknown>
  job_result: Record<string, unknown> | null
  supersedes_import_id: string | null
  /** The import this batch appends to (issue #108); null for every import. */
  base_import_id?: string | null
  file_storage_path: string
  file_hash: string
  prepared_through: number
  audit_mode: 'full' | 'chunk'
}

export function isSIEJobUnresolved(state: SIEJobState): boolean {
  return !['completed', 'undone', 'failed'].includes(state)
}

/** Identity is independent of object insertion order, never of array order. */
export function canonicalJSON(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    const encoded = JSON.stringify(value)
    if (encoded === undefined) throw new Error('SIE payload contains an undefined value')
    return encoded
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(',')}]`
  return `{${Object.entries(value).filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b, 'en'))
    .map(([key, v]) => `${JSON.stringify(key)}:${canonicalJSON(v)}`).join(',')}}`
}

export function hashSIEPayload(value: unknown): string {
  return createHash('sha256').update(canonicalJSON(value)).digest('hex')
}

/**
 * One entry is larger than a chunk may carry (2 000 lines or 1 MB with the
 * array brackets): chunkSIEEntries refuses it, failing the whole job.
 */
export function exceedsSIEEntryLimits(
  entry: { lines: unknown[] },
  entryBytes: number = Buffer.byteLength(JSON.stringify(entry), 'utf8'),
): boolean {
  return entry.lines.length > SIE_LIMITS.chunkLines || entryBytes + 2 > SIE_LIMITS.chunkBytes
}

/** Include the brackets and separators in the actual UTF-8 request budget. */
export function* chunkSIEEntries<T extends { sourceId: string; lines: unknown[] }>(
  entries: Iterable<T>,
): Generator<T[]> {
  let chunk: T[] = []
  let bytes = 2
  let lines = 0
  for (const entry of entries) {
    const entryBytes = Buffer.byteLength(JSON.stringify(entry), 'utf8')
    if (exceedsSIEEntryLimits(entry, entryBytes)) {
      throw new Error(`SIE-verifikation ${entry.sourceId} överskrider gränsen på 2 000 rader eller 1 MB.`)
    }
    const separator = chunk.length > 0 ? 1 : 0
    if (chunk.length && (chunk.length >= SIE_LIMITS.chunkVouchers ||
      lines + entry.lines.length > SIE_LIMITS.chunkLines ||
      bytes + separator + entryBytes > SIE_LIMITS.chunkBytes)) {
      yield chunk
      chunk = []
      bytes = 2
      lines = 0
    }
    bytes += (chunk.length ? 1 : 0) + entryBytes
    lines += entry.lines.length
    chunk.push(entry)
  }
  if (chunk.length) yield chunk
}

/** A response loss preserves the phase, including a partially completed undo. */
export function resumedSIEState(phase: SIEJobPhase, done: number, total: number): SIEJobState {
  if (phase === 'undo') return 'undoing'
  if (phase === 'prepare') return 'preparing'
  if (phase === 'finalize' || done === total) return 'finalizing'
  return 'running'
}

export function sieRetryDelaySeconds(failures: number): number {
  return Math.min(15 * 2 ** Math.min(Math.max(failures - 1, 0), 8), 3600)
}
