/**
 * Types for the provider migration extension.
 *
 * DTO types are now imported from the canonical source at lib/providers/dto.ts
 * instead of being duplicated here.
 */

import type { HydrationReport } from '@/lib/providers/provider-data-fetcher'

// Re-export canonical DTOs used by entity-mapper and migration-orchestrator
export type {
  AmountType,
  PostalAddress,
  Contact,
  PartyIdentification,
  PartyLegalEntity,
  PartyDto,
  PaginatedResponse,
  TaxSubtotalDto,
  TaxTotalDto,
  LegalMonetaryTotalDto,
  PaymentStatusDto,
  CompanyInformationDto,
  CustomerDto,
  SupplierDto,
  InvoiceStatusCode,
  SalesInvoiceLineDto,
  SalesInvoiceDto,
  SupplierInvoiceLineDto,
  SupplierInvoiceDto,
} from '@/lib/providers/dto'

export type { CustomerType as ArcimCustomerType } from '@/lib/providers/dto'

// ── Supported providers ─────────────────────────────────────────────

export type ArcimProvider = 'fortnox' | 'visma' | 'briox' | 'bokio' | 'bjornlunden' | 'wint'

// `sieViaApi`: the provider serves its general ledger as SIE over the API, so
// the wizard imports bookkeeping automatically: no manual SIE upload needed.
// Mirrored in ArcimMigrationWorkspace.tsx (deliberate duplication: core code
// must not import from @/extensions/: CI enforces it). Keep both in sync.
export const ARCIM_PROVIDERS: { id: ArcimProvider; name: string; authType: 'oauth' | 'token'; sieViaApi: boolean }[] = [
  { id: 'fortnox', name: 'Fortnox', authType: 'oauth', sieViaApi: true },
  { id: 'visma', name: 'Visma eEkonomi', authType: 'oauth', sieViaApi: false },
  { id: 'bokio', name: 'Bokio', authType: 'token', sieViaApi: false },
  { id: 'bjornlunden', name: 'Björn Lundén', authType: 'token', sieViaApi: true },
  { id: 'briox', name: 'Briox', authType: 'token', sieViaApi: true },
  // WINT's "token" is the user's WINT login exchanged once for a JWT pair
  // (WINT has no API keys or OAuth). Gated behind WINT_MIGRATION_ENABLED in
  // index.ts until verified against a live account.
  { id: 'wint', name: 'WINT', authType: 'token', sieViaApi: true },
]

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
}

/**
 * A migration step that failed against the provider API, surfaced to the user
 * instead of being swallowed into a "successful" empty sync. `message` is the
 * user-facing Swedish text (mapped from the structured error registry when the
 * failure classifies, otherwise a generic sentence with the provider's reply).
 */
export interface MigrationStepError {
  step: 'companyInfo' | 'customers' | 'suppliers' | 'salesInvoices' | 'supplierInvoices' | 'reconciliation'
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
  hydration?: HydrationReport
  errorSample?: string
}

export interface MigrationResults {
  companyInfo?: { imported: boolean }
  customers?: { total: number; imported: number; updated?: number; skipped: number; skipReasons?: SkipReasons; errorSample?: string }
  suppliers?: { total: number; imported: number; skipped: number; skipReasons?: SkipReasons; errorSample?: string }
  salesInvoices?: InvoiceStepResult
  supplierInvoices?: InvoiceStepResult
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
