import type { ProviderRefusalReason } from './with-provider-call'

/** Serializable contract shared by the provider worker and the migration wizard. */
export const MIGRATION_RESOURCES = ['customers', 'suppliers', 'salesInvoices', 'supplierInvoices'] as const
export type MigrationResource = typeof MIGRATION_RESOURCES[number]
export type MigrationJobState = 'queued' | 'running' | 'retry_wait' | 'needs_attention' | 'completed'
export type MigrationJobPhase = 'discover' | 'import' | 'link' | 'reconcile' | 'settle' | 'completed'

/**
 * Which invoices a job imports (migration_jobs.fiscal_year_scope). start and
 * end are the migrated fiscal years, which bound the paid invoices a job takes
 * in; a scope built from SIE imports without bounds has none.
 * allSupplierInvoices is the member's request, for this sync, for Fortnox's
 * paid supplier invoices too (crm#1114): Fortnox is otherwise listed unpaid
 * only, and every other provider always lists the whole register.
 */
export interface MigrationJobScope {
  start?: string
  end?: string
  allSupplierInvoices?: boolean
}

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
  fiscal_year_scope: MigrationJobScope | null
  /**
   * When a member accepted the finished job with the records that still need
   * attention (accept_provider_migration_job). Those records keep their
   * state and code, so the result lists them. Absent before migration
   * 20261005193000.
   */
  review_accepted_at?: string | null
  review_accepted_by?: string | null
  /**
   * Registers the provider refused for this job, and why (migration
   * 20261005193815). The worker skips such a register and imports the rest;
   * the wizard names it with its remedy. Absent before that migration.
   */
  refused_resources?: Partial<Record<MigrationResource, ProviderRefusalReason>>
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

/** The phase a record stopped in. 'import' means it is not in Accounted at all. */
export type MigrationIssuePhase = 'import' | 'link' | 'reconcile' | 'settle'

/**
 * How the user recognises a record: read from the record's own source
 * snapshot or receipt when the status is read, never stored separately.
 */
export interface MigrationIssueLabel {
  /** Invoice number, or the customer or supplier number. */
  number: string | null
  /** Invoice date, ISO day. */
  date: string | null
  /** Invoice total in its own currency. */
  amount: number | null
  currency: string | null
  /** Customer or supplier name. */
  party: string | null
}

/**
 * What a review outcome found, as the worker stored it with the record
 * (receipt.review, migration 20261005193000). Older records carry none.
 */
export interface MigrationIssueReview {
  kind: 'registration' | 'payment'
  /** Registration: 'ambiguous' or 'amountMismatch'. */
  outcome?: string | null
  /** Payment: the reconciliation's review reason. */
  reason?: string | null
  /** Registration amountMismatch: the voucher's AR/AP amount and the invoice's SEK total. */
  bookedSek?: number | null
  expectedSek?: number | null
}

/** One record that needs attention, with what the review needs to explain it. */
export interface ProviderMigrationIssue {
  id: string
  resource: MigrationResource
  source_id: string
  error_code: string
  error_phase: MigrationIssuePhase | null
  /** The record is in Accounted: only its voucher link or payment check stopped. */
  imported: boolean
  /**
   * The record's own row in Accounted when it is there (an invoice, a
   * supplier invoice, a customer or a supplier): what the review opens.
   */
  target_id: string | null
  /** The last retry ended with this same code: retrying again alone changes nothing. */
  repeated: boolean
  label: MigrationIssueLabel | null
  /** The booking voucher the provider named, for a voucher-link review. */
  voucher: { series: string | null; number: number } | null
  review: MigrationIssueReview | null
}

/** Whole-job facts for the review: what the user can do next. */
export interface ProviderMigrationReview {
  /** Records that need attention in the whole job. */
  total: number
  /** Every record has an outcome and no worker holds the job: it can be accepted. */
  acceptable: boolean
  /**
   * The last retry changed nothing: every record that needs attention failed
   * again with the same code, and none of them failed for a passing reason.
   * A further retry would loop, so the wizard offers acceptance instead.
   */
  unchanged: boolean
  /** Fewer records are listed than need attention. */
  truncated: boolean
}

export interface ProviderMigrationStatus {
  job: ProviderMigrationJob
  counts: MigrationResourceCounts[]
  issues: ProviderMigrationIssue[]
  review: ProviderMigrationReview
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
export function migrationIssueKind(code: string | null): 'connection' | 'access' | 'refused' | 'review' | 'lines' | 'size' | 'exists' | 'retry' {
  if (code === 'PROVIDER_AUTH_EXPIRED') return 'connection'
  // A job parked on a refused register before the worker learned to skip one
  // (migration 20261005193815). Resuming now skips that register, so say so
  // instead of promising that a retry fixes the record.
  if (code === 'PROVIDER_RESOURCE_FORBIDDEN') return 'refused'
  // A record with the same number already exists and differs. Resuming
  // repeats the same outcome, so never suggest a retry (23505 = unique_violation).
  if (code === 'MIGRATION_INVOICE_NUMBER_TAKEN' || code === '23505') return 'exists'
  if (code?.includes('LICENSE') || code?.includes('MODULE') || code === 'MIGRATION_WRITE_FORBIDDEN') return 'access'
  if (code?.includes('AMBIGUOUS') || code?.includes('REVIEW') || code?.includes('CHANGED')) return 'review'
  if (code?.includes('ROWS') || code?.includes('LINES')) return 'lines'
  if (code?.includes('TOO_LARGE')) return 'size'
  return 'retry'
}

/**
 * Record-level codes a plain retry can clear on its own: a provider detail
 * fetch that ran out of attempts, or a write that lost to a concurrent one
 * (serialization failure, deadlock, lock or statement timeout). Every other
 * code is a verdict on the record's data, and the same data gets the same
 * verdict on every retry.
 */
const TRANSIENT_ISSUE_CODES = new Set([
  'MIGRATION_DETAIL_RETRY', 'MIGRATION_RETRY', 'MIGRATION_LINK_RESULT_MISSING',
  '40001', '40P01', '55P03', '57014',
])

export function isTransientIssueCode(code: string | null | undefined): boolean {
  return !!code && TRANSIENT_ISSUE_CODES.has(code)
}

/** The page of each register's records in Accounted. */
const ISSUE_PAGES: Record<MigrationResource, string> = {
  customers: '/customers',
  suppliers: '/suppliers',
  salesInvoices: '/invoices',
  supplierInvoices: '/supplier-invoices',
}

/**
 * Where a record that needs attention opens in Accounted, or null for one
 * that never reached it. The invoice's own page is where a payment is linked
 * to its verifikat or marked by hand; the review only names what stopped.
 */
export function migrationIssueHref(issue: Pick<ProviderMigrationIssue, 'resource' | 'target_id'>): string | null {
  return issue.target_id ? `${ISSUE_PAGES[issue.resource]}/${encodeURIComponent(issue.target_id)}` : null
}

/** Why one record needs attention, in the terms the review explains it in. */
export type MigrationIssueReason =
  | 'number_taken'
  | 'number_missing'
  | 'missing_value'
  | 'invalid_value'
  | 'ambiguous_match'
  | 'party_ambiguous'
  | 'party_changed'
  | 'source_id_missing'
  | 'changed'
  | 'rows_mismatch'
  | 'lines_missing'
  | 'too_large'
  | 'temporary'
  | 'registration_amount'
  | 'registration_ambiguous'
  | 'registration_review'
  | 'voucher_unavailable'
  | 'payment_review'
  | 'source_check'
  | 'connection'
  | 'unknown'

/**
 * Map a record's stored code (and the review detail stored with it) to the
 * reason the wizard explains. Codes are what the worker and its RPCs write
 * into migration_job_chunks.error_code: a named MIGRATION_ code, a named
 * provider code, or a bare SQLSTATE when Postgres refused the row.
 */
export function migrationIssueReason(issue: Pick<ProviderMigrationIssue, 'error_code' | 'review'>): MigrationIssueReason {
  const code = issue.error_code
  if (isTransientIssueCode(code)) return 'temporary'
  switch (code) {
    case 'MIGRATION_INVOICE_NUMBER_TAKEN':
    case '23505':
      return 'number_taken'
    // No longer raised: a supplier invoice without a number is stored with a
    // NULL number (20261005225009). Kept for records that still carry it.
    case 'MIGRATION_SUPPLIER_INVOICE_NUMBER_MISSING':
      return 'number_missing'
    // A NOT NULL column the source left empty (until 2026-10 the most common
    // one: a supplier invoice without a number) and other refused values.
    case '23502':
      return 'missing_value'
    case '23514':
    case '22001':
    case '22003':
    case '22007':
    case '22008':
    case '22P02':
      return 'invalid_value'
    case 'MIGRATION_INVOICE_AMBIGUOUS':
      return 'ambiguous_match'
    case 'MIGRATION_PARTY_AMBIGUOUS':
      return 'party_ambiguous'
    case 'MIGRATION_PARTY_CHANGED':
      return 'party_changed'
    case 'MIGRATION_PARTY_ID_MISSING':
    case 'MIGRATION_SOURCE_ID_MISSING':
      return 'source_id_missing'
    case 'MIGRATION_INVOICE_CHANGED':
    case 'MIGRATION_SOURCE_ID_CHANGED':
      return 'changed'
    case 'MIGRATION_ROWS_MISMATCH':
      return 'rows_mismatch'
    case 'MIGRATION_SOURCE_LINES_MISSING':
      return 'lines_missing'
    case 'MIGRATION_INVOICE_TOO_LARGE':
      return 'too_large'
    case 'MIGRATION_REGISTRATION_REVIEW':
      if (issue.review?.outcome === 'amountMismatch') return 'registration_amount'
      if (issue.review?.outcome === 'ambiguous') return 'registration_ambiguous'
      return 'registration_review'
    case 'MIGRATION_REGISTRATION_AMBIGUOUS':
      return 'registration_ambiguous'
    case 'MIGRATION_VOUCHER_UNAVAILABLE':
      return 'voucher_unavailable'
    case 'MIGRATION_PAYMENT_REVIEW':
    case 'MIGRATION_PAYMENT_AMBIGUOUS':
    case 'MIGRATION_PAYMENT_REJECTED':
      return 'payment_review'
    case 'MIGRATION_BOKIO_COMPLETION_REJECTED':
      return 'source_check'
    case 'PROVIDER_AUTH_EXPIRED':
      return 'connection'
  }
  if (code.startsWith('BOKIO_')) return 'source_check'
  return 'unknown'
}

/**
 * Translation key (extensions namespace) for what to do about a refused
 * register. A missing licence names the module: Fortnox requires Kundfaktura
 * or Order for customers and customer invoices, Bokföring for suppliers and
 * supplier invoices. A missing permission takes `{provider}`.
 */
export function migrationRefusalMessageKey(resource: MigrationResource, reason: ProviderRefusalReason): string {
  if (reason === 'permission') return 'ext_arcim_job_refused_permission'
  return resource === 'customers' || resource === 'salesInvoices'
    ? 'ext_arcim_job_refused_license_sales'
    : 'ext_arcim_job_refused_license_purchase'
}

/**
 * The job's refused registers, grouped by remedy in register order, so
 * customers and customer invoices refused for the same missing licence read
 * as one line. Empty for a job with none, and for one stored before
 * refused_resources existed.
 */
export function migrationRefusals(job: Pick<ProviderMigrationJob, 'refused_resources'>): { messageKey: string; resources: MigrationResource[] }[] {
  const groups = new Map<string, MigrationResource[]>()
  for (const resource of MIGRATION_RESOURCES) {
    const reason = job.refused_resources?.[resource]
    if (reason !== 'license' && reason !== 'permission') continue
    const key = migrationRefusalMessageKey(resource, reason)
    groups.set(key, [...(groups.get(key) ?? []), resource])
  }
  return [...groups].map(([messageKey, resources]) => ({ messageKey, resources }))
}
