/**
 * Types for the provider migration extension.
 *
 * DTO types are now imported from the canonical source at lib/providers/dto.ts
 * instead of being duplicated here.
 */

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

export type ArcimProvider = 'fortnox' | 'visma' | 'briox' | 'bokio' | 'bjornlunden'

export const ARCIM_PROVIDERS: { id: ArcimProvider; name: string; authType: 'oauth' | 'token' }[] = [
  { id: 'fortnox', name: 'Fortnox', authType: 'oauth' },
  { id: 'visma', name: 'Visma eEkonomi', authType: 'oauth' },
  { id: 'bokio', name: 'Bokio', authType: 'token' },
  { id: 'bjornlunden', name: 'Björn Lundén', authType: 'token' },
  { id: 'briox', name: 'Briox', authType: 'token' },
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

export interface MigrationResults {
  companyInfo?: { imported: boolean }
  customers?: { total: number; imported: number; skipped: number; skipReasons?: SkipReasons }
  suppliers?: { total: number; imported: number; skipped: number; skipReasons?: SkipReasons }
  salesInvoices?: { total: number; imported: number; skipped: number; skipReasons?: SkipReasons }
  supplierInvoices?: { total: number; imported: number; skipped: number; skipReasons?: SkipReasons }
  /**
   * Auto-reconciliation of imported supplier invoices to the GL payment
   * vouchers that the separate SIE import already posted. `autoLinked` invoices
   * are now marked paid; `ambiguous` need manual review; `unmatched` had no
   * candidate voucher.
   */
  reconciliation?: { scanned: number; autoLinked: number; ambiguous: number; unmatched: number }
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
