/** Serializable contract shared by the provider worker and the migration wizard. */
export const MIGRATION_RESOURCES = ['customers', 'suppliers', 'salesInvoices', 'supplierInvoices'] as const
export type MigrationResource = typeof MIGRATION_RESOURCES[number]
export type MigrationJobState = 'queued' | 'running' | 'retry_wait' | 'needs_attention' | 'completed'
export type MigrationJobPhase = 'discover' | 'import' | 'link' | 'reconcile' | 'settle' | 'completed'

export interface ProviderMigrationJob {
  id: string
  company_id: string
  user_id: string
  consent_id: string | null
  provider: string
  account_key: string
  resources: MigrationResource[]
  resource_index: number
  next_page: number
  phase: MigrationJobPhase
  state: MigrationJobState
  attempt: number
  worker_id: string | null
  lease_until: string | null
  next_attempt_at: string | null
  failures: number
  error_code: string | null
  fiscal_year_scope: { start: string; end: string } | null
  created_at: string
  updated_at: string
}

export interface MigrationResourceCounts {
  resource: MigrationResource
  total: number
  imported: number
  completed: number
  skipped: number
  needs_attention: number
  pending: number
  fx_unresolved: number
  vat_unresolved: number
  /**
   * Credit notes without a credited_invoice_id once their link phase has run:
   * the provider sent no reference, or named an invoice the import could not
   * resolve. Derived from the invoice row, not from a flag
   * (migration 20260920190600).
   */
  credit_notes_unlinked: number
  /** Credit notes paired with the invoice they credit. Absent before migration 20260920190600. */
  credit_notes_linked?: number
}

export interface ProviderMigrationStatus {
  job: ProviderMigrationJob
  counts: MigrationResourceCounts[]
  issues: { id: string; resource: MigrationResource; source_id: string; error_code: string }[]
}

export function migrationProgress(status: ProviderMigrationStatus): number {
  if (status.job.state === 'completed') return 100
  const total = status.counts.reduce((n, row) => n + row.total, 0)
  const done = status.counts.reduce((n, row) => n + row.completed + row.skipped, 0)
  // Discovery has an unknown denominator. Persisted counts, never elapsed time,
  // determine the rest; final checks cannot appear as a completed import.
  if (status.job.phase === 'discover' || total === 0) return 0
  return Math.min(99, Math.floor(done / total * 100))
}

export function migrationRetrySeconds(failures: number): number {
  return Math.min(900, 15 * 2 ** Math.min(Math.max(0, failures - 1), 6))
}

/** Group internal failure codes into actionable, translated messages. */
export function migrationIssueKind(code: string | null): 'connection' | 'access' | 'review' | 'lines' | 'size' | 'exists' | 'retry' {
  if (code === 'PROVIDER_AUTH_EXPIRED') return 'connection'
  // A record with the same number already exists and differs. Resuming
  // repeats the same outcome, so never suggest a retry (23505 = unique_violation).
  if (code === 'MIGRATION_INVOICE_NUMBER_TAKEN' || code === '23505') return 'exists'
  if (code?.includes('LICENSE') || code?.includes('MODULE') || code === 'MIGRATION_WRITE_FORBIDDEN') return 'access'
  if (code?.includes('AMBIGUOUS') || code?.includes('REVIEW') || code?.includes('CHANGED')) return 'review'
  if (code?.includes('ROWS') || code?.includes('LINES')) return 'lines'
  if (code?.includes('TOO_LARGE')) return 'size'
  return 'retry'
}
