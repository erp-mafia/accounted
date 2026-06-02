// Entity types
export type EntityType = 'enskild_firma' | 'aktiebolag'

// Swedish accounting framework. K2 (BFNAR 2016:10) is the default simplified
// ruleset for smaller AB; K3 (BFNAR 2012:1) is the principles-based ruleset
// required for medium-to-large AB and permitted voluntarily for smaller ones.
// Only meaningful for entity_type='aktiebolag'.
export type AccountingFramework = 'k2' | 'k3'

// Company role for multi-tenant access
export type CompanyRole = 'owner' | 'admin' | 'member' | 'viewer'

// Team (consulting firm) roles and source tracking
export type TeamRole = 'owner' | 'admin' | 'member'
export type MemberSource = 'direct' | 'team'

// Team (consulting firm grouping)
export interface Team {
  id: string
  name: string
  created_by: string
  created_at: string
  updated_at: string
}

// Company (multi-tenant identity)
export interface Company {
  id: string
  name: string
  org_number: string | null
  entity_type: EntityType
  accounting_framework: AccountingFramework
  created_by: string
  team_id: string | null
  archived_at: string | null
  created_at: string
  updated_at: string
}

// Company membership
export interface CompanyMember {
  id: string
  company_id: string
  user_id: string
  role: CompanyRole
  invited_by: string | null
  joined_at: string
  created_at: string
  updated_at: string
}

// User preferences (cross-company)
export interface UserPreferences {
  id: string
  user_id: string
  active_company_id: string | null
  created_at: string
  updated_at: string
}

// Transaction categories
export type TransactionCategory =
  | 'income_services'
  | 'income_products'
  | 'income_other'
  | 'expense_equipment'
  | 'expense_software'
  | 'expense_travel'
  | 'expense_office'
  | 'expense_marketing'
  | 'expense_professional_services'
  | 'expense_education'
  | 'expense_representation'
  | 'expense_consumables'
  | 'expense_vehicle'
  | 'expense_telecom'
  | 'expense_bank_fees'
  | 'expense_card_fees'
  | 'expense_currency_exchange'
  | 'expense_other'
  | 'private'
  | 'uncategorized'

// Customer types for VAT handling
export type CustomerType =
  | 'individual'        // Swedish private person
  | 'swedish_business'  // Swedish company
  | 'eu_business'       // EU company (needs VAT validation)
  | 'non_eu_business'   // Non-EU company

// Invoice status
export type InvoiceStatus = 'draft' | 'sent' | 'paid' | 'partially_paid' | 'overdue' | 'cancelled' | 'credited'

// Invoice document type
export type InvoiceDocumentType = 'invoice' | 'proforma' | 'delivery_note'

// Supplier types
export type SupplierType = 'swedish_business' | 'eu_business' | 'non_eu_business'

// Supplier invoice status
// 'reversed' marks a credit note whose journal entry was storno-reversed via
// "Ångra kreditering". The row is preserved (BFL 7 kap) rather than hard-deleted.
export type SupplierInvoiceStatus = 'registered' | 'approved' | 'paid' | 'partially_paid' | 'overdue' | 'disputed' | 'credited' | 'reversed'

// VAT treatment
export type VatTreatment =
  | 'standard_25'       // 25% Swedish VAT
  | 'reduced_12'        // 12% reduced rate
  | 'reduced_6'         // 6% reduced rate
  | 'reverse_charge'    // EU reverse charge (0%)
  | 'export'            // Non-EU export (0%)
  | 'exempt'            // VAT exempt

// Accounting method (bokföringsmetod)
export type AccountingMethod = 'accrual' | 'cash'

// Moms reporting period
export type MomsPeriod = 'monthly' | 'quarterly' | 'yearly'

// Reconciliation method
export type ReconciliationMethod = 'auto_exact' | 'auto_date_range' | 'auto_reference' | 'auto_fuzzy' | 'manual'

// Processing history (behandlingshistorik) — event-driven audit trail per BFNAR 2013:2 kap 8

export type ProcessingHistoryActorType = 'user' | 'system' | 'llm' | 'cron' | 'api_key'

export interface ProcessingHistoryActor {
  type: ProcessingHistoryActorType
  id: string
  label?: string
}

export type ProcessingHistoryAggregateType =
  | 'Document'
  | 'BankTransaction'
  | 'MatchProposal'
  | 'Verifikation'
  | 'CounterpartyTemplate'
  | 'Period'
  | 'Migration'
  | 'System'

export interface ProcessingHistoryEvent {
  event_id: string
  seq: number
  company_id: string
  correlation_id: string
  causation_id: string | null
  aggregate_type: ProcessingHistoryAggregateType
  aggregate_id: string
  event_type: string // open type — validated at runtime against processing_event_types registry
  payload: Record<string, unknown>
  payload_schema_version: number
  actor: ProcessingHistoryActor
  rubric_version: string | null
  occurred_at: string
  appended_at: string
}

// Bank connection status
// 'pending_selection' = PSD2 consent granted, awaiting user to pick which
// accounts to actually sync. No transactions are pulled in this state.
export type BankConnectionStatus = 'pending' | 'pending_selection' | 'active' | 'expired' | 'revoked' | 'error'

// Currency types
export type Currency = 'SEK' | 'EUR' | 'USD' | 'GBP' | 'NOK' | 'DKK'

// Profile (extends auth.users)
export interface Profile {
  id: string
  email: string
  full_name: string | null
  avatar_url: string | null
  created_at: string
  updated_at: string
}

// Company Settings
export interface CompanySettings {
  id: string
  user_id: string
  company_id: string

  // Entity info
  entity_type: EntityType
  company_name: string | null
  org_number: string | null

  // Address
  address_line1: string | null
  address_line2: string | null
  postal_code: string | null
  city: string | null
  country: string

  // Contact
  phone: string | null
  email: string | null
  website: string | null

  // Tax registration
  pays_salaries: boolean
  f_skatt: boolean
  vat_registered: boolean
  vat_number: string | null
  moms_period: MomsPeriod | null
  periodisk_sammanstallning_period: 'monthly' | 'quarterly'

  // Tax contact (SKV-filings, periodisk sammanställning, AGI, etc.)
  tax_contact_name: string | null
  tax_contact_phone: string | null
  tax_contact_email: string | null

  // Fiscal year
  fiscal_year_start_month: number  // 1-12
  // Transient first-year fields (used during onboarding, not persisted in DB)
  is_first_fiscal_year?: boolean
  first_year_start?: string
  first_year_end?: string

  // Preliminary tax
  preliminary_tax_monthly: number | null

  // Bank details for invoices
  bank_name: string | null
  clearing_number: string | null
  account_number: string | null
  bankgiro: string | null
  plusgiro: string | null
  swish: string | null
  iban: string | null
  bic: string | null

  // Accounting method
  accounting_method: AccountingMethod

  // Invoice settings
  invoice_prefix: string | null
  next_invoice_number: number
  next_delivery_note_number: number
  invoice_default_days: number
  invoice_default_notes: string | null

  // Bookkeeping lock
  bookkeeping_locked_through: string | null
  auto_lock_period_days: number | null

  // Voucher series
  default_voucher_series: string
  /**
   * Per-source-type default voucher series map. Keys are
   * JournalEntrySourceType values; values are single uppercase letters A–Z.
   * Resolved by `lib/bookkeeping/voucher-series-resolver.ts`. Defaults to
   * all "A" entries; users can override per source via the bookkeeping
   * settings UI.
   */
  default_voucher_series_per_source_type: Partial<Record<JournalEntrySourceType, string>>

  // Most recently picked BAS account for supplier invoice payments — used to
  // default the mark-paid dialog so repeat payments don't force re-picking.
  last_supplier_payment_account: string | null

  // Invoice PDF settings
  ore_rounding: boolean
  invoice_show_ocr: boolean
  invoice_show_bankgiro: boolean
  invoice_show_plusgiro: boolean
  invoice_show_swish: boolean
  invoice_show_logo: boolean
  invoice_show_company_name: boolean
  invoice_company_name_position: 'header' | 'footer'
  invoice_late_fee_text: string | null
  invoice_credit_terms_text: string | null

  // Invoice branding (per-company colors, font, optional header/footer text).
  // Defaults preserve the legacy hardcoded palette so unbranded companies
  // render identically to the pre-branding template.
  invoice_primary_color: string  // hex #RRGGBB, default '#1a1a1a'
  invoice_accent_color: string   // hex #RRGGBB, default '#666666'
  invoice_font_family: 'Helvetica' | 'Times-Roman' | 'Courier'
  invoice_header_text: string | null
  invoice_footer_text: string | null

  // Automation
  send_invoice_reminders: boolean

  // Reminder surcharges (dröjsmålsränta + lagstadgad påminnelseavgift)
  reminder_fee_enabled: boolean
  reminder_fee_amount: number
  reminder_interest_rate_override: number | null

  // Logo
  logo_url: string | null

  // Onboarding
  onboarding_step: number
  onboarding_complete: boolean

  // Sector
  sector_slug: string | null

  // Sandbox
  is_sandbox: boolean

  // Timestamps
  created_at: string
  updated_at: string
}

// Bank Connection
export interface BankConnection {
  id: string
  user_id: string
  company_id: string

  bank_name: string
  provider: string

  // Enable Banking specific
  session_id: string | null
  authorization_id: string | null

  // Account info
  accounts_data: BankAccount[]

  // Status
  status: BankConnectionStatus

  // Consent
  consent_expires: string | null
  last_synced_at: string | null
  error_message: string | null

  // Initial-sync metadata. initial_sync_completed_at gates the cron's
  // first-sync 90-day backfill path independently of last_synced_at, so
  // a manual "Sync now" doesn't permanently lose the deep backfill window.
  // The returned-date columns power the "we requested X but got Y" UI when
  // an ASPSP truncates history below the requested window.
  initial_sync_completed_at: string | null
  initial_sync_requested_from: string | null
  initial_sync_returned_min_date: string | null
  initial_sync_returned_max_date: string | null
  initial_sync_lookback_days: number | null

  created_at: string
  updated_at: string
}

export interface BankAccount {
  uid: string  // Enable Banking account UID
  iban: string | null
  name: string | null
  currency: Currency
  balance: number | null
  balance_updated_at?: string | null
}

// Cash account — first-class entity for ledger-account routing decisions.
// Backed by the cash_accounts table; bank_connections.accounts_data remains
// the source for PSD2 sync metadata + UI display until a follow-up migration
// drops it 30 days after this PR.
export type CashAccountSource = 'enable_banking' | 'manual' | 'sie_import'

export interface CashAccount {
  id: string
  company_id: string
  bank_connection_id: string | null
  external_uid: string | null    // PSD2 StoredAccount.uid
  iban: string | null
  bg_pg: string | null
  name: string | null
  currency: string                // 3-char ISO; broader than Currency union to
                                  // tolerate future currencies without DB-driven enum drift
  ledger_account: string
  balance: number | null
  balance_updated_at: string | null
  enabled: boolean
  is_primary: boolean
  source: CashAccountSource
  created_at: string
  updated_at: string
}

// Import source identifiers
export type ImportSource =
  | 'enable_banking'
  | 'csv_nordea'
  | 'csv_seb'
  | 'csv_swedbank'
  | 'csv_handelsbanken'
  | 'csv_generic'
  | 'camt053'
  | 'manual'

// Transaction
export interface Transaction {
  id: string
  user_id: string
  company_id: string

  // Source
  bank_connection_id: string | null
  external_id: string | null  // For deduplication

  // The cash account (cash_accounts row) this transaction settled on. Drives
  // per-account bank reconciliation isolation and the correct bank leg when
  // booking. Null on legacy/unresolved rows — callers fall back to currency.
  // See 20260606120000_transactions_cash_account_id.sql.
  cash_account_id: string | null

  // Details
  date: string
  description: string  // Mutable working title — user-editable while unbooked (see PATCH /api/transactions/[id])
  // Bank/PSD2 description captured at ingest, normalized (empty/whitespace and
  // the legacy "Unknown" sentinel map to the Swedish neutral). Never overwritten
  // by user title edits; source for the dedup bridge and the "restore original"
  // action. Null only for rows predating the column.
  original_description: string | null
  // Set when the user has overridden the title; null = still the bank original.
  title_edited_at: string | null
  amount: number  // Positive = income, negative = expense
  currency: Currency

  // For non-SEK transactions
  amount_sek: number | null
  exchange_rate: number | null
  exchange_rate_date: string | null

  // Categorization
  category: TransactionCategory
  is_business: boolean | null  // null = uncategorized

  // Linked invoice (for matching)
  invoice_id: string | null

  // Linked supplier invoice (for matching)
  supplier_invoice_id: string | null

  // Potential invoice match (suggested, not confirmed)
  potential_invoice_id: string | null

  // Potential supplier invoice match (suggested, not confirmed)
  potential_supplier_invoice_id: string | null

  // Bookkeeping
  journal_entry_id: string | null
  mcc_code: number | null
  merchant_name: string | null

  // Receipt link
  receipt_id: string | null

  // Inbox/upload document pinned to this transaction (pre-categorization).
  // Propagates to document_attachments.journal_entry_id on categorize.
  document_id: string | null

  // Reconciliation
  reconciliation_method: ReconciliationMethod | null

  // User has chosen to suppress this transaction from the bank reconciliation
  // view without booking it. See migration
  // 20260529140000_transactions_is_ignored.sql for the rationale.
  is_ignored: boolean

  // Import tracking
  import_source: string | null
  reference: string | null  // OCR number, Bankgiro reference

  // Counterparty identification from PSD2 (creditor for outflows, debtor for
  // inflows). The own-account transfer detector matches `counterparty_iban`
  // against cash_accounts.iban for the same company. `counterparty_account`
  // is the BG/PG/BBAN fallback for Swedish domestic transfers without IBAN.
  counterparty_iban: string | null
  counterparty_account: string | null

  // Notes
  notes: string | null

  created_at: string
  updated_at: string
}

// Bank File Import (tracking table for file-based imports)
export type BankFileImportStatus = 'pending' | 'processing' | 'completed' | 'failed'

export interface BankFileImport {
  id: string
  user_id: string
  company_id: string
  filename: string
  file_hash: string
  file_format: string
  transaction_count: number
  imported_count: number
  duplicate_count: number
  matched_count: number
  date_from: string | null
  date_to: string | null
  status: BankFileImportStatus
  error_message: string | null
  created_at: string
  updated_at: string
}

// Customer
export interface Customer {
  id: string
  user_id: string
  company_id: string

  // Basic info
  name: string
  customer_type: CustomerType

  // Contact
  email: string | null
  phone: string | null

  // Address
  address_line1: string | null
  address_line2: string | null
  postal_code: string | null
  city: string | null
  country: string

  // Tax info
  org_number: string | null
  vat_number: string | null
  vat_number_validated: boolean
  vat_number_validated_at: string | null
  personal_number: string | null

  // Language for customer-facing invoice PDF and email
  language: 'sv' | 'en'

  // Payment
  default_payment_terms: number  // Days

  // Notes
  notes: string | null

  created_at: string
  updated_at: string
}

// Supplier
export interface Supplier {
  id: string
  user_id: string
  company_id: string

  name: string
  supplier_type: SupplierType

  email: string | null
  phone: string | null

  address_line1: string | null
  address_line2: string | null
  postal_code: string | null
  city: string | null
  country: string

  org_number: string | null
  vat_number: string | null

  bankgiro: string | null
  plusgiro: string | null
  bank_account: string | null
  iban: string | null
  bic: string | null

  default_expense_account: string | null
  default_payment_terms: number
  default_currency: string

  notes: string | null

  created_at: string
  updated_at: string
}

// Supplier Invoice
export interface SupplierInvoice {
  id: string
  user_id: string
  company_id: string
  supplier_id: string

  arrival_number: number
  supplier_invoice_number: string

  invoice_date: string
  due_date: string
  received_date: string
  delivery_date: string | null

  status: SupplierInvoiceStatus

  currency: string
  exchange_rate: number | null
  exchange_rate_date: string | null

  subtotal: number
  subtotal_sek: number | null
  vat_amount: number
  vat_amount_sek: number | null
  total: number
  total_sek: number | null

  vat_treatment: VatTreatment
  reverse_charge: boolean

  payment_reference: string | null
  paid_at: string | null
  paid_amount: number
  remaining_amount: number

  is_credit_note: boolean
  credited_invoice_id: string | null

  registration_journal_entry_id: string | null
  payment_journal_entry_id: string | null

  transaction_id: string | null
  document_id: string | null

  // Owner paid out-of-pocket; AP step is bypassed and the expense is booked
  // directly against 2893 (AB) or 2018 (EF). Status is set to 'paid' at
  // creation and mark-paid is rejected by the existing status guard.
  paid_with_private_funds: boolean

  notes: string | null

  created_at: string
  updated_at: string

  // Relations (populated when fetched)
  supplier?: Supplier
  items?: SupplierInvoiceItem[]
  payments?: SupplierInvoicePayment[]
}

// Supplier Invoice Item
export interface SupplierInvoiceItem {
  id: string
  supplier_invoice_id: string

  sort_order: number
  description: string
  quantity: number
  unit: string
  unit_price: number
  line_total: number

  account_number: string
  vat_code: string | null
  vat_rate: number
  vat_amount: number
  // Self-assessed VAT rate for omvänd skattskyldighet (0.06/0.12/0.25), null
  // for non-RC lines. The supplier charges no VAT so vat_rate stays 0; this
  // rate drives the fiktiv-moms + basbelopp booking. See the booking engine.
  reverse_charge_rate: number | null

  created_at: string
}

// Supplier Invoice Payment (partial payments)
export interface SupplierInvoicePayment {
  id: string
  supplier_invoice_id: string

  payment_date: string
  amount: number
  currency: string
  exchange_rate: number | null
  exchange_rate_difference: number

  journal_entry_id: string | null
  transaction_id: string | null
  notes: string | null

  created_at: string
}

// Invoice Payment (partial payments)
export interface InvoicePayment {
  id: string
  user_id: string
  company_id: string
  invoice_id: string

  payment_date: string
  amount: number
  currency: string
  exchange_rate: number | null
  exchange_rate_difference: number

  journal_entry_id: string | null
  transaction_id: string | null
  notes: string | null

  created_at: string
}

// Invoice
export interface Invoice {
  id: string
  user_id: string
  company_id: string
  customer_id: string

  // Invoice number (auto-generated at first send; null while draft)
  invoice_number: string | null

  // Dates
  invoice_date: string
  due_date: string
  delivery_date: string | null

  // Status
  status: InvoiceStatus

  // Currency
  currency: Currency

  // Exchange rate (if non-SEK)
  exchange_rate: number | null
  exchange_rate_date: string | null

  // Amounts
  subtotal: number
  subtotal_sek: number | null

  vat_amount: number
  vat_amount_sek: number | null

  total: number
  total_sek: number | null

  // VAT
  vat_treatment: VatTreatment
  vat_rate: number
  moms_ruta: string | null  // For Swedish VAT reporting (05, 39, 40, etc.)

  // Reference
  your_reference: string | null
  our_reference: string | null

  // Notes
  notes: string | null

  // Reverse charge text (auto-added for EU B2B)
  reverse_charge_text: string | null

  // Credit note reference
  credited_invoice_id: string | null

  // Document type (invoice, proforma, delivery_note, quote)
  document_type: InvoiceDocumentType

  // Conversion tracking (proforma -> invoice)
  converted_from_id: string | null

  // Payment tracking
  paid_at: string | null
  paid_amount: number | null
  remaining_amount: number

  // ROT/RUT-avdrag claim info. `deduction_total` is the sum of the per-item
  // deduction_amount and equals the 1513 debit on the verifikation. The
  // personnummer is stored only as AES-256-GCM ciphertext + the last four
  // digits (PII isolation). All three fields are null/0 on invoices with
  // no ROT/RUT lines. Optional in TypeScript to keep legacy fixtures
  // (pre-migration) valid — treat undefined the same as 0/null.
  deduction_total?: number
  deduction_personnummer_encrypted?: string | null
  deduction_personnummer_last4?: string | null

  created_at: string
  updated_at: string

  // Relations (populated when fetched)
  customer?: Customer
  items?: InvoiceItem[]
  payments?: InvoicePayment[]
}

// Invoice Item
export interface InvoiceItem {
  id: string
  invoice_id: string

  // Order
  sort_order: number

  // Description
  description: string

  // Quantity
  quantity: number
  unit: string  // 'st', 'tim', 'dag', etc.

  // Price
  unit_price: number

  // Calculated
  line_total: number

  // Per-line VAT
  vat_rate: number
  vat_amount: number

  // ROT/RUT-avdrag (Sweden's tax deduction for household services / home
  // renovation). When `deduction_type` is set, the system computes
  // `deduction_amount` from the rules in lib/invoices/rot-rut-rules.ts
  // and posts the receivable to BAS 1513 (Skatteverket). v1 deducts on
  // the full line total; future work can use `labor_hours` to honour the
  // labor-only restriction.
  //
  // All fields are optional in TypeScript even though Postgres has
  // defaults — legacy rows pulled before the schema change carry
  // `undefined` in JS land, and many existing test fixtures predate the
  // ROT/RUT migration. Treat undefined the same as null/0 throughout.
  deduction_type?: 'rot' | 'rut' | null
  deduction_amount?: number
  labor_hours?: number | null
  /** Skatteverket arbetstypskod (e.g. 'BYGG', 'STAD'). See ROT_WORK_TYPES / RUT_WORK_TYPES. */
  work_type?: string | null
  /** Fastighetsbeteckning. Required for ROT, optional for RUT. */
  housing_designation?: string | null
  /** Lägenhetsnummer. Optional, used for ROT in flerbostadshus. */
  apartment_number?: string | null

  created_at: string
}

// Recurring Invoice Schedule (template + monthly cadence)
export type RecurringInvoiceScheduleStatus = 'active' | 'paused'

export interface RecurringInvoiceSchedule {
  id: string
  company_id: string
  user_id: string
  customer_id: string

  name: string

  // Monthly cadence, day-of-month 1-31. Clamped to last day of month in
  // shorter months (handled by computeNextRunDate).
  day_of_month: number
  payment_terms_days: number

  currency: Currency
  your_reference: string | null
  our_reference: string | null
  notes: string | null

  auto_send: boolean
  status: RecurringInvoiceScheduleStatus

  next_run_date: string
  last_run_at: string | null
  last_invoice_id: string | null
  last_run_warning: string | null
  generated_count: number

  created_at: string
  updated_at: string

  // Relations
  customer?: Customer
  items?: RecurringInvoiceScheduleItem[]
}

export interface RecurringInvoiceScheduleItem {
  id: string
  schedule_id: string
  sort_order: number
  description: string
  quantity: number
  unit: string
  unit_price: number
  // null = inherit customer's default VAT rate at spawn time
  vat_rate: number | null
  created_at: string
}

// Tax Rates (reference table)
export interface TaxRate {
  id: string

  // Type
  rate_type: 'egenavgifter' | 'bolagsskatt' | 'arbetsgivaravgifter' | 'vat' | 'municipal'

  // Rate
  rate: number

  // Validity
  valid_from: string
  valid_to: string | null

  // Description
  description: string
}

// Form types for creating/updating

export interface CreateCustomerInput {
  name: string
  customer_type: CustomerType
  email?: string
  phone?: string
  address_line1?: string
  address_line2?: string
  postal_code?: string
  city?: string
  country?: string
  org_number?: string
  vat_number?: string
  personal_number?: string
  language?: 'sv' | 'en'
  default_payment_terms?: number
  notes?: string
}

export interface CreateSupplierInput {
  name: string
  supplier_type: SupplierType
  email?: string
  phone?: string
  address_line1?: string
  address_line2?: string
  postal_code?: string
  city?: string
  country?: string
  org_number?: string
  vat_number?: string
  bankgiro?: string
  plusgiro?: string
  bank_account?: string
  iban?: string
  bic?: string
  default_expense_account?: string
  default_payment_terms?: number
  default_currency?: string
  notes?: string
}

export interface CreateSupplierInvoiceInput {
  supplier_id: string
  supplier_invoice_number: string
  invoice_date: string
  due_date: string
  delivery_date?: string
  currency?: string
  exchange_rate?: number
  vat_treatment?: VatTreatment
  reverse_charge?: boolean
  payment_reference?: string
  notes?: string
  items: CreateSupplierInvoiceItemInput[]
}

export interface CreateSupplierInvoiceItemInput {
  description: string
  amount: number
  account_number: string
  vat_rate?: number
  // Manual override. See CreateSupplierInvoiceItemSchema for rationale.
  vat_amount?: number
  // Self-assessed VAT rate for omvänd skattskyldighet (0.06/0.12/0.25). When
  // set, the engine books fiktiv moms at this rate while vat_rate stays 0.
  reverse_charge_rate?: number
  vat_code?: string
  // Legacy fields (backward compat, ignored when amount is set)
  quantity?: number
  unit?: string
  unit_price?: number
}

export interface CreateInvoiceInput {
  customer_id: string
  invoice_date: string
  due_date: string
  currency: Currency
  document_type?: InvoiceDocumentType
  your_reference?: string
  our_reference?: string
  notes?: string
  /** Plaintext personnummer — encrypted server-side before storage. */
  deduction_personnummer?: string
  /** Fastighetsbeteckning. Required when any item carries deduction_type === 'rot'. */
  deduction_housing_designation?: string
  items: CreateInvoiceItemInput[]
}

export interface CreateInvoiceItemInput {
  description: string
  quantity: number
  unit: string
  unit_price: number
  vat_rate?: number
  /** ROT/RUT toggle. null/undefined = no deduction. */
  deduction_type?: 'rot' | 'rut' | null
  labor_hours?: number | null
  work_type?: string | null
  housing_designation?: string | null
  apartment_number?: string | null
}

export interface CreateTransactionInput {
  date: string
  description: string
  amount: number
  currency: Currency
  category?: TransactionCategory
  is_business?: boolean
  notes?: string
}

// API Response types
export interface ApiResponse<T> {
  data?: T
  error?: string
}

export interface PaginatedResponse<T> {
  data: T[]
  count: number
  page: number
  pageSize: number
  totalPages: number
}

// VAT validation response
export interface VatValidationResult {
  valid: boolean
  name?: string
  address?: string
  country_code?: string
  vat_number?: string
  error?: string
}

// Exchange rate response
export interface ExchangeRate {
  currency: Currency
  rate: number
  date: string
}

// Dashboard summary types
export interface DashboardSummary {
  // Income
  total_income_ytd: number
  total_income_mtd: number

  // Expenses
  total_expenses_ytd: number
  total_expenses_mtd: number

  // Net
  net_income_ytd: number
  net_income_mtd: number

  // Tax estimates
  estimated_tax: TaxEstimate

  // Alerts
  uncategorized_count: number
  unpaid_invoices_count: number
  unpaid_invoices_total: number
  overdue_invoices_count: number

  // Bank
  bank_balance: number | null
  available_balance: number | null  // After tax reservations
}

export interface TaxEstimate {
  // For EF
  egenavgifter?: number
  income_tax?: number // Municipal tax (kommunalskatt)
  state_tax?: number // State tax (statlig skatt) - 20% on high incomes
  grundavdrag?: number // Basic deduction applied

  // For AB
  bolagsskatt?: number

  // Common
  moms_to_pay: number
  total_tax_liability: number

  // Comparison with preliminary
  preliminary_paid_ytd: number
  difference: number  // Positive = underpaying

}

// ============================================================
// BAS Kontoplan & Bookkeeping Types
// ============================================================

// Risk levels for mapping rules
export type RiskLevel = 'NONE' | 'LOW' | 'MEDIUM' | 'HIGH' | 'VERY_HIGH'

// Account types
export type AccountType = 'asset' | 'equity' | 'liability' | 'revenue' | 'expense' | 'untaxed_reserves'
export type NormalBalance = 'debit' | 'credit'
export type PlanType = 'k1' | 'full_bas'

// Journal entry source
export type JournalEntrySourceType =
  | 'manual'
  | 'bank_transaction'
  | 'invoice_created'
  | 'invoice_paid'
  | 'invoice_cash_payment'
  | 'credit_note'
  | 'salary_payment'
  | 'opening_balance'
  | 'year_end'
  | 'storno'
  | 'correction'
  | 'import'
  | 'system'
  | 'inbox_item'
  | 'supplier_invoice_registered'
  | 'supplier_invoice_paid'
  | 'supplier_invoice_cash_payment'
  | 'supplier_invoice_privately_paid'
  | 'supplier_credit_note'
  | 'currency_revaluation'
  | 'reminder_fee'

// Journal entry status
export type JournalEntryStatus = 'draft' | 'posted' | 'reversed' | 'cancelled'

// Mapping rule type
export type MappingRuleType =
  | 'mcc_code'
  | 'merchant_name'
  | 'description_pattern'
  | 'amount_threshold'
  | 'combined'

// BAS Account
export interface BASAccount {
  id: string
  user_id: string
  company_id: string
  account_number: string
  account_name: string
  account_class: number
  account_group: string
  account_type: AccountType
  normal_balance: NormalBalance
  plan_type: PlanType
  is_active: boolean
  is_system_account: boolean
  default_vat_code: string | null
  description: string | null
  sru_code: string | null
  k2_excluded: boolean
  sort_order: number
  created_at: string
  updated_at: string
}

// Fiscal Period (Räkenskapsår)
export interface FiscalPeriod {
  id: string
  user_id: string
  company_id: string
  name: string
  period_start: string
  period_end: string
  is_closed: boolean
  closed_at: string | null
  locked_at: string | null
  retention_expires_at: string | null
  opening_balances_set: boolean
  closing_entry_id: string | null
  opening_balance_entry_id: string | null
  previous_period_id: string | null
  created_at: string
  updated_at: string
}

// Journal Entry (Verifikation)
export interface JournalEntry {
  id: string
  user_id: string
  company_id: string
  fiscal_period_id: string
  voucher_number: number
  voucher_series: string
  entry_date: string
  description: string
  source_type: JournalEntrySourceType
  source_id: string | null
  status: JournalEntryStatus
  committed_at: string | null
  reversed_by_id: string | null
  reverses_id: string | null
  correction_of_id: string | null
  attachment_urls: string[] | null
  notes: string | null
  commit_method: string | null
  rubric_version: string | null
  source_voucher_series: string | null
  source_voucher_number: number | null
  created_at: string
  updated_at: string
  // Relations
  lines?: JournalEntryLine[]
  // Set by list_fiscal_period_entries_with_related when the entry was
  // returned as a follow-up from a different fiscal period than the one
  // being viewed. Absent from plain PostgREST responses.
  out_of_period?: boolean
}

// Journal Entry Line
export interface JournalEntryLine {
  id: string
  journal_entry_id: string
  account_number: string
  account_id: string | null
  debit_amount: number
  credit_amount: number
  currency: string
  amount_in_currency: number | null
  exchange_rate: number | null
  line_description: string | null
  tax_code: string | null
  cost_center: string | null
  project: string | null
  sort_order: number
  created_at: string
}

// Mapping Rule
export interface MappingRule {
  id: string
  user_id: string | null
  company_id: string | null
  rule_name: string
  rule_type: MappingRuleType
  priority: number
  // Matching
  mcc_codes: number[] | null
  merchant_pattern: string | null
  description_pattern: string | null
  amount_min: number | null
  amount_max: number | null
  // Targets
  debit_account: string | null
  credit_account: string | null
  vat_treatment: string | null
  vat_debit_account: string | null
  vat_credit_account: string | null
  // Risk
  risk_level: RiskLevel
  default_private: boolean
  requires_review: boolean
  confidence_score: number
  // Capitalization
  capitalization_threshold: number | null
  capitalized_debit_account: string | null
  // Source tracking
  source: 'auto' | 'user_description' | 'system'
  user_description: string | null
  template_id: string | null
  // Meta
  is_active: boolean
  created_at: string
  updated_at: string
}

// Mapping engine result
export interface MappingResult {
  rule: MappingRule | null
  template_id?: string
  debit_account: string
  credit_account: string
  risk_level: RiskLevel
  confidence: number
  requires_review: boolean
  default_private: boolean
  vat_lines: VatJournalLine[]
  all_lines_complete?: boolean  // when true, vat_lines contains ALL non-settlement lines
  description: string
}

// VAT journal line (auto-generated)
export interface VatJournalLine {
  account_number: string
  debit_amount: number
  credit_amount: number
  description: string
}

// Categorization template source
export type CategorizationTemplateSource = 'sie_import' | 'user_approved' | 'sni_default' | 'auto_learned' | 'ai_corrected'

// Multi-line booking pattern entry
export interface LinePatternEntry {
  account: string
  type: 'business' | 'vat' | 'tax'
  side: 'debit' | 'credit'
  ratio?: number      // proportion of NON-VAT amount (business + tax ratios sum to ~1.0)
  vat_rate?: number   // applied to FULL amount via rate/(1+rate) (vat type only)
}

// Per-tenant counterparty-based categorization template
export interface CategorizationTemplate {
  id: string
  user_id: string
  company_id: string
  counterparty_name: string
  counterparty_aliases: string[]
  debit_account: string
  credit_account: string
  vat_treatment: VatTreatment | null
  vat_account: string | null
  category: TransactionCategory | null
  line_pattern: LinePatternEntry[] | null
  occurrence_count: number
  confidence: number
  last_seen_date: string | null
  source: CategorizationTemplateSource
  is_active: boolean
  created_at: string
  updated_at: string
}

// Booking template library categories
export type BookingTemplateCategory =
  | 'eu_trade'
  | 'tax_account'
  | 'private_transfer'
  | 'salary'
  | 'representation'
  | 'year_end'
  | 'vat'
  | 'financial'
  | 'other'

// Booking template library line
export interface BookingTemplateLibraryLine {
  account: string
  label: string
  side: 'debit' | 'credit'
  type: 'business' | 'vat' | 'settlement'
  ratio?: number
  vat_rate?: number
}

// Booking template library entry (system, team, or company-scoped)
export interface BookingTemplateLibrary {
  id: string
  company_id: string | null
  team_id: string | null
  created_by: string | null
  name: string
  description: string
  category: BookingTemplateCategory
  entity_type: 'all' | EntityType
  lines: BookingTemplateLibraryLine[]
  is_system: boolean
  is_active: boolean
  created_at: string
  updated_at: string
}

// Account Balance (cached)
export interface AccountBalance {
  id: string
  user_id: string
  company_id: string
  fiscal_period_id: string
  account_number: string
  account_id: string | null
  opening_debit: number
  opening_credit: number
  period_debit: number
  period_credit: number
  closing_debit: number
  closing_credit: number
  created_at: string
  updated_at: string
}

// Report types
export interface TrialBalanceRow {
  account_number: string
  account_name: string
  account_class: number
  opening_debit: number
  opening_credit: number
  period_debit: number
  period_credit: number
  closing_debit: number
  closing_credit: number
}

export interface IncomeStatementSection {
  title: string
  rows: { account_number: string; account_name: string; amount: number }[]
  subtotal: number
}

export interface IncomeStatementReport {
  revenue_sections: IncomeStatementSection[]
  total_revenue: number
  expense_sections: IncomeStatementSection[]
  total_expenses: number
  financial_sections: IncomeStatementSection[]
  total_financial: number
  net_result: number
  period: { start: string; end: string }
}

export interface BalanceSheetSection {
  title: string
  rows: { account_number: string; account_name: string; amount: number }[]
  subtotal: number
}

export interface BalanceSheetReport {
  asset_sections: BalanceSheetSection[]
  total_assets: number
  equity_liability_sections: BalanceSheetSection[]
  total_equity_liabilities: number
  period: { start: string; end: string }
}

export interface ResultatrapportRow {
  account_number: string
  account_name: string
  current_period: number
  prior_period: number
}

export interface ResultatrapportGroup {
  class: number
  class_label: string
  rows: ResultatrapportRow[]
  subtotal_current: number
  subtotal_prior: number
}

export interface ResultatrapportReport {
  groups: ResultatrapportGroup[]
  net_result_current: number
  net_result_prior: number
  period: { start: string; end: string }
  prior_period: { start: string; end: string } | null
}

export interface BalansrapportRow {
  account_number: string
  account_name: string
  ib: number
  ub: number
  period_change: number
}

export interface BalansrapportGroup {
  class: number
  class_label: string
  rows: BalansrapportRow[]
  subtotal_ib: number
  subtotal_ub: number
}

export interface BalansrapportReport {
  groups: BalansrapportGroup[]
  total_assets_ub: number
  total_equity_liabilities_ub: number
  beraknat_resultat: number
  is_balanced: boolean
  period: { start: string; end: string }
}

export interface SIEExportOptions {
  fiscal_period_id: string
  company_name: string
  org_number: string | null
  program_name?: string
  /**
   * When true, omit year-end closing verifikat (source_type = 'year_end')
   * from #VER and from #RES/#UB calculations. Use when handing the file
   * to systems (e.g. eDeklarera) that do their own closing — including
   * our closing entry would zero out the P&L accounts.
   */
  exclude_year_end_closing?: boolean
}

// Input types for creating entries
export interface CreateJournalEntryInput {
  fiscal_period_id: string
  entry_date: string
  description: string
  source_type: JournalEntrySourceType
  source_id?: string
  voucher_series?: string
  notes?: string
  lines: CreateJournalEntryLineInput[]
}

export interface CreateJournalEntryLineInput {
  account_number: string
  debit_amount: number
  credit_amount: number
  line_description?: string
  currency?: string
  amount_in_currency?: number
  exchange_rate?: number
  tax_code?: string
  cost_center?: string
  project?: string
}

export interface CreateFiscalPeriodInput {
  name: string
  period_start: string
  period_end: string
}

// ── Pending Operations ────────────────────────────────────────

export type PendingOperationType =
  | 'categorize_transaction'
  | 'create_customer'
  | 'create_supplier'
  | 'create_invoice'
  | 'mark_invoice_paid'
  | 'send_invoice'
  | 'mark_invoice_sent'
  | 'match_transaction_invoice'
  // Stream 1 Phase 1: bookkeeping period operations
  | 'close_period'
  | 'lock_period'
  | 'unlock_period'
  | 'set_opening_balances'
  | 'run_year_end'
  | 'run_currency_revaluation'
  // Stream 1 Phase 1: SIE import (export is read-only)
  | 'import_sie'
  // SIE undo: hard-deletes the import's journal entries and releases the
  // (company_id, file_hash) slot. Recovery for botched imports.
  | 'undo_sie_import'
  // Stream 1 Phase 1: voucher gap explanations
  | 'explain_voucher_gap'
  // Stream 1 Phase 1: transaction reversal
  | 'uncategorize_transaction'
  // Document inbox: pin doc to bank transaction
  | 'attach_document_to_transaction'
  // Manual transaction ingestion (uncategorized row, reversible by delete)
  | 'create_transaction'
  // Stream 1 Phase 1: supplier invoice lifecycle
  | 'approve_supplier_invoice'
  | 'credit_supplier_invoice'
  // Phase 5: convert an OCR'd inbox item to a leverantörsfaktura + registration JE
  | 'create_supplier_invoice_from_inbox'
  // Stream 1 Phase 1: invoice operations beyond simple create/send
  | 'credit_invoice'
  | 'convert_invoice'
  // Phase 4: arbitrary-line bookkeeping primitives
  | 'create_voucher'
  | 'correct_entry'
  // Pure makulering (storno) of a posted entry — agent-native API plan item 38
  | 'reverse_entry'
  // Bokslut: planenlig avskrivning (one journal entry per asset)
  | 'post_annual_depreciation'
  // Payroll: salary run creation + AGI declaration
  | 'create_salary_run'
  | 'generate_agi'
  // Mark invoice paid by linking an existing posted verifikat (no new JE)
  | 'link_invoice_voucher'
  // Supplier-side mirror: mark a leverantörsfaktura paid by linking an existing
  // posted verifikat that debits 2440 (no new JE)
  | 'link_supplier_invoice_voucher'
  // PR #603/#607: allocate 1 bank tx across N customer or supplier invoices
  | 'match_batch_allocate'
  // PR #606/#610: bulk-book N bank txs into 1 combined verifikat
  | 'bulk_book_transactions'
  // PR #614: link a single bank tx to an already-posted verifikat (no new JE)
  | 'link_transaction_journal_entry'
export type PendingOperationStatus = 'pending' | 'committing' | 'committed' | 'rejected'

export type PendingOperationActorType = 'user' | 'api_key' | 'mcp_oauth' | 'cron'
export type PendingOperationRiskLevel = 'low' | 'medium' | 'high'

export interface PendingOperationAgentMetadata {
  conversation_id?: string
  intent_id?: string
  model?: string
  model_version?: string
  prompt_hash?: string
  atoms_loaded?: string[]
  approved_by_user_id?: string
}

export type PendingOperationRejectionCategory =
  | 'wrong_category'
  | 'wrong_amount'
  | 'duplicate'
  | 'wrong_period'
  | 'other'

export interface PendingOperation {
  id: string
  user_id: string
  company_id: string
  operation_type: PendingOperationType
  status: PendingOperationStatus
  title: string
  params: Record<string, unknown>
  preview_data: Record<string, unknown>
  result_data: Record<string, unknown> | null
  // Stream 2 Phase 1: actor model
  actor_type: PendingOperationActorType
  actor_id: string | null
  actor_label: string | null
  risk_level: PendingOperationRiskLevel
  // Stream 2 Phase 3: agent provenance (populated by chat loop, NULL for user-staged)
  agent_metadata: PendingOperationAgentMetadata | null
  // Stream 2 Phase 4: structured rejection so the agent can learn from "no"
  rejection_category: PendingOperationRejectionCategory | null
  rejection_reason: string | null
  created_at: string
  resolved_at: string | null
  updated_at: string
}

// Onboarding progress for new user checklist
export interface OnboardingProgress {
  hasCustomers: boolean
  hasInvoices: boolean
  hasBankConnected: boolean
  hasSIEImport: boolean
  /** True when the active user has a stored Skatteverket OAuth token. */
  hasSkatteverketConnected: boolean
}

// Onboarding step data
export interface OnboardingStepData {
  step1?: {
    entity_type: EntityType
  }
  step2?: {
    company_name: string
    org_number?: string
    address_line1?: string
    postal_code?: string
    city?: string
  }
  step3?: {
    f_skatt: boolean
    fiscal_year_start_month: number
    is_first_fiscal_year?: boolean
    first_year_start?: string
    first_year_end?: string
    vat_registered: boolean
    vat_number?: string
    moms_period?: MomsPeriod
  }
  step4?: {
    preliminary_tax_monthly?: number
  }
  step5?: {
    bank_name?: string
    clearing_number?: string
    account_number?: string
    iban?: string
    bic?: string
  }
  step6?: {
    bank_connected: boolean
    bank_connection_id?: string
  }
}

// ============================================================
// Calendar & Deadline Types
// ============================================================

// Calendar view mode
export type CalendarViewMode = 'month' | 'week' | 'day'

// Payment calendar day (for invoice due date tracking)
export interface PaymentCalendarDay {
  date: string
  invoices: Invoice[]
  totalExpected: number
  overdueCount: number
}

// Tax deadline types (Swedish Skatteverket)
export type TaxDeadlineType =
  | 'moms_monthly'
  | 'moms_quarterly'
  | 'moms_yearly'
  | 'f_skatt'
  | 'arbetsgivardeklaration'
  | 'inkomstdeklaration_ef'
  | 'inkomstdeklaration_ab'
  | 'arsredovisning'
  | 'periodisk_sammanstallning'
  | 'bokslut'

// Deadline status workflow
export type DeadlineStatus =
  | 'upcoming'       // More than 14 days away
  | 'action_needed'  // Within 14 days, needs attention
  | 'in_progress'    // User is working on it
  | 'submitted'      // Submitted to Skatteverket
  | 'confirmed'      // Confirmed/acknowledged
  | 'overdue'        // Past due date without submission

// Deadline source
export type DeadlineSource = 'system' | 'user'

// Deadline types
export type DeadlineType = 'delivery' | 'invoicing' | 'report' | 'tax' | 'other'
export type DeadlinePriority = 'critical' | 'important' | 'normal'

// Deadline record
export interface Deadline {
  id: string
  user_id: string
  company_id: string
  title: string
  due_date: string
  due_time: string | null
  deadline_type: DeadlineType
  priority: DeadlinePriority
  is_completed: boolean
  completed_at: string | null
  customer_id: string | null
  is_auto_generated: boolean
  notes: string | null
  created_at: string
  updated_at: string

  // Tax deadline fields
  tax_deadline_type: TaxDeadlineType | null
  tax_period: string | null
  source: DeadlineSource
  reminder_offsets: number[] | null
  status: DeadlineStatus
  status_changed_at: string
  linked_report_type: string | null
  linked_report_period: Record<string, unknown> | null

  // Relations
  customer?: Customer
}

// Input for creating a deadline
export interface CreateDeadlineInput {
  title: string
  due_date: string
  due_time?: string
  deadline_type: DeadlineType
  priority?: DeadlinePriority
  customer_id?: string
  notes?: string
  // Tax deadline fields
  tax_deadline_type?: TaxDeadlineType
  tax_period?: string
  source?: DeadlineSource
  linked_report_type?: string
  linked_report_period?: Record<string, unknown>
}

// ============================================================
// Push Notification Types
// ============================================================

// Push subscription for Web Push API
export interface PushSubscription {
  id: string
  user_id: string
  endpoint: string
  p256dh: string
  auth: string
  user_agent: string | null
  is_active: boolean
  last_used_at: string | null
  created_at: string
}

// Notification settings per user
export interface NotificationSettings {
  id: string
  user_id: string
  tax_deadlines_enabled: boolean
  invoice_reminders_enabled: boolean
  quiet_start: string // time format "HH:MM"
  quiet_end: string   // time format "HH:MM"
  email_enabled: boolean
  push_enabled: boolean
  period_locked_enabled: boolean
  period_year_closed_enabled: boolean
  invoice_sent_enabled: boolean
  receipt_extracted_enabled: boolean
  receipt_matched_enabled: boolean
  created_at: string
  updated_at: string
}

// Notification type for logging
export type NotificationType =
  | 'tax_deadline'
  | 'invoice_due'
  | 'invoice_overdue'
  | 'period_locked'
  | 'period_year_closed'
  | 'receipt_extracted'
  | 'receipt_matched'
  | 'invoice_sent'
  | 'missing_underlag'

// Notification log entry
export interface NotificationLog {
  id: string
  user_id: string
  company_id: string | null
  notification_type: NotificationType
  reference_id: string
  days_before: number
  sent_at: string
  delivery_status: 'sent' | 'delivered' | 'failed'
}

// ============================================================
// Calendar Feed Types (ICS)
// ============================================================

// Calendar feed for Apple Calendar / Google Calendar sync
export interface CalendarFeed {
  id: string
  user_id: string
  company_id: string
  feed_token: string
  is_active: boolean
  include_tax_deadlines: boolean
  include_invoices: boolean
  last_accessed_at: string | null
  access_count: number
  created_at: string
  updated_at: string
}

// Input for creating/updating calendar feed
export interface UpdateCalendarFeedInput {
  include_tax_deadlines?: boolean
  include_invoices?: boolean
}

// Swedish labels for deadline status
export const DEADLINE_STATUS_LABELS: Record<DeadlineStatus, string> = {
  upcoming: 'Kommande',
  action_needed: 'Åtgärd krävs',
  in_progress: 'Pågår',
  submitted: 'Inskickad',
  confirmed: 'Bekräftad',
  overdue: 'Försenad'
}

// Swedish labels for tax deadline types
export const TAX_DEADLINE_TYPE_LABELS: Record<TaxDeadlineType, string> = {
  moms_monthly: 'Momsdeklaration (månad)',
  moms_quarterly: 'Momsdeklaration (kvartal)',
  moms_yearly: 'Momsdeklaration (år)',
  f_skatt: 'F-skatt',
  arbetsgivardeklaration: 'Arbetsgivardeklaration',
  inkomstdeklaration_ef: 'Inkomstdeklaration EF',
  inkomstdeklaration_ab: 'Inkomstdeklaration AB',
  arsredovisning: 'Årsredovisning',
  periodisk_sammanstallning: 'Periodisk sammanställning',
  bokslut: 'Bokslut'
}

// ============================================================
// SIE Import Types
// ============================================================

// SIE import status
export type SIEImportStatus = 'pending' | 'mapped' | 'completed' | 'failed'

// SIE import record
export interface SIEImport {
  id: string
  user_id: string
  company_id: string
  filename: string
  file_hash: string
  org_number: string | null
  company_name: string | null
  sie_type: number
  fiscal_year_start: string | null
  fiscal_year_end: string | null
  accounts_count: number
  transactions_count: number
  opening_balance_total: number | null
  status: SIEImportStatus
  error_message: string | null
  fiscal_period_id: string | null
  opening_balance_entry_id: string | null
  imported_at: string | null
  created_at: string
  updated_at: string
}

// SIE account mapping record
export interface SIEAccountMapping {
  id: string
  user_id: string
  company_id: string
  source_account: string
  source_name: string | null
  target_account: string
  confidence: number
  match_type: 'exact' | 'name' | 'class' | 'manual'
  created_at: string
  updated_at: string
}

// ============================================================
// Invoice Inbox Types
// ============================================================

export type InboxItemStatus = 'received' | 'error'
export type InboxItemSource = 'email' | 'upload'

export type CompanyInboxStatus = 'active' | 'deprecated' | 'blocked'

export interface CompanyInbox {
  id: string
  company_id: string
  local_part: string
  status: CompanyInboxStatus
  slug_seed: string
  created_at: string
  updated_at: string
  deprecated_at: string | null
}

export interface InvoiceInboxItem {
  id: string
  user_id: string
  company_id: string
  status: InboxItemStatus
  source: InboxItemSource
  email_from: string | null
  email_subject: string | null
  email_received_at: string | null
  email_body_text: string | null
  resend_email_id: string | null
  resend_attachment_id: string | null
  document_id: string | null
  extracted_data: Record<string, unknown> | null
  matched_supplier_id: string | null
  created_supplier_invoice_id: string | null
  matched_transaction_id: string | null
  created_journal_entry_id: string | null
  error_message: string | null
  raw_email_payload: Record<string, unknown> | null

  // Audit chain (processing_history correlation)
  correlation_id: string | null

  created_at: string
  updated_at: string

  // Relations (populated when fetched)
  document?: DocumentAttachment
  supplier?: Supplier
  supplier_invoice?: SupplierInvoice
}

// ============================================================
// Receipt Types
// ============================================================

// Receipt extraction status
export type ReceiptStatus = 'pending' | 'processing' | 'extracted' | 'confirmed' | 'error'

// Receipt record
export interface Receipt {
  id: string
  user_id: string
  company_id: string

  // Image storage
  image_url: string
  image_thumbnail_url: string | null

  // Extraction status
  status: ReceiptStatus
  extraction_confidence: number | null

  // Extracted header data
  merchant_name: string | null
  merchant_org_number: string | null
  merchant_vat_number: string | null
  receipt_date: string | null
  receipt_time: string | null
  total_amount: number | null
  currency: string
  vat_amount: number | null

  // Special flags
  is_restaurant: boolean
  is_systembolaget: boolean
  is_foreign_merchant: boolean

  // Restaurant representation data
  representation_persons: number | null
  representation_purpose: string | null
  representation_business_connection: string | null

  // Source tracking (for email-originated receipts)
  source: 'upload' | 'camera' | 'email'
  email_from: string | null

  // Transaction matching
  matched_transaction_id: string | null
  match_confidence: number | null

  // Raw extraction data
  raw_extraction: ReceiptExtractionResult | null

  created_at: string
  updated_at: string

  // Relations (populated when fetched)
  line_items?: ReceiptLineItem[]
  matched_transaction?: Transaction
}

// Receipt line item record
export interface ReceiptLineItem {
  id: string
  receipt_id: string

  // Extracted data
  description: string
  quantity: number
  unit_price: number | null
  line_total: number
  vat_rate: number | null
  vat_amount: number | null

  // Classification
  is_business: boolean | null
  category: TransactionCategory | null
  bas_account: string | null

  // Confidence
  extraction_confidence: number | null
  suggested_category: string | null

  sort_order: number
  created_at: string
}

// AI extraction result from Claude Vision
export interface ReceiptExtractionResult {
  merchant: {
    name: string | null
    orgNumber: string | null
    vatNumber: string | null
    isForeign: boolean
  }
  receipt: {
    date: string | null
    time: string | null
    currency: string
  }
  lineItems: ExtractedLineItem[]
  totals: {
    subtotal: number | null
    vatAmount: number | null
    total: number | null
  }
  flags: {
    isRestaurant: boolean
    isSystembolaget: boolean
    isForeignMerchant: boolean
  }
  confidence: number
  suggestedTemplateId?: string
}

// Extracted line item from AI
export interface ExtractedLineItem {
  description: string
  quantity: number
  unitPrice: number | null
  lineTotal: number
  vatRate: number | null
  suggestedCategory: string | null
  suggestedTemplateId?: string
  confidence?: number
}

// Match candidate for receipt-to-transaction matching
export interface ReceiptMatchCandidate {
  transaction: Transaction
  confidence: number
  matchReasons: string[]
  dateVariance: number
  amountVariance: number
}

// Input for creating a receipt
export interface CreateReceiptInput {
  image_url: string
  image_thumbnail_url?: string
}

// Input for confirming receipt line items
export interface ConfirmReceiptInput {
  line_items: ConfirmLineItemInput[]
  matched_transaction_id?: string
  representation_persons?: number
  representation_purpose?: string
}

export interface ConfirmLineItemInput {
  id: string
  is_business: boolean
  category?: TransactionCategory
  bas_account?: string
}

// Receipt queue summary
export interface ReceiptQueueSummary {
  unmatched_receipts_count: number
  unmatched_transactions_count: number
  pending_review_count: number
  streak_count: number
}

// Camera quality feedback
export interface CameraQualityFeedback {
  lightingOk: boolean
  distanceOk: boolean
  focusOk: boolean
  readyToCapture: boolean
  message?: string
}

// Swedish labels for receipt status
export const RECEIPT_STATUS_LABELS: Record<ReceiptStatus, string> = {
  pending: 'Väntar',
  processing: 'Analyserar',
  extracted: 'Extraherat',
  confirmed: 'Bekräftat',
  error: 'Fel'
}

// ============================================================
// VAT Declaration Types (Momsdeklaration)
// ============================================================

// VAT period type
export type VatPeriodType = 'monthly' | 'quarterly' | 'yearly'

// VAT declaration rutor (boxes) according to SKV 4700
// Complete set of all 30 boxes in the momsdeklaration form.
export interface VatDeclarationRutor {
  // Momspliktig försäljning (taxable sales basis, all rates combined)
  ruta05: number  // Momspliktig försäljning (excl. ruta 06, 07, 08)
  ruta06: number  // Momspliktiga uttag (always 0 for most users)
  ruta07: number  // Vinstmarginalbeskattning (always 0 for most users)
  ruta08: number  // Hyresinkomster frivillig beskattning (always 0 for most users)

  // Utgående moms (Output VAT per rate)
  ruta10: number  // Utgående moms 25%
  ruta11: number  // Utgående moms 12%
  ruta12: number  // Utgående moms 6%

  // Inköp vid omvänd skattskyldighet (reverse charge purchase bases)
  ruta20: number  // Inköp av varor från annat EU-land
  ruta21: number  // Inköp av tjänster från annat EU-land
  ruta22: number  // Inköp av tjänster från land utanför EU
  ruta23: number  // Inköp av varor i Sverige (construction reverse charge goods)
  ruta24: number  // Övriga inköp av tjänster i Sverige (domestic reverse charge)

  // Utgående moms omvänd skattskyldighet (self-assessed output VAT on reverse charge)
  ruta30: number  // Utgående moms 25% omvänd skattskyldighet
  ruta31: number  // Utgående moms 12% omvänd skattskyldighet
  ruta32: number  // Utgående moms 6% omvänd skattskyldighet

  // EU och export försäljning
  ruta35: number  // Varuförsäljning till annat EU-land
  ruta36: number  // Varuförsäljning utanför EU (export)
  ruta37: number  // Mellanmans inköp vid trepartshandel
  ruta38: number  // Mellanmans försäljning vid trepartshandel
  ruta39: number  // Försäljning av tjänster till annat EU-land (reverse charge)
  ruta40: number  // Övrig försäljning av tjänster utomlands
  ruta41: number  // Försäljning med omvänd skattskyldighet (Sverige)
  ruta42: number  // Övrig momsfri försäljning m.m.

  // Ingående moms (Input VAT)
  ruta48: number  // Ingående moms att dra av

  // Moms att betala eller få tillbaka
  ruta49: number  // Moms att betala (positive) eller återfå (negative)

  // Import (via Tullverket)
  ruta50: number  // Beskattningsunderlag vid import
  ruta60: number  // Utgående moms 25% import
  ruta61: number  // Utgående moms 12% import
  ruta62: number  // Utgående moms 6% import
}

// VAT declaration response
export interface VatDeclaration {
  period: {
    type: VatPeriodType
    year: number
    period: number  // 1-12 for monthly, 1-4 for quarterly, 1 for yearly
    start: string   // YYYY-MM-DD
    end: string     // YYYY-MM-DD
  }
  rutor: VatDeclarationRutor
  // Supporting data
  invoiceCount: number
  transactionCount: number
  // Breakdown by source
  breakdown: {
    invoices: {
      ruta05: number
      ruta06: number
      ruta07: number
      ruta10: number
      ruta11: number
      ruta12: number
      ruta39: number
      ruta40: number
      // Per-rate base amounts for UI display
      base25: number
      base12: number
      base6: number
    }
    transactions: {
      ruta48: number  // Ingående moms from categorized expenses
    }
    receipts: {
      ruta48: number  // Ingående moms from receipts
    }
    reverseCharge: {
      ruta20: number
      ruta21: number
      ruta22: number
      ruta23: number
      ruta24: number
      ruta30: number
      ruta31: number
      ruta32: number
    }
  }
}

// VAT declaration request parameters
export interface VatDeclarationRequest {
  periodType: VatPeriodType
  year: number
  period: number
}

// Labels for VAT rutor
export const VAT_RUTA_LABELS: Record<keyof VatDeclarationRutor, string> = {
  ruta05: 'Momspliktig försäljning',
  ruta06: 'Momspliktiga uttag',
  ruta07: 'Vinstmarginalbeskattning',
  ruta08: 'Hyresinkomster (frivillig beskattning)',
  ruta10: 'Utgående moms 25%',
  ruta11: 'Utgående moms 12%',
  ruta12: 'Utgående moms 6%',
  ruta20: 'Inköp av varor från annat EU-land',
  ruta21: 'Inköp av tjänster från annat EU-land',
  ruta22: 'Inköp av tjänster från land utanför EU',
  ruta23: 'Inköp av varor i Sverige',
  ruta24: 'Övriga inköp av tjänster i Sverige',
  ruta30: 'Utgående moms 25% (omvänd skattskyldighet)',
  ruta31: 'Utgående moms 12% (omvänd skattskyldighet)',
  ruta32: 'Utgående moms 6% (omvänd skattskyldighet)',
  ruta35: 'Varuförsäljning till annat EU-land',
  ruta36: 'Varuförsäljning utanför EU (export)',
  ruta37: 'Mellanmans inköp vid trepartshandel',
  ruta38: 'Mellanmans försäljning vid trepartshandel',
  ruta39: 'Försäljning av tjänster till EU-land',
  ruta40: 'Övrig försäljning av tjänster utomlands',
  ruta41: 'Försäljning med omvänd skattskyldighet (Sverige)',
  ruta42: 'Övrig momsfri försäljning m.m.',
  ruta48: 'Ingående moms att dra av',
  ruta49: 'Moms att betala/återfå',
  ruta50: 'Beskattningsunderlag vid import',
  ruta60: 'Utgående moms 25% import',
  ruta61: 'Utgående moms 12% import',
  ruta62: 'Utgående moms 6% import',
}

// ============================================================
// Event Payload Placeholder Types
// ============================================================

/** Credit note is an invoice with a credited_invoice_id */
export interface CreditNote extends Invoice {
  credited_invoice_id: string
}

/** Generic key-value store record for extensions */
export interface ExtensionDataRecord {
  id: string
  user_id: string
  company_id: string
  extension_id: string
  key: string
  value: Record<string, unknown>
  created_at: string
  updated_at: string
}

// ============================================================
// Tax Code Types
// ============================================================

// Tax code identifiers (standard Swedish codes)
export type TaxCodeId =
  | 'MP1' | 'MP2' | 'MP3'       // Output VAT 25%, 12%, 6%
  | 'MPI' | 'MPI12' | 'MPI6'    // Input VAT 25%, 12%, 6%
  | 'IV'                          // Intra-EU acquisition
  | 'EUS'                         // EU sale (reverse charge)
  | 'IP'                          // Import
  | 'EXP'                         // Export outside EU
  | 'OSS'                         // One Stop Shop
  | 'NONE'                        // VAT exempt

export interface TaxCode {
  id: string
  user_id: string | null
  code: string
  description: string
  rate: number
  moms_basis_boxes: string[]
  moms_tax_boxes: string[]
  moms_input_boxes: string[]
  is_output_vat: boolean
  is_reverse_charge: boolean
  is_eu: boolean
  is_export: boolean
  is_oss: boolean
  is_system: boolean
  created_at: string
  updated_at: string
}

// ============================================================
// Document Archive Types
// ============================================================

export type DocumentUploadSource =
  | 'camera'
  | 'file_upload'
  | 'email'
  | 'e_invoice'
  | 'scan'
  | 'api'
  | 'system'

export interface DocumentAttachment {
  id: string
  user_id: string
  company_id: string
  storage_path: string
  file_name: string
  file_size_bytes: number | null
  mime_type: string | null
  sha256_hash: string
  version: number
  original_id: string | null
  superseded_by_id: string | null
  is_current_version: boolean
  uploaded_by: string | null
  upload_source: DocumentUploadSource | null
  digitization_date: string | null
  journal_entry_id: string | null
  journal_entry_line_id: string | null
  prev_version_hash: string | null
  last_integrity_check_at: string | null
  created_at: string
  updated_at: string
}

export interface CreateDocumentAttachmentInput {
  storage_path: string
  file_name: string
  file_size_bytes?: number
  mime_type?: string
  sha256_hash: string
  upload_source?: DocumentUploadSource
  journal_entry_id?: string
  journal_entry_line_id?: string
}

// ============================================================
// Audit Log Types
// ============================================================

export type AuditAction =
  | 'INSERT'
  | 'UPDATE'
  | 'DELETE'
  | 'COMMIT'
  | 'REVERSE'
  | 'CORRECT'
  | 'LOCK_PERIOD'
  | 'CLOSE_PERIOD'
  | 'DOCUMENT_DELETE_BLOCKED'
  | 'RETENTION_BLOCK'
  | 'SECURITY_EVENT'
  | 'INTEGRITY_FAILURE'

export interface AuditLogEntry {
  id: string
  user_id: string
  company_id: string | null
  action: AuditAction
  table_name: string | null
  record_id: string | null
  actor_id: string | null
  actor_type: 'user' | 'api_key' | 'mcp_oauth' | 'cron' | 'system' | null
  actor_label: string | null
  old_state: Record<string, unknown> | null
  new_state: Record<string, unknown> | null
  description: string | null
  created_at: string
}

// ============================================================
// Dimension Types (Kostnadsställen & Projekt)
// ============================================================

export interface CostCenter {
  id: string
  company_id: string
  code: string
  name: string
  is_active: boolean
  created_at: string
  updated_at: string
}

export interface Project {
  id: string
  company_id: string
  code: string
  name: string
  is_active: boolean
  start_date: string | null
  end_date: string | null
  created_at: string
  updated_at: string
}

// ============================================================
// Voucher Gap Detection
// ============================================================

export interface VoucherGap {
  gap_start: number
  gap_end: number
  series: string
}

export interface VoucherGapExplanation {
  id: string
  company_id: string
  user_id: string
  fiscal_period_id: string
  voucher_series: string
  gap_start: number
  gap_end: number
  explanation: string
  created_at: string
  updated_at: string
}

export interface SequenceMismatch {
  series: string
  sequenceCounter: number
  actualMax: number
}

// ============================================================
// Year-End Closing Types (Årsbokslut)
// ============================================================

export interface YearEndValidation {
  ready: boolean
  errors: string[]
  warnings: string[]
  draftCount: number
  voucherGaps: VoucherGap[]
  unexplainedGaps: VoucherGap[]
  sequenceMismatches: SequenceMismatch[]
  trialBalanceBalanced: boolean
}

export interface YearEndPreview {
  netResult: number
  closingAccount: string
  closingAccountName: string
  closingLines: CreateJournalEntryLineInput[]
  resultAccountSummary: { account_number: string; account_name: string; amount: number }[]
  currencyRevaluation: CurrencyRevaluationPreview | null
}

export interface YearEndResult {
  closingEntry: JournalEntry
  nextPeriod: FiscalPeriod
  openingBalanceEntry: JournalEntry
  revaluationEntry: JournalEntry | null
  /**
   * IB/UB reconciliation per balance sheet account, computed after the
   * opening balances are posted. Surfaced to the UI's ResultStep so the
   * user can verify continuity before navigating away. Always within
   * ORE_TOLERANCE — otherwise executeYearEndClosing would have thrown.
   */
  continuity?: ContinuityCheckResult
}

// ============================================================
// Asset Register Types (Anläggningsregister)
// ============================================================

export type AssetCategory =
  | 'immaterial'
  | 'building'
  | 'land_improvement'
  | 'machinery'
  | 'equipment'
  | 'vehicle'
  | 'computer'
  | 'other_tangible'

export type DepreciationMethod =
  | 'linear'
  | 'declining_balance_30'
  | 'declining_balance_20'
  | 'restvardesavskrivning_25'

/**
 * K3 component (BFNAR 2012:1 ch 17.4 — komponentavskrivning). When a
 * substantial asset (typically real estate) has significant components with
 * materially different useful lives, K3 reporting requires each component to
 * be depreciated on its own life rather than treating the asset as a single
 * unit. Components are stored as an array on `Asset.k3_components`; when
 * non-null, the depreciation engine routes through `computeComponentDepreciation`
 * and sums per-component linear depreciation (with the same pro-ration logic
 * as the asset-level linear method).
 *
 * Validation (enforced in `lib/bokslut/assets/k3-components.ts`):
 *   - sum(components.cost) === asset.acquisition_cost (±1 kr tolerance)
 *   - every component: cost > 0, useful_life_months > 0
 *   - salvage_value (if present) ≤ component cost
 *   - non-empty array when set to non-null
 *
 * Salvage_value defaults to 0 when omitted.
 */
export interface K3Component {
  name: string
  cost: number
  useful_life_months: number
  salvage_value?: number
}

export interface Asset {
  id: string
  user_id: string
  company_id: string
  name: string
  category: AssetCategory
  acquisition_date: string
  acquisition_cost: number
  salvage_value: number
  useful_life_months: number
  depreciation_method: DepreciationMethod
  bas_asset_account: string
  bas_accumulated_account: string
  bas_expense_account: string
  /** Book-value floor for restvärdeavskrivning (IL 18 kap 13§ st.3). Required
   *  iff depreciation_method = 'restvardesavskrivning_25'; null otherwise. */
  restvarde_target: number | null
  disposed_at: string | null
  disposed_proceeds: number | null
  /** Output VAT on disposal proceeds (ML 3 kap 3 § / 7 kap 3 §). Defaults to
   *  0 — only nonzero when the sale was momspliktig. The VAT account
   *  (2611/2621/2631) is derived from disposed_vat_treatment. */
  disposed_proceeds_vat: number
  /** VAT treatment applied to disposal proceeds. Null for legacy disposals
   *  without VAT data. Constrained by DB CHECK to the same enum as
   *  VatTreatment. */
  disposed_vat_treatment: VatTreatment | null
  /** Jämkning amount per ML 8a kap 7 § — input VAT paid back on disposal
   *  inside the correction period. Defaults to 0; positive number = debt
   *  to the state booked on 2641 credit. */
  jamkning_amount: number
  /** Remaining months in the korrigeringstid at disposal date. Audit
   *  metadata only — the booking sits on the journal entry. */
  jamkning_remaining_months: number | null
  /** Total korrigeringstid in months: 60 (lös egendom) or 120 (fastighet /
   *  markanläggning). Audit metadata. */
  jamkning_total_months: number | null
  /** Original input VAT that was deducted at acquisition. Audit metadata
   *  the user supplies (or the system derives from the supplier invoice). */
  jamkning_original_input_vat: number | null
  /** K3 component depreciation (BFNAR 2012:1 ch.17.4). When non-null, the
   *  depreciation engine sums per-component linear depreciation instead of
   *  applying `depreciation_method` to the asset as a whole. Null for K2
   *  companies (the API rejects writes for accounting_framework='k2'). */
  k3_components: K3Component[] | null
  notes: string | null
  created_at: string
  updated_at: string
}

export interface DepreciationSchedule {
  id: string
  user_id: string
  company_id: string
  asset_id: string
  fiscal_period_id: string
  planned_depreciation: number
  journal_entry_id: string | null
  posted_at: string | null
  created_at: string
  updated_at: string
}

// ============================================================
// IB/UB Continuity Check Types (Avstämning ingående/utgående balans)
// ============================================================

export interface ContinuityDiscrepancy {
  account_number: string
  account_name: string
  previous_ub_net: number
  current_ib_net: number
  difference: number
}

export interface ContinuityCheckResult {
  valid: boolean
  period_name: string
  previous_period_name: string | null
  discrepancies: ContinuityDiscrepancy[]
  checked_accounts: number
}

// ============================================================
// Currency Revaluation Types (Omvärdering utländsk valuta)
// ============================================================

export interface RevaluationItem {
  type: 'receivable' | 'payable'
  source_id: string
  reference: string
  currency: Currency
  amount_in_currency: number
  original_rate: number
  closing_rate: number
  original_sek: number
  closing_sek: number
  difference_sek: number
}

export interface CurrencyRevaluationPreview {
  items: RevaluationItem[]
  lines: CreateJournalEntryLineInput[]
  closingRates: Record<string, number>
  totalGain: number
  totalLoss: number
  netEffect: number
}

export interface CurrencyRevaluationResult {
  entry: JournalEntry
  preview: CurrencyRevaluationPreview
}

export interface PeriodStatus {
  is_locked: boolean
  is_closed: boolean
  has_closing_entry: boolean
  has_opening_balances: boolean
  draft_count: number
  next_period_exists: boolean
}

// ============================================================
// Invoice Reminder Types (Betalningspåminnelser)
// ============================================================

// Response type from customer action
export type ReminderResponseType = 'marked_paid' | 'disputed'

// Invoice reminder record
export interface InvoiceReminder {
  id: string
  invoice_id: string
  user_id: string
  company_id: string
  reminder_level: 1 | 2 | 3
  sent_at: string
  email_to: string
  response_type: ReminderResponseType | null
  response_at: string | null
  action_token: string
  action_token_used: boolean
  created_at: string
  // Dröjsmålsränta + lagstadgad påminnelseavgift (Räntelagen §6, Lag 1981:739)
  interest_amount: number
  interest_rate: number | null
  interest_from_date: string | null
  interest_days: number | null
  reminder_fee: number
  fee_journal_entry_id: string | null
}

// Swedish labels for reminder levels
export const REMINDER_LEVEL_LABELS: Record<1 | 2 | 3, string> = {
  1: 'Vänlig påminnelse',
  2: 'Andra påminnelsen',
  3: 'Slutlig påminnelse'
}

// Reminder level descriptions
export const REMINDER_LEVEL_DESCRIPTIONS: Record<1 | 2 | 3, string> = {
  1: '15 dagar efter förfallodatum',
  2: '30 dagar efter förfallodatum',
  3: '45 dagar efter förfallodatum'
}

// ============================================================
// Transaction Ingestion Types (re-exported for extension use)
// ============================================================

/** Normalized transaction input for the generic ingestion pipeline */
export interface RawTransaction {
  date: string
  description: string
  amount: number
  currency: string
  external_id: string
  mcc_code?: number | null
  merchant_name?: string | null
  reference?: string | null
  bank_connection_id?: string | null
  import_source?: string
  /**
   * Counterparty IBAN from PSD2 (creditor for outflows, debtor for inflows).
   * Used by the own-account transfer detector — when this matches another
   * cash_accounts row for the same company, both legs auto-book as a transfer.
   */
  counterparty_iban?: string | null
  /**
   * Bankgiro / Plusgiro / BBAN fallback when no IBAN is available (typical
   * for Swedish domestic transfers). Kept distinct from IBAN so matching
   * doesn't accidentally collide BG numbers with IBAN strings.
   */
  counterparty_account?: string | null
}

/** Options for the transaction ingestion pipeline */
export interface IngestOptions {
  /** Skip auto-categorization (mapping engine + journal entry creation).
   * Reconciliation and invoice matching still run.
   * Used when SIE-imported entries overlap the sync date range
   * to prevent double-booking. */
  skipAutoCategorization?: boolean
  /** Override the default settlement account (1930) for bank transactions.
   * Used when importing to a secondary bank account (e.g., 1931). */
  settlementAccount?: string
  /** Only INSERT transactions + dedup. Skip reconciliation, invoice matching,
   * supplier matching, and auto-categorization. For viewer imports. */
  rawInsertOnly?: boolean
}

/** Result of the transaction ingestion pipeline */
export interface IngestResult {
  imported: number
  duplicates: number
  reconciled: number
  auto_categorized: number
  auto_matched_invoices: number
  errors: number
  transaction_ids: string[]
  /** First insert error encountered, surfaced for debugging. Optional. */
  first_error?: { message: string; code?: string | null; details?: string | null; hint?: string | null }
}

// ── Invoice extraction (used by invoice-inbox extension and core utils) ──

export interface InvoiceExtractionResult {
  supplier: {
    name: string | null
    orgNumber: string | null
    vatNumber: string | null
    address: string | null
    bankgiro: string | null
    plusgiro: string | null
  }
  invoice: {
    invoiceNumber: string | null
    invoiceDate: string | null
    dueDate: string | null
    paymentReference: string | null
    currency: string
  }
  lineItems: ExtractedInvoiceLineItem[]
  totals: {
    subtotal: number | null
    vatAmount: number | null
    total: number | null
  }
  vatBreakdown: VatBreakdownItem[]
  confidence: number
  suggestedTemplateId?: string
}

export interface ExtractedInvoiceLineItem {
  description: string
  quantity: number
  unitPrice: number | null
  lineTotal: number
  vatRate: number | null
  accountSuggestion: string | null
  suggestedTemplateId?: string
}

export interface VatBreakdownItem {
  rate: number
  base: number
  amount: number
}

// KPI Report
export interface KPIReport {
  netResult: number                // SEK
  cashPosition: number             // SEK (sum of 19xx account balances)
  outstandingReceivables: number   // SEK
  overdueReceivables: number       // SEK
  vatLiability: number             // SEK, ruta 49 (positive = owe, negative = refund)
  totalRevenue: number             // SEK
  totalExpenses: number            // SEK
  grossMargin: number | null       // percentage, null if no revenue
  expenseRatio: number | null      // percentage, null if no revenue
  avgPaymentDays: number | null    // days, null if fewer than 5 paid invoices
  periodComplete: boolean          // whether selected period is closed/complete
  months: { label: string; income: number; expenses: number; net: number }[]
  period: { start: string; end: string }
  expenseComposition: {
    class4: number
    class5: number
    class6: number
    class7: number
  }
  topSuppliers: { supplier_id: string; supplier_name: string; total: number }[]
}

export interface KPIPreferences {
  visibleKpis: string[]
  kpiOrder: string[]
  accountOverrides: Record<string, string[]>
}

// ============================================================
// Salary Module Types (Lönehantering)
// ============================================================

export type EmploymentType = 'employee' | 'company_owner' | 'board_member'
export type SalaryType = 'monthly' | 'hourly'
export type FSkattStatus = 'a_skatt' | 'f_skatt' | 'fa_skatt' | 'not_verified'
export type VacationRule = 'procentregeln' | 'sammaloneregeln' | 'none' | 'semesterersattning'
export type SalaryRunStatus = 'draft' | 'review' | 'approved' | 'paid' | 'booked' | 'corrected'
export type AGIStatus =
  | 'generated'         // XML built from a salary run; nothing sent to SKV yet
  | 'pending_signature' // underlag accepted into Eget utrymme; awaiting BankID
  | 'exported'          // legacy: manual XML download path
  | 'submitted'         // kvittens received; AGI is filed
  | 'accepted'          // reserved (SKV does not currently expose this)
  | 'rejected'          // reserved (kontrollresultat DONE_REJECTED could land here)

export type SalaryLineItemType =
  | 'monthly_salary' | 'hourly_salary'
  | 'overtime' | 'overtime_50' | 'overtime_100'
  | 'ob_weekday_evening' | 'ob_weekend' | 'ob_night' | 'ob_holiday'
  | 'bonus' | 'commission'
  | 'gross_deduction_pension' | 'gross_deduction_other'
  | 'benefit_car' | 'benefit_housing' | 'benefit_meals' | 'benefit_wellness' | 'benefit_bike' | 'benefit_other'
  | 'sick_karens' | 'sick_day2_14' | 'sick_day15_plus'
  | 'vab' | 'parental_leave' | 'unpaid_leave' | 'vacation' | 'semesterersattning'
  | 'traktamente_taxfree' | 'traktamente_taxable'
  | 'mileage_taxfree' | 'mileage_taxable'
  | 'net_deduction_advance' | 'net_deduction_union' | 'net_deduction_benefit_payment'
  | 'net_deduction_other'
  | 'correction' | 'other'

export type ShiftPremiumItemType =
  | 'overtime_50' | 'overtime_100'
  | 'ob_weekday_evening' | 'ob_weekend' | 'ob_night' | 'ob_holiday'

export interface ShiftPremiumRule {
  id: string
  company_id: string
  name: string
  applies_to_all_employees: boolean
  applies_to_employee_ids: string[]
  /** ISO weekday array: 1 = Monday … 7 = Sunday. */
  day_of_week: number[]
  /** 'HH:MM' or 'HH:MM:SS' (PostgreSQL TIME). */
  start_time: string
  /** 'HH:MM' or 'HH:MM:SS'. End values <= start mean the window wraps midnight. */
  end_time: string
  premium_percent: number
  item_type: ShiftPremiumItemType
  priority: number
  is_active: boolean
  created_at: string
  updated_at: string
  created_by: string | null
}

export interface Employee {
  id: string
  company_id: string
  user_id: string
  first_name: string
  last_name: string
  personnummer: string
  personnummer_last4: string
  employment_type: EmploymentType
  employment_start: string
  employment_end: string | null
  employment_degree: number
  salary_type: SalaryType
  monthly_salary: number | null
  hourly_rate: number | null
  tax_table_number: number | null
  tax_column: number
  tax_municipality: string | null
  jamkning_percentage: number | null
  jamkning_valid_from: string | null
  jamkning_valid_to: string | null
  is_sidoinkomst: boolean
  f_skatt_status: FSkattStatus
  f_skatt_verified_at: string | null
  clearing_number: string | null
  bank_account_number: string | null
  vacation_rule: VacationRule
  vacation_days_per_year: number
  vacation_days_saved: number
  semestertillagg_rate: number
  email: string | null
  phone: string | null
  address_line1: string | null
  postal_code: string | null
  city: string | null
  specification_number: number | null
  vaxa_stod_eligible: boolean
  vaxa_stod_start: string | null
  vaxa_stod_end: string | null
  is_active: boolean
  created_at: string
  updated_at: string
}

export interface SalaryRun {
  id: string
  company_id: string
  user_id: string
  period_year: number
  period_month: number
  payment_date: string
  status: SalaryRunStatus
  voucher_series: string
  total_gross: number
  total_tax: number
  total_net: number
  total_avgifter: number
  total_vacation_accrual: number
  total_employer_cost: number
  salary_entry_id: string | null
  avgifter_entry_id: string | null
  vacation_entry_id: string | null
  agi_generated_at: string | null
  agi_submitted_at: string | null
  payment_file_format: 'bg_lb' | 'pain001' | null
  payment_file_generated_at: string | null
  calculation_params: Record<string, unknown> | null
  approved_by: string | null
  approved_at: string | null
  paid_at: string | null
  booked_at: string | null
  booked_by: string | null
  notes: string | null
  is_correction: boolean
  corrects_run_id: string | null
  created_at: string
  updated_at: string
  // Relations
  employees?: SalaryRunEmployee[]
}

export interface SalaryRunEmployee {
  id: string
  salary_run_id: string
  employee_id: string
  company_id: string
  employment_degree: number
  monthly_salary: number
  salary_type: string
  hours_worked: number | null
  gross_salary: number
  gross_deductions: number
  benefit_values: number
  taxable_income: number
  tax_withheld: number
  tax_withheld_override: number | null
  net_deductions: number
  net_salary: number
  avgifter_rate: number
  avgifter_amount: number
  avgifter_amount_override: number | null
  avgifter_basis: number
  avgifter_basis_override: number | null
  override_reason: string | null
  vacation_accrual: number
  vacation_accrual_avgifter: number
  tax_table_number: number | null
  tax_column: number | null
  tax_table_year: number | null
  sick_days: number
  vab_days: number
  parental_days: number
  vacation_days_taken: number
  calculation_breakdown: Record<string, unknown> | null
  ytd_gross: number
  ytd_tax: number
  ytd_net: number
  created_at: string
  updated_at: string
  // Relations
  employee?: Employee
  line_items?: SalaryLineItem[]
}

export interface SalaryLineItem {
  id: string
  salary_run_employee_id: string
  company_id: string
  item_type: SalaryLineItemType
  description: string
  quantity: number | null
  unit_price: number | null
  amount: number
  is_taxable: boolean
  is_avgift_basis: boolean
  is_vacation_basis: boolean
  is_gross_deduction: boolean
  is_net_deduction: boolean
  account_number: string | null
  sort_order: number
  created_at: string
  updated_at: string
}

export interface AGIDeclaration {
  id: string
  company_id: string
  user_id: string
  salary_run_id: string | null
  period_year: number
  period_month: number
  xml_content: string
  status: AGIStatus
  individuppgifter: Record<string, unknown>[]
  total_gross: number
  total_tax: number
  total_avgifter_basis: number
  total_avgifter: number
  employee_count: number
  kvittensnummer: string | null
  submitted_at: string | null
  submitted_by: string | null
  response_data: Record<string, unknown> | null
  is_correction: boolean
  corrects_agi_id: string | null
  created_at: string
  updated_at: string
}

