/** Serializable contract shared by the provider worker and the migration wizard. */
export const MIGRATION_RESOURCES = ['customers', 'suppliers', 'salesInvoices', 'supplierInvoices'] as const
export type MigrationResource = typeof MIGRATION_RESOURCES[number]
export type MigrationJobState = 'queued' | 'running' | 'retry_wait' | 'needs_attention' | 'completed'
export type MigrationJobPhase = 'discover' | 'import' | 'link' | 'reconcile' | 'settle' | 'completed'

export interface ProviderMigrationJob {
  review_deferred_at?: string | null
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
  fiscal_year_scope: { start: string; end: string; periods?: {start:string;end:string}[] } | null
  created_at: string
  updated_at: string
}

export interface PendingImportPayables {
  count:number
  items:{id:string;invoiceNumber:string;dueDate:string;remaining:number;currency:string}[]
}
export interface MigrationResourceCounts {
  skipReasons?: {historicalReceivable?:number;outsideFiscalYears?:number;inactive?:number;zeroTotal?:number;creditNoteInOldShape?:number}

  unchanged?: number
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
  paymentsAwaitingDueDate?: PendingImportPayables
  job: ProviderMigrationJob
  counts: MigrationResourceCounts[]
  changes?: {id:string;resource:MigrationResource;source_id:string;targetId:string;label:string;kind:'new'|'changed'}[]
  issues: { id: string; resource: MigrationResource; source_id: string; error_code: string;
    invoiceNumber?: string; invoiceDate?: string; amount?: number; currency?: string;
    targetId?: string | null; errorPhase?: string | null }[]
}

export function migrationProgress(status: ProviderMigrationStatus): number {
  if (status.job.state === 'completed') return 100
  const total = status.counts.reduce((n, row) => n + row.total, 0)
  const done = status.counts.reduce((n, row) => n + row.completed + row.skipped + (row.unchanged ?? 0), 0)
  // Discovery has an unknown denominator. Persisted counts, never elapsed time,
  // determine the rest; final checks cannot appear as a completed import.
  if (status.job.phase === 'discover' || total === 0) return 0
  return Math.min(99, Math.floor(done / total * 100))
}

export function migrationRetrySeconds(failures: number): number {
  return Math.min(900, 15 * 2 ** Math.min(Math.max(0, failures - 1), 6))
}

/** Group internal failure codes into actionable, translated messages. */
export function migrationIssueKind(code: string | null): 'connection' | 'access' | 'review' | 'lines' | 'size' | 'exists' | 'configuration' | 'missing' | 'registration' | 'payment' | 'overdue' | 'source_changed' | 'retry' {
  if (code === 'MIGRATION_SOURCE_CHANGED') return 'source_changed'
  if (code === 'MIGRATION_REGISTRATION_REVIEW') return 'registration'
  if (code === 'MIGRATION_UNPAID_OVERDUE') return 'overdue'
  if (code === 'MIGRATION_PAYMENT_REVIEW') return 'payment'
  if (code === '23502' || code === 'MIGRATION_INVOICE_NUMBER_REQUIRED') return 'missing'
  if (code === 'PERSONNUMMER_ENCRYPTION_NOT_CONFIGURED') return 'configuration'
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
