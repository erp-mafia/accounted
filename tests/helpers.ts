/**
 * Shared test helpers — mock factories and fixture builders
 */
import { vi } from 'vitest'
import type {
  Receipt,
  Transaction,
  FiscalPeriod,
  JournalEntry,
  JournalEntryLine,
  DocumentAttachment,
  TaxCode,
  Invoice,
  InvoicePayment,
  Customer,
  Supplier,
  SupplierInvoice,
  CompanySettings,
  InvoiceInboxItem,
  CategorizationTemplate,
  Company,
  CompanyMember,
} from '@/types'
import type { SIEVoucher, SIETransactionLine } from '@/lib/import/types'

// ============================================================
// Chainable Supabase mock
// ============================================================

/**
 * Creates a deeply chainable mock that mirrors the Supabase client API.
 *
 * Usage:
 *   const { supabase, mockResult } = createMockSupabase()
 *   mockResult({ data: [...], error: null })
 *   const { data } = await supabase.from('table').select('*').eq('id', '1').single()
 */
export function createMockSupabase() {
  // The value that terminal calls (.single(), .maybeSingle(), or the chain itself) resolve to
  let pendingResult: { data: unknown; error: unknown; count?: number | null } = {
    data: null,
    error: null,
  }

  const mockResult = (result: {
    data?: unknown
    error?: unknown
    count?: number | null
  }) => {
    pendingResult = {
      data: result.data ?? null,
      error: result.error ?? null,
      count: result.count ?? null,
    }
  }

  // Build a proxy that returns itself for any chained method call,
  // and resolves to pendingResult when awaited.
  const buildChain = (): unknown => {
    const handler: ProxyHandler<object> = {
      get(_target, prop) {
        if (prop === 'then') {
          // Make the chain thenable — resolves to pendingResult
          return (resolve: (v: unknown) => void) => resolve(pendingResult)
        }
        // Return a function that returns a new chain
        return (..._args: unknown[]) => buildChain()
      },
    }
    return new Proxy({}, handler)
  }

  // Storage mock
  const storageMock = {
    from: vi.fn().mockReturnValue({
      upload: vi.fn().mockResolvedValue({ data: {}, error: null }),
      download: vi.fn().mockResolvedValue({
        data: new Blob(['test']),
        error: null,
      }),
      remove: vi.fn().mockResolvedValue({ data: [], error: null }),
      getPublicUrl: vi.fn().mockReturnValue({
        data: { publicUrl: 'https://example.com/file.jpg' },
      }),
    }),
  }

  const supabase = {
    from: vi.fn().mockImplementation(() => buildChain()),
    rpc: vi.fn().mockImplementation(() => buildChain()),
    storage: storageMock,
  }

  return { supabase, mockResult }
}

// ============================================================
// Fixture factories
// ============================================================

let _counter = 0
const nextId = () => `test-${++_counter}`

export function makeCompany(overrides: Partial<Company> = {}): Company {
  const { team_id = null, ...rest } = overrides
  return {
    id: 'company-1',
    name: 'Test Company',
    org_number: null,
    entity_type: 'enskild_firma',
    created_by: 'user-1',
    team_id,
    archived_at: null,
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
    ...rest,
  }
}

export function makeCompanyMember(overrides: Partial<CompanyMember> = {}): CompanyMember {
  return {
    id: 'member-1',
    company_id: 'company-1',
    user_id: 'user-1',
    role: 'owner',
    invited_by: null,
    joined_at: '2024-01-01T00:00:00Z',
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
    ...overrides,
  }
}

export function makeReceipt(overrides: Partial<Receipt> = {}): Receipt {
  return {
    id: nextId(),
    user_id: 'user-1',
    company_id: 'company-1',
    image_url: 'https://example.com/receipt.jpg',
    image_thumbnail_url: null,
    status: 'confirmed',
    extraction_confidence: 0.95,
    merchant_name: 'ICA Maxi',
    merchant_org_number: null,
    merchant_vat_number: null,
    receipt_date: '2024-06-15',
    receipt_time: '14:30',
    total_amount: 299.0,
    currency: 'SEK',
    vat_amount: 59.8,
    is_restaurant: false,
    is_systembolaget: false,
    is_foreign_merchant: false,
    representation_persons: null,
    representation_purpose: null,
    representation_business_connection: null,
    source: 'upload',
    email_from: null,
    matched_transaction_id: null,
    match_confidence: null,
    raw_extraction: null,
    created_at: '2024-06-15T14:30:00Z',
    updated_at: '2024-06-15T14:30:00Z',
    ...overrides,
  }
}

export function makeTransaction(overrides: Partial<Transaction> = {}): Transaction {
  return {
    id: nextId(),
    user_id: 'user-1',
    company_id: 'company-1',
    bank_connection_id: null,
    external_id: null,
    date: '2024-06-15',
    description: 'ICA MAXI STOCKHOLM',
    amount: -299.0,
    currency: 'SEK',
    amount_sek: null,
    exchange_rate: null,
    exchange_rate_date: null,
    category: 'uncategorized',
    is_business: null,
    invoice_id: null,
    supplier_invoice_id: null,
    potential_invoice_id: null,
    potential_supplier_invoice_id: null,
    journal_entry_id: null,
    mcc_code: null,
    merchant_name: 'ICA Maxi',
    reconciliation_method: null,
    receipt_id: null,
    import_source: null,
    reference: null,
    notes: null,
    created_at: '2024-06-15T14:30:00Z',
    updated_at: '2024-06-15T14:30:00Z',
    ...overrides,
  }
}

export function makeFiscalPeriod(overrides: Partial<FiscalPeriod> = {}): FiscalPeriod {
  return {
    id: nextId(),
    user_id: 'user-1',
    company_id: 'company-1',
    name: 'FY 2024',
    period_start: '2024-01-01',
    period_end: '2024-12-31',
    is_closed: false,
    closed_at: null,
    locked_at: null,
    retention_expires_at: null,
    opening_balances_set: false,
    closing_entry_id: null,
    opening_balance_entry_id: null,
    previous_period_id: null,
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
    ...overrides,
  }
}

export function makeJournalEntry(overrides: Partial<JournalEntry> = {}): JournalEntry {
  return {
    id: nextId(),
    user_id: 'user-1',
    company_id: 'company-1',
    fiscal_period_id: 'period-1',
    voucher_number: 1,
    voucher_series: 'A',
    entry_date: '2024-06-15',
    description: 'Test entry',
    source_type: 'manual',
    source_id: null,
    status: 'posted',
    committed_at: '2024-06-15T14:30:00Z',
    reversed_by_id: null,
    reverses_id: null,
    correction_of_id: null,
    attachment_urls: null,
    created_at: '2024-06-15T14:30:00Z',
    updated_at: '2024-06-15T14:30:00Z',
    ...overrides,
  }
}

export function makeJournalEntryLine(
  overrides: Partial<JournalEntryLine> = {}
): JournalEntryLine {
  return {
    id: nextId(),
    journal_entry_id: 'entry-1',
    account_number: '1930',
    account_id: null,
    debit_amount: 0,
    credit_amount: 0,
    currency: 'SEK',
    amount_in_currency: null,
    exchange_rate: null,
    line_description: null,
    tax_code: null,
    cost_center: null,
    project: null,
    sort_order: 0,
    created_at: '2024-06-15T14:30:00Z',
    ...overrides,
  }
}

export function makeDocumentAttachment(
  overrides: Partial<DocumentAttachment> = {}
): DocumentAttachment {
  return {
    id: nextId(),
    user_id: 'user-1',
    company_id: 'company-1',
    storage_path: 'documents/user-1/file.pdf',
    file_name: 'file.pdf',
    file_size_bytes: 1024,
    mime_type: 'application/pdf',
    sha256_hash: 'abc123',
    version: 1,
    original_id: null,
    superseded_by_id: null,
    is_current_version: true,
    uploaded_by: 'user-1',
    upload_source: 'file_upload',
    digitization_date: '2024-06-15T14:30:00Z',
    journal_entry_id: null,
    journal_entry_line_id: null,
    prev_version_hash: null,
    last_integrity_check_at: null,
    created_at: '2024-06-15T14:30:00Z',
    updated_at: '2024-06-15T14:30:00Z',
    ...overrides,
  }
}

export function makeTaxCode(overrides: Partial<TaxCode> = {}): TaxCode {
  return {
    id: nextId(),
    user_id: null,
    code: 'MP1',
    description: 'Utgående moms 25%',
    rate: 25,
    moms_basis_boxes: ['05'],
    moms_tax_boxes: ['10'],
    moms_input_boxes: [],
    is_output_vat: true,
    is_reverse_charge: false,
    is_eu: false,
    is_export: false,
    is_oss: false,
    is_system: true,
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
    ...overrides,
  }
}

export function makeInvoice(overrides: Partial<Invoice> = {}): Invoice {
  return {
    id: nextId(),
    user_id: 'user-1',
    company_id: 'company-1',
    customer_id: 'customer-1',
    invoice_number: 'F-2024001',
    invoice_date: '2024-06-15',
    due_date: '2024-07-15',
    status: 'draft',
    currency: 'SEK',
    exchange_rate: null,
    exchange_rate_date: null,
    subtotal: 10000,
    subtotal_sek: null,
    vat_amount: 2500,
    vat_amount_sek: null,
    total: 12500,
    total_sek: null,
    vat_treatment: 'standard_25',
    vat_rate: 25,
    moms_ruta: '10',
    your_reference: null,
    our_reference: null,
    notes: null,
    reverse_charge_text: null,
    credited_invoice_id: null,
    document_type: 'invoice',
    converted_from_id: null,
    paid_at: null,
    paid_amount: null,
    remaining_amount: 12500,
    created_at: '2024-06-15T14:30:00Z',
    updated_at: '2024-06-15T14:30:00Z',
    ...overrides,
  }
}

export function makeInvoicePayment(
  overrides: Partial<InvoicePayment> = {}
): InvoicePayment {
  return {
    id: nextId(),
    user_id: 'user-1',
    company_id: 'company-1',
    invoice_id: 'invoice-1',
    payment_date: '2024-07-01',
    amount: 12500,
    currency: 'SEK',
    exchange_rate: null,
    exchange_rate_difference: 0,
    journal_entry_id: null,
    transaction_id: null,
    notes: null,
    created_at: '2024-07-01T00:00:00Z',
    ...overrides,
  }
}

export function makeCustomer(overrides: Partial<Customer> = {}): Customer {
  return {
    id: nextId(),
    user_id: 'user-1',
    company_id: 'company-1',
    name: 'Test AB',
    customer_type: 'swedish_business',
    email: 'kontakt@test.se',
    phone: null,
    address_line1: 'Storgatan 1',
    address_line2: null,
    postal_code: '111 22',
    city: 'Stockholm',
    country: 'SE',
    org_number: '5566778899',
    vat_number: 'SE556677889901',
    vat_number_validated: true,
    vat_number_validated_at: '2024-01-01T00:00:00Z',
    default_payment_terms: 30,
    notes: null,
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
    ...overrides,
  }
}

export function makeSupplier(overrides: Partial<Supplier> = {}): Supplier {
  return {
    id: nextId(),
    user_id: 'user-1',
    company_id: 'company-1',
    name: 'Leverantör AB',
    supplier_type: 'swedish_business',
    email: 'info@leverantor.se',
    phone: null,
    address_line1: 'Industrivägen 5',
    address_line2: null,
    postal_code: '123 45',
    city: 'Göteborg',
    country: 'SE',
    org_number: '5599887766',
    vat_number: null,
    bankgiro: '123-4567',
    plusgiro: null,
    bank_account: null,
    iban: null,
    bic: null,
    default_expense_account: '6200',
    default_payment_terms: 30,
    default_currency: 'SEK',
    notes: null,
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
    ...overrides,
  }
}

export function makeSupplierInvoice(
  overrides: Partial<SupplierInvoice> = {}
): SupplierInvoice {
  return {
    id: nextId(),
    user_id: 'user-1',
    company_id: 'company-1',
    supplier_id: 'supplier-1',
    arrival_number: 1,
    supplier_invoice_number: 'LF-001',
    invoice_date: '2024-06-01',
    due_date: '2024-07-01',
    received_date: '2024-06-02',
    delivery_date: null,
    status: 'registered',
    currency: 'SEK',
    exchange_rate: null,
    exchange_rate_date: null,
    subtotal: 8000,
    subtotal_sek: null,
    vat_amount: 2000,
    vat_amount_sek: null,
    total: 10000,
    total_sek: null,
    vat_treatment: 'standard_25',
    reverse_charge: false,
    payment_reference: null,
    paid_at: null,
    paid_amount: 0,
    remaining_amount: 10000,
    is_credit_note: false,
    credited_invoice_id: null,
    registration_journal_entry_id: null,
    payment_journal_entry_id: null,
    transaction_id: null,
    document_id: null,
    notes: null,
    created_at: '2024-06-02T00:00:00Z',
    updated_at: '2024-06-02T00:00:00Z',
    ...overrides,
  }
}

export function makeCompanySettings(
  overrides: Partial<CompanySettings> = {}
): CompanySettings {
  return {
    id: nextId(),
    user_id: 'user-1',
    company_id: 'company-1',
    entity_type: 'enskild_firma',
    company_name: 'Test Firma',
    org_number: '199001011234',
    address_line1: 'Testgatan 1',
    address_line2: null,
    postal_code: '111 22',
    city: 'Stockholm',
    country: 'SE',
    phone: null,
    email: null,
    website: null,
    pays_salaries: false,
    f_skatt: true,
    vat_registered: true,
    vat_number: null,
    moms_period: 'quarterly',
    fiscal_year_start_month: 1,
    preliminary_tax_monthly: null,
    bank_name: null,
    clearing_number: null,
    account_number: null,
    bankgiro: null,
    plusgiro: null,
    iban: null,
    bic: null,
    accounting_method: 'accrual',
    invoice_prefix: 'F',
    next_invoice_number: 1,
    next_delivery_note_number: 1,
    invoice_default_days: 30,
    invoice_default_notes: null,
    bookkeeping_locked_through: null,
    auto_lock_period_days: null,
    ore_rounding: true,
    invoice_show_ocr: true,
    invoice_show_bankgiro: true,
    invoice_show_plusgiro: true,
    invoice_late_fee_text: null,
    invoice_credit_terms_text: null,
    logo_url: null,
    onboarding_step: 6,
    onboarding_complete: true,
    sector_slug: null,
    is_sandbox: false,
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
    ...overrides,
  }
}

export function makeInvoiceInboxItem(
  overrides: Partial<InvoiceInboxItem> = {}
): InvoiceInboxItem {
  return {
    id: nextId(),
    user_id: 'user-1',
    company_id: 'company-1',
    status: 'pending',
    source: 'upload',
    email_from: null,
    email_subject: null,
    email_received_at: null,
    document_id: null,
    extracted_data: null,
    confidence: null,
    matched_supplier_id: null,
    created_supplier_invoice_id: null,
    error_message: null,
    document_type: 'supplier_invoice',
    linked_receipt_id: null,
    raw_email_payload: null,
    suggested_template_id: null,
    suggested_template_confidence: null,
    matched_transaction_id: null,
    match_confidence: null,
    match_method: null,
    created_at: '2024-06-15T14:30:00Z',
    updated_at: '2024-06-15T14:30:00Z',
    ...overrides,
  }
}

// ============================================================
// API Route Test Helpers
// ============================================================

/**
 * Build a Request object for testing Next.js API route handlers.
 */
export function createMockRequest(
  url: string,
  options?: {
    method?: string
    body?: unknown
    searchParams?: Record<string, string>
  }
): Request {
  const fullUrl = new URL(url, 'http://localhost:3000')
  if (options?.searchParams) {
    for (const [key, value] of Object.entries(options.searchParams)) {
      fullUrl.searchParams.set(key, value)
    }
  }
  return new Request(fullUrl.toString(), {
    method: options?.method || 'GET',
    headers: { 'Content-Type': 'application/json' },
    ...(options?.body ? { body: JSON.stringify(options.body) } : {}),
  })
}

/**
 * Parse NextResponse to {status, body}.
 */
export async function parseJsonResponse<T = unknown>(
  response: Response
): Promise<{ status: number; body: T }> {
  const body = (await response.json()) as T
  return { status: response.status, body }
}

/**
 * Build Promise-based params for Next.js 16 dynamic routes.
 */
export function createMockRouteParams<T extends Record<string, string>>(
  params: T
): { params: Promise<T> } {
  return { params: Promise.resolve(params) }
}

/**
 * Queue-based Supabase mock for routes with multiple sequential DB calls.
 *
 * Each call to `.from()` or `.rpc()` consumes the next result in the queue.
 */
export function createQueuedMockSupabase() {
  const queue: { data: unknown; error: unknown; count?: number | null }[] = []

  const enqueue = (result: {
    data?: unknown
    error?: unknown
    count?: number | null
  }) => {
    queue.push({
      data: result.data ?? null,
      error: result.error ?? null,
      count: result.count ?? null,
    })
  }

  const enqueueMany = (
    results: { data?: unknown; error?: unknown; count?: number | null }[]
  ) => {
    for (const r of results) {
      enqueue(r)
    }
  }

  const reset = () => {
    queue.length = 0
  }

  const buildChain = (): unknown => {
    // Capture the result at chain creation (when from/rpc is called)
    const result = queue.shift() || { data: null, error: null, count: null }

    const handler: ProxyHandler<object> = {
      get(_target, prop) {
        if (prop === 'then') {
          return (resolve: (v: unknown) => void) => resolve(result)
        }
        return (..._args: unknown[]) => buildChain2(result)
      },
    }
    return new Proxy({}, handler)
  }

  // Inner chain methods reuse the same result
  const buildChain2 = (result: {
    data: unknown
    error: unknown
    count?: number | null
  }): unknown => {
    const handler: ProxyHandler<object> = {
      get(_target, prop) {
        if (prop === 'then') {
          return (resolve: (v: unknown) => void) => resolve(result)
        }
        return (..._args: unknown[]) => buildChain2(result)
      },
    }
    return new Proxy({}, handler)
  }

  const storageMock = {
    from: vi.fn().mockReturnValue({
      upload: vi.fn().mockResolvedValue({ data: {}, error: null }),
      download: vi.fn().mockResolvedValue({
        data: new Blob(['test']),
        error: null,
      }),
      remove: vi.fn().mockResolvedValue({ data: [], error: null }),
      getPublicUrl: vi.fn().mockReturnValue({
        data: { publicUrl: 'https://example.com/file.jpg' },
      }),
    }),
  }

  const supabase = {
    from: vi.fn().mockImplementation(() => buildChain()),
    rpc: vi.fn().mockImplementation(() => buildChain()),
    storage: storageMock,
    auth: {
      getUser: vi.fn(),
    },
  }

  return { supabase, enqueue, enqueueMany, reset }
}

export function makeCategorizationTemplate(
  overrides: Partial<CategorizationTemplate> = {}
): CategorizationTemplate {
  return {
    id: nextId(),
    user_id: 'user-1',
    company_id: 'company-1',
    counterparty_name: 'telia',
    counterparty_aliases: ['telia sverige ab'],
    debit_account: '6200',
    credit_account: '1930',
    vat_treatment: 'standard_25',
    vat_account: '2641',
    category: 'expense_telecom',
    occurrence_count: 5,
    confidence: 0.7,
    last_seen_date: '2024-06-15',
    source: 'user_approved',
    line_pattern: null,
    is_active: true,
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-06-15T00:00:00Z',
    ...overrides,
  }
}

export function makeSIEVoucher(
  overrides: Partial<Omit<SIEVoucher, 'lines'>> & { lines?: SIETransactionLine[] } = {}
): SIEVoucher {
  return {
    series: 'A',
    number: 1,
    date: new Date(2024, 5, 15), // June 15, 2024
    description: 'Faktura',
    lines: [
      { account: '1930', amount: -1000 },
      { account: '6200', amount: 800 },
      { account: '2641', amount: 200 },
    ],
    ...overrides,
  }
}
