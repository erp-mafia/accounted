/**
 * SIE Import Engine
 *
 * Executes the actual import of SIE data into the database.
 * Creates fiscal periods, opening balance entries, and journal entries.
 * All operations are wrapped to ensure atomic behavior.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { normalizeLineDimensions } from '@/lib/bookkeeping/dimension-resolver'
import { importDimensionRegistry } from './sie-dimensions'
import { createJournalEntry, reverseEntry } from '@/lib/bookkeeping/engine'
import type {
  ParsedSIEFile,
  AccountMapping,
  ImportResult,
  ImportPreview,
  SIEImport,
  MigrationDocumentation,
} from './types'
import type { CreateJournalEntryLineInput } from '@/types'
import { mappingsToMap, getMappingStats } from './account-mapper'
import { syncMappedAccounts } from './account-sync'
import {
  calculateFileHash,
  getEffectiveOpeningBalances,
  isBalanceSheetAccount,
  OPENING_BALANCE_DESCRIPTION_RE,
  SHARE_CAPITAL_DESCRIPTION_RE,
} from './sie-parser'

// Re-export from the parser (moved there to avoid an import cycle:
// getEffectiveOpeningBalances needs it) so existing importers keep working.
export { isBalanceSheetAccount } from './sie-parser'
import { getBASReference } from '@/lib/bookkeeping/bas-reference'
import { classifyAccount } from '@/lib/bookkeeping/account-classifier'
import { computeSRUCode } from '@/lib/bookkeeping/bas-data/sru-mapping'
import { populateTemplatesFromSieVouchers } from '@/lib/bookkeeping/counterparty-templates'
import { markEntriesNoDocRequired } from '@/lib/bookkeeping/no-doc-required'
import { parseDateParts } from '@/lib/bookkeeping/validate-period-duration'
import { findUntransferredResults } from '@/lib/reports/imbalance-diagnosis'
import { formatCurrency } from '@/lib/utils'

/**
 * Format a date to ISO date string (YYYY-MM-DD)
 */
function formatDate(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/**
 * Generate a preview of what will be imported
 */
export function generateImportPreview(
  parsed: ParsedSIEFile,
  mappings: AccountMapping[]
): ImportPreview {
  // Calculate opening balance totals from the effective set: for files
  // without #IB 0 this is the IB derived from #UB -1 (issue #675), so the
  // preview (and the IB toggle in ImportReviewStep, keyed off
  // openingBalanceTotal > 0) reflects what the import will actually book.
  const { balances: currentYearBalances, derivedFromPriorYearUB } =
    getEffectiveOpeningBalances(parsed)
  let totalDebit = 0
  let totalCredit = 0

  for (const balance of currentYearBalances) {
    if (balance.amount > 0) {
      totalDebit += balance.amount
    } else {
      totalCredit += Math.abs(balance.amount)
    }
  }

  const mappingStats = getMappingStats(mappings)

  return {
    companyName: parsed.header.companyName,
    orgNumber: parsed.header.orgNumber,
    fiscalYearStart: parsed.stats.fiscalYearStart,
    fiscalYearEnd: parsed.stats.fiscalYearEnd,
    accountCount: parsed.stats.totalAccounts,
    voucherCount: parsed.stats.totalVouchers,
    transactionLineCount: parsed.stats.totalTransactionLines,
    openingBalanceTotal: totalDebit,
    trialBalance: {
      totalDebit,
      totalCredit,
      isBalanced: Math.abs(totalDebit - totalCredit) < 0.01,
    },
    mappingStatus: {
      total: mappingStats.total,
      mapped: mappingStats.mapped,
      unmapped: mappingStats.unmapped,
      lowConfidence: mappingStats.lowConfidence,
    },
    excludedSystemAccounts: [],
    issues: derivedFromPriorYearUB
      ? [
          ...parsed.issues,
          {
            severity: 'info',
            line: 0,
            message:
              'Ingående balanser härleds från föregående års utgående balans (#UB -1): filen saknar #IB-poster för aktuellt räkenskapsår.',
          },
        ]
      : parsed.issues,
  }
}

/**
 * Check if a file has already been imported
 */
export async function checkDuplicateImport(
  supabase: SupabaseClient,
  companyId: string,
  fileContent: string
): Promise<SIEImport | null> {
  const fileHash = await calculateFileHash(fileContent)

  const { data } = await supabase
    .from('sie_imports')
    .select('*')
    .eq('company_id', companyId)
    .eq('file_hash', fileHash)
    .eq('status', 'completed')
    .single()

  return data as SIEImport | null
}

/**
 * Check if a completed SIE import already exists for the same fiscal year period.
 * Prevents importing two different SIE files that cover the same accounting period,
 * which would create duplicate verifikationer violating BFL 4:1 (löpande bokföring).
 * Only blocks on status='completed': failed/pending imports don't prevent retries.
 */
export async function checkDuplicatePeriodImport(
  supabase: SupabaseClient,
  companyId: string,
  fiscalYearStart: string,
  fiscalYearEnd: string
): Promise<SIEImport | null> {
  // Range overlap check: start <= other_end AND end >= other_start.
  // Two imports whose räkenskapsår overlap would produce duplicate
  // verifikationer, violating BFL 4:1 (löpande bokföring).
  const { data } = await supabase
    .from('sie_imports')
    .select('*')
    .eq('company_id', companyId)
    .eq('status', 'completed')
    .lte('fiscal_year_start', fiscalYearEnd)
    .gte('fiscal_year_end', fiscalYearStart)
    .limit(1)
    .maybeSingle()

  return data as SIEImport | null
}

/**
 * Client for the bulk hard-delete RPCs (replace_sie_import / undo_sie_import).
 *
 * The authenticated role carries statement_timeout=8s on hosted Supabase,
 * and deleting a large import (thousands of journal_entries, each firing
 * write_audit_log with a JSONB old_state snapshot, plus cascading lines)
 * does not finish inside that budget: the RPC dies with "canceling
 * statement due to statement timeout" and rolls back. The service role has
 * no statement_timeout, so the RPC runs on it instead.
 *
 * Safe escalation: callers validate company ownership against the
 * RLS-scoped session client BEFORE the RPC, and the RPC itself (SECURITY
 * DEFINER) re-filters every statement on p_company_id.
 *
 * Falls back to the caller's client when the service key is absent
 * (unit tests, misconfigured self-hosted), same behavior as before.
 */
async function rpcClientForBulkDelete(fallback: SupabaseClient): Promise<SupabaseClient> {
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) return fallback
  const { createServiceClient } = await import('@/lib/supabase/server')
  return createServiceClient()
}

/**
 * Replace a completed SIE import so the user can re-import corrected data
 * for the same fiscal period.
 *
 * The RPC hard-deletes every source_type='import' entry the original import
 * created (plus stragglers from any prior soft-replace), detaches user-
 * attached documents from those entries (PDFs stay in storage as unlinked
 * documents), clears the fiscal-period opening-balance pointer if it came
 * from this import, and resets voucher_sequences so the next re-import
 * restarts the series at 1 (or at MAX of remaining non-import entries).
 *
 * Audit trail lives in the sie_imports row (status='replaced',
 * replaced_at, filename, file_hash, transactions_count, fiscal_year_*)
 * plus per-row audit_log entries written by the write_audit_log trigger
 * on each journal_entries DELETE (old_state JSONB snapshot).
 *
 * The whole cleanup is atomic via the replace_sie_import DB RPC.
 */
export async function replaceSIEImport(
  supabase: SupabaseClient,
  companyId: string,
  importId: string
): Promise<{ success: boolean; deletedEntries: number; error?: string }> {
  // 1. Fetch and validate the import record
  const { data: importRecord } = await supabase
    .from('sie_imports')
    .select('status, fiscal_period_id')
    .eq('id', importId)
    .eq('company_id', companyId)
    .single()

  if (!importRecord) {
    return { success: false, deletedEntries: 0, error: 'Import hittades inte' }
  }

  if (importRecord.status !== 'completed') {
    return { success: false, deletedEntries: 0, error: `Kan bara ersätta slutförda importer (status: ${importRecord.status})` }
  }

  // 2. Check that the fiscal period is not closed or locked
  if (importRecord.fiscal_period_id) {
    const { data: period } = await supabase
      .from('fiscal_periods')
      .select('is_closed, locked_at')
      .eq('id', importRecord.fiscal_period_id)
      .eq('company_id', companyId)
      .single()

    if (period?.is_closed || period?.locked_at) {
      return { success: false, deletedEntries: 0, error: 'Kan inte ersätta import i ett låst eller stängt räkenskapsår. Öppna perioden först.' }
    }
  }

  // 3. Atomically delete entries and mark import as replaced via DB RPC.
  // Runs on the service client: see rpcClientForBulkDelete.
  const rpcClient = await rpcClientForBulkDelete(supabase)
  const { data: deletedCount, error: rpcError } = await rpcClient.rpc('replace_sie_import', {
    p_company_id: companyId,
    p_import_id: importId,
  })

  if (rpcError) {
    return { success: false, deletedEntries: 0, error: `Kunde inte ersätta import: ${rpcError.message}` }
  }

  return { success: true, deletedEntries: deletedCount as number }
}

/**
 * Undo a completed SIE import by hard-deleting its entries (transaction
 * vouchers + opening_balance) and resetting voucher_sequences, without
 * requiring a replacement file. Marks sie_imports.status='undone'.
 *
 * Pre-flight checks mirror replaceSIEImport so the user gets a Swedish
 * error message before the RPC raises. The RPC itself is idempotent on
 * status: calling twice surfaces the "not in completed status" error.
 *
 * `userId` is the authorising user. It is passed to the RPC as p_user_id
 * because the RPC may run on the service client (see rpcClientForBulkDelete),
 * where auth.uid() is NULL: without it the RPC's owner/admin gate can never
 * match and always raises. The RPC enforces owner/admin against this id.
 */
export async function undoSIEImport(
  supabase: SupabaseClient,
  companyId: string,
  importId: string,
  userId: string
): Promise<{ success: boolean; deletedEntries: number; error?: string }> {
  const { data: importRecord } = await supabase
    .from('sie_imports')
    .select('status, fiscal_period_id')
    .eq('id', importId)
    .eq('company_id', companyId)
    .single()

  if (!importRecord) {
    return { success: false, deletedEntries: 0, error: 'Import hittades inte' }
  }

  if (importRecord.status !== 'completed') {
    return { success: false, deletedEntries: 0, error: `Kan bara ångra slutförda importer (status: ${importRecord.status})` }
  }

  if (importRecord.fiscal_period_id) {
    const { data: period } = await supabase
      .from('fiscal_periods')
      .select('is_closed, locked_at')
      .eq('id', importRecord.fiscal_period_id)
      .eq('company_id', companyId)
      .single()

    if (period?.is_closed || period?.locked_at) {
      return { success: false, deletedEntries: 0, error: 'Kan inte ångra import i ett låst eller stängt räkenskapsår. Öppna perioden först.' }
    }
  }

  // Runs on the service client: see rpcClientForBulkDelete. Pass the
  // authorising user explicitly: on the service client auth.uid() is NULL,
  // so the RPC's owner/admin gate resolves against p_user_id instead.
  const rpcClient = await rpcClientForBulkDelete(supabase)
  const { data: deletedCount, error: rpcError } = await rpcClient.rpc('undo_sie_import', {
    p_company_id: companyId,
    p_import_id: importId,
    p_user_id: userId,
  })

  if (rpcError) {
    return { success: false, deletedEntries: 0, error: `Kunde inte ångra import: ${rpcError.message}` }
  }

  return { success: true, deletedEntries: deletedCount as number }
}

/**
 * Clean up orphan in-flight import records for a given file hash.
 *
 * Targets rows in status='pending', left behind when a prior import
 * crashed (or short-circuited at checkDuplicatePeriodImport) before
 * reaching finalizeImportRecord. They hold the slot in the partial
 * unique index `sie_imports_company_id_file_hash_active_idx`, so a
 * retry would fail with a constraint violation.
 *
 * Five-minute age gate protects an in-flight import in another tab/
 * session: createPendingImportRecord → ... → finalizeImportRecord can
 * take tens of seconds for large SIE files. Without the gate, a
 * concurrent retry of the same file would delete the live pending row
 * mid-flight and the original session's finalize would silently no-op.
 * Five minutes is long enough for any normal interactive import yet
 * short enough that legitimate retries after a crash succeed.
 *
 * The 'mapped' status is defined in the type but never written by any
 * code path, so we don't include it. 'failed' and 'replaced' rows are
 * allowed by the partial index (excluded from its predicate), so they
 * stay in place for the audit trail.
 */
async function cleanupStaleImportRecords(
  supabase: SupabaseClient,
  companyId: string,
  fileHash: string
): Promise<void> {
  const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString()

  await supabase
    .from('sie_imports')
    .delete()
    .eq('company_id', companyId)
    .eq('file_hash', fileHash)
    .eq('status', 'pending')
    .lt('created_at', fiveMinutesAgo)
}

/**
 * Create a fiscal period if one doesn't exist for the date range.
 * Dates are ISO strings "YYYY-MM-DD" to avoid timezone issues.
 *
 * Exported for unit testing of the pre-validation that mirrors the
 * `enforce_period_start_day` DB trigger.
 */
export async function ensureFiscalPeriod(
  supabase: SupabaseClient,
  companyId: string,
  startDate: string,
  endDate: string
): Promise<string> {
  // Check for an existing period that contains the SIE date range
  const { data: containing } = await supabase
    .from('fiscal_periods')
    .select('id')
    .eq('company_id', companyId)
    .lte('period_start', startDate)
    .gte('period_end', endDate)
    .single()

  if (containing) {
    return containing.id
  }

  // An overlapping-but-not-containing period needs to be split into two cases:
  //   - The period has any real content (posted entries, opening balances set,
  //     closed, or locked): refuse. Silently reusing it would stamp imported
  //     vouchers with a fiscal_period_id whose date window doesn't match the
  //     voucher's own date: breaking the SIE invariant that #VER dates fall
  //     inside #RAR and BFL 5 kap. (verifikationsnummer per räkenskapsår).
  //   - The period is empty (onboarding-seeded with the default calendar year
  //     but never used): replace it. The user has a förlängt räkenskapsår per
  //     BFL 3 kap. that doesn't match the seeded period, and the seeded period
  //     carries no data to preserve.
  const { data: overlapping } = await supabase
    .from('fiscal_periods')
    .select('id, period_start, period_end, name, is_closed, locked_at, opening_balances_set')
    .eq('company_id', companyId)
    .lte('period_start', endDate)
    .gte('period_end', startDate)
    .order('period_start', { ascending: false })
    .limit(1)

  let periodToReplaceId: string | null = null

  if (overlapping && overlapping.length > 0) {
    const existing = overlapping[0]

    const replaceableGateOpen =
      !existing.is_closed && !existing.locked_at && !existing.opening_balances_set

    let hasEntries = true
    if (replaceableGateOpen) {
      const { data: existingEntries } = await supabase
        .from('journal_entries')
        .select('id')
        .eq('fiscal_period_id', existing.id)
        .eq('company_id', companyId)
        .limit(1)
      hasEntries = (existingEntries?.length ?? 0) > 0
    }

    if (!replaceableGateOpen || hasEntries) {
      throw new Error(
        `SIE-filens räkenskapsår (${startDate} till ${endDate}) överlappar men matchar inte ett befintligt räkenskapsår i Accounted ` +
          `(${existing.name}: ${existing.period_start} till ${existing.period_end}). ` +
          `Justera räkenskapsåret i Inställningar → Företag så att det matchar SIE-filen exakt, eller importera en SIE-fil som täcker exakt samma period.`
      )
    }

    periodToReplaceId = existing.id
  }

  // Pre-validate against the DB-side enforce_period_start_day trigger so the
  // user gets an actionable Swedish error instead of a raw Postgres message.
  // Per BFL 3 kap., only the company's chronologically FIRST fiscal year may
  // start mid-month (förlängt första räkenskapsår). Any period that comes
  // after an earlier one must start on day 1. We check "is there a period
  // that starts earlier?" rather than "does any period exist?" so a user can
  // retroactively import an old first fiscal year via SIE even after an
  // onboarding-created period already exists later in time.
  const startParts = parseDateParts(startDate)
  const endParts = parseDateParts(endDate)

  if (startParts.day !== 1) {
    const { data: earlier } = await supabase
      .from('fiscal_periods')
      .select('id')
      .eq('company_id', companyId)
      .lt('period_start', startDate)
      .limit(1)

    if (earlier && earlier.length > 0) {
      throw new Error(
        `SIE-filens räkenskapsår börjar ${startDate}: endast företagets kronologiskt första räkenskapsår får börja mitt i månaden. Efterföljande räkenskapsår måste börja den 1:a i en månad (BFL 3 kap.). Kontrollera datumen i #RAR-raden.`
      )
    }
  }

  // Matches the fiscal_period_end_last_of_month CHECK constraint on prod;
  // surface it as a clean message instead of a DB error.
  const lastDayOfEndMonth = new Date(endParts.year, endParts.month, 0).getDate()
  if (endParts.day !== lastDayOfEndMonth) {
    throw new Error(
      `SIE-filens räkenskapsår slutar ${endDate}: räkenskapsår måste sluta på månadens sista dag (BFL 3 kap.). Kontrollera datumen i #RAR-raden.`
    )
  }

  // All date validation passed. If we identified an empty seeded period above,
  // delete it now, deferring the destructive step until after every check
  // keeps the seeded period intact when an SIE has malformed dates.
  // FK cascades: account_balances, voucher_sequences, voucher_gap_explanations
  // are ON DELETE CASCADE (all empty for a seeded period); sie_imports is
  // ON DELETE SET NULL; journal_entries is ON DELETE RESTRICT but we already
  // verified zero rows above.
  if (periodToReplaceId) {
    const { error: deleteError } = await supabase
      .from('fiscal_periods')
      .delete()
      .eq('id', periodToReplaceId)
      .eq('company_id', companyId)

    if (deleteError) {
      throw new Error(`Kunde inte ersätta automatiskt skapat räkenskapsår: ${deleteError.message}`)
    }
  }

  // Create new fiscal period
  const startYear = startParts.year
  const endYear = endParts.year
  const name = startYear === endYear
    ? `Räkenskapsår ${startYear}`
    : `Räkenskapsår ${startYear}/${endYear}`

  // Link the BFNAR 2013:2 continuity chain so the resultatrapport can find the
  // prior year for its comparison column. Mirrors the manual fiscal-periods
  // route: point this period at its closest predecessor, then relink the
  // immediate successor (if any) to follow this one, so multi-year SIE files
  // chain correctly regardless of the order #RAR years are processed in.
  const { data: predecessors } = await supabase
    .from('fiscal_periods')
    .select('id')
    .eq('company_id', companyId)
    .lt('period_end', startDate)
    .order('period_end', { ascending: false })
    .limit(1)
  const previousPeriodId = predecessors && predecessors.length > 0 ? predecessors[0].id : null

  const { data: newPeriod, error } = await supabase
    .from('fiscal_periods')
    .insert({
      company_id: companyId,
      name,
      period_start: startDate,
      period_end: endDate,
      is_closed: false,
      opening_balances_set: false,
      previous_period_id: previousPeriodId,
    })
    .select()
    .single()

  if (error || !newPeriod) {
    throw new Error(`Failed to create fiscal period: ${error?.message}`)
  }

  // Relink the immediate successor (e.g. when an earlier year is imported after
  // a later one) so the chain holds in both directions.
  const { data: successors } = await supabase
    .from('fiscal_periods')
    .select('id')
    .eq('company_id', companyId)
    .gt('period_start', endDate)
    .neq('id', newPeriod.id)
    .order('period_start', { ascending: true })
    .limit(1)
  if (successors && successors.length > 0) {
    await supabase
      .from('fiscal_periods')
      .update({ previous_period_id: newPeriod.id })
      .eq('id', successors[0].id)
      .eq('company_id', companyId)
  }

  return newPeriod.id
}

/**
 * Compute IB imbalance and validate it before creating the opening balance entry.
 *
 * Distinguishes between:
 * - File-level imbalance: the raw SIE #IB data doesn't balance (source file error)
 * - Mapping-level imbalance: caused by excluded accounts (system accounts like Fortnox 0099)
 *   that carry IB balances but are correctly filtered from mapping. This is expected and
 *   should be booked to 2099 with clear documentation.
 */
export function validateIBBalance(
  parsed: ParsedSIEFile,
  accountMap: Map<string, string>
): {
  lines: CreateJournalEntryLineInput[]
  roundingAdjustment: number
  fileImbalance: number
  excludedAccountsTotal: number
} {
  // Effective set: explicit #IB 0, or IB derived from #UB -1 (issue #675).
  const currentYearBalances = getEffectiveOpeningBalances(parsed).balances

  // First: check the raw file-level IB balance (all accounts, before mapping)
  const rawTotal = currentYearBalances.reduce((sum, b) => sum + b.amount, 0)
  const fileImbalance = Math.round(Math.abs(rawTotal) * 100) / 100

  // Build mapped lines and track excluded account totals
  const lines: CreateJournalEntryLineInput[] = []
  let excludedTotal = 0

  for (const balance of currentYearBalances) {
    const targetAccount = accountMap.get(balance.account)
    if (!targetAccount) {
      // Account not in mapping (system account or unmapped): track its IB contribution
      excludedTotal += balance.amount
      continue
    }

    if (balance.amount > 0) {
      lines.push({
        account_number: targetAccount,
        debit_amount: balance.amount,
        credit_amount: 0,
        line_description: `IB ${balance.account}`,
      })
    } else if (balance.amount < 0) {
      lines.push({
        account_number: targetAccount,
        debit_amount: 0,
        credit_amount: Math.abs(balance.amount),
        line_description: `IB ${balance.account}`,
      })
    }
  }

  const totalDebit = lines.reduce((sum, l) => sum + l.debit_amount, 0)
  const totalCredit = lines.reduce((sum, l) => sum + l.credit_amount, 0)
  const mappedDiff = Math.round((totalDebit - totalCredit) * 100) / 100

  return {
    lines,
    roundingAdjustment: Math.abs(mappedDiff) > 0.01 ? mappedDiff : 0,
    fileImbalance,
    excludedAccountsTotal: Math.round(excludedTotal * 100) / 100,
  }
}

/**
 * Create opening balance journal entry from IB amounts.
 * The caller must validate the IB balance first via validateIBBalance().
 * If roundingAdjustment is non-zero, it is booked explicitly to 2099 with clear text.
 */
async function createOpeningBalanceEntry(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  fiscalPeriodId: string,
  parsed: ParsedSIEFile,
  accountMap: Map<string, string>,
  roundingAdjustment: number
): Promise<string | null> {
  // Effective set: explicit #IB 0, or IB derived from #UB -1 (issue #675).
  const { balances: currentYearBalances, derivedFromPriorYearUB } =
    getEffectiveOpeningBalances(parsed)

  if (currentYearBalances.length === 0) {
    return null
  }

  // Build journal entry lines
  const lines: CreateJournalEntryLineInput[] = []

  for (const balance of currentYearBalances) {
    const targetAccount = accountMap.get(balance.account)
    if (!targetAccount) continue

    if (balance.amount > 0) {
      lines.push({
        account_number: targetAccount,
        debit_amount: balance.amount,
        credit_amount: 0,
        line_description: `IB ${balance.account}`,
      })
    } else if (balance.amount < 0) {
      lines.push({
        account_number: targetAccount,
        debit_amount: 0,
        credit_amount: Math.abs(balance.amount),
        line_description: `IB ${balance.account}`,
      })
    }
  }

  if (lines.length === 0) {
    return null
  }

  // Add explicit rounding adjustment if needed (pre-validated by caller, <= 1 SEK)
  if (Math.abs(roundingAdjustment) > 0.01) {
    if (roundingAdjustment > 0) {
      lines.push({
        account_number: '2099',
        debit_amount: 0,
        credit_amount: roundingAdjustment,
        line_description: `Avrundningsdifferens vid SIE-import, ${roundingAdjustment} SEK`,
      })
    } else {
      lines.push({
        account_number: '2099',
        debit_amount: Math.abs(roundingAdjustment),
        credit_amount: 0,
        line_description: `Avrundningsdifferens vid SIE-import, ${roundingAdjustment} SEK`,
      })
    }
  }

  const entryDate = parsed.stats.fiscalYearStart ?? formatDate(new Date())

  const entry = await createJournalEntry(supabase, companyId, userId, {
    fiscal_period_id: fiscalPeriodId,
    entry_date: entryDate,
    // When derived, say so on the voucher itself: permanent documentation
    // of where the amounts came from (BFNAR 2013:2 behandlingshistorik).
    description: derivedFromPriorYearUB
      ? 'Ingående balanser från SIE-import (härledda från föregående års utgående balans)'
      : 'Ingående balanser från SIE-import',
    source_type: 'opening_balance',
    voucher_series: 'A',
    lines,
  })

  return entry.id
}

/**
 * Returns true when the company already has at least one posted (or reversed)
 * non-IB journal entry, i.e. this is a continuation import, not the first
 * ever SIE upload for the company.
 *
 * Used to gate IB-entry creation: when a company is already live, each year's
 * #IB equals the prior year's UB, which is the sum of already-imported
 * journal lines. Creating a new IB entry would double-count one year's
 * movements against every balance-sheet account.
 */
export async function companyHasPriorActivity(
  supabase: SupabaseClient,
  companyId: string
): Promise<boolean> {
  // Only count currently-effective real activity. Excluding 'reversed' drops
  // cancelled originals; excluding source_type 'storno' drops their matching
  // reversal entries so a fully-cancelled pair contributes nothing. Without
  // this, repair scripts that storno duplicate IB entries would leave storno
  // artifacts that trip the guard on a freshly-repaired company.
  const { count } = await supabase
    .from('journal_entries')
    .select('id', { count: 'exact', head: true })
    .eq('company_id', companyId)
    .neq('source_type', 'opening_balance')
    .neq('source_type', 'storno')
    .eq('status', 'posted')

  return (count ?? 0) > 0
}

/**
 * Link an opening-balance journal entry to its fiscal period so balance-sheet
 * reports use the explicit IB path in getOpeningBalances() (reads only that
 * entry's lines for IB) instead of falling through to summing all prior
 * journal lines, which inflates multi-year imports, because each year's IB
 * is double-counted against the prior year's UB.
 *
 * Mirrors the pattern used by the Excel-based OB import at
 * app/api/import/opening-balance/execute/route.ts:224-231.
 */
export async function linkOpeningBalanceEntryToPeriod(
  supabase: SupabaseClient,
  companyId: string,
  fiscalPeriodId: string,
  openingBalanceEntryId: string
): Promise<void> {
  const { error } = await supabase
    .from('fiscal_periods')
    .update({
      opening_balance_entry_id: openingBalanceEntryId,
      opening_balances_set: true,
    })
    .eq('id', fiscalPeriodId)
    .eq('company_id', companyId)

  if (error) {
    throw new Error(`Failed to link opening balance entry to fiscal period: ${error.message}`)
  }
}

/**
 * Pragmatic IB resync.
 *
 * Backfill scenario: user already imported 2026 (or set its IB manually),
 * then later imports 2025. The previously-set 2026 IB no longer matches
 * the 2025 UB we just computed: resync it by stornoing the old IB and
 * creating a fresh one from the just-imported #UB.
 *
 * Returns:
 *   - { resynced: true, ...details } when storno + new IB succeeded
 *   - { resynced: false, reason } when there's no next period, no existing
 *     IB to replace, or the next period is locked/closed
 *
 * Caller is responsible for surfacing the result in ImportResult.
 */
export async function resyncNextPeriodOpeningBalance(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  justImportedPeriodEnd: string,
  parsed: ParsedSIEFile,
  accountMap: Map<string, string>
): Promise<
  | {
      resynced: true
      nextPeriodId: string
      nextPeriodName: string
      stornoEntryId: string
      newOpeningBalanceEntryId: string
    }
  | { resynced: false; reason: string; nextPeriodName?: string }
> {
  const { data: nextPeriod } = await supabase
    .from('fiscal_periods')
    .select('id, name, period_start, period_end, is_closed, locked_at, opening_balance_entry_id, opening_balances_set')
    .eq('company_id', companyId)
    .gt('period_start', justImportedPeriodEnd)
    .order('period_start', { ascending: true })
    .limit(1)
    .maybeSingle()

  if (!nextPeriod) {
    return { resynced: false, reason: 'no_next_period' }
  }

  if (!nextPeriod.opening_balance_entry_id) {
    // No existing IB on the next period: caller has nothing to resync; the
    // user's first IB for the next period will be derived from the import
    // we just completed via getOpeningBalances() fallback.
    return { resynced: false, reason: 'next_period_has_no_ib', nextPeriodName: nextPeriod.name }
  }

  if (nextPeriod.is_closed || nextPeriod.locked_at) {
    return {
      resynced: false,
      reason: 'next_period_locked',
      nextPeriodName: nextPeriod.name,
    }
  }

  // Build the new IB lines from the just-imported year's #UB (yearIndex=0
  // closing balances). Each balance carries the source account number; map
  // through accountMap so chart renames in the target company are honored.
  const currentYearUB = parsed.closingBalances.filter((b) => b.yearIndex === 0)
  if (currentYearUB.length === 0) {
    return { resynced: false, reason: 'no_closing_balances', nextPeriodName: nextPeriod.name }
  }

  const newLines: CreateJournalEntryLineInput[] = []
  for (const balance of currentYearUB) {
    const targetAccount = accountMap.get(balance.account) ?? balance.account
    if (balance.amount > 0) {
      newLines.push({
        account_number: targetAccount,
        debit_amount: balance.amount,
        credit_amount: 0,
        line_description: `IB ${balance.account} (resynk efter import)`,
      })
    } else if (balance.amount < 0) {
      newLines.push({
        account_number: targetAccount,
        debit_amount: 0,
        credit_amount: Math.abs(balance.amount),
        line_description: `IB ${balance.account} (resynk efter import)`,
      })
    }
  }

  if (newLines.length === 0) {
    return { resynced: false, reason: 'empty_new_ib', nextPeriodName: nextPeriod.name }
  }

  // Balance check: if the new IB doesn't balance (excluded accounts, etc.),
  // book the difference to 2099 the same way createOpeningBalanceEntry does.
  const totalDebit = newLines.reduce((s, l) => s + l.debit_amount, 0)
  const totalCredit = newLines.reduce((s, l) => s + l.credit_amount, 0)
  const diff = Math.round((totalDebit - totalCredit) * 100) / 100
  if (Math.abs(diff) > 0.01) {
    if (diff > 0) {
      newLines.push({
        account_number: '2099',
        debit_amount: 0,
        credit_amount: diff,
        line_description: 'Avrundningsdifferens vid IB-resynk',
      })
    } else {
      newLines.push({
        account_number: '2099',
        debit_amount: Math.abs(diff),
        credit_amount: 0,
        line_description: 'Avrundningsdifferens vid IB-resynk',
      })
    }
  }

  // Ordering note: create the new IB FIRST, then storno the old one. If we
  // stornoed first and the createJournalEntry call failed, the next period
  // would be left with a reversed IB and nothing to replace it, and
  // executeSIEImport swallows our error as a non-fatal warning. By creating
  // first we guarantee the worst case is "new IB exists but not yet linked",
  // which getOpeningBalances() can still reason about.

  // Build the new IB entry on the next period.
  const newEntry = await createJournalEntry(supabase, companyId, userId, {
    fiscal_period_id: nextPeriod.id,
    entry_date: nextPeriod.period_start as string,
    description: 'Ingående balanser (resynk efter prior-year SIE-import)',
    source_type: 'opening_balance',
    voucher_series: 'A',
    lines: newLines,
  })

  // Atomically swap the period FK pointer (two-step around the
  // immutability trigger).
  const { error: relinkError } = await supabase.rpc('replace_period_opening_balance_link', {
    p_company_id: companyId,
    p_period_id: nextPeriod.id,
    p_new_entry_id: newEntry.id,
  })

  if (relinkError) {
    throw new Error(`Failed to relink opening balance on next period: ${relinkError.message}`)
  }

  // Now that the period points at the new IB, storno the old one. If this
  // throws, the period is already on the correct entry: the orphaned old
  // entry shows up as a stray verifikat but the FK stays consistent.
  const storno = await reverseEntry(
    supabase,
    companyId,
    userId,
    nextPeriod.opening_balance_entry_id,
    nextPeriod.period_start as string,
  )

  return {
    resynced: true,
    nextPeriodId: nextPeriod.id,
    nextPeriodName: nextPeriod.name,
    stornoEntryId: storno.id,
    newOpeningBalanceEntryId: newEntry.id,
  }
}

/**
 * Create journal entries from vouchers using batch insert for performance.
 *
 * Preserves per-voucher series from the source SIE file so customers migrating
 * from systems like Fortnox (which uses B=kundfakturor, C=inbetalningar, etc.)
 * retain traceability back to their original bookkeeping. Source voucher
 * numbers are renumbered per target series via next_voucher_number to avoid
 * collisions with existing entries; the source (series, number) is preserved
 * in MigrationDocumentation.voucherNumberMapping for audit trail (BFNAR 2013:2).
 *
 * `defaultSeries` is used as a fallback only for vouchers that arrive with an
 * empty series (e.g., SIE4I import files, per spec §5.15).
 */
export async function importVouchers(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  fiscalPeriodId: string,
  parsed: ParsedSIEFile,
  accountMap: Map<string, string>,
  defaultSeries: string
): Promise<{
  created: number
  ids: string[]
  // Subset of `ids` whose entries were inserted with source_type='import' (i.e.
  // excludes #VER vouchers re-tagged as opening_balance). Used to scope the
  // opt-in "Inget underlag krävs" auto-exemption to genuinely migrated vouchers.
  importTypedIds: string[]
  errors: string[]
  skippedEmpty: number
  skippedSingleLine: number
  skippedUnbalanced: number
  skippedUnmapped: number
  movementsByAccount: Map<string, number>
  skippedDetails: {
    voucherId: string
    date: string
    description: string
    reason: 'unmapped' | 'empty' | 'unbalanced' | 'zero_lines' | 'single_line'
    unmappedAccounts?: string[]
    balanceDiff?: number
    totalDebit?: number
    totalCredit?: number
    sourceLines?: { account: string; amount: number }[]
    mappedLineCount?: number
    originalLineCount?: number
  }[]
  voucherNumberMapping: Array<{ sourceId: string; series: string; targetNumber: number }>
  seriesUsed: string[]
  retriedBatches: number
  failedBatches: number
}> {
  const results = {
    created: 0,
    ids: [] as string[],
    importTypedIds: [] as string[],
    errors: [] as string[],
    skippedEmpty: 0,
    skippedSingleLine: 0,
    skippedUnbalanced: 0,
    skippedUnmapped: 0,
    movementsByAccount: new Map<string, number>(),
    skippedDetails: [] as {
      voucherId: string
      date: string
      description: string
      reason: 'unmapped' | 'empty' | 'unbalanced' | 'zero_lines' | 'single_line'
      unmappedAccounts?: string[]
      balanceDiff?: number
      totalDebit?: number
      totalCredit?: number
      sourceLines?: { account: string; amount: number }[]
      mappedLineCount?: number
      originalLineCount?: number
    }[],
    voucherNumberMapping: [] as Array<{ sourceId: string; series: string; targetNumber: number }>,
    seriesUsed: [] as string[],
    retriedBatches: 0,
    failedBatches: 0,
  }

  // Pre-filter and prepare all valid vouchers
  interface PreparedVoucher {
    sourceId: string
    series: string
    date: string
    description: string
    // Original series/number as written in the source SIE file. NULL for SIE4I
    // subsystem imports where series/verno are optional. Stored per-entry for
    // traceability alongside the aggregate sie_imports.migration_documentation.
    sourceSeries: string | null
    sourceNumber: number | null
    // 'import' for ordinary migrated vouchers; 'opening_balance' for a #VER that
    // is really the year's ingående balans (see isLikelyOpeningBalance below).
    sourceType: 'import' | 'opening_balance'
    lines: {
      account_number: string
      debit_amount: number
      credit_amount: number
      line_description: string | null
      dimensions?: Record<string, string>
    }[]
  }

  const preparedVouchers: PreparedVoucher[] = []

  // A SIE file represents the opening balance either as #IB records (handled
  // separately by createOpeningBalanceEntry → source_type='opening_balance'),
  // as IB derived from #UB -1 when #IB 0 is missing (issue #675, also via
  // createOpeningBalanceEntry) or, in some source systems, as an ordinary #VER
  // dated on the fiscal-year start. When there is NO current-year IB from
  // either of the first two paths, detect a clearly-labelled IB voucher and
  // tag it opening_balance so bank reconciliation excludes it from the period
  // movement (otherwise it lands as 'import' and surfaces as a phantom
  // difference equal to the IB). Deliberately conservative: requires the IB
  // wording AND a balance-sheet-only voucher on FY start, and never a
  // share-capital deposit. A missed IB still falls back to the manual "Märk som
  // ingående balans" action in Bankavstämning, so we never risk hiding a real
  // bank movement by over-classifying.
  //
  // Using the effective set keeps this gate consistent with the helper's
  // precedence: when an OB-voucher candidate exists the helper yields no
  // balances (the voucher serves as IB and gets tagged here); when IB was
  // derived from #UB -1 the gate is closed so the same amounts can never be
  // booked twice.
  const hasCurrentYearIb = getEffectiveOpeningBalances(parsed).balances.length > 0
  const fyStart = parsed.stats.fiscalYearStart

  for (const voucher of parsed.vouchers) {
    const lines: PreparedVoucher['lines'] = []
    let hasUnmappedAccount = false
    const unmappedAccountSet = new Set<string>()

    for (const line of voucher.lines) {
      const targetAccount = accountMap.get(line.account)

      if (!targetAccount) {
        hasUnmappedAccount = true
        unmappedAccountSet.add(line.account)
        continue
      }

      // In SIE, amount is positive for debit, negative for credit
      if (line.amount > 0) {
        lines.push({
          account_number: targetAccount,
          debit_amount: Math.round(line.amount * 100) / 100,
          credit_amount: 0,
          line_description: line.description || null,
          ...(line.dimensions ? { dimensions: line.dimensions } : {}),
        })
      } else if (line.amount < 0) {
        lines.push({
          account_number: targetAccount,
          debit_amount: 0,
          credit_amount: Math.round(Math.abs(line.amount) * 100) / 100,
          line_description: line.description || null,
          ...(line.dimensions ? { dimensions: line.dimensions } : {}),
        })
      }
      // Note: lines with amount === 0 are silently dropped
    }

    const voucherId = `${voucher.series}${voucher.number}`
    const voucherDate = formatDate(voucher.date)

    // Skip vouchers with unmapped accounts
    if (hasUnmappedAccount) {
      results.skippedDetails.push({
        voucherId,
        date: voucherDate,
        description: voucher.description,
        reason: 'unmapped',
        unmappedAccounts: [...unmappedAccountSet],
        mappedLineCount: lines.length,
        originalLineCount: voucher.lines.length,
        sourceLines: voucher.lines.map(l => ({ account: l.account, amount: l.amount })),
      })
      results.skippedUnmapped++
      continue
    }

    // Fix 3: Separate empty (0 lines) from single-line vouchers
    if (lines.length === 0) {
      results.skippedDetails.push({
        voucherId,
        date: voucherDate,
        description: voucher.description,
        reason: 'zero_lines',
        mappedLineCount: 0,
        originalLineCount: voucher.lines.length,
        sourceLines: voucher.lines.map(l => ({ account: l.account, amount: l.amount })),
      })
      results.skippedEmpty++
      continue
    }

    if (lines.length === 1) {
      results.skippedDetails.push({
        voucherId,
        date: voucherDate,
        description: voucher.description,
        reason: 'single_line',
        mappedLineCount: 1,
        originalLineCount: voucher.lines.length,
        sourceLines: voucher.lines.map(l => ({ account: l.account, amount: l.amount })),
      })
      results.skippedSingleLine++
      continue
    }

    // Validate balance, Fix 2: Tiered rounding with öresutjämning (3741)
    const totalDebit = lines.reduce((sum, l) => sum + l.debit_amount, 0)
    const totalCredit = lines.reduce((sum, l) => sum + l.credit_amount, 0)
    const balanceDiff = Math.round(Math.abs(totalDebit - totalCredit) * 100) / 100
    if (balanceDiff > 1.00) {
      // More than 1 SEK off: incomplete voucher in source system, skip
      results.skippedDetails.push({
        voucherId,
        date: voucherDate,
        description: voucher.description,
        reason: 'unbalanced',
        balanceDiff,
        totalDebit: Math.round(totalDebit * 100) / 100,
        totalCredit: Math.round(totalCredit * 100) / 100,
        mappedLineCount: lines.length,
        originalLineCount: voucher.lines.length,
        sourceLines: voucher.lines.map(l => ({ account: l.account, amount: l.amount })),
      })
      results.skippedUnbalanced++
      continue
    } else if (balanceDiff > 0.005) {
      // Rounding difference <= 1 SEK: add explicit öresutjämning line (never modify existing lines)
      const roundedDiff = Math.round((totalDebit - totalCredit) * 100) / 100
      if (roundedDiff > 0) {
        lines.push({
          account_number: '3741',
          debit_amount: 0,
          credit_amount: Math.abs(roundedDiff),
          line_description: 'Öresutjämning',
        })
      } else {
        lines.push({
          account_number: '3741',
          debit_amount: Math.abs(roundedDiff),
          credit_amount: 0,
          line_description: 'Öresutjämning',
        })
      }
    }

    // Resolve per-voucher series from the parsed SIE record. Fall back to the
    // caller-supplied default only when the source voucher has no series
    // (e.g., SIE4I subsystem import files where series/verno are optional).
    const resolvedSeries = voucher.series && voucher.series.trim()
      ? voucher.series.trim()
      : defaultSeries

    const rawSourceSeries = voucher.series && voucher.series.trim() ? voucher.series.trim() : null
    const rawSourceNumber = Number.isFinite(voucher.number) ? voucher.number : null

    const voucherDateStr = formatDate(voucher.date)
    const isLikelyOpeningBalance =
      !hasCurrentYearIb &&
      !!fyStart && fyStart.slice(0, 10) === voucherDateStr &&
      lines.length > 0 &&
      lines.every((l) => isBalanceSheetAccount(l.account_number)) &&
      OPENING_BALANCE_DESCRIPTION_RE.test(voucher.description || '') &&
      !SHARE_CAPITAL_DESCRIPTION_RE.test(voucher.description || '')

    preparedVouchers.push({
      sourceId: voucherId,
      series: resolvedSeries,
      date: voucherDateStr,
      description: voucher.description || `Import: ${voucher.series}${voucher.number}`,
      sourceSeries: rawSourceSeries,
      sourceNumber: rawSourceNumber,
      sourceType: isLikelyOpeningBalance ? 'opening_balance' : 'import',
      lines,
    })
  }

  // NOTE: Per-account net movements are tracked inside the batch loop below,
  // so that only SUCCESSFULLY inserted vouchers are counted. This ensures
  // the migration adjustment entry correctly compensates for failed batches.

  if (preparedVouchers.length === 0) {
    return results
  }

  // Get all unique account numbers used
  const allAccountNumbers = new Set<string>()
  for (const v of preparedVouchers) {
    for (const l of v.lines) {
      allAccountNumbers.add(l.account_number)
    }
  }

  // Resolve all account IDs in one query
  const { data: accounts } = await supabase
    .from('chart_of_accounts')
    .select('id, account_number')
    .eq('company_id', companyId)
    .in('account_number', [...allAccountNumbers])

  const accountIdMap = new Map<string, string>()
  for (const acc of accounts || []) {
    accountIdMap.set(acc.account_number, acc.id)
  }

  // Group prepared vouchers by series so each series' voucher numbers are
  // reserved and assigned independently. Preserves SIE parse order within a
  // series (Map maintains insertion order) so the first source voucher in
  // series B becomes the first target voucher in series B.
  const seriesGroups = new Map<string, PreparedVoucher[]>()
  for (const v of preparedVouchers) {
    const list = seriesGroups.get(v.series)
    if (list) {
      list.push(v)
    } else {
      seriesGroups.set(v.series, [v])
    }
  }

  results.seriesUsed = [...seriesGroups.keys()]

  const voucherBySourceId = new Map(preparedVouchers.map((voucher) => [voucher.sourceId, voucher]))
  const rpcPayload = preparedVouchers.map((voucher) => ({
    sourceId: voucher.sourceId,
    series: voucher.series,
    date: voucher.date,
    description: voucher.description,
    sourceSeries: voucher.sourceSeries,
    sourceNumber: voucher.sourceNumber,
    sourceType: voucher.sourceType,
    lines: voucher.lines.map((line, lineIndex) => ({
      account_number: line.account_number,
      account_id: accountIdMap.get(line.account_number) || null,
      debit_amount: line.debit_amount,
      credit_amount: line.credit_amount,
      currency: 'SEK',
      line_description: line.line_description,
      sort_order: lineIndex,
      // dimensions jsonb is the source of truth; cost_center/project are
      // GENERATED mirrors the DB derives from it. SIE object-list codes carry
      // through so imported dimension data is not dropped (dimensions PR5 #866).
      dimensions: normalizeLineDimensions({ dimensions: line.dimensions ?? null }),
    })),
  }))

  type ImportSieJournalEntriesRpcResult = {
    inserted_entries?: Array<{
      id: string
      sourceId: string
      series: string
      voucherNumber: number
      sourceType: 'import' | 'opening_balance'
    }>
    skipped_duplicates?: Array<{ sourceId?: string; reason?: string }>
    validation_errors?: Array<{ sourceId?: string; message?: string }>
  }

  const { data: rpcResult, error: rpcError } = await supabase.rpc('import_sie_journal_entries', {
    p_company_id: companyId,
    p_user_id: userId,
    p_fiscal_period_id: fiscalPeriodId,
    p_entries: rpcPayload,
  })

  if (rpcError) {
    results.errors.push(`SIE-verifikationer kunde inte importeras atomiskt: ${rpcError.message}`)
    results.failedBatches = 1
    return results
  }

  const structuredResult = (rpcResult ?? {}) as ImportSieJournalEntriesRpcResult
  for (const validationError of structuredResult.validation_errors ?? []) {
    results.errors.push(
      validationError.sourceId
        ? `${validationError.sourceId}: ${validationError.message ?? 'valideringsfel'}`
        : validationError.message ?? 'Valideringsfel vid SIE-import',
    )
  }
  for (const skippedDuplicate of structuredResult.skipped_duplicates ?? []) {
    results.errors.push(
      skippedDuplicate.sourceId
        ? `${skippedDuplicate.sourceId}: duplicerad verifikation hoppades över`
        : 'Duplicerad verifikation hoppades över',
    )
  }

  if (results.errors.length > 0) {
    return results
  }

  for (const inserted of structuredResult.inserted_entries ?? []) {
    const voucher = voucherBySourceId.get(inserted.sourceId)
    if (!voucher) continue

    results.voucherNumberMapping.push({
      sourceId: inserted.sourceId,
      series: inserted.series,
      targetNumber: inserted.voucherNumber,
    })

    results.ids.push(inserted.id)
    if (inserted.sourceType === 'import') {
      results.importTypedIds.push(inserted.id)
    }
    results.created++

    for (const line of voucher.lines) {
      const net = line.debit_amount - line.credit_amount
      results.movementsByAccount.set(
        line.account_number,
        (results.movementsByAccount.get(line.account_number) || 0) + net
      )
    }
  }

  return results
}

/**
 * Compute per-series voucher number ranges from the voucher number mapping.
 * SIE imports can span multiple series (B, C, V, ...), each with its own
 * independent target-number range, so the documentation records one range
 * per series.
 */
export function computeVoucherNumberRanges(
  mapping: Array<{ sourceId: string; series: string; targetNumber: number }>
): Array<{ series: string; from: number; to: number }> {
  if (mapping.length === 0) return []
  const bySeries = new Map<string, { from: number; to: number }>()
  for (const entry of mapping) {
    const existing = bySeries.get(entry.series)
    if (existing) {
      if (entry.targetNumber < existing.from) existing.from = entry.targetNumber
      if (entry.targetNumber > existing.to) existing.to = entry.targetNumber
    } else {
      bySeries.set(entry.series, { from: entry.targetNumber, to: entry.targetNumber })
    }
  }
  return [...bySeries.entries()].map(([series, range]) => ({ series, ...range }))
}

/**
 * Create a migration adjustment entry (omföringsverifikation) to reconcile
 * imported voucher movements against the SIE file's closing balances.
 *
 * When unbalanced vouchers are skipped during import, the sum of imported
 * movements will differ from the true account balances computed by the source
 * system. This function:
 *   1. Computes expected net movements from #UB (balance sheet) and #RES (result),
 *      separated by account class per Fix 8
 *   2. Compares against actual imported movements
 *   3. Books the per-account delta as a proper omföringsverifikation
 *
 * Per BFL 1999:1078 and BFNAR 2013:2, corrections must be documented through
 * verifikationer with clear descriptions. This satisfies that requirement.
 */
async function createMigrationAdjustmentEntry(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  fiscalPeriodId: string,
  parsed: ParsedSIEFile,
  accountMap: Map<string, string>,
  importedMovements: Map<string, number>,
  skippedDetails: {
    voucherId: string
    date: string
    reason: string
  }[]
): Promise<{ entryId: string | null; deltaAccounts: number; warnings: string[] }> {
  const warnings: string[] = []
  const hasUB = parsed.closingBalances.some((b) => b.yearIndex === 0)
  const hasRES = parsed.resultBalances.some((b) => b.yearIndex === 0)

  if (!hasUB && !hasRES) {
    return { entryId: null, deltaAccounts: 0, warnings }
  }

  // Fix 8: Separate BS/P&L reconciliation
  // For BS accounts (class 1-2): expectedMovement = UB - IB (ignore RES)
  // For P&L accounts (class 3-8): expectedMovement = RES (ignore IB/UB)
  const expectedMovements = new Map<string, number>()

  // Process IB: only for balance sheet accounts. Effective set: explicit
  // #IB 0, or IB derived from #UB -1 (issue #675), so the expected BS
  // movement is UB(0) − UB(-1), the correct one-year movement, instead of
  // treating the whole opening balance as unexplained movement.
  for (const ib of getEffectiveOpeningBalances(parsed).balances) {
    const target = accountMap.get(ib.account)
    if (!target) continue
    if (!isBalanceSheetAccount(target)) {
      // P&L account appearing in IB: likely malformed SIE
      warnings.push(`P&L-konto ${ib.account} (→${target}) förekommer i #IB: ignoreras för resultaträkning`)
      continue
    }
    expectedMovements.set(target, (expectedMovements.get(target) || 0) - ib.amount)
  }

  // Process UB: only for balance sheet accounts
  for (const ub of parsed.closingBalances.filter((b) => b.yearIndex === 0)) {
    const target = accountMap.get(ub.account)
    if (!target) continue
    if (!isBalanceSheetAccount(target)) {
      warnings.push(`P&L-konto ${ub.account} (→${target}) förekommer i #UB: ignoreras för resultaträkning`)
      continue
    }
    expectedMovements.set(target, (expectedMovements.get(target) || 0) + ub.amount)
  }

  // Process RES: only for P&L accounts
  for (const res of parsed.resultBalances.filter((b) => b.yearIndex === 0)) {
    const target = accountMap.get(res.account)
    if (!target) continue
    if (isBalanceSheetAccount(target)) {
      warnings.push(`Balanskonto ${res.account} (→${target}) förekommer i #RES: ignoreras för balansräkning`)
      continue
    }
    expectedMovements.set(target, (expectedMovements.get(target) || 0) + res.amount)
  }

  // Compute per-account delta: expected - imported
  const lines: CreateJournalEntryLineInput[] = []
  const allAccounts = new Set([...expectedMovements.keys(), ...importedMovements.keys()])
  let deltaAccountCount = 0

  for (const account of allAccounts) {
    const expected = expectedMovements.get(account) || 0
    const imported = importedMovements.get(account) || 0
    const delta = Math.round((expected - imported) * 100) / 100

    if (Math.abs(delta) < 0.01) continue
    deltaAccountCount++

    // Fix 4: Per-line text referencing what the adjustment concerns
    const lineDesc = `Justering konto ${account}: delta ${delta} SEK från ${skippedDetails.length} exkl. verifikationer`

    if (delta > 0) {
      lines.push({
        account_number: account,
        debit_amount: delta,
        credit_amount: 0,
        line_description: lineDesc,
      })
    } else {
      lines.push({
        account_number: account,
        debit_amount: 0,
        credit_amount: Math.abs(delta),
        line_description: lineDesc,
      })
    }
  }

  if (lines.length === 0) {
    return { entryId: null, deltaAccounts: 0, warnings }
  }

  // The entry must balance. It should by construction, but verify and handle rounding.
  const totalDebit = lines.reduce((sum, l) => sum + l.debit_amount, 0)
  const totalCredit = lines.reduce((sum, l) => sum + l.credit_amount, 0)
  const balanceDiff = Math.round(Math.abs(totalDebit - totalCredit) * 100) / 100

  if (balanceDiff > 0.005) {
    const roundedDiff = Math.round((totalDebit - totalCredit) * 100) / 100
    if (roundedDiff > 0) {
      lines.push({
        account_number: '3741',
        debit_amount: 0,
        credit_amount: Math.abs(roundedDiff),
        line_description: 'Öresutjämning omföringsverifikation',
      })
    } else {
      lines.push({
        account_number: '3741',
        debit_amount: Math.abs(roundedDiff),
        credit_amount: 0,
        line_description: 'Öresutjämning omföringsverifikation',
      })
    }
  }

  // Date the adjustment at fiscal year end
  const entryDate = parsed.stats.fiscalYearEnd ?? formatDate(new Date())

  // Fix 4: Build structured description with skipped voucher details
  const skippedIds = skippedDetails.map(d => d.voucherId)
  const skippedDates = skippedDetails.map(d => d.date).sort()
  const firstId = skippedIds[0] || '?'
  const lastId = skippedIds[skippedIds.length - 1] || '?'
  const firstDate = skippedDates[0] || '?'
  const lastDate = skippedDates[skippedDates.length - 1] || '?'

  const entry = await createJournalEntry(supabase, companyId, userId, {
    fiscal_period_id: fiscalPeriodId,
    entry_date: entryDate,
    description: `Omföringsverifikation: justering för ${skippedDetails.length} exkluderade verifikationer (${firstId}-${lastId}, ${firstDate}-${lastDate}) vid SIE-import`,
    source_type: 'import',
    voucher_series: 'M',
    lines,
  })

  return { entryId: entry.id, deltaAccounts: deltaAccountCount, warnings }
}

/**
 * Ensure a specific account exists in the user's chart of accounts.
 * Uses BAS reference for metadata when available, falls back to derivation.
 */
async function ensureAccountExists(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  accountNumber: string,
  accountName: string
): Promise<void> {
  const { data } = await supabase
    .from('chart_of_accounts')
    .select('id')
    .eq('company_id', companyId)
    .eq('account_number', accountNumber)
    .single()

  if (data) return // Already exists

  const basRef = getBASReference(accountNumber)

  if (basRef) {
    await supabase.from('chart_of_accounts').insert({
      user_id: userId,
      company_id: companyId,
      account_number: accountNumber,
      account_name: basRef.account_name,
      account_class: basRef.account_class,
      account_group: basRef.account_group,
      account_type: basRef.account_type,
      normal_balance: basRef.normal_balance,
      sru_code: basRef.sru_code ?? computeSRUCode(accountNumber),
      k2_excluded: basRef.k2_excluded,
      plan_type: 'full_bas',
      is_active: true,
      is_system_account: false,
    })
    return
  }

  // Fallback: derive metadata from account number
  const classNum = parseInt(accountNumber.charAt(0), 10)
  const group = accountNumber.substring(0, 2)
  const classified = classifyAccount(accountNumber)

  await supabase.from('chart_of_accounts').insert({
    user_id: userId,
    company_id: companyId,
    account_number: accountNumber,
    account_name: accountName,
    account_class: classNum,
    account_group: group,
    account_type: classified.account_type,
    normal_balance: classified.normal_balance,
    sru_code: computeSRUCode(accountNumber),
    plan_type: 'full_bas',
    is_active: true,
    is_system_account: false,
  })
}

/**
 * Phase 1: Create a pending import record early, before any journal entries.
 * This ensures the import is tracked even if later steps fail.
 */
async function createPendingImportRecord(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  parsed: ParsedSIEFile,
  fileContent: string,
  filename: string
): Promise<string> {
  const fileHash = await calculateFileHash(fileContent)

  // Clean up any stale pending/failed records for this hash to avoid UNIQUE conflicts
  await cleanupStaleImportRecords(supabase, companyId, fileHash)

  const { data, error } = await supabase
    .from('sie_imports')
    .insert({
      user_id: userId,
      company_id: companyId,
      filename,
      file_hash: fileHash,
      org_number: parsed.header.orgNumber,
      company_name: parsed.header.companyName,
      sie_type: parsed.header.sieType,
      fiscal_year_start: parsed.stats.fiscalYearStart ?? null,
      fiscal_year_end: parsed.stats.fiscalYearEnd ?? null,
      accounts_count: parsed.stats.totalAccounts,
      transactions_count: 0,
      status: 'pending',
      imported_at: null,
    })
    .select('id')
    .single()

  if (error || !data) {
    // PG error 23505 (unique_violation) on the partial index means another
    // active row exists for the same (company_id, file_hash). Surface the
    // recovery path in Swedish instead of leaking the raw Postgres message.
    const pgCode = (error as { code?: string } | null | undefined)?.code
    const pgMessage = error?.message ?? ''
    const hitsActiveIdx =
      pgCode === '23505' &&
      pgMessage.includes('sie_imports_company_id_file_hash_active_idx')

    if (hitsActiveIdx) {
      throw new Error(
        'En tidigare SIE-import för samma fil finns redan i gnubok. Öppna importhistoriken och välj "Ersätt import" på den befintliga raden, eller använd Fortnox-synkningen för att hämta uppdaterad data automatiskt.'
      )
    }

    throw new Error(`Failed to create pending import record: ${pgMessage}`)
  }

  return data.id
}

/**
 * Phase 2: Finalize the import record with results and archive the SIE file.
 */
export async function finalizeImportRecord(
  supabase: SupabaseClient,
  importId: string,
  companyId: string,
  result: ImportResult,
  fileContent: string,
  documentation?: MigrationDocumentation
): Promise<void> {
  // Safety net: if the import ran without errors but didn't actually create
  // any journal entries (no OB entry, no vouchers), refuse to mark it as
  // 'completed'. A 'completed' row with transactions_count=0 would claim
  // the (company_id, file_hash) slot in the partial unique index and the
  // overlapping-period check would block any retry. Flipping to 'failed'
  // (which the partial index already excludes) keeps the slot free so the
  // caller can re-import the same file once the mapping is fixed.
  const noEntriesCreated =
    result.success &&
    result.journalEntriesCreated === 0 &&
    !result.openingBalanceEntryId
  if (noEntriesCreated) {
    result.success = false
    if (result.errors.length === 0) {
      result.errors.push(
        'Importen skapade 0 verifikationer: markerar som misslyckad så filen ' +
        'kan importeras om utan replace/undo. Granska varningarna för att se ' +
        'vilka konton som behöver mappas.',
      )
    }
  }

  const status = result.success ? 'completed' : 'failed'

  await supabase
    .from('sie_imports')
    .update({
      status,
      imported_at: result.success ? new Date().toISOString() : null,
      transactions_count: result.journalEntriesCreated,
      error_message: result.errors.length > 0 ? result.errors.join('; ') : null,
      fiscal_period_id: result.fiscalPeriodId,
      opening_balance_entry_id: result.openingBalanceEntryId,
      migration_documentation: documentation ?? null,
    })
    .eq('id', importId)

  // Archive the SIE file to Supabase Storage (BFL 7 kap 1-2§ retention)
  if (result.success) {
    const storagePath = `${companyId}/${importId}.se`
    const fileBlob = new Blob([fileContent], { type: 'text/plain' })
    const { error: uploadError } = await supabase.storage
      .from('sie-files')
      .upload(storagePath, fileBlob, { upsert: false })

    if (uploadError) {
      console.error(`[sie-import] Failed to archive SIE file: ${uploadError.message}`)
    } else {
      await supabase
        .from('sie_imports')
        .update({ file_storage_path: storagePath })
        .eq('id', importId)
    }
  }
}

/**
 * Save account mappings to the database for future use
 */
export async function saveMappings(
  supabase: SupabaseClient,
  companyId: string,
  mappings: AccountMapping[]
): Promise<void> {
  // Filter to only mapped accounts
  const mappingsToSave = mappings
    .filter((m) => m.targetAccount)
    .map((m) => ({
      company_id: companyId,
      source_account: m.sourceAccount,
      source_name: m.sourceName,
      target_account: m.targetAccount,
      confidence: m.confidence,
      match_type: m.matchType,
    }))

  if (mappingsToSave.length === 0) return

  // Batch upsert in chunks of 100
  const BATCH_SIZE = 100
  for (let i = 0; i < mappingsToSave.length; i += BATCH_SIZE) {
    const batch = mappingsToSave.slice(i, i + BATCH_SIZE)
    await supabase
      .from('sie_account_mappings')
      .upsert(batch, {
        onConflict: 'company_id,source_account',
      })
  }
}

/**
 * Load existing account mappings for a user
 */
export async function loadMappings(supabase: SupabaseClient, companyId: string): Promise<Map<string, AccountMapping>> {
  const { data } = await supabase
    .from('sie_account_mappings')
    .select('*')
    .eq('company_id', companyId)

  const map = new Map<string, AccountMapping>()

  for (const record of data || []) {
    map.set(record.source_account, {
      sourceAccount: record.source_account,
      sourceName: record.source_name || '',
      targetAccount: record.target_account,
      targetName: '', // Will be filled in by the mapper
      confidence: record.confidence,
      matchType: record.match_type,
      isOverride: true,
    })
  }

  return map
}

/**
 * Execute the full SIE import
 *
 * `onExistingPeriod` controls how a prior completed import that overlaps
 * the new SIE's fiscal year is handled:
 *   - 'block' (default): refuse with a Swedish error. Used by the manual
 *     upload route in app/api/import/sie. Preserves prior behavior.
 *   - 'replace': automatically call replaceSIEImport on the prior row
 *     (marks it 'replaced', cancels its imported journal entries) and
 *     proceed. Used by the Fortnox re-sync flow so the user can pull
 *     updated data from Fortnox without manual cleanup.
 *
 * Replace only cancels journal entries with source_type='import'; entries
 * the user created natively in Accounted (categorized transactions, invoices,
 * etc.) are left alone. See the replace_sie_import RPC.
 *
 * `updateAccountNames` (default true) carries the SIE file's #KONTO names
 * into the chart for identity-mapped accounts: new accounts are created with
 * the file's name and existing accounts whose name differs are renamed.
 * When false, accounts are created with BAS default names and existing
 * accounts are left untouched (the pre-2026-06 behavior).
 */
export async function executeSIEImport(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  parsed: ParsedSIEFile,
  mappings: AccountMapping[],
  options: {
    filename: string
    fileContent: string
    createFiscalPeriod: boolean
    importOpeningBalances: boolean
    importTransactions: boolean
    voucherSeries?: string
    onExistingPeriod?: 'block' | 'replace'
    updateAccountNames?: boolean
    // Opt-in: mark every imported (source_type='import') verifikat as "Inget
    // underlag krävs" so a multi-year migration doesn't flood "Att hantera:
    // saknade underlag" with thousands of items. OFF by default.
    markImportedNoDocRequired?: boolean
  }
): Promise<ImportResult> {
  const result: ImportResult = {
    success: false,
    importId: null,
    fiscalPeriodId: null,
    openingBalanceEntryId: null,
    journalEntriesCreated: 0,
    journalEntryIds: [],
    errors: [],
    warnings: [],
    replacedPriorImport: null,
  }

  // Collected source_type='import' entry ids (vouchers + migration adjustment),
  // used only when options.markImportedNoDocRequired is set. Kept separate from
  // result.journalEntryIds because that also holds opening_balance entries.
  const importTypedEntryIds: string[] = []

  const onExistingPeriod = options.onExistingPeriod ?? 'block'
  const updateAccountNames = options.updateAccountNames ?? true

  try {
    // Validate all accounts are mapped
    const unmapped = mappings.filter((m) => !m.targetAccount)
    if (unmapped.length > 0) {
      result.errors.push(
        `${unmapped.length} accounts are not mapped: ${unmapped.map((m) => m.sourceAccount).join(', ')}`
      )
      return result
    }

    // Defense in depth: refuse to enter executeSIEImport when the mapping
    // doesn't cover a single account present in the file. Without this guard
    // a stale MCP client (or the HTTP execute route) could still drive
    // importVouchers to silently skip every voucher and write a 0-entry
    // 'completed' sie_imports row that holds the unique-index slot. Mirrors
    // the stage-time check in gnubok_import_sie.
    const sourceAccountsInFile = new Set<string>()
    for (const v of parsed.vouchers) for (const l of v.lines) sourceAccountsInFile.add(l.account)
    if (options.importOpeningBalances) {
      // Effective set: also covers UB-1-only files (issue #675), whose
      // derived IB accounts would otherwise bypass this guard entirely.
      for (const b of getEffectiveOpeningBalances(parsed).balances) {
        sourceAccountsInFile.add(b.account)
      }
    }
    const mappedSources = new Set(
      mappings.filter((m) => m.targetAccount).map((m) => m.sourceAccount),
    )
    const hasOverlap = [...sourceAccountsInFile].some((a) => mappedSources.has(a))
    if (sourceAccountsInFile.size > 0 && !hasOverlap) {
      const sample = [...sourceAccountsInFile].slice(0, 8).join(', ')
      result.errors.push(
        `Kontomappningarna täcker inga konton i SIE-filen. ` +
        `Filen innehåller ${sourceAccountsInFile.size} unika källkonton ` +
        `(t.ex. ${sample}), men inget av dem finns i mappings.sourceAccount. ` +
        `Importen avbryts innan en sie_imports-rad skapas så att du kan ` +
        `försöka igen med korrekta mappningar.`,
      )
      return result
    }

    // Replace mode: if a prior completed import overlaps the new SIE's fiscal
    // year, mark it 'replaced' (and cancel its imported entries) before we
    // try to insert. Done before checkDuplicateImport / checkDuplicatePeriodImport
    // since both of those would otherwise reject the replace flow.
    if (onExistingPeriod === 'replace') {
      const fyStart = parsed.stats.fiscalYearStart
      const fyEnd = parsed.stats.fiscalYearEnd
      if (fyStart && fyEnd) {
        const priorPeriodImport = await checkDuplicatePeriodImport(
          supabase, companyId, fyStart, fyEnd
        )
        if (priorPeriodImport) {
          const replaceResult = await replaceSIEImport(
            supabase, companyId, priorPeriodImport.id
          )
          if (!replaceResult.success) {
            result.errors.push(
              replaceResult.error ?? 'Kunde inte ersätta tidigare SIE-import'
            )
            return result
          }
          result.replacedPriorImport = {
            importId: priorPeriodImport.id,
            deletedEntries: replaceResult.deletedEntries,
          }

          // The replace_sie_import RPC clears fiscal_periods
          // opening_balance_entry_id and opening_balances_set inside its
          // transaction when the prior import had an OB entry. This client-
          // side UPDATE is now an idempotent safety net for pre-fix data
          // (companies whose prior replace ran against the soft-cancel
          // implementation and left the pointer dangling on the row).
          if (priorPeriodImport.fiscal_period_id && priorPeriodImport.opening_balance_entry_id) {
            await supabase
              .from('fiscal_periods')
              .update({
                opening_balances_set: false,
                opening_balance_entry_id: null,
              })
              .eq('id', priorPeriodImport.fiscal_period_id)
              .eq('company_id', companyId)
              .eq('opening_balance_entry_id', priorPeriodImport.opening_balance_entry_id)
          }
        }
      }
    }

    // Block mode (default): the hash and period checks reject duplicates with
    // graceful Swedish errors. Skipped in replace mode because we've already
    // resolved any prior import above.
    if (onExistingPeriod === 'block') {
      const duplicate = await checkDuplicateImport(supabase, companyId, options.fileContent)
      if (duplicate) {
        result.errors.push(
          `This file has already been imported on ${duplicate.imported_at ? new Date(duplicate.imported_at).toLocaleDateString('sv-SE') : 'okänt datum'}`
        )
        return result
      }
    }

    // Create pending import record early: ensures tracking even if later steps fail
    result.importId = await createPendingImportRecord(
      supabase,
      companyId,
      userId,
      parsed,
      options.fileContent,
      options.filename
    )

    // Dimension registry (#DIM/#UNDERDIM/#OBJEKT + object-list references):
    // upsert missing rows and auto-enable the toggle with a notice. Runs
    // before vouchers so tagged lines land with their registry rows present.
    // Files without dimension data return null: nothing changes.
    const dimensionSummary = await importDimensionRegistry(
      supabase,
      companyId,
      parsed,
      result.importId
    )
    if (dimensionSummary) {
      result.dimensionsImported = {
        dimensions: dimensionSummary.dimensionsCreated,
        values: dimensionSummary.valuesCreated,
        taggedLines: dimensionSummary.taggedLines,
        toggleEnabled: dimensionSummary.toggleEnabled,
      }
      result.warnings.push(...dimensionSummary.warnings)
    }

    // Build account mapping lookup
    const accountMap = mappingsToMap(mappings)

    // Ensure all mapped target accounts exist in chart_of_accounts and,
    // unless disabled, carry the SIE file's #KONTO names into the chart:
    // customized names from the source system (e.g. Fortnox) would otherwise
    // be lost to the BAS defaults.
    const accountSync = await syncMappedAccounts(
      supabase,
      companyId,
      userId,
      mappings,
      updateAccountNames
    )
    if (accountSync.error) {
      result.errors.push(`Failed to create accounts: ${accountSync.error}`)
      return result
    }
    if (accountSync.renamed > 0) {
      result.warnings.push(
        accountSync.renamed === 1
          ? '1 konto bytte namn till namnet från SIE-filen'
          : `${accountSync.renamed} konton bytte namn till namnen från SIE-filen`
      )
    }
    if (accountSync.renameFailed > 0) {
      result.warnings.push(
        `${accountSync.renameFailed} kontonamn kunde inte uppdateras från SIE-filen`
      )
    }

    // Create or find fiscal period
    const fiscalYearStart = parsed.stats.fiscalYearStart
    const fiscalYearEnd = parsed.stats.fiscalYearEnd

    if (!fiscalYearStart || !fiscalYearEnd) {
      result.errors.push('No fiscal year defined in the SIE file')
      return result
    }

    // Safety net: reject if a completed import already exists for this period.
    // Skipped in replace mode: any overlapping prior import was already
    // marked 'replaced' at the top of executeSIEImport.
    if (onExistingPeriod === 'block') {
      const periodDuplicate = await checkDuplicatePeriodImport(
        supabase, companyId, fiscalYearStart, fiscalYearEnd
      )
      if (periodDuplicate) {
        result.errors.push(
          `En SIE-import för ett överlappande räkenskapsår (${periodDuplicate.fiscal_year_start} till ${periodDuplicate.fiscal_year_end}) finns redan`
        )
        return result
      }
    }

    if (options.createFiscalPeriod) {
      result.fiscalPeriodId = await ensureFiscalPeriod(
        supabase,
        companyId,
        fiscalYearStart,
        fiscalYearEnd
      )
    } else {
      // Find existing fiscal period
      const { data: existing } = await supabase
        .from('fiscal_periods')
        .select('id')
        .eq('company_id', companyId)
        .lte('period_start', fiscalYearStart)
        .gte('period_end', fiscalYearEnd)
        .single()

      if (!existing) {
        result.errors.push('No matching fiscal period found. Enable "Create fiscal period" option.')
        return result
      }

      result.fiscalPeriodId = existing.id
    }

    // Track documentation data across import phases
    let ibRoundingAdjustment = 0
    let ibExplanation: 'unallocated_result' | 'excluded_accounts' | 'rounding' | null = null
    let migrationAdjustmentInfo = { created: false, deltaAccounts: 0, entryId: null as string | null }
    let voucherNumberMapping: Array<{ sourceId: string; series: string; targetNumber: number }> = []
    let voucherSeriesUsed: string[] = []
    let voucherRetryStats = { retriedBatches: 0, failedBatches: 0 }
    let voucherStats = {
      total: parsed.vouchers.length,
      imported: 0,
      skippedUnbalanced: 0,
      skippedUnmapped: 0,
      skippedSingleLine: 0,
      skippedEmpty: 0,
    }
    // Fallback series for vouchers that arrive without one (SIE4I subsystem files).
    // Source series from #VER are preserved per-voucher by importVouchers.
    const defaultSeries = options.voucherSeries || 'B'

    // Validate and import opening balances.
    //
    // IB imbalance is NORMAL in Swedish SIE files for two common reasons:
    // 1. Excluded system accounts (Fortnox 0099 etc.) carry IB balances
    // 2. Previous year's result (årets resultat) hasn't been allocated to equity
    //    yet: the profit/loss is implicit, not an explicit IB on 2099
    //
    // In both cases, the correct treatment is to book the diff to 2099 with
    // explicit documentation. We never reject based on IB imbalance: the
    // original goal was to stop SILENT equity alteration, not prevent it.
    //
    // Gate on the EFFECTIVE set: for files without #IB 0, the IB derived
    // from #UB -1 (issue #675) must still open this block: gating on raw
    // parsed.openingBalances would silently skip the derived IB entirely.
    const effectiveIB = getEffectiveOpeningBalances(parsed)
    if (options.importOpeningBalances && effectiveIB.balances.length > 0 && result.fiscalPeriodId) {
      // Check if opening balances already exist for this period
      const { data: period } = await supabase
        .from('fiscal_periods')
        .select('opening_balances_set, opening_balance_entry_id')
        .eq('id', result.fiscalPeriodId)
        .single()

      if (period?.opening_balances_set || period?.opening_balance_entry_id) {
        result.warnings.push('Ingående balanser finns redan för denna period: hoppar över IB-import')
      } else {
        // Continuation-import guard: if the company already has any posted
        // non-IB journal entries from a prior import or manual bookkeeping,
        // do NOT create a new IB entry. Each year's #IB equals the prior
        // year's UB, which is already the sum of the prior year's posted
        // transactions, so importing another IB entry double-counts one
        // year of activity against every balance-sheet account. The
        // first-ever import creates the legitimate pre-system IB; subsequent
        // imports must rely on the prior entries to derive opening balances
        // on the fly (via getOpeningBalances() fallback).
        const isContinuationImport = await companyHasPriorActivity(supabase, companyId)

        if (isContinuationImport) {
          result.warnings.push(
            'Ingående balanser hoppades över eftersom bolaget redan har bokförda verifikationer. ' +
            'Ingående balans för denna period härleds från föregående periods utgående balans. ' +
            'Stäm av mot SIE-filens #IB om du är osäker.'
          )
        } else {
        const ibValidation = validateIBBalance(parsed, accountMap)

        if (ibValidation.lines.length > 0) {
          if (effectiveIB.derivedFromPriorYearUB) {
            result.warnings.push(
              'SIE-filen saknar ingående balanser (#IB) för räkenskapsåret. ' +
              'Ingående balanser härleddes från föregående års utgående balanser (#UB -1) enligt kontinuitetsprincipen.'
            )
          }

          const absAdj = Math.abs(ibValidation.roundingAdjustment)

          if (absAdj > 0.01) {
            ibRoundingAdjustment = ibValidation.roundingAdjustment

            // Produce a descriptive warning explaining the source of the imbalance
            if (Math.abs(ibValidation.excludedAccountsTotal) > 0.01 && ibValidation.fileImbalance <= 1.00) {
              // File-level IB is balanced: imbalance is entirely from excluded system accounts
              ibExplanation = 'excluded_accounts'
              result.warnings.push(
                `Exkluderade systemkonton har IB-saldon på totalt ${ibValidation.excludedAccountsTotal} SEK. ` +
                `Differensen (${ibValidation.roundingAdjustment} SEK) bokförs på konto 2099.`
              )
            } else if (ibValidation.fileImbalance > 1.00) {
              // File-level IB doesn't balance: likely unallocated årets resultat from previous year
              ibExplanation = 'unallocated_result'
              result.warnings.push(
                `Ingående balanser obalanserade med ${ibValidation.roundingAdjustment} SEK ` +
                `(troligen ej allokerat årets resultat från föregående räkenskapsår). ` +
                `Differensen bokförs på konto 2099 (Årets resultat).`
              )
            } else {
              // Small rounding
              ibExplanation = 'rounding'
              result.warnings.push(
                `Avrundningsdifferens vid SIE-import: ${ibValidation.roundingAdjustment} SEK bokförd på konto 2099`
              )
            }
          }

          result.openingBalanceEntryId = await createOpeningBalanceEntry(
            supabase,
            companyId,
            userId,
            result.fiscalPeriodId,
            parsed,
            accountMap,
            ibRoundingAdjustment
          )

          if (result.openingBalanceEntryId) {
            result.journalEntriesCreated++
            result.journalEntryIds.push(result.openingBalanceEntryId)

            await linkOpeningBalanceEntryToPeriod(
              supabase,
              companyId,
              result.fiscalPeriodId,
              result.openingBalanceEntryId
            )
          }
        }
        }
      }
    }

    // Import transactions (SIE4 only)
    if (options.importTransactions && parsed.vouchers.length > 0 && result.fiscalPeriodId) {
      // Reject vouchers whose date falls outside the resolved fiscal period.
      // Without this guard, a SIE file whose #VER dates extend beyond #RAR (or
      // a fiscal period whose shape doesn't match the file's #RAR) would
      // produce journal entries stamped to a period that doesn't cover their
      // own entry_date: breaking the SIE invariant and BFL 5 kap.
      //
      // Fail closed if the period fetch errors: a silent skip would leave the
      // exact data-corruption path this guard exists to close.
      const { data: resolvedPeriod, error: resolvedPeriodError } = await supabase
        .from('fiscal_periods')
        .select('period_start, period_end')
        .eq('id', result.fiscalPeriodId)
        .single()

      if (resolvedPeriodError || !resolvedPeriod) {
        result.errors.push(
          `Kunde inte verifiera räkenskapsårets datumintervall innan import: ${resolvedPeriodError?.message ?? 'räkenskapsåret hittades inte'}. Försök igen.`
        )
        return result
      }

      // Date-only string comparison: sidesteps any latent off-by-one if the
      // SIE parser ever attaches a time component to v.date. SIE per spec is
      // YYYYMMDD and our parser normalizes to midnight, but a string compare
      // matches the underlying DATE columns exactly and is cheap.
      const periodStart = resolvedPeriod.period_start as string
      const periodEnd = resolvedPeriod.period_end as string
      const outOfRange = parsed.vouchers.filter((v) => {
        const d = formatDate(v.date)
        return d < periodStart || d > periodEnd
      })

      if (outOfRange.length > 0) {
        const sample = outOfRange.slice(0, 3).map(v => `${v.series}${v.number} (${formatDate(v.date)})`).join(', ')
        result.errors.push(
          `${outOfRange.length} verifikation${outOfRange.length === 1 ? '' : 'er'} har datum utanför räkenskapsåret ` +
            `${periodStart} till ${periodEnd}. Exempel: ${sample}${outOfRange.length > 3 ? '…' : ''}. ` +
            `Importera varje räkenskapsår som en egen SIE-fil: flera år i samma fil stöds inte.`
        )
        return result
      }

      // Detect partial-year export: if voucher dates don't span the full fiscal year,
      // the migration adjustment will produce incorrect large deltas for the missing period.
      if (parsed.vouchers.length > 0 && fiscalYearStart && fiscalYearEnd) {
        const voucherDates = parsed.vouchers.map(v => v.date.getTime())
        const earliestVoucher = new Date(Math.min(...voucherDates))
        const latestVoucher = new Date(Math.max(...voucherDates))

        // Parse fiscal year string dates for comparison (append T00:00:00 to avoid UTC shift)
        const fyStart = new Date(fiscalYearStart + 'T00:00:00')
        const fyEnd = new Date(fiscalYearEnd + 'T00:00:00')

        // Allow 30 days margin from fiscal year start/end for partial detection
        const msPerDay = 86400000
        const startGap = earliestVoucher.getTime() - fyStart.getTime()
        const endGap = fyEnd.getTime() - latestVoucher.getTime()

        if (startGap > 60 * msPerDay || endGap > 60 * msPerDay) {
          result.warnings.push(
            `SIE-filen verkar innehålla ett ofullständigt räkenskapsår: verifikationer ${formatDate(earliestVoucher)}-${formatDate(latestVoucher)}, ` +
            `räkenskapsår ${fiscalYearStart}-${fiscalYearEnd}. ` +
            `Omföringsverifikationen kan bli felaktig om #UB/#RES avser hela året men verifikationerna bara täcker en del.`
          )
        }
      }

      // Ensure öresutjämning account 3741 exists in the user's chart
      await ensureAccountExists(supabase, companyId, userId, '3741', 'Öresutjämning vid import')

      const voucherResults = await importVouchers(
        supabase,
        companyId,
        userId,
        result.fiscalPeriodId,
        parsed,
        accountMap,
        defaultSeries
      )

      result.journalEntriesCreated += voucherResults.created
      result.journalEntryIds.push(...voucherResults.ids)
      importTypedEntryIds.push(...voucherResults.importTypedIds)
      result.errors.push(...voucherResults.errors)
      voucherNumberMapping = voucherResults.voucherNumberMapping
      voucherSeriesUsed = voucherResults.seriesUsed
      voucherRetryStats = {
        retriedBatches: voucherResults.retriedBatches,
        failedBatches: voucherResults.failedBatches,
      }

      // Update stats for documentation
      voucherStats = {
        total: parsed.vouchers.length,
        imported: voucherResults.created,
        skippedUnbalanced: voucherResults.skippedUnbalanced,
        skippedUnmapped: voucherResults.skippedUnmapped,
        skippedSingleLine: voucherResults.skippedSingleLine,
        skippedEmpty: voucherResults.skippedEmpty,
      }

      // Report skipped vouchers as warnings
      const totalSkipped = voucherResults.skippedEmpty + voucherResults.skippedSingleLine + voucherResults.skippedUnbalanced + voucherResults.skippedUnmapped
      if (totalSkipped > 0) {
        const parts: string[] = []
        if (voucherResults.skippedEmpty > 0) parts.push(`${voucherResults.skippedEmpty} tomma`)
        if (voucherResults.skippedUnbalanced > 0) parts.push(`${voucherResults.skippedUnbalanced} obalanserade`)
        if (voucherResults.skippedUnmapped > 0) parts.push(`${voucherResults.skippedUnmapped} med ej mappade konton`)
        result.warnings.push(
          `${totalSkipped} verifikationer hoppades över (ofullständiga i källsystemet): ${parts.join(', ')}`
        )
      }

      // Fix 3: Specific warning for single-line vouchers
      if (voucherResults.skippedSingleLine > 0) {
        const singleLineDetails = voucherResults.skippedDetails
          .filter(d => d.reason === 'single_line')
          .slice(0, 10)
          .map(d => d.voucherId)
        result.warnings.push(
          `${voucherResults.skippedSingleLine} enradsverifikationer hoppades över (kan vara periodiseringar/manuella justeringar): ${singleLineDetails.join(', ')}${voucherResults.skippedSingleLine > 10 ? '...' : ''}`
        )
      }

      // Create migration adjustment entry to reconcile against UB/RES
      const totalSkippedForAdjustment = voucherResults.skippedUnbalanced + voucherResults.skippedUnmapped + voucherResults.skippedSingleLine
      if (totalSkippedForAdjustment > 0 && result.fiscalPeriodId) {
        try {
          const adjustment = await createMigrationAdjustmentEntry(
            supabase,
            companyId,
            userId,
            result.fiscalPeriodId,
            parsed,
            accountMap,
            voucherResults.movementsByAccount,
            voucherResults.skippedDetails
          )

          result.warnings.push(...adjustment.warnings)

          if (adjustment.entryId) {
            result.journalEntriesCreated++
            result.journalEntryIds.push(adjustment.entryId)
            // The omföringsverifikation is source_type='import' too.
            importTypedEntryIds.push(adjustment.entryId)
            result.warnings.push(
              `Migreringsjustering skapad: ${adjustment.deltaAccounts} konton justerade för att matcha UB/RES från källsystemet`
            )
            migrationAdjustmentInfo = {
              created: true,
              deltaAccounts: adjustment.deltaAccounts,
              entryId: adjustment.entryId,
            }
          }
        } catch (adjustmentError) {
          console.error('[sie-import] Failed to create migration adjustment entry:', adjustmentError)
          result.warnings.push(
            'Kunde inte skapa migreringsjustering: kontrollera saldon manuellt mot källsystemet'
          )
        }
      }
    }

    // Save account mappings for future use (non-fatal, import data is already committed)
    try {
      await saveMappings(supabase, companyId, mappings)
    } catch (mappingError) {
      console.error('[sie-import] Failed to save mappings (non-fatal):', mappingError)
      result.warnings.push('Kunde inte spara kontomappningar: påverkar inte importerade data')
    }

    // Pragmatic IB resync: if a chronologically-later fiscal period already
    // exists with its own opening_balance entry, the customer is doing a
    // prior-year backfill. Sync the next period's IB to match the UB we
    // just imported so reports stay consistent.
    if (result.success && fiscalYearEnd && result.fiscalPeriodId && parsed.closingBalances.length > 0) {
      try {
        const resync = await resyncNextPeriodOpeningBalance(
          supabase,
          companyId,
          userId,
          fiscalYearEnd,
          parsed,
          accountMap,
        )
        if (resync.resynced) {
          result.nextPeriodIBResync = {
            nextPeriodId: resync.nextPeriodId,
            nextPeriodName: resync.nextPeriodName,
            stornoEntryId: resync.stornoEntryId,
            newOpeningBalanceEntryId: resync.newOpeningBalanceEntryId,
          }
          result.journalEntriesCreated += 2 // storno + new IB
          result.journalEntryIds.push(resync.stornoEntryId, resync.newOpeningBalanceEntryId)
          result.warnings.push(
            `Ingående balanser för ${resync.nextPeriodName} synkades om mot den just importerade utgående balansen.`,
          )
        } else if (resync.reason === 'next_period_locked' && resync.nextPeriodName) {
          result.nextPeriodIBResyncSkipped = {
            reason: 'locked',
            nextPeriodName: resync.nextPeriodName,
          }
          result.warnings.push(
            `Nästa räkenskapsår (${resync.nextPeriodName}) är låst: ingående balanser kunde inte synkas om automatiskt. Lås upp perioden och importera igen för att synka.`,
          )
        }
      } catch (resyncError) {
        console.error('[sie-import] IB resync failed (non-fatal):', resyncError)
        result.warnings.push(
          `Ingående balanser för nästa räkenskapsår kunde inte synkas om automatiskt: ${resyncError instanceof Error ? resyncError.message : 'okänt fel'}. Kontrollera och justera manuellt.`,
        )
      }
    }

    // Generate systemdokumentation (MigrationDocumentation)
    const mappingStats = getMappingStats(mappings)
    const documentation: MigrationDocumentation = {
      sourceSystem: parsed.header.program,
      sourceVersion: parsed.header.programVersion,
      sieType: parsed.header.sieType,
      generatedDate: parsed.header.generatedDate ?? null,
      fiscalYear: {
        start: fiscalYearStart,
        end: fiscalYearEnd,
      },
      importedAt: new Date().toISOString(),
      importedBy: userId,
      accountMappings: {
        total: mappingStats.total,
        exact: mappingStats.exact,
        basRange: mappingStats.basRange,
        manual: mappingStats.manual,
        unmapped: mappingStats.unmapped,
      },
      // Behandlingshistorik for #KONTO renames applied by this import
      // (BFNAR 2013:2, the warnings array only carries the count).
      accountRenames:
        accountSync.renamedAccounts.length > 0 ? accountSync.renamedAccounts : undefined,
      vouchers: voucherStats,
      openingBalanceRounding: ibRoundingAdjustment !== 0 ? ibRoundingAdjustment : null,
      migrationAdjustment: migrationAdjustmentInfo,
      voucherSeriesUsed: voucherSeriesUsed.length > 0 ? voucherSeriesUsed : [defaultSeries],
      voucherNumberRanges: computeVoucherNumberRanges(voucherNumberMapping),
      voucherNumberMapping,
    }

    // Populate structured details for the UI
    const totalSkippedForDetails = voucherStats.skippedUnbalanced + voucherStats.skippedUnmapped +
      voucherStats.skippedSingleLine + voucherStats.skippedEmpty
    result.details = {
      fiscalYear: fiscalYearStart && fiscalYearEnd
        ? { start: fiscalYearStart, end: fiscalYearEnd }
        : undefined,
      skippedVouchers: totalSkippedForDetails > 0 ? {
        unbalanced: voucherStats.skippedUnbalanced,
        unmapped: voucherStats.skippedUnmapped,
        singleLine: voucherStats.skippedSingleLine,
        empty: voucherStats.skippedEmpty,
        total: totalSkippedForDetails,
      } : undefined,
      openingBalance: ibRoundingAdjustment !== 0 ? {
        imbalance: ibRoundingAdjustment,
        explanation: ibExplanation,
        bookedToAccount: '2099',
      } : undefined,
      migrationAdjustment: migrationAdjustmentInfo.created ? {
        created: true,
        accountsAdjusted: migrationAdjustmentInfo.deltaAccounts,
      } : undefined,
      retriedBatches: voucherRetryStats.retriedBatches,
      failedBatches: voucherRetryStats.failedBatches,
    }

    // Untransferred prior-year results — the root cause of "balansräkningen
    // balanserar inte" after multi-year migrations. Any non-latest fiscal
    // year whose P&L doesn't net to zero (its omföring av årets resultat is
    // missing) corrupts every later derived opening balance by exactly that
    // residual. Checked against the DB (not the file) so it also catches
    // gaps introduced across separate per-year imports. Non-fatal: a
    // diagnosis failure never fails the import.
    try {
      const untransferred = await findUntransferredResults(supabase, companyId)
      if (untransferred.length > 0 && result.details) {
        result.details.untransferredResults = untransferred
        for (const culprit of untransferred) {
          result.warnings.push(
            `Resultatet för ${culprit.period_name} (${formatCurrency(culprit.pl_net, 'SEK', { minimumFractionDigits: 2 })}) har inte förts om till eget kapital — ` +
            'senare års balansräkning visar en differens tills omföringen bokförs i det året.'
          )
        }
      }
    } catch (diagnosisError) {
      console.error('[sie-import] untransferred-results check failed (non-fatal):', diagnosisError)
    }

    // Set success before finalizing
    result.success = result.errors.length === 0

    // Finalize the import record with results and documentation
    await finalizeImportRecord(
      supabase,
      result.importId,
      companyId,
      result,
      options.fileContent,
      documentation
    )

    // Populate counterparty templates from voucher patterns (non-blocking)
    if (result.success && parsed.vouchers.length > 0) {
      try {
        const templateCount = await populateTemplatesFromSieVouchers(
          supabase, companyId, parsed.vouchers
        )
        if (templateCount > 0) {
          console.info(`[sie-import] ${templateCount} counterparty templates extracted from voucher history`)
        }
      } catch (templateError) {
        console.error('[sie-import] Failed to populate counterparty templates:', templateError)
      }
    }

    // Opt-in: mark imported verifikat as "Inget underlag krävs" (non-blocking).
    // Migrated vouchers carry their underlag in the source system, so the user
    // can choose to keep all of them out of "Att hantera: saknade underlag" in
    // one go instead of clearing thousands of items by hand. Data is already
    // committed at this point, so a failure here only loses the convenience.
    if (result.success && options.markImportedNoDocRequired && importTypedEntryIds.length > 0) {
      try {
        await markEntriesNoDocRequired(
          supabase,
          companyId,
          userId,
          importTypedEntryIds,
          'Importerad från tidigare system (SIE)',
        )
      } catch (exemptError) {
        console.error('[sie-import] Failed to mark imported entries no-doc-required (non-fatal):', exemptError)
        result.warnings.push(
          'Kunde inte markera importerade verifikat som "Inget underlag krävs": du kan markera dem manuellt i bokföringslistan.',
        )
      }
    }

    // Add warnings for any issues
    for (const issue of parsed.issues) {
      if (issue.severity === 'warning') {
        result.warnings.push(`Line ${issue.line}: ${issue.message}`)
      }
    }

  } catch (error) {
    result.errors.push(
      `Import failed: ${error instanceof Error ? error.message : 'Unknown error'}`
    )

    // Mark the pending import as failed if we created one
    if (result.importId) {
      try {
        await finalizeImportRecord(
          supabase,
          result.importId,
          companyId,
          result,
          options.fileContent
        )
      } catch (finalizeError) {
        console.error('[sie-import] Failed to finalize import record on error:', finalizeError)
      }
    }
  }

  return result
}
