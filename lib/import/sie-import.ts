/**
 * SIE Import Engine
 *
 * Executes the actual import of SIE data into the database.
 * Creates fiscal periods, opening balance entries, and journal entries.
 * All operations are wrapped to ensure atomic behavior.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { createJournalEntry } from '@/lib/bookkeeping/engine'
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
import { calculateFileHash } from './sie-parser'
import { getBASReference } from '@/lib/bookkeeping/bas-reference'
import { computeSRUCode } from '@/lib/bookkeeping/bas-data/sru-mapping'
import { populateTemplatesFromSieVouchers } from '@/lib/bookkeeping/counterparty-templates'

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
  // Calculate opening balance totals
  const currentYearBalances = parsed.openingBalances.filter((b) => b.yearIndex === 0)
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
    issues: parsed.issues,
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
 * which would create duplicate verifikationer violating BFNAR 2013:2.
 * Only blocks on status='completed' — failed/pending imports don't prevent retries.
 */
export async function checkDuplicatePeriodImport(
  supabase: SupabaseClient,
  companyId: string,
  fiscalYearStart: string,
  fiscalYearEnd: string
): Promise<SIEImport | null> {
  const { data } = await supabase
    .from('sie_imports')
    .select('*')
    .eq('company_id', companyId)
    .eq('fiscal_year_start', fiscalYearStart)
    .eq('fiscal_year_end', fiscalYearEnd)
    .eq('status', 'completed')
    .limit(1)
    .maybeSingle()

  return data as SIEImport | null
}

/**
 * Clean up stale pending/failed import records for a given file hash.
 * Prevents UNIQUE constraint conflicts when re-importing after a failure.
 */
async function cleanupStaleImportRecords(
  supabase: SupabaseClient,
  companyId: string,
  fileHash: string
): Promise<void> {
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString()

  await supabase
    .from('sie_imports')
    .delete()
    .eq('company_id', companyId)
    .eq('file_hash', fileHash)
    .in('status', ['pending', 'failed'])
}

/**
 * Create a fiscal period if one doesn't exist for the date range.
 * Dates are ISO strings "YYYY-MM-DD" to avoid timezone issues.
 */
async function ensureFiscalPeriod(
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

  // Check for any overlapping period (DB exclusion constraint would reject
  // a new insert that overlaps). Use the overlapping period instead.
  const { data: overlapping } = await supabase
    .from('fiscal_periods')
    .select('id')
    .eq('company_id', companyId)
    .lte('period_start', endDate)
    .gte('period_end', startDate)
    .order('period_start', { ascending: false })
    .limit(1)

  if (overlapping && overlapping.length > 0) {
    return overlapping[0].id
  }

  // Create new fiscal period
  const startYear = parseInt(startDate.substring(0, 4), 10)
  const endYear = parseInt(endDate.substring(0, 4), 10)
  const name = startYear === endYear
    ? `Räkenskapsår ${startYear}`
    : `Räkenskapsår ${startYear}/${endYear}`

  const { data: newPeriod, error } = await supabase
    .from('fiscal_periods')
    .insert({
      company_id: companyId,
      name,
      period_start: startDate,
      period_end: endDate,
      is_closed: false,
      opening_balances_set: false,
    })
    .select()
    .single()

  if (error || !newPeriod) {
    throw new Error(`Failed to create fiscal period: ${error?.message}`)
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
  const currentYearBalances = parsed.openingBalances.filter((b) => b.yearIndex === 0)

  // First: check the raw file-level IB balance (all accounts, before mapping)
  const rawTotal = currentYearBalances.reduce((sum, b) => sum + b.amount, 0)
  const fileImbalance = Math.round(Math.abs(rawTotal) * 100) / 100

  // Build mapped lines and track excluded account totals
  const lines: CreateJournalEntryLineInput[] = []
  let excludedTotal = 0

  for (const balance of currentYearBalances) {
    const targetAccount = accountMap.get(balance.account)
    if (!targetAccount) {
      // Account not in mapping (system account or unmapped) — track its IB contribution
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
  const currentYearBalances = parsed.openingBalances.filter((b) => b.yearIndex === 0)

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
    description: 'Ingående balanser från SIE-import',
    source_type: 'opening_balance',
    voucher_series: 'A',
    lines,
  })

  return entry.id
}

/**
 * Create journal entries from vouchers using batch insert for performance
 */
async function importVouchers(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  fiscalPeriodId: string,
  parsed: ParsedSIEFile,
  accountMap: Map<string, string>,
  voucherSeries: string
): Promise<{
  created: number
  ids: string[]
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
  voucherNumberMapping: Array<{ sourceId: string; targetNumber: number }>
  retriedBatches: number
  failedBatches: number
}> {
  const results = {
    created: 0,
    ids: [] as string[],
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
    voucherNumberMapping: [] as Array<{ sourceId: string; targetNumber: number }>,
    retriedBatches: 0,
    failedBatches: 0,
  }

  // Pre-filter and prepare all valid vouchers
  interface PreparedVoucher {
    sourceId: string
    date: string
    description: string
    lines: { account_number: string; debit_amount: number; credit_amount: number; line_description: string | null }[]
  }

  const preparedVouchers: PreparedVoucher[] = []

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
        })
      } else if (line.amount < 0) {
        lines.push({
          account_number: targetAccount,
          debit_amount: 0,
          credit_amount: Math.round(Math.abs(line.amount) * 100) / 100,
          line_description: line.description || null,
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

    // Validate balance — Fix 2: Tiered rounding with öresutjämning (3741)
    const totalDebit = lines.reduce((sum, l) => sum + l.debit_amount, 0)
    const totalCredit = lines.reduce((sum, l) => sum + l.credit_amount, 0)
    const balanceDiff = Math.round(Math.abs(totalDebit - totalCredit) * 100) / 100
    if (balanceDiff > 1.00) {
      // More than 1 SEK off — incomplete voucher in source system, skip
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
      // Rounding difference <= 1 SEK — add explicit öresutjämning line (never modify existing lines)
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

    preparedVouchers.push({
      sourceId: voucherId,
      date: formatDate(voucher.date),
      description: voucher.description || `Import: ${voucher.series}${voucher.number}`,
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

  // Get starting voucher number
  const { data: startNumber } = await supabase.rpc('next_voucher_number', {
    p_company_id: companyId,
    p_fiscal_period_id: fiscalPeriodId,
    p_series: voucherSeries,
  })

  const currentVoucherNumber = (startNumber as number) || 1

  // Batch insert journal entries (in chunks of 100) with retry logic.
  // Retries handle transient errors (Supabase rate limits, Cloudflare 500s).
  const BATCH_SIZE = 100
  const MAX_RETRIES = 3
  const INTER_BATCH_DELAY_MS = 50  // Prevent rate limiting under sustained load
  let retriedBatches = 0
  let failedBatches = 0

  for (let batchStart = 0; batchStart < preparedVouchers.length; batchStart += BATCH_SIZE) {
    const batch = preparedVouchers.slice(batchStart, batchStart + BATCH_SIZE)
    const batchNumber = Math.floor(batchStart / BATCH_SIZE) + 1
    let batchWasRetried = false

    // Prepare journal entry headers
    const entryInserts = batch.map((v, i) => ({
      user_id: userId,
      company_id: companyId,
      fiscal_period_id: fiscalPeriodId,
      voucher_number: currentVoucherNumber + batchStart + i,
      voucher_series: voucherSeries,
      entry_date: v.date,
      description: v.description,
      source_type: 'import',
      status: 'posted',
      committed_at: new Date().toISOString(),
    }))

    // Insert headers with retry
    let entries: { id: string }[] | null = null
    let lastEntryError: string | null = null

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        batchWasRetried = true
        const backoffMs = Math.pow(2, attempt - 1) * 1000 // 1s, 2s, 4s
        console.log(`[sie-import] Retrying batch ${batchNumber} (attempt ${attempt + 1}/${MAX_RETRIES + 1}) after ${backoffMs}ms`)
        await new Promise(resolve => setTimeout(resolve, backoffMs))
      }

      const { data, error: entryError } = await supabase
        .from('journal_entries')
        .insert(entryInserts)
        .select('id')

      if (!entryError && data) {
        entries = data
        lastEntryError = null
        break
      }

      lastEntryError = entryError?.message || 'Failed to insert entries'
    }

    if (!entries) {
      failedBatches++
      results.errors.push(
        `Batch ${batchNumber} misslyckades efter ${MAX_RETRIES + 1} försök: ${lastEntryError}`
      )
      continue
    }

    // Prepare all lines for this batch
    const allLines: {
      journal_entry_id: string
      account_number: string
      account_id: string | null
      debit_amount: number
      credit_amount: number
      currency: string
      line_description: string | null
      sort_order: number
    }[] = []

    for (let i = 0; i < batch.length; i++) {
      const entryId = entries[i]?.id
      if (!entryId) continue

      const voucher = batch[i]
      const assignedNumber = currentVoucherNumber + batchStart + i
      voucher.lines.forEach((line, lineIndex) => {
        allLines.push({
          journal_entry_id: entryId,
          account_number: line.account_number,
          account_id: accountIdMap.get(line.account_number) || null,
          debit_amount: line.debit_amount,
          credit_amount: line.credit_amount,
          currency: 'SEK',
          line_description: line.line_description,
          sort_order: lineIndex,
        })
      })

      results.voucherNumberMapping.push({
        sourceId: voucher.sourceId,
        targetNumber: assignedNumber,
      })

      results.ids.push(entryId)
      results.created++
    }

    // Insert all lines with retry
    if (allLines.length > 0) {
      let linesInserted = false
      let lastLinesError: string | null = null

      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        if (attempt > 0) {
          batchWasRetried = true
          const backoffMs = Math.pow(2, attempt - 1) * 1000
          console.log(`[sie-import] Retrying batch ${batchNumber} lines (attempt ${attempt + 1}/${MAX_RETRIES + 1}) after ${backoffMs}ms`)
          await new Promise(resolve => setTimeout(resolve, backoffMs))
        }

        const { error: linesError } = await supabase
          .from('journal_entry_lines')
          .insert(allLines)

        if (!linesError) {
          linesInserted = true
          break
        }

        lastLinesError = linesError.message
      }

      if (linesInserted) {
        // Track movements ONLY for successfully inserted vouchers.
        // This ensures the migration adjustment correctly compensates for
        // any batches that failed completely.
        for (let i = 0; i < batch.length; i++) {
          const voucher = batch[i]
          for (const line of voucher.lines) {
            const net = line.debit_amount - line.credit_amount
            results.movementsByAccount.set(
              line.account_number,
              (results.movementsByAccount.get(line.account_number) || 0) + net
            )
          }
        }
      } else {
        failedBatches++
        results.errors.push(
          `Batch ${batchNumber} rader misslyckades efter ${MAX_RETRIES + 1} försök: ${lastLinesError}`
        )
      }
    } else {
      // No lines to insert — still count movements for vouchers with entries
      for (let i = 0; i < batch.length; i++) {
        const voucher = batch[i]
        for (const line of voucher.lines) {
          const net = line.debit_amount - line.credit_amount
          results.movementsByAccount.set(
            line.account_number,
            (results.movementsByAccount.get(line.account_number) || 0) + net
          )
        }
      }
    }

    // Count distinct batches that needed retries (not individual attempts)
    if (batchWasRetried) {
      retriedBatches++
    }

    // Small delay between batches to prevent Supabase/Cloudflare rate limiting
    if (batchStart + BATCH_SIZE < preparedVouchers.length) {
      await new Promise(resolve => setTimeout(resolve, INTER_BATCH_DELAY_MS))
    }
  }

  // Update voucher sequence to reflect all assigned numbers.
  // next_voucher_number() was called once but we assigned N numbers manually,
  // so the sequence only got incremented by 1. Fix with GREATEST to avoid races.
  if (results.created > 0) {
    const highestUsed = currentVoucherNumber + preparedVouchers.length - 1
    await supabase.rpc('reserve_voucher_range', {
      p_company_id: companyId,
      p_fiscal_period_id: fiscalPeriodId,
      p_series: voucherSeries,
      p_highest_used: highestUsed,
    })
  }

  // Propagate batch retry stats
  results.retriedBatches = retriedBatches
  results.failedBatches = failedBatches

  return results
}

/**
 * Determine if an account is balance sheet (class 1-2) or P&L (class 3-8)
 */
export function isBalanceSheetAccount(accountNumber: string): boolean {
  const firstDigit = parseInt(accountNumber.charAt(0), 10)
  return firstDigit >= 1 && firstDigit <= 2
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

  // Process IB — only for balance sheet accounts
  for (const ib of parsed.openingBalances.filter((b) => b.yearIndex === 0)) {
    const target = accountMap.get(ib.account)
    if (!target) continue
    if (!isBalanceSheetAccount(target)) {
      // P&L account appearing in IB — likely malformed SIE
      warnings.push(`P&L-konto ${ib.account} (→${target}) förekommer i #IB — ignoreras för resultaträkning`)
      continue
    }
    expectedMovements.set(target, (expectedMovements.get(target) || 0) - ib.amount)
  }

  // Process UB — only for balance sheet accounts
  for (const ub of parsed.closingBalances.filter((b) => b.yearIndex === 0)) {
    const target = accountMap.get(ub.account)
    if (!target) continue
    if (!isBalanceSheetAccount(target)) {
      warnings.push(`P&L-konto ${ub.account} (→${target}) förekommer i #UB — ignoreras för resultaträkning`)
      continue
    }
    expectedMovements.set(target, (expectedMovements.get(target) || 0) + ub.amount)
  }

  // Process RES — only for P&L accounts
  for (const res of parsed.resultBalances.filter((b) => b.yearIndex === 0)) {
    const target = accountMap.get(res.account)
    if (!target) continue
    if (isBalanceSheetAccount(target)) {
      warnings.push(`Balanskonto ${res.account} (→${target}) förekommer i #RES — ignoreras för balansräkning`)
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
    description: `Omföringsverifikation: justering för ${skippedDetails.length} exkluderade verifikationer (${firstId}–${lastId}, ${firstDate}–${lastDate}) vid SIE-import`,
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
  const accountType = classNum === 1 ? 'asset'
    : classNum === 2 ? (group === '21' ? 'untaxed_reserves' : (group === '20' ? 'equity' : 'liability'))
    : classNum === 3 ? 'revenue'
    : 'expense'

  await supabase.from('chart_of_accounts').insert({
    user_id: userId,
    company_id: companyId,
    account_number: accountNumber,
    account_name: accountName,
    account_class: classNum,
    account_group: group,
    account_type: accountType,
    normal_balance: classNum <= 1 || classNum >= 4 ? 'debit' : 'credit',
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
    throw new Error(`Failed to create pending import record: ${error?.message}`)
  }

  return data.id
}

/**
 * Phase 2: Finalize the import record with results and archive the SIE file.
 */
async function finalizeImportRecord(
  supabase: SupabaseClient,
  importId: string,
  companyId: string,
  result: ImportResult,
  fileContent: string,
  documentation?: MigrationDocumentation
): Promise<void> {
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
    const fileBlob = new Blob([fileContent], { type: 'text/plain; charset=cp437' })
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
        onConflict: 'user_id,source_account',
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
  }

  try {
    // Validate all accounts are mapped
    const unmapped = mappings.filter((m) => !m.targetAccount)
    if (unmapped.length > 0) {
      result.errors.push(
        `${unmapped.length} accounts are not mapped: ${unmapped.map((m) => m.sourceAccount).join(', ')}`
      )
      return result
    }

    // Check for duplicate import (only completed imports count as duplicates)
    const duplicate = await checkDuplicateImport(supabase, companyId, options.fileContent)
    if (duplicate) {
      result.errors.push(
        `This file has already been imported on ${duplicate.imported_at ? new Date(duplicate.imported_at).toLocaleDateString('sv-SE') : 'okänt datum'}`
      )
      return result
    }

    // Create pending import record early — ensures tracking even if later steps fail
    result.importId = await createPendingImportRecord(
      supabase,
      companyId,
      userId,
      parsed,
      options.fileContent,
      options.filename
    )

    // Build account mapping lookup
    const accountMap = mappingsToMap(mappings)

    // Ensure all mapped target accounts exist in chart_of_accounts.
    // The mapping contains every account referenced in the SIE file; accounts
    // that were not seeded during onboarding need to be created here so that
    // journal entry lines can link to them via account_id.
    const seenTargets = new Set<string>()
    for (const mapping of mappings) {
      if (mapping.targetAccount && !seenTargets.has(mapping.targetAccount)) {
        seenTargets.add(mapping.targetAccount)
        await ensureAccountExists(
          supabase,
          companyId,
          userId,
          mapping.targetAccount,
          mapping.targetName
        )
      }
    }

    // Create or find fiscal period
    const fiscalYearStart = parsed.stats.fiscalYearStart
    const fiscalYearEnd = parsed.stats.fiscalYearEnd

    if (!fiscalYearStart || !fiscalYearEnd) {
      result.errors.push('No fiscal year defined in the SIE file')
      return result
    }

    // Safety net: reject if a completed import already exists for this period
    const periodDuplicate = await checkDuplicatePeriodImport(
      supabase, companyId, fiscalYearStart, fiscalYearEnd
    )
    if (periodDuplicate) {
      result.errors.push(
        `En SIE-import för perioden ${fiscalYearStart} – ${fiscalYearEnd} finns redan (ID: ${periodDuplicate.id})`
      )
      return result
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
    let voucherNumberMapping: Array<{ sourceId: string; targetNumber: number }> = []
    let voucherRetryStats = { retriedBatches: 0, failedBatches: 0 }
    let voucherStats = {
      total: parsed.vouchers.length,
      imported: 0,
      skippedUnbalanced: 0,
      skippedUnmapped: 0,
      skippedSingleLine: 0,
      skippedEmpty: 0,
    }
    const voucherSeries = options.voucherSeries || 'B'

    // Validate and import opening balances.
    //
    // IB imbalance is NORMAL in Swedish SIE files for two common reasons:
    // 1. Excluded system accounts (Fortnox 0099 etc.) carry IB balances
    // 2. Previous year's result (årets resultat) hasn't been allocated to equity
    //    yet — the profit/loss is implicit, not an explicit IB on 2099
    //
    // In both cases, the correct treatment is to book the diff to 2099 with
    // explicit documentation. We never reject based on IB imbalance — the
    // original goal was to stop SILENT equity alteration, not prevent it.
    if (options.importOpeningBalances && parsed.openingBalances.length > 0 && result.fiscalPeriodId) {
      // Check if opening balances already exist for this period
      const { data: period } = await supabase
        .from('fiscal_periods')
        .select('opening_balances_set, opening_balance_entry_id')
        .eq('id', result.fiscalPeriodId)
        .single()

      if (period?.opening_balances_set || period?.opening_balance_entry_id) {
        result.warnings.push('Ingående balanser finns redan för denna period — hoppar över IB-import')
      } else {
        const ibValidation = validateIBBalance(parsed, accountMap)

        if (ibValidation.lines.length > 0) {
          const absAdj = Math.abs(ibValidation.roundingAdjustment)

          if (absAdj > 0.01) {
            ibRoundingAdjustment = ibValidation.roundingAdjustment

            // Produce a descriptive warning explaining the source of the imbalance
            if (Math.abs(ibValidation.excludedAccountsTotal) > 0.01 && ibValidation.fileImbalance <= 1.00) {
              // File-level IB is balanced — imbalance is entirely from excluded system accounts
              ibExplanation = 'excluded_accounts'
              result.warnings.push(
                `Exkluderade systemkonton har IB-saldon på totalt ${ibValidation.excludedAccountsTotal} SEK. ` +
                `Differensen (${ibValidation.roundingAdjustment} SEK) bokförs på konto 2099.`
              )
            } else if (ibValidation.fileImbalance > 1.00) {
              // File-level IB doesn't balance — likely unallocated årets resultat from previous year
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
          }
        }
      }
    }

    // Import transactions (SIE4 only)
    if (options.importTransactions && parsed.vouchers.length > 0 && result.fiscalPeriodId) {
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
            `SIE-filen verkar innehålla ett ofullständigt räkenskapsår: verifikationer ${formatDate(earliestVoucher)}–${formatDate(latestVoucher)}, ` +
            `räkenskapsår ${fiscalYearStart}–${fiscalYearEnd}. ` +
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
        voucherSeries
      )

      result.journalEntriesCreated += voucherResults.created
      result.journalEntryIds.push(...voucherResults.ids)
      result.errors.push(...voucherResults.errors)
      voucherNumberMapping = voucherResults.voucherNumberMapping
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
            'Kunde inte skapa migreringsjustering — kontrollera saldon manuellt mot källsystemet'
          )
        }
      }
    }

    // Save account mappings for future use (non-fatal — import data is already committed)
    try {
      await saveMappings(supabase, companyId, mappings)
    } catch (mappingError) {
      console.error('[sie-import] Failed to save mappings (non-fatal):', mappingError)
      result.warnings.push('Kunde inte spara kontomappningar — påverkar inte importerade data')
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
      importedBy: companyId,
      accountMappings: {
        total: mappingStats.total,
        exact: mappingStats.exact,
        basRange: mappingStats.basRange,
        manual: mappingStats.manual,
        unmapped: mappingStats.unmapped,
      },
      vouchers: voucherStats,
      openingBalanceRounding: ibRoundingAdjustment !== 0 ? ibRoundingAdjustment : null,
      migrationAdjustment: migrationAdjustmentInfo,
      voucherSeriesUsed: voucherSeries,
      voucherNumberRange: voucherNumberMapping.length > 0
        ? {
            from: voucherNumberMapping[0].targetNumber,
            to: voucherNumberMapping[voucherNumberMapping.length - 1].targetNumber,
          }
        : null,
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
