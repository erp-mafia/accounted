// Entity types
export type EntityType = 'enskild_firma' | 'aktiebolag'

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
export type SupplierInvoiceStatus = 'registered' | 'approved' | 'paid' | 'partially_paid' | 'overdue' | 'disputed' | 'credited'

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

// Bank connection status
export type BankConnectionStatus = 'pending' | 'active' | 'expired' | 'revoked' | 'error'

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

  // Invoice PDF settings
  ore_rounding: boolean
  invoice_show_ocr: boolean
  invoice_show_bankgiro: boolean
  invoice_show_plusgiro: boolean
  invoice_late_fee_text: string | null
  invoice_credit_terms_text: string | null

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

  // Details
  date: string
  description: string
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

  // Reconciliation
  reconciliation_method: ReconciliationMethod | null

  // Import tracking
  import_source: string | null
  reference: string | null  // OCR number, Bankgiro reference

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

  // Invoice number (auto-generated)
  invoice_number: string

  // Dates
  invoice_date: string
  due_date: string

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

  // Document type (invoice, proforma, delivery_note)
  document_type: InvoiceDocumentType

  // Conversion tracking (proforma -> invoice)
  converted_from_id: string | null

  // Payment tracking
  paid_at: string | null
  paid_amount: number | null
  remaining_amount: number

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
  items: CreateInvoiceItemInput[]
}

export interface CreateInvoiceItemInput {
  description: string
  quantity: number
  unit: string
  unit_price: number
  vat_rate?: number
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
  | 'supplier_invoice_registered'
  | 'supplier_invoice_paid'
  | 'supplier_invoice_cash_payment'
  | 'supplier_credit_note'
  | 'currency_revaluation'

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
  created_at: string
  updated_at: string
  // Relations
  lines?: JournalEntryLine[]
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
export type CategorizationTemplateSource = 'sie_import' | 'user_approved' | 'sni_default' | 'auto_learned'

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

export interface SIEExportOptions {
  fiscal_period_id: string
  company_name: string
  org_number: string | null
  program_name?: string
}

// Input types for creating entries
export interface CreateJournalEntryInput {
  fiscal_period_id: string
  entry_date: string
  description: string
  source_type: JournalEntrySourceType
  source_id?: string
  voucher_series?: string
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

export type PendingOperationType = 'categorize_transaction' | 'create_customer' | 'create_invoice' | 'mark_invoice_paid' | 'send_invoice' | 'mark_invoice_sent' | 'match_transaction_invoice'
export type PendingOperationStatus = 'pending' | 'committed' | 'rejected'

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

export type InboxItemStatus = 'pending' | 'processing' | 'ready' | 'confirmed' | 'rejected' | 'error'
export type InboxItemSource = 'email' | 'upload'

// Document classification type for unified inbox routing
export type DocumentClassificationType = 'supplier_invoice' | 'receipt' | 'government_letter' | 'unknown'

export interface InvoiceInboxItem {
  id: string
  user_id: string
  company_id: string
  status: InboxItemStatus
  source: InboxItemSource
  email_from: string | null
  email_subject: string | null
  email_received_at: string | null
  document_id: string | null
  extracted_data: Record<string, unknown> | null
  confidence: number | null
  matched_supplier_id: string | null
  created_supplier_invoice_id: string | null
  error_message: string | null

  // Unified document inbox fields
  document_type: DocumentClassificationType
  linked_receipt_id: string | null
  raw_email_payload: Record<string, unknown> | null

  // AI template suggestion
  suggested_template_id: string | null
  suggested_template_confidence: number | null

  // Transaction matching
  matched_transaction_id: string | null
  match_confidence: number | null
  match_method: 'payment_reference' | 'amount_date' | 'amount_merchant' | 'receipt_match' | null

  created_at: string
  updated_at: string

  // Relations (populated when fetched)
  document?: DocumentAttachment
  supplier?: Supplier
  supplier_invoice?: SupplierInvoice
  receipt?: Receipt
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
  user_id: string
  company_id: string
  code: string
  name: string
  is_active: boolean
  created_at: string
  updated_at: string
}

export interface Project {
  id: string
  user_id: string
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
}

/** Options for the transaction ingestion pipeline */
export interface IngestOptions {
  /** Skip auto-categorization (mapping engine + journal entry creation).
   * Reconciliation and invoice matching still run.
   * Used when SIE-imported entries overlap the sync date range
   * to prevent double-booking. */
  skipAutoCategorization?: boolean
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
}

export interface KPIPreferences {
  visibleKpis: string[]
  kpiOrder: string[]
  accountOverrides: Record<string, string[]>
}
