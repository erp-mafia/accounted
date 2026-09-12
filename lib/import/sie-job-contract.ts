import { createHash } from 'node:crypto'

export const SIE_JOB_VERSION = 1
export const SIE_LIMITS = Object.freeze({
  fileBytes: 50 * 1024 * 1024,
  fileVouchers: 50_000,
  chunkVouchers: 200,
  chunkLines: 2_000,
  chunkBytes: 1024 * 1024,
})

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

/** Include the brackets and separators in the actual UTF-8 request budget. */
export function* chunkSIEEntries<T extends { sourceId: string; lines: unknown[] }>(
  entries: Iterable<T>,
): Generator<T[]> {
  let chunk: T[] = []
  let bytes = 2
  let lines = 0
  for (const entry of entries) {
    const entryBytes = Buffer.byteLength(JSON.stringify(entry), 'utf8')
    if (entry.lines.length > SIE_LIMITS.chunkLines || entryBytes + 2 > SIE_LIMITS.chunkBytes) {
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
