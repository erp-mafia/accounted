/**
 * SIE Import Types
 *
 * Types for parsing and importing SIE files (Swedish standard for
 * accounting data exchange between systems).
 */

// SIE file types
export type SIEType = 1 | 2 | 3 | 4

// Encoding types supported by SIE files
export type SIEEncoding = 'cp437' | 'utf8' | 'windows1252'

// Import status
export type SIEImportStatus = 'pending' | 'mapped' | 'completed' | 'failed' | 'replaced'

// Match type for account mapping
export type AccountMatchType = 'exact' | 'name' | 'class' | 'manual' | 'bas_range'

// Parse issue severity
export type ParseIssueSeverity = 'error' | 'warning' | 'info'

/**
 * SIE file header information
 */
export interface SIEHeader {
  // File metadata
  sieType: SIEType
  flagga: number | null            // #FLAGGA (0 = not imported, 1 = already imported)
  program: string | null           // #PROGRAM
  programVersion: string | null
  generatedDate: string | null     // #GEN: "YYYY-MM-DD"
  format: string | null            // #FORMAT (PC8 = CP437)

  // Company info
  companyName: string | null       // #FNAMN
  orgNumber: string | null         // #ORGNR
  address: string | null           // #ADRESS

  // Fiscal year info
  fiscalYears: FiscalYearInfo[]    // #RAR
  currency: string                 // #VALUTA (default SEK)
  kontoPlanType: string | null     // #KPTYP (e.g. 'BAS95', 'BAS96', 'EUBAS')
}

/**
 * Fiscal year info from #RAR tag
 */
export interface FiscalYearInfo {
  yearIndex: number                // 0 = current, -1 = previous, etc.
  start: string                    // "YYYY-MM-DD"
  end: string                      // "YYYY-MM-DD"
}

/**
 * Account from #KONTO tag
 */
export interface SIEAccount {
  number: string
  name: string
  sruCode?: string                 // #SRU mapping
  accountType?: string             // #KTYP
}

/**
 * Balance entry from #IB, #UB, or #RES tag
 */
export interface SIEBalance {
  yearIndex: number
  account: string
  amount: number
  quantity?: number
  objectId?: string
}

/**
 * Transaction line from #TRANS tag inside #VER block
 */
export interface SIETransactionLine {
  account: string
  amount: number
  date?: Date
  description?: string
  quantity?: number
  signature?: string
  objectId?: string
  /** Object list ({dimNo "code" …}) as SIE dim number → object code. */
  dimensions?: Record<string, string>
}

/**
 * Dimension declaration from #DIM or #UNDERDIM
 */
export interface SIEDimension {
  sieDimNo: number
  name: string
  /** Set when declared via #UNDERDIM: the parent dimension number. */
  parentSieDimNo?: number
}

/**
 * Dimension value from #OBJEKT
 */
export interface SIEDimensionValue {
  sieDimNo: number
  code: string
  name: string
}

/**
 * Voucher/Journal entry from #VER tag
 */
export interface SIEVoucher {
  series: string                   // Voucher series (A, B, etc.)
  number: number                   // Voucher number
  date: Date
  description: string
  registrationDate?: Date
  signature?: string
  lines: SIETransactionLine[]
}

/**
 * Parse issue found during SIE file parsing
 */
export interface ParseIssue {
  severity: ParseIssueSeverity
  line: number
  message: string
  tag?: string
}

/**
 * Result of parsing a SIE file
 */
export interface ParsedSIEFile {
  // Header info
  header: SIEHeader

  // Chart of accounts
  accounts: SIEAccount[]

  // Balances
  openingBalances: SIEBalance[]    // #IB
  closingBalances: SIEBalance[]    // #UB
  resultBalances: SIEBalance[]     // #RES

  // Transactions (SIE4 only)
  vouchers: SIEVoucher[]

  // Dimension registry records (#DIM / #UNDERDIM / #OBJEKT)
  dimensions: SIEDimension[]
  dimensionValues: SIEDimensionValue[]

  // Parse issues
  issues: ParseIssue[]

  // Statistics
  stats: {
    totalAccounts: number
    totalVouchers: number
    totalTransactionLines: number
    fiscalYearStart: string | null   // "YYYY-MM-DD"
    fiscalYearEnd: string | null     // "YYYY-MM-DD"
  }
}

/**
 * Validation result for a parsed SIE file
 */
export interface ValidationResult {
  valid: boolean
  errors: string[]
  warnings: string[]
}

/**
 * Account mapping suggestion
 */
export interface AccountMapping {
  sourceAccount: string
  sourceName: string
  targetAccount: string
  targetName: string
  confidence: number               // 0-1
  matchType: AccountMatchType
  isOverride: boolean              // User manually set this
}

/**
 * Account mapping context for the mapper
 */
export interface MappingContext {
  sourceAccounts: SIEAccount[]
  existingMappings?: Map<string, AccountMapping>
}

/**
 * SIE import record (matches database table)
 */
export interface SIEImport {
  id: string
  user_id: string
  filename: string
  file_hash: string
  org_number: string | null
  company_name: string | null
  sie_type: SIEType
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
  migration_documentation: MigrationDocumentation | null
  file_storage_path: string | null
  replaced_at: string | null
  created_at: string
  updated_at: string
}

/**
 * SIE account mapping record (matches database table)
 */
export interface SIEAccountMappingRecord {
  id: string
  user_id: string
  source_account: string
  source_name: string | null
  target_account: string
  confidence: number
  match_type: AccountMatchType
  created_at: string
  updated_at: string
}

/**
 * Options for executing an import
 */
export interface ImportOptions {
  // The parsed SIE data
  parsed: ParsedSIEFile

  // Account mappings to use
  mappings: AccountMapping[]

  // Whether to create a new fiscal period
  createFiscalPeriod: boolean

  // Whether to import opening balances as a journal entry
  importOpeningBalances: boolean

  // Whether to import transactions (SIE4 only)
  importTransactions: boolean

  // Voucher series to use for imported entries
  voucherSeries?: string

  // Opt-in: mark imported verifikat as "Inget underlag krävs" so a migration
  // doesn't flood "Att hantera: saknade underlag". OFF by default.
  markImportedNoDocRequired?: boolean
}

/**
 * Structured import details for UI display.
 * Provides machine-readable data so the UI can render proper explanations
 * instead of parsing warning strings.
 */
export interface ImportResultDetails {
  /** Fiscal year this import covers */
  fiscalYear?: { start: string; end: string }

  /** Breakdown of skipped vouchers by reason */
  skippedVouchers?: {
    unbalanced: number
    unmapped: number
    singleLine: number
    empty: number
    total: number
  }

  /** Opening balance imbalance info */
  openingBalance?: {
    /** SEK amount of the imbalance (0 if balanced) */
    imbalance: number
    /** Why the imbalance exists */
    explanation: 'unallocated_result' | 'excluded_accounts' | 'rounding' | null
    /** Account the difference was booked to */
    bookedToAccount: string | null
  }

  /** Migration adjustment entry info */
  migrationAdjustment?: {
    created: boolean
    accountsAdjusted: number
  }

  /**
   * Non-latest fiscal years whose P&L doesn't net to zero — their result
   * was never transferred to equity (omföring av årets resultat saknas).
   * Each corrupts every later derived opening balance by exactly pl_net,
   * which surfaces as a balansräkning differens. Structurally identical to
   * UntransferredResult in @/types.
   */
  untransferredResults?: Array<{
    fiscal_period_id: string
    period_name: string
    /** Class 3-8 net (credit-positive = profit), rounded to öre. */
    pl_net: number
  }>

  /** Number of batches that needed retries (0 = clean run) */
  retriedBatches: number

  /** Number of batches that still failed after all retries */
  failedBatches: number
}

/**
 * Result of executing an import
 */
export interface ImportResult {
  success: boolean

  // What was created
  importId: string | null
  fiscalPeriodId: string | null
  openingBalanceEntryId: string | null
  journalEntriesCreated: number
  journalEntryIds: string[]

  // Issues
  errors: string[]
  warnings: string[]

  // Structured details for UI (populated alongside warnings for backwards compat)
  details?: ImportResultDetails

  // If this import replaced a prior completed import for the same fiscal year
  // (Fortnox re-sync flow), the prior import's id and the count of journal
  // entries that were deleted as a result.
  replacedPriorImport?: { importId: string; deletedEntries: number } | null

  // If a prior-year backfill triggered IB resync on the immediately-following
  // fiscal period (storno + recreate of its opening_balance entry), the
  // details of what happened: populated only when the resync ran.
  nextPeriodIBResync?: {
    nextPeriodId: string
    nextPeriodName: string
    stornoEntryId: string
    newOpeningBalanceEntryId: string
  } | null

  // If the next period's IB needed resync but we couldn't do it (locked,
  // closed, or no existing IB), the human-readable reason.
  nextPeriodIBResyncSkipped?: { reason: string; nextPeriodName: string } | null

  // Populated when the file carried dimension data (#DIM/#OBJEKT/object
  // lists): what landed in the registry and whether the import flipped
  // company_settings.dimensions_enabled on (with a UI notice).
  dimensionsImported?: {
    dimensions: number
    values: number
    taggedLines: number
    toggleEnabled: boolean
  } | null
}

/**
 * Preview data shown to user before import
 */
export interface ImportPreview {
  // Company info from file
  companyName: string | null
  orgNumber: string | null

  // Fiscal year
  fiscalYearStart: string | null   // "YYYY-MM-DD"
  fiscalYearEnd: string | null     // "YYYY-MM-DD"

  // Statistics
  accountCount: number
  voucherCount: number
  transactionLineCount: number

  // Opening balance total
  openingBalanceTotal: number

  // Trial balance preview from opening balances
  trialBalance: {
    totalDebit: number
    totalCredit: number
    isBalanced: boolean
  }

  // Mapping status
  mappingStatus: {
    total: number
    mapped: number
    unmapped: number
    lowConfidence: number
  }

  // Source-system accounts excluded from import (e.g. Fortnox 0099)
  excludedSystemAccounts: { number: string; name: string }[]

  // Issues to review
  issues: ParseIssue[]
}

/**
 * Structured systemdokumentation per BFNAR 2013:2 Chapter 9.
 * Generated at the end of a SIE import and stored in sie_imports.migration_documentation.
 */
export interface MigrationDocumentation {
  // Source system info
  sourceSystem: string | null       // from #PROGRAM
  sourceVersion: string | null
  sieType: number
  generatedDate: string | null      // from #GEN

  // Import scope
  fiscalYear: { start: string; end: string }
  importedAt: string
  importedBy: string                // user_id

  // Account mapping
  accountMappings: {
    total: number
    exact: number
    basRange: number
    manual: number
    unmapped: number
  }

  // Chart-of-accounts renames applied from the file's #KONTO records
  // (behandlingshistorik per BFNAR 2013:2, who/when is carried by
  // importedBy/importedAt on this record). Absent when nothing was renamed
  // and on imports recorded before this field existed.
  accountRenames?: Array<{ accountNumber: string; from: string; to: string }>

  // Voucher statistics
  vouchers: {
    total: number
    imported: number
    skippedUnbalanced: number
    skippedUnmapped: number
    skippedSingleLine: number
    skippedEmpty: number
  }

  // Adjustments
  openingBalanceRounding: number | null  // SEK amount if any
  migrationAdjustment: {
    created: boolean
    deltaAccounts: number
    entryId: string | null
  }

  // Voucher number mapping.
  // Per-voucher series is preserved from the source SIE file (e.g., Fortnox uses
  // B=kundfakturor, C=inbetalningar), so a single import may span multiple series
  // and each series has its own independent target-number range.
  voucherSeriesUsed: string[]
  voucherNumberRanges: Array<{ series: string; from: number; to: number }>
  voucherNumberMapping: Array<{
    sourceId: string    // e.g. "B1"
    series: string      // target series (same as source unless fallback applied)
    targetNumber: number
  }>
}

/**
 * Wizard step state
 */
export type ImportWizardStep = 'upload' | 'preview' | 'mapping' | 'review' | 'result'

/**
 * Full wizard state
 */
export interface ImportWizardState {
  step: ImportWizardStep
  file: File | null
  parsed: ParsedSIEFile | null
  mappings: AccountMapping[]
  preview: ImportPreview | null
  importResult: ImportResult | null
  isLoading: boolean
  error: string | null
}
