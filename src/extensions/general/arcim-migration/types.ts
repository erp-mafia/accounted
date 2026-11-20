/**
 * Types for the provider migration extension.
 *
 * DTO types are now imported from the canonical source at lib/providers/dto.ts
 * instead of being duplicated here.
 */

import type { HydrationReport } from '@/lib/providers/provider-data-fetcher'
import type { ProviderName } from '@/lib/providers/types'
import { MIGRATION_PROVIDERS } from '@/lib/providers/catalog'

// Re-export the canonical DTOs used by arcim-client (entity-mapper imports
// its DTOs straight from '@/lib/providers/dto')
export type {
  PaginatedResponse,
  CompanyInformationDto,
  CustomerDto,
  SupplierDto,
  SalesInvoiceDto,
  SupplierInvoiceDto,
} from '@/lib/providers/dto'


// ── Supported providers ─────────────────────────────────────────────

// The providers and their catalog (name, auth, sieViaApi) are core's:
// lib/providers/catalog.ts, one list for the workspace, this extension and
// the MCP connect card.
export type ArcimProvider = ProviderName
export const ARCIM_PROVIDERS = MIGRATION_PROVIDERS

// ── Migration state ─────────────────────────────────────────────────

export interface MigrationProgress {
  status: 'idle' | 'connecting' | 'fetching' | 'importing' | 'completed' | 'failed'
  currentStep?: string
  progress: number // 0-100
  results?: MigrationResults
  error?: string
}

export interface SkipReasons {
  duplicate?: number
  inactive?: number
  failed?: number
  noMatch?: number
  /**
   * Invoices outside the fiscal years the SIE import covers: issued and
   * settled before them, or issued after them (crm#1660). Never fetched in
   * detail, never inserted: their ledger is not here.
   */
  outsideFiscalYears?: number
  /**
   * Supplier invoices the provider returned with no amount and no line items.
   * Bokio answers that way for invoices older than the register its API
   * exposes; importing them wrote rows whose zero balance then read as a
   * settled 0 kr payable. An amount-less record is not a 0 kr invoice, so it
   * is declined and counted rather than imported.
   */
  zeroTotal?: number
  /**
   * Skipped records whose reason the result does not carry. The provider
   * migration job reports state 'skipped' per resource without grouping it by
   * the chunk's receipt reason (provider_migration_counts), so the wizard can
   * count them but not say which reason each had (agent feedback seq 939430).
   */
  reasonUnknown?: number
}

/**
 * Asset-step skip reasons: `unsupported` counts source assets the mapping
 * cannot represent (no positive acquisition value, no acquisition date).
 * One shared contract for the migration producer and the wizard consumer.
 */
export interface AssetSkipReasons extends SkipReasons {
  unsupported?: number
  /**
   * Assets imported on their category default accounts because the source
   * type could not be resolved, or resolved ambiguously. Not a skip: the
   * asset is in the register, but on accounts the source did not confirm, so
   * the register may not tie to the ledger until someone looks.
   */
  typeUnresolved?: number
}

/**
 * A migration step that failed against the provider API, surfaced to the user
 * instead of being swallowed into a "successful" empty sync. `message` is the
 * user-facing Swedish text (mapped from the structured error registry when the
 * failure classifies, otherwise a generic sentence with the provider's reply).
 */
export interface MigrationStepError {
  step: 'companyInfo' | 'customers' | 'suppliers' | 'salesInvoices' | 'supplierInvoices' | 'assets' | 'registrationLinks' | 'reconciliation'
  /** Structured code when the failure classifies (e.g. PROVIDER_API_MODULE_INACTIVE), else null. */
  code: string | null
  message: string
}

/**
 * Foreign-currency invoices that were imported but whose SEK value could not
 * be established (currency outside Riksbanken's series, or no observation for
 * the invoice's own date). They are counted in `imported`: the record itself is
 * räkenskapsinformation and dropping it would lose data. But they carry
 * exchange_rate = null, so every booking path refuses them until a rate is
 * set, and the migration reports them here instead of passing them off as
 * ordinary imports. Per-invoice detail goes to the server log.
 */
/**
 * Per-step outcome for the two invoice registers.
 *
 * `vatUnresolved` counts invoices whose provider payload established no VAT at
 * all; they are imported with the gross as subtotal and a null rate, which is
 * the only honest reading of "the source did not say". `hydration` reports how
 * many detail payloads were fetched, and how many the time budget could not
 * reach, so a partially hydrated run is visible rather than looking complete.
 */
export interface InvoiceStepResult {
  total: number
  imported: number
  skipped: number
  skipReasons?: SkipReasons
  fxUnresolved?: number
  vatUnresolved?: number
  /**
   * Supplier invoices whose provider rows did not add up to the invoice, net
   * or VAT off by more than 1 kr. They are imported without rows, because
   * every booking path would debit the rows as they stand.
   */
  rowsMismatch?: number
  /**
   * Supplier invoices with a provider row that named no account. They are
   * imported without rows: no account is guessed for a row.
   */
  rowsUnaccounted?: number
  /**
   * Credit notes imported without a credited_invoice_id: the provider named
   * no credited invoice, or the one it named is not among the company's
   * invoices. The amounts are reversed and the record is complete, but the
   * pairing is missing and the user is told so.
   */
  creditNotesUnlinked?: number
  /** Credit notes paired with the invoice they credit during this run. */
  creditNotesLinked?: number
  hydration?: HydrationReport
  errorSample?: string
  /**
   * The run listed Fortnox's paid supplier invoices too, on the member's
   * request, so the "unpaid only" note does not apply (crm#1114).
   */
  paidIncluded?: boolean
}

export interface MigrationResults {
  companyInfo?: { imported: boolean }
  customers?: { total: number; imported: number; updated?: number; skipped: number; skipReasons?: SkipReasons; errorSample?: string }
  suppliers?: { total: number; imported: number; skipped: number; skipReasons?: SkipReasons; errorSample?: string }
  salesInvoices?: InvoiceStepResult
  supplierInvoices?: InvoiceStepResult
  /**
   * Fortnox anläggningsregister → local asset register. Creates register
   * rows only, never journal entries (the values arrived via SIE).
   * `scopesMissing` marks the whole step as skipped because the consent
   * lacks the Fortnox assets scope (or the licence behind it).
   */
  assets?: {
    total: number
    imported: number
    skipped: number
    skipReasons?: AssetSkipReasons
    errorSample?: string
    scopesMissing?: boolean
  }

  /**
   * Imported invoices linked to the SIE-imported verifikat that BOOKED them
   * (the registration voucher the provider named on the invoice). Only exact,
   * amount-corroborated matches are written; the other buckets stay unlinked
   * and explain why. `refNotFetched` counts invoices whose provider detail
   * payload (where Fortnox carries the ref) was never fetched, so nothing is
   * known either way. See lib/invoices/link-migrated-registration-vouchers.ts.
   */
  registrationLinks?: {
    scanned: number
    linked: number
    noRef: number
    refNotFetched: number
    unresolved: number
    ambiguous: number
    amountMismatch: number
    alreadyLinked: number
  }
  /**
   * Auto-reconciliation of imported supplier invoices to the GL payment
   * vouchers that the separate SIE import already posted. `autoLinked` invoices
   * are now marked paid; `ambiguous` need manual review; `unmatched` had no
   * candidate voucher.
   */
  reconciliation?: { scanned: number; autoLinked: number; ambiguous: number; unmatched: number }
  /**
   * Steps that failed against the provider API. Present (non-empty) whenever a
   * step's fetch or import threw: the result step must render these instead of
   * implying the sync succeeded with zero rows.
   */
  stepErrors?: MigrationStepError[]
}

// ── Consent flow ────────────────────────────────────────────────────

export interface ConsentRecord {
  id: string
  name: string
  provider: ArcimProvider
  status: 0 | 1 | 2 | 3 // Created | Accepted | Revoked | Inactive
  orgNumber?: string
  companyName?: string
  etag?: string
  createdAt?: string
  updatedAt?: string
}

export interface OtcResponse {
  code: string
  consentId: string
  expiresAt: string
}
