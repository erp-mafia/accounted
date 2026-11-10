/**
 * SIE Import helpers
 *
 * Preview, duplicate and fiscal-year checks for an uploaded SIE file, the
 * fiscal period it lands in, and the pure builders the durable SIE job
 * (sie-job-preparation.ts) uses to prepare its opening-balance, voucher and
 * migration-adjustment entries.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { normalizeLineDimensions } from '@/lib/bookkeeping/dimension-resolver'
import type {
  ParsedSIEFile,
  AccountMapping,
  ImportPreview,
  FiscalYearPrecheck,
  SIEImport,
  SIETransactionLine,
  SIEObjectBalance,
  SIEAccountMappingRecord,
  SIEVoucher,
} from './types'
import type { CreateJournalEntryInput, CreateJournalEntryLineInput } from '@/types'
import type { SIEPreparedEntry } from './sie-job-contract'
import { ORE_ROUNDING_ACCOUNT, roundOre } from '@/lib/money'
import { lineBalance } from '@/lib/bookkeeping/line-balance'
import { isResultatkonto } from '@/lib/bookkeeping/bas-data/result-accounts'
import { getMappingStats } from './account-mapper'
import {
  calculateFileHash,
  formatVoucherRef,
  getEffectiveObjectOpeningBalances,
  getEffectiveOpeningBalances,
  isBalanceSheetAccount,
  OPENING_BALANCE_DESCRIPTION_RE,
  SHARE_CAPITAL_DESCRIPTION_RE,
} from './sie-parser'
import {
  planObjectBalances,
  SIE_DEFAULT_ACCUMULATING_DIMENSIONS,
  splitBalanceLines,
  type ObjectBalancePlan,
} from './sie-object-balances'
import { carriesObjectBalances, fetchAccumulatingDimensions } from '@/lib/bookkeeping/dimension-carry'
import { todayIsoStockholm } from '@/lib/dates/iso'
import { whereSieImportInPlace } from '@/lib/bookkeeping/sie-import-in-place'

// Re-export from the parser (moved there to avoid an import cycle:
// getEffectiveOpeningBalances needs it) so existing importers keep working.
export { isBalanceSheetAccount } from './sie-parser'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { fiscalYearName } from '@/lib/bookkeeping/suggest-fiscal-period'
import { checkPeriodDuration, isFirstFiscalPeriod } from '@/lib/bookkeeping/validate-period-duration'
import { fiscalYearLockedToCalendar, resolveCompanyEntityType } from '@/lib/company/entity-type'
import { resolvePreviousFiscalPeriod } from '@/lib/core/bookkeeping/period-service'
import { userFacing } from '@/lib/errors/user-facing'

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
  const { totalDebit, totalCredit, difference } = lineBalance(
    currentYearBalances.map((balance) => ({
      debit_amount: Math.max(balance.amount, 0),
      credit_amount: Math.max(-balance.amount, 0),
    })),
  )

  const mappingStats = getMappingStats(mappings)

  return {
    companyName: parsed.header.companyName,
    orgNumber: parsed.header.orgNumber,
    fiscalYearStart: parsed.stats.fiscalYearStart,
    fiscalYearEnd: parsed.stats.fiscalYearEnd,
    accountCount: parsed.stats.totalAccounts,
    voucherCount: parsed.stats.totalVouchers,
    transactionLineCount: parsed.stats.totalTransactionLines,
    // Debit-side total of the IB voucher (shown as "IB, summa debet"), not a
    // net opening balance: a balanced IB nets to zero.
    openingBalanceTotal: totalDebit,
    trialBalance: {
      totalDebit,
      totalCredit,
      isBalanced: difference === 0,
    },
    mappingStatus: {
      total: mappingStats.total,
      mapped: mappingStats.mapped,
      unmapped: mappingStats.unmapped,
      lowConfidence: mappingStats.lowConfidence,
    },
    excludedSystemAccounts: [],
    voucherSeriesInFile: [
      ...new Set(
        parsed.vouchers
          .map((v) => (v.series ?? '').trim())
          .filter((s) => s.length > 0)
      ),
    ].sort(),
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

  const { data } = await whereSieImportInPlace(
    supabase
      .from('sie_imports')
      .select('*')
      .eq('company_id', companyId)
      .eq('file_hash', fileHash),
  ).single()

  return data as SIEImport | null
}

/**
 * Every completed SIE import whose fiscal year overlaps the given range,
 * newest first (imported_at desc, created_at as tiebreak).
 *
 * More than one row can overlap the same räkenskapsår: a manual upload plus
 * a provider sync, or residue from partially deleted data. The old
 * `.limit(1).maybeSingle()` shape picked an arbitrary row in that case, so
 * the replace flow resolved one watermark and left the others standing,
 * permanently blocking a re-sync of that year (issue #1667). Callers that
 * resolve prior imports must handle every returned row.
 */
export async function findOverlappingPeriodImports(
  supabase: SupabaseClient,
  companyId: string,
  fiscalYearStart: string,
  fiscalYearEnd: string
): Promise<SIEImport[]> {
  // Range overlap check: start <= other_end AND end >= other_start.
  // Two imports whose räkenskapsår overlap would produce duplicate
  // verifikationer, violating BFL 4:1 (löpande bokföring).
  //
  // fetchAllRows throws on any query error: a swallowed error here would
  // return [] and let replace mode import fresh on top of rows it never
  // resolved. It also pages past PostgREST's row cap, and the id tiebreak
  // keeps the pagination order total.
  const rows = await fetchAllRows<SIEImport>(
    ({ from, to }) =>
      whereSieImportInPlace(
        supabase
          .from('sie_imports')
          .select('*')
          .eq('company_id', companyId),
      )
        .lte('fiscal_year_start', fiscalYearEnd)
        .gte('fiscal_year_end', fiscalYearStart)
        .order('imported_at', { ascending: false, nullsFirst: false })
        .order('created_at', { ascending: false })
        .order('id', { ascending: false })
        .range(from, to),
    { dedupeBy: (r) => r.id }
  )
  return rows
}

/**
 * Check if a completed SIE import already exists for the same fiscal year period.
 * Prevents importing two different SIE files that cover the same accounting period,
 * which would create duplicate verifikationer violating BFL 4:1 (löpande bokföring).
 * Only blocks on status='completed': failed/pending imports don't prevent retries.
 * When several rows overlap, the newest is returned (deterministic, see
 * findOverlappingPeriodImports).
 */
export async function checkDuplicatePeriodImport(
  supabase: SupabaseClient,
  companyId: string,
  fiscalYearStart: string,
  fiscalYearEnd: string
): Promise<SIEImport | null> {
  const overlapping = await findOverlappingPeriodImports(
    supabase, companyId, fiscalYearStart, fiscalYearEnd
  )
  // The year's own import, not an append to it (issue #108): replacing or
  // appending names the base, and an append is undone on its own.
  return overlapping.find((row) => !row.base_import_id) ?? overlapping[0] ?? null
}

interface ClosedPeriodState {
  name: string
  period_start: string
  period_end: string
  is_closed: boolean | null
  locked_at: string | null
  closed_externally?: boolean | null
  closing_entry_id?: string | null
}

/**
 * Why a closed or locked fiscal year cannot take imported vouchers, with the
 * way out spelled out per state, or null when the year is open. Three states
 * map to three different remedies:
 *
 *   - klarmarkerad (closed_externally, no closing entry): "Öppna igen" in
 *     Inställningar > Bokföring > Räkenskapsår undoes it, so say so.
 *   - closed by a year-end run (closing entry): nothing self-serve reopens it.
 *   - locked only: "Lås upp" in the same settings section.
 */
export function closedPeriodRefusal(period: ClosedPeriodState): string | null {
  const label = `Räkenskapsåret ${period.name} (${period.period_start} till ${period.period_end})`
  if (period.is_closed) {
    if (period.closed_externally && !period.closing_entry_id) {
      return (
        `${label} är markerat som avslutat i ett tidigare program och tar inte emot verifikationer. ` +
        `Öppna det igen under Inställningar > Bokföring > Räkenskapsår (knappen Öppna igen), ` +
        `importera filen på nytt och klarmarkera året igen efteråt.`
      )
    }
    if (period.closing_entry_id) {
      return (
        `${label} är stängt med ett årsbokslut i Accounted och tar inte emot fler verifikationer. ` +
        `Bokför rättelser i det öppna räkenskapsåret i stället.`
      )
    }
    return (
      `${label} är stängt och tar inte emot fler verifikationer. ` +
      `Öppna räkenskapsåret under Inställningar > Bokföring > Räkenskapsår och importera sedan filen på nytt.`
    )
  }
  if (period.locked_at) {
    return (
      `${label} är låst. Lås upp det under Inställningar > Bokföring > Räkenskapsår ` +
      `och importera sedan filen på nytt.`
    )
  }
  return null
}

/**
 * Read-only verdict on how the SIE file's räkenskapsår relates to the
 * company's existing fiscal periods. Shared by the parse preview and by
 * ensureFiscalPeriod, so what the wizard says before import is exactly what
 * the import will do:
 *
 *   - match: an open period already contains the file's date range; it is
 *     reused. A closed or locked containing period is a conflict instead,
 *     with the remedy (Öppna igen / Lås upp) in the message.
 *   - create: no period covers the range; one is created. If an overlapping
 *     period is empty (onboarding-seeded with the default calendar year but
 *     never used) it is replaced: the user has a förlängt räkenskapsår per
 *     BFL 3 kap. that doesn't match the seeded period, and the seeded period
 *     carries no data to preserve.
 *   - conflict: an overlapping period carries real content (posted entries,
 *     opening balances set, closed, or locked). Silently reusing it would stamp
 *     imported vouchers with a fiscal_period_id whose date window doesn't match
 *     the voucher's own date: breaking the SIE invariant that #VER dates fall
 *     inside #RAR and BFL 5 kap. (verifikationsnummer per räkenskapsår).
 *
 * Runs no writes. The date-shape rules (18 months, mid-month start, month-end
 * finish) stay in ensureFiscalPeriod: they are about the file, not the company.
 */
export async function precheckFiscalPeriod(
  supabase: SupabaseClient,
  companyId: string,
  startDate: string,
  endDate: string
): Promise<FiscalYearPrecheck> {
  // Check for an existing period that contains the SIE date range
  const { data: containing } = await supabase
    .from('fiscal_periods')
    .select('id, name, period_start, period_end, is_closed, locked_at, closed_externally, closing_entry_id')
    .eq('company_id', companyId)
    .lte('period_start', startDate)
    .gte('period_end', endDate)
    .single()

  if (containing) {
    // A closed or locked year would only fail later, inside the atomic
    // voucher RPC, with the DB trigger's own text and no way forward. Refuse
    // here so the preview says what to do (observed 2026-09-04: an owner
    // klarmarkerade an empty prior year, then could not import its one
    // voucher and never found "Öppna igen").
    const refusal = closedPeriodRefusal(containing as ClosedPeriodState)
    if (refusal) {
      return {
        verdict: 'conflict',
        existingPeriod: {
          id: containing.id as string,
          name: containing.name as string,
          periodStart: containing.period_start as string,
          periodEnd: containing.period_end as string,
        },
        message: refusal,
      }
    }
    return { verdict: 'match', periodId: containing.id }
  }

  const { data: overlapping } = await supabase
    .from('fiscal_periods')
    .select('id, period_start, period_end, name, is_closed, locked_at, opening_balances_set')
    .eq('company_id', companyId)
    .lte('period_start', endDate)
    .gte('period_end', startDate)
    .order('period_start', { ascending: false })
    .limit(1)

  if (!overlapping || overlapping.length === 0) {
    const invalid = await checkFiscalYearShape(supabase, companyId, startDate, endDate)
    if (invalid) return invalid
    return { verdict: 'create', replacesEmptyPeriodId: null }
  }

  const existing = overlapping[0]
  const existingPeriod = {
    id: existing.id as string,
    name: existing.name as string,
    periodStart: existing.period_start as string,
    periodEnd: existing.period_end as string,
  }

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
    return {
      verdict: 'conflict',
      existingPeriod,
      message:
        `SIE-filens räkenskapsår (${startDate} till ${endDate}) överlappar men matchar inte ett befintligt räkenskapsår i Accounted ` +
        `(${existingPeriod.name}: ${existingPeriod.periodStart} till ${existingPeriod.periodEnd}). ` +
        `Justera räkenskapsåret i Inställningar → Företag så att det matchar SIE-filen exakt, eller importera en SIE-fil som täcker exakt samma period.`,
    }
  }

  const invalid = await checkFiscalYearShape(supabase, companyId, startDate, endDate, existingPeriod.id)
  if (invalid) return invalid

  return { verdict: 'create', replacesEmptyPeriodId: existingPeriod.id }
}

/**
 * The BFL 3 kap. shape rules a new period must satisfy, in the order the
 * import has always applied them. Returns the 'invalid' verdict with the
 * refusal text, or null when the dates are fine. Runs after the overlap
 * verdict so a conflict with an existing period is reported first, as before.
 * `replacedPeriodId` is the empty year the import deletes first: it is gone
 * when the new one is written, so it does not make the new one a later year.
 */
async function checkFiscalYearShape(
  supabase: SupabaseClient,
  companyId: string,
  startDate: string,
  endDate: string,
  replacedPeriodId: string | null = null,
): Promise<Extract<FiscalYearPrecheck, { verdict: 'invalid' }> | null> {
  const { data: recorded, error: othersError } = await supabase
    .from('fiscal_periods')
    .select('id, period_start')
    .eq('company_id', companyId)
  if (othersError) throw new Error(`Failed to read fiscal periods: ${othersError.message}`)
  const others = ((recorded ?? []) as { id: string; period_start: string }[]).filter((p) => p.id !== replacedPeriodId)
  const entityType = await resolveCompanyEntityType(supabase, companyId)

  // Refused rather than warned about, also for an extended or re-laid year:
  // no reading of BFL 3 kap. permits these shapes, so this is a malformed or
  // merged #RAR, not historical data booked under different rules. Continuing
  // would stamp every imported voucher with an illegal period that no UI path
  // can repair afterwards, leaving undo_sie_import as the only way out. Checked
  // before the destructive delete in ensureFiscalPeriod so a refused import
  // leaves the company untouched, and a user can retroactively import an old
  // first fiscal year even after an onboarding-created period exists later.
  const issue = checkPeriodDuration(startDate, endDate, {
    isFirstPeriod: isFirstFiscalPeriod(startDate, others.map((p) => p.period_start)),
    calendarYearOnly: fiscalYearLockedToCalendar(entityType),
  })
  if (!issue) return null

  const fileYear = `SIE-filens räkenskapsår (${startDate} till ${endDate})`
  switch (issue.rule) {
    case 'end_not_after_start':
      return { verdict: 'invalid', message: `${fileYear} slutar inte efter att det börjar. Kontrollera #RAR-raden i filen.` }
    case 'not_calendar_year_end':
    case 'not_calendar_year_start':
      return {
        verdict: 'invalid',
        message:
          `${fileYear} är inte ett kalenderår: en enskild firma har räkenskapsår till 31 december, och bara det första får börja efter 1 januari (BFL 3 kap.). ` +
          `Kontrollera #RAR-raden i filen.`,
      }
    case 'start_not_first_of_month':
      return {
        verdict: 'invalid',
        message: `SIE-filens räkenskapsår börjar ${startDate}: endast företagets kronologiskt första räkenskapsår får börja mitt i månaden. Efterföljande räkenskapsår måste börja den 1:a i en månad (BFL 3 kap.). Kontrollera datumen i #RAR-raden.`,
      }
    case 'end_not_month_end':
      return {
        verdict: 'invalid',
        message: `SIE-filens räkenskapsår slutar ${endDate}: räkenskapsår måste sluta på månadens sista dag (BFL 3 kap.). Kontrollera datumen i #RAR-raden.`,
      }
    case 'exceeds_18_months':
      return {
        verdict: 'invalid',
        message:
          `${fileYear} omfattar ${issue.months} månader: ett räkenskapsår får vara högst 18 månader (BFL 3 kap.). ` +
          `Kontrollera #RAR-raden i filen och exportera om från källsystemet med ett räkenskapsår per fil.`,
      }
  }
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
  // Containment, overlap and the refuse-or-replace verdict live in
  // precheckFiscalPeriod so the parse preview shows the same outcome the
  // import will produce.
  const precheck = await precheckFiscalPeriod(supabase, companyId, startDate, endDate)

  if (precheck.verdict === 'match') {
    return precheck.periodId
  }

  if (precheck.verdict === 'conflict' || precheck.verdict === 'invalid') {
    // precheckFiscalPeriod writes for the reader: closedPeriodRefusal names the
    // year and the exact settings path that reopens it. Marked so the sentence
    // survives the error envelope, which otherwise answered a klarmarkerat
    // year with "Ett oväntat serverfel uppstod" and a 500 on an expected,
    // self-serve state.
    throw userFacing(new Error(precheck.message))
  }

  const periodToReplaceId: string | null = precheck.replacesEmptyPeriodId

  // All date validation passed (checkFiscalYearShape, via the precheck). If we
  // identified an empty seeded period above,
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
  const name = fiscalYearName(startDate, endDate)

  // Link the BFNAR 2013:2 continuity chain so the resultatrapport can find the
  // prior year for its comparison column. Mirrors the manual fiscal-periods
  // route: point this period at its closest predecessor, then relink the
  // immediate successor (if any) to follow this one, so multi-year SIE files
  // chain correctly regardless of the order #RAR years are processed in.
  //
  // Adjacency is required on both sides. previous_period_id means "the
  // räkenskapsår immediately before", and year-end seeds opening balances
  // into whatever follows the chain: linking the NEAREST period across a gap
  // of missing years once sent a company's IB two years forward (feedback
  // seq 249297). A gap stays unlinked until the missing year is imported.
  const predecessor = await resolvePreviousFiscalPeriod<{ id: string; period_end: string }>(
    supabase,
    companyId,
    { period_start: startDate },
    'id, period_end',
  )

  const { data: newPeriod, error } = await supabase
    .from('fiscal_periods')
    .insert({
      company_id: companyId,
      name,
      period_start: startDate,
      period_end: endDate,
      is_closed: false,
      opening_balances_set: false,
      previous_period_id: predecessor?.id ?? null,
    })
    .select()
    .single()

  if (error || !newPeriod) {
    throw new Error(`Failed to create fiscal period: ${error?.message}`)
  }

  // Relink the immediate successor (e.g. when an earlier year is imported after
  // a later one) so the chain holds in both directions. Only a successor that
  // starts the day after this period qualifies (see above).
  const { data: successors } = await supabase
    .from('fiscal_periods')
    .select('id, period_start')
    .eq('company_id', companyId)
    .gt('period_start', endDate)
    .neq('id', newPeriod.id)
    .order('period_start', { ascending: true })
    .limit(1)
  if (
    successors &&
    successors.length > 0 &&
    successors[0].period_start === shiftIsoDate(endDate, 1)
  ) {
    await supabase
      .from('fiscal_periods')
      .update({ previous_period_id: newPeriod.id })
      .eq('id', successors[0].id)
      .eq('company_id', companyId)
  }

  return newPeriod.id
}

/** Shift a YYYY-MM-DD string by `days` in pure UTC (no local DST drift). */
function shiftIsoDate(isoDate: string, days: number): string {
  const d = new Date(isoDate + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

/**
 * Compute IB imbalance and validate it before creating the opening balance entry.
 *
 * Distinguishes between:
 * - File-level imbalance: the raw SIE #IB data doesn't balance (source file error)
 * - Mapping-level imbalance: caused by excluded accounts (system accounts like Fortnox 0099)
 *   that carry IB balances but are correctly filtered from mapping. This is expected and
 *   should be booked to the form's result-closing account with clear documentation.
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

  // Anything left is real and gets booked, one öre included:
  // import_sie_chunk rejects any nonzero difference at two decimals, and a
  // stricter threshold here let a 1 öre file pass preparation and fail at
  // commit. Consumers test `!== 0`, never a tolerance.
  return {
    lines,
    roundingAdjustment: lineBalance(lines).difference,
    fileImbalance,
    excludedAccountsTotal: Math.round(excludedTotal * 100) / 100,
  }
}

/**
 * Object balances that split the IB per project (issue #3313): the rows
 * (#OIB 0, or #OUB -1 when the IB is derived) and the company's
 * accumulating dimensions. Omitted: the file's effective rows under the SIE
 * convention (projekt accumulates).
 */
export interface SIEObjectOpeningBalances {
  rows?: readonly SIEObjectBalance[]
  accumulating?: ReadonlySet<string>
}

/**
 * Build IB journal lines per account, split per object: one tagged line per
 * object of an accumulating dimension and one untagged remainder line
 * (IB - sum of the objects), so each account's total is exactly its IB.
 * Accounts with object rows but no #IB row (a zero IB) still get their
 * object lines and an offsetting remainder. Unmapped source accounts are
 * skipped whole, as before. A target VAT account (26xx) is never split
 * (carriesObjectBalances), whatever source account maps onto it: its IB
 * stays one untagged line.
 */
export function buildSplitOpeningLines(
  balances: ReadonlyArray<{ account: string; amount: number }>,
  mapAccount: (sourceAccount: string) => string | undefined,
  plan: ObjectBalancePlan,
  describe: (sourceAccount: string) => string
): CreateJournalEntryLineInput[] {
  const lines: CreateJournalEntryLineInput[] = []
  const pending = new Map(plan.byAccount)
  for (const balance of balances) {
    const targetAccount = mapAccount(balance.account)
    if (!targetAccount) continue
    const parts = carriesObjectBalances(targetAccount) ? pending.get(balance.account) : undefined
    pending.delete(balance.account)
    lines.push(...splitBalanceLines(targetAccount, balance.amount, parts, describe(balance.account)))
  }
  for (const [account, parts] of pending) {
    const targetAccount = mapAccount(account)
    if (!targetAccount || !carriesObjectBalances(targetAccount)) continue
    lines.push(...splitBalanceLines(targetAccount, 0, parts, describe(account)))
  }
  return lines
}

/**
 * Create opening balance journal entry from IB amounts.
 * The caller must validate the IB balance first via validateIBBalance().
 * If roundingAdjustment is non-zero, it is booked explicitly to
 * `differenceAccount` with clear text. That account is the legal form's
 * result-closing account (resultClosingAccounts: 2099 for an aktiebolag,
 * 2010 for an enskild firma, 2069 for an ideell förening): the imbalance is
 * almost always the prior year's result the source system never carried, so
 * it must land where that form's year-end would have put it.
 *
 * Each account's IB is split per project from the file's object balances
 * (issue #3313, see SIEObjectOpeningBalances); account totals, and so the
 * entry's balance and the rounding adjustment, are unchanged by the split.
 */
export function buildSIEOpeningBalanceEntry(
  fiscalPeriodId: string,
  parsed: ParsedSIEFile,
  accountMap: Map<string, string>,
  roundingAdjustment: number,
  voucherSeries: string,
  differenceAccount: string,
  objectBalances: SIEObjectOpeningBalances = {}
): CreateJournalEntryInput | null {
  // Effective set: explicit #IB 0, or IB derived from #UB -1 (issue #675).
  const { balances: currentYearBalances, derivedFromPriorYearUB } =
    getEffectiveOpeningBalances(parsed)

  if (currentYearBalances.length === 0) {
    return null
  }

  const plan = planObjectBalances(
    objectBalances.rows ?? getEffectiveObjectOpeningBalances(parsed).rows,
    objectBalances.accumulating ?? SIE_DEFAULT_ACCUMULATING_DIMENSIONS
  )
  const lines = buildSplitOpeningLines(
    currentYearBalances,
    (account) => accountMap.get(account),
    plan,
    (account) => `IB ${account}`
  )

  if (lines.length === 0) {
    return null
  }

  // Book the adjustment validateIBBalance found, however small.
  if (roundingAdjustment !== 0) {
    if (roundingAdjustment > 0) {
      lines.push({
        account_number: differenceAccount,
        debit_amount: 0,
        credit_amount: roundingAdjustment,
        line_description: `Avrundningsdifferens vid SIE-import, ${roundingAdjustment} SEK`,
      })
    } else {
      lines.push({
        account_number: differenceAccount,
        debit_amount: Math.abs(roundingAdjustment),
        credit_amount: 0,
        line_description: `Avrundningsdifferens vid SIE-import, ${roundingAdjustment} SEK`,
      })
    }
  }

  const entryDate = parsed.stats.fiscalYearStart ?? todayIsoStockholm()

  return {
    fiscal_period_id: fiscalPeriodId,
    entry_date: entryDate,
    // When derived, say so on the voucher itself: permanent documentation
    // of where the amounts came from (BFNAR 2013:2 behandlingshistorik).
    description: derivedFromPriorYearUB
      ? 'Ingående balanser från SIE-import (härledda från föregående års utgående balans)'
      : 'Ingående balanser från SIE-import',
    source_type: 'opening_balance',
    // Never hardcoded to 'A': the IB entry is created BEFORE the file's
    // vouchers, so booking it in a series the file uses would consume that
    // series' next number and shift every imported voucher one number
    // higher than in the source system (issue #1882).
    voucher_series: voucherSeries,
    lines,
  }
}

/**
 * The company's accumulating dimensions for the IB split, read after the
 * import registered the file's dimensions. A failed read falls back to the
 * SIE convention (projekt) rather than dropping every project tag.
 */
export async function resolveAccumulatingDimensions(
  supabase: SupabaseClient,
  companyId: string
): Promise<ReadonlySet<string>> {
  try {
    return await fetchAccumulatingDimensions(supabase, companyId)
  } catch {
    return SIE_DEFAULT_ACCUMULATING_DIMENSIONS
  }
}

/**
 * Prepare a SIE file's vouchers for the durable import job: map each #VER's
 * lines to the target chart, skip what cannot be booked (unmapped account,
 * no lines, one line, more than 1 SEK off balance) and build the payload
 * rows the job stores and later commits.
 *
 * Preserves per-voucher series from the source SIE file so customers migrating
 * from systems like Fortnox (which uses B=kundfakturor, C=inbetalningar, etc.)
 * retain traceability back to their original bookkeeping; the source series
 * and number travel on each prepared entry (BFNAR 2013:2).
 *
 * `defaultSeries` is used as a fallback only for vouchers that arrive with an
 * empty series (e.g., SIE4I import files, per spec §5.15). `sieImportId` is
 * the job's id: it is stamped on every entry and on the correction history
 * rows (journal_entry_rattelse_log.sie_import_id) so the log can be traced
 * back to the file that carried it.
 */
export function prepareSIEVouchers(
  parsed: ParsedSIEFile,
  accountMap: Map<string, string>,
  defaultSeries: string,
  sieImportId: string,
  options: {
    startOrdinal: number
    hasCurrentYearIb?: boolean
    accountIds: Map<string, string>
    /** Skipped vouchers still waiting for a booked successor, carried from the previous voucher group. */
    pendingNumberGaps?: SIEPendingNumberGaps
    /**
     * Series whose numbers rise through the whole file (seriesNumberedInOrder):
     * only there does a number missing between two of its vouchers hold its
     * place. Omitted (an append, a job snapshotted before this): none does.
     */
    numberedInOrder?: ReadonlySet<string>
    /** The last source number seen per series, carried from the previous voucher group. */
    lastSourceNumbers?: Record<string, number>
  },
): {
  preparedEntries: SIEPreparedEntry[]
  /** Skipped vouchers no booked voucher of their series has followed yet: the next group's input. */
  pendingNumberGaps: SIEPendingNumberGaps
  /** The last source number seen per series: the next group's input. */
  lastSourceNumbers: Record<string, number>
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
} {
  const results: ReturnType<typeof prepareSIEVouchers> = {
    preparedEntries: [], skippedDetails: [], pendingNumberGaps: {}, lastSourceNumbers: {},
  }
  // A voucher the file numbers but the import does not book (crm#1599: one
  // the source system cancelled, only #BTRANS rows left) keeps its number:
  // the next booked voucher of its series carries the count as numberGap, the
  // writer reserves that many numbers before it and records the documented
  // gap (BFNAR 2013:2, voucher_gap_explanations). Without this every later
  // voucher of the series lands one number below its source number.
  const pendingGaps: SIEPendingNumberGaps = structuredClone(options.pendingNumberGaps ?? {})
  // A number the file skips between two vouchers of a series (the source
  // system left the voucher out of the export) is held the same way, so the
  // vouchers after it keep their numbers too. Only in a series whose numbers
  // rise through the whole file: out of order, the writer's numbering cannot
  // follow the source anyway, and a held number would be explained wrongly.
  const lastNumbers: Record<string, number> = { ...(options.lastSourceNumbers ?? {}) }

  // Pre-filter and prepare all valid vouchers
  interface PreparedVoucher {
    sourceId: string
    sourceOrdinal: number
    series: string
    numberGap?: SIEPreparedEntry['numberGap']
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
    // Source-system correction history (#BTRANS struck / #RTRANS added, see
    // SIEVoucherCorrections). Persisted by the RPC as a journal_entry_rattelse_log
    // row with source='sie_import'; never booked as lines.
    corrections?: {
      struck: CorrectionLineSnapshot[]
      added: CorrectionLineSnapshot[]
      signature: string | null
    }
  }

  interface CorrectionLineSnapshot {
    account_number: string
    debit_amount: number
    credit_amount: number
    line_description: string | null
    sort_order: number
    /** SIE `sign` of this row: who removed/added it in the source system. */
    signature: string | null
  }

  // History keeps the source account when it is unmapped: the row is audit
  // trail, not a booking, and a rewritten account would misdescribe what the
  // source system showed. Zero-amount rows carry no information and are dropped
  // like their #TRANS counterparts.
  const toCorrectionSnapshots = (sourceLines: SIETransactionLine[]): CorrectionLineSnapshot[] =>
    sourceLines
      .filter((line) => line.amount !== 0)
      .map((line, index) => ({
        account_number: accountMap.get(line.account) ?? line.account,
        debit_amount: line.amount > 0 ? roundOre(line.amount) : 0,
        credit_amount: line.amount < 0 ? roundOre(Math.abs(line.amount)) : 0,
        line_description: line.description || null,
        sort_order: index,
        signature: line.signature?.trim() || null,
      }))

  const preparedVouchers: PreparedVoucher[] = []

  // A SIE file represents the opening balance either as #IB records (handled
  // separately by buildSIEOpeningBalanceEntry → source_type='opening_balance'),
  // as IB derived from #UB -1 when #IB 0 is missing (issue #675, also via
  // buildSIEOpeningBalanceEntry) or, in some source systems, as an ordinary #VER
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
  const hasCurrentYearIb = options.hasCurrentYearIb ?? (getEffectiveOpeningBalances(parsed).balances.length > 0)
  const fyStart = parsed.stats.fiscalYearStart

  for (const [voucherIndex, voucher] of parsed.vouchers.entries()) {
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
          debit_amount: roundOre(line.amount),
          credit_amount: 0,
          line_description: line.description || null,
          ...(line.dimensions ? { dimensions: line.dimensions } : {}),
        })
      } else if (line.amount < 0) {
        lines.push({
          account_number: targetAccount,
          debit_amount: 0,
          credit_amount: roundOre(Math.abs(line.amount)),
          line_description: line.description || null,
          ...(line.dimensions ? { dimensions: line.dimensions } : {}),
        })
      }
      // Note: lines with amount === 0 are silently dropped
    }

    // The voucher's position in the FILE, not in this call: a chunked import
    // runs one call per voucher group, so voucherIndex restarts every group
    // while startOrdinal carries the running offset.
    const sourceOrdinal = options.startOrdinal + voucherIndex

    // sourceId keys the RPC payload, the skipped list and the
    // voucherNumberMapping audit trail, so it has to be unique per file.
    // A SIE4I voucher has no series and no number (numberOmitted, parsed as a
    // placeholder 0), which is why the ordinal stands in: without it every
    // such voucher in the file would share the single key "0" and all but the
    // last would be lost from the mapping and from the per-account movements.
    const voucherId = formatVoucherRef(voucher, sourceOrdinal + 1)
    const voucherDate = formatDate(voucher.date)

    // Resolve per-voucher series from the parsed SIE record. Fall back to the
    // caller-supplied default only when the source voucher has no series
    // (e.g., SIE4I subsystem import files where series/verno are optional).
    const resolvedSeries = voucher.series && voucher.series.trim()
      ? voucher.series.trim()
      : defaultSeries
    // A skipped voucher the source numbered holds its number for the next
    // booked voucher of the series. Without a source number (SIE4I) there is
    // no numbering to follow, nor for a repeated number (it holds none).
    const numbered = !voucher.numberOmitted && !voucher.numberRepeated && Number.isFinite(voucher.number)
    const holdNumbers = (ref: string, count: number) => {
      const pending = (pendingGaps[resolvedSeries] ??= { count: 0, refs: [] })
      pending.count += count
      if (pending.refs.length < GAP_REFS_NAMED) {
        // `named` only once a ref names a range: a hold of single refs keeps its checkpointed shape.
        const named = pending.named ?? pending.refs.length
        pending.refs.push(ref)
        if (count !== 1 || pending.named !== undefined) pending.named = named + count
      }
    }
    const holdNumber = (why: string) => {
      if (numbered) holdNumbers(`${voucherId} (${why})`, 1)
    }
    const ownSeries = voucher.series?.trim() ?? ''
    if (numbered && ownSeries && options.numberedInOrder?.has(ownSeries)) {
      const last = lastNumbers[ownSeries]
      if (last !== undefined && voucher.number > last + 1) {
        const from = `${ownSeries}${last + 1}`
        const missing = voucher.number - last - 1
        holdNumbers(`${missing === 1 ? from : `${from}-${ownSeries}${voucher.number - 1}`} (finns inte i filen)`, missing)
      }
      lastNumbers[ownSeries] = voucher.number
    }

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
      holdNumber('konto utan mappning')
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
      holdNumber(voucher.corrections?.struck.length ? 'makulerat i källsystemet' : 'saknar rader med belopp')
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
      holdNumber('bara en rad')
      continue
    }

    // Validate balance, Fix 2: Tiered rounding with öresutjämning (ORE_ROUNDING_ACCOUNT, BAS 3740)
    const { totalDebit, totalCredit, difference } = lineBalance(lines)
    const balanceDiff = Math.abs(difference)
    if (balanceDiff > 1.00) {
      // More than 1 SEK off: incomplete voucher in source system, skip
      results.skippedDetails.push({
        voucherId,
        date: voucherDate,
        description: voucher.description,
        reason: 'unbalanced',
        balanceDiff,
        totalDebit,
        totalCredit,
        mappedLineCount: lines.length,
        originalLineCount: voucher.lines.length,
        sourceLines: voucher.lines.map(l => ({ account: l.account, amount: l.amount })),
      })
      holdNumber('balanserar inte')
      continue
    } else if (difference !== 0) {
      // Rounding difference <= 1 SEK: add explicit öresutjämning line (never modify existing lines)
      lines.push({
        account_number: ORE_ROUNDING_ACCOUNT,
        debit_amount: difference < 0 ? balanceDiff : 0,
        credit_amount: difference > 0 ? balanceDiff : 0,
        line_description: 'Öresutjämning',
      })
    }

    const rawSourceSeries = voucher.series && voucher.series.trim() ? voucher.series.trim() : null
    // A repeated number (moveRepeatedVoucherNumbersLast) is no source key:
    // the earlier voucher holds it in journal_import_source_owned_idx.
    const rawSourceNumber = !voucher.numberOmitted && !voucher.numberRepeated && Number.isFinite(voucher.number)
      ? voucher.number : null

    const voucherDateStr = formatDate(voucher.date)
    const isLikelyOpeningBalance =
      !hasCurrentYearIb &&
      !!fyStart && fyStart.slice(0, 10) === voucherDateStr &&
      lines.length > 0 &&
      lines.every((l) => isBalanceSheetAccount(l.account_number)) &&
      OPENING_BALANCE_DESCRIPTION_RE.test(voucher.description || '') &&
      !SHARE_CAPITAL_DESCRIPTION_RE.test(voucher.description || '')

    let corrections: PreparedVoucher['corrections']
    if (voucher.corrections) {
      const struck = toCorrectionSnapshots(voucher.corrections.struck)
      const added = toCorrectionSnapshots(voucher.corrections.added)
      if (struck.length > 0 || added.length > 0) {
        // SIE 4B: `sign` on #BTRANS/#RTRANS names who removed or added the row.
        // Each snapshot keeps its own; this voucher-level summary is the first
        // one, for the log row's external_signature column.
        const signature =
          [...voucher.corrections.struck, ...voucher.corrections.added]
            .map((line) => line.signature?.trim())
            .find((sig) => !!sig) ?? null
        corrections = { struck, added, signature }
      }
    }

    const held = pendingGaps[resolvedSeries]
    delete pendingGaps[resolvedSeries]

    preparedVouchers.push({
      sourceId: voucherId,
      sourceOrdinal,
      series: resolvedSeries,
      ...(held ? { numberGap: { count: held.count, explanation: numberGapExplanation(held) } } : {}),
      date: voucherDateStr,
      // A repeat carries no source number, so its text names the source voucher.
      description: voucher.numberRepeated
        ? `${voucher.description || 'Import'} (${rawSourceSeries ?? ''}${voucher.number} i filen, numret upprepas)`
        : voucher.description || `Import: ${voucherId}`,
      sourceSeries: rawSourceSeries,
      sourceNumber: rawSourceNumber,
      sourceType: isLikelyOpeningBalance ? 'opening_balance' : 'import',
      lines,
      ...(corrections ? { corrections } : {}),
    })
  }

  results.preparedEntries = preparedVouchers.map((voucher) => ({
    sourceId: voucher.sourceId,
    sieImportId,
    sourceOrdinal: voucher.sourceOrdinal,
    series: voucher.series,
    date: voucher.date,
    description: voucher.description,
    sourceSeries: voucher.sourceSeries,
    sourceNumber: voucher.sourceNumber,
    sourceType: voucher.sourceType,
    ...(voucher.numberGap ? { numberGap: voucher.numberGap } : {}),
    ...(voucher.corrections ? { corrections: voucher.corrections } : {}),
    lines: voucher.lines.map((line, lineIndex) => ({
      account_number: line.account_number,
      account_id: options.accountIds.get(line.account_number) || null,
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
  })) as SIEPreparedEntry[]
  results.pendingNumberGaps = pendingGaps
  results.lastSourceNumbers = lastNumbers

  return results
}

/** How many held vouchers a gap explanation names before it summarises the rest. */
const GAP_REFS_NAMED = 5

/**
 * Skipped vouchers of one series not yet followed by a booked one: the count
 * of numbers to hold and the first few refs with why each was not booked.
 */
export type SIEPendingNumberGaps = Record<string, {
  count: number
  refs: string[]
  /** Numbers the refs cover, when a ref names a range; absent, one per ref. */
  named?: number
}>

/**
 * The series whose numbered vouchers rise through the file, in file order:
 * the series where a number missing between two vouchers can hold its place.
 * Repeated and omitted numbers hold none and are left out.
 */
export function seriesNumberedInOrder(vouchers: readonly SIEVoucher[]): string[] {
  const last = new Map<string, number>()
  const disordered = new Set<string>()
  for (const voucher of vouchers) {
    const series = voucher.series?.trim() ?? ''
    if (!series || voucher.numberOmitted || voucher.numberRepeated || !Number.isFinite(voucher.number)) continue
    const previous = last.get(series)
    if (previous !== undefined && voucher.number <= previous) disordered.add(series)
    last.set(series, voucher.number)
  }
  return [...last.keys()].filter((series) => !disordered.has(series))
}

/** The gap's documented explanation (voucher_gap_explanations, at most 500 characters). */
function numberGapExplanation(held: { count: number; refs: string[]; named?: number }): string {
  const rest = held.count - (held.named ?? held.refs.length)
  const named = rest > 0 ? `${held.refs.join(', ')} och ${rest} till` : held.refs.join(', ')
  const one = held.count === 1
  const text = `SIE-import: källsystemets ${one ? 'verifikation' : 'verifikationer'} ${named} bokfördes inte. ` +
    `${one ? 'Numret hålls tomt' : 'Numren hålls tomma'} så att serien följer källsystemets numrering.`
  return text.length > 500 ? `${text.slice(0, 499)}…` : text
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

type ClosingLineLike = { account_number: string; debit_amount: number; credit_amount: number }

/**
 * Net (debit - credit) per target account of the file's resultatavslut among
 * the vouchers the import books: dated on the fiscal year's last day, every
 * line on a result account (BAS class 3-8) or on the form's årets resultat
 * account, at least one of each. The shape result_closing_entry_ids reads in
 * the books.
 */
export function resultClosingMovementsOf(
  entries: ReadonlyArray<{ date: string; lines: ReadonlyArray<ClosingLineLike> }>,
  fiscalYearEnd: string | null,
  resultAccount: string,
): Map<string, number> {
  const net = new Map<string, number>()
  if (!fiscalYearEnd) return net
  for (const entry of entries) {
    if (entry.date !== fiscalYearEnd) continue
    const accounts = entry.lines.map((line) => line.account_number)
    const closingShaped = accounts.every((a) => a === resultAccount || isResultatkonto(a))
      && accounts.some((a) => a === resultAccount) && accounts.some(isResultatkonto)
    if (!closingShaped) continue
    for (const line of entry.lines) {
      const amount = (Number(line.debit_amount) || 0) - (Number(line.credit_amount) || 0)
      net.set(line.account_number, roundOre((net.get(line.account_number) ?? 0) + amount))
    }
  }
  return net
}

/**
 * The imported movements to compare with #RES: less the resultatavslut's
 * result lines when the file's #RES is the result before it, which is when
 * #RES plus the closing line is zero on every result account the closing
 * touches. A #RES written after the closing (0 on those accounts), or a
 * closing through 8999 that #RES already contains, fails that test and the
 * movements are compared as they are.
 */
export function movementsBeforeResultClosing(
  expected: ReadonlyMap<string, number>,
  imported: Map<string, number>,
  resultClosing: ReadonlyMap<string, number>,
): Map<string, number> {
  const closingLines = [...resultClosing].filter(
    ([account, amount]) => !isBalanceSheetAccount(account) && Math.abs(amount) >= 0.005,
  )
  if (closingLines.length === 0) return imported
  const resBeforeClosing = closingLines.every(
    ([account, amount]) => Math.abs(roundOre((expected.get(account) ?? 0) + amount)) < 0.005,
  )
  if (!resBeforeClosing) return imported
  const adjusted = new Map(imported)
  for (const [account, amount] of closingLines) {
    adjusted.set(account, roundOre((adjusted.get(account) ?? 0) - amount))
  }
  return adjusted
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
export function buildSIEMigrationAdjustmentEntry(
  fiscalPeriodId: string,
  parsed: ParsedSIEFile,
  accountMap: Map<string, string>,
  importedMovements: Map<string, number>,
  skippedDetails: {
    voucherId: string
    date: string
    reason: string
  }[],
  skippedCount = skippedDetails.length,
  /** Net per target account of the file's resultatavslut among the imported vouchers (resultClosingMovementsOf). */
  resultClosing: Map<string, number> = new Map(),
): { input: CreateJournalEntryInput | null; deltaAccounts: number; warnings: string[] } {
  const warnings: string[] = []
  const hasUB = parsed.closingBalances.some((b) => b.yearIndex === 0)
  const hasRES = parsed.resultBalances.some((b) => b.yearIndex === 0)

  if (!hasUB && !hasRES) {
    return { input: null, deltaAccounts: 0, warnings }
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

  // A #RES written before the resultatavslut (Accounted's own export, and the
  // SIE convention for a closing that zeroes the result accounts into årets
  // resultat) is compared with the imported movements less that closing:
  // otherwise every result account's delta is the whole year's result and the
  // adjustment books it a second time (crm#1727).
  const comparedMovements = movementsBeforeResultClosing(expectedMovements, importedMovements, resultClosing)

  // Compute per-account delta: expected - imported
  const lines: CreateJournalEntryLineInput[] = []
  const allAccounts = new Set([...expectedMovements.keys(), ...comparedMovements.keys()])
  let deltaAccountCount = 0

  for (const account of allAccounts) {
    const expected = expectedMovements.get(account) || 0
    const imported = comparedMovements.get(account) || 0
    const delta = roundOre(expected - imported)

    if (Math.abs(delta) < 0.01) continue
    deltaAccountCount++

    // Fix 4: Per-line text referencing what the adjustment concerns
    const lineDesc = `Justering konto ${account}: delta ${delta} SEK från ${skippedCount} exkl. verifikationer`

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
    return { input: null, deltaAccounts: 0, warnings }
  }

  // The entry must balance. It should by construction, but verify and handle rounding.
  const { difference } = lineBalance(lines)
  if (difference !== 0) {
    lines.push({
      account_number: ORE_ROUNDING_ACCOUNT,
      debit_amount: difference < 0 ? -difference : 0,
      credit_amount: difference > 0 ? difference : 0,
      line_description: 'Öresutjämning omföringsverifikation',
    })
  }

  // Date the adjustment at fiscal year end
  const entryDate = parsed.stats.fiscalYearEnd ?? todayIsoStockholm()

  // Fix 4: Build structured description with skipped voucher details
  const skippedIds = skippedDetails.map(d => d.voucherId)
  const skippedDates = skippedDetails.map(d => d.date).sort()
  const firstId = skippedIds[0] || '?'
  const lastId = skippedIds[skippedIds.length - 1] || '?'
  const firstDate = skippedDates[0] || '?'
  const lastDate = skippedDates[skippedDates.length - 1] || '?'

  const input: CreateJournalEntryInput = {
    fiscal_period_id: fiscalPeriodId,
    entry_date: entryDate,
    description: `Omföringsverifikation: justering för ${skippedCount} exkluderade verifikationer (${firstId}-${lastId}, ${firstDate}-${lastDate}) vid SIE-import`,
    source_type: 'import',
    voucher_series: 'M',
    lines,
  }

  return { input, deltaAccounts: deltaAccountCount, warnings }
}

/**
 * Save account mappings to the database for future use.
 *
 * Two things this function got wrong for four months, both of which have to
 * stay fixed together:
 *
 * 1. `user_id` must be in the payload. sie_account_mappings.user_id is NOT NULL
 *    with no column default and no BEFORE INSERT trigger to fill it in (the
 *    only trigger on the table is the BEFORE UPDATE updated_at one), and the
 *    multi-tenant refactor added company_id without ever adding user_id to this
 *    payload. PostgREST sends an upsert as INSERT ... ON CONFLICT DO UPDATE and
 *    Postgres checks NOT NULL on the proposed tuple before conflict resolution,
 *    so omitting it raises 23502 even when the row already exists: neither the
 *    insert nor the update path can land. company_id is the tenant key; user_id
 *    records who approved the mapping review, matching what the PUT handler in
 *    app/api/import/sie/mappings writes for a single mapping.
 * 2. The upsert result must be inspected. supabase-js resolves with
 *    `{ data, error }` and does not throw on a Postgres error, so a bare
 *    `await supabase.from(...).upsert(...)` discards the failure and the caller
 *    reports success. That is why 834 imports since 2026-03-30 wrote zero
 *    mapping rows without a single complaint.
 *
 * Pass `userId` explicitly. It is only resolved from the session as a fallback
 * for callers that cannot supply it: API-key/MCP paths run on a cookieless
 * service client where auth.uid() is NULL and there is no session to read, so
 * a derived id is never something this function can rely on.
 *
 * Throws when the mappings cannot be persisted. The account mapping is the
 * user's manual review work (SIE carries no mapping and no VAT codes, so the
 * source-to-BAS decision per account is made by hand): losing it silently means
 * the next import re-opens the whole review. Callers that have already committed
 * verifikationer must catch this and surface it as a warning rather than
 * unwinding an otherwise-good import.
 */
export async function saveMappings(
  supabase: SupabaseClient,
  companyId: string,
  mappings: AccountMapping[],
  userId?: string
): Promise<void> {
  // Filter to only mapped accounts
  const mapped = mappings.filter((m) => m.targetAccount)

  if (mapped.length === 0) return

  const resolvedUserId = userId ?? (await supabase.auth.getUser()).data.user?.id
  if (!resolvedUserId) {
    throw new Error(
      'Kunde inte spara kontomappningar: user_id saknas. ' +
      'sie_account_mappings.user_id är NOT NULL utan default, och anropet ' +
      'kördes utan session (API-nyckel/MCP använder en cookie-lös ' +
      'service-klient). Skicka userId till saveMappings().'
    )
  }

  const mappingsToSave = mapped.map((m) => ({
    user_id: resolvedUserId,
    company_id: companyId,
    source_account: m.sourceAccount,
    source_name: m.sourceName,
    target_account: m.targetAccount,
    confidence: m.confidence,
    match_type: m.matchType,
  }))

  // Batch upsert in chunks of 100
  const BATCH_SIZE = 100
  let saved = 0
  for (let i = 0; i < mappingsToSave.length; i += BATCH_SIZE) {
    const batch = mappingsToSave.slice(i, i + BATCH_SIZE)
    const { error } = await supabase
      .from('sie_account_mappings')
      .upsert(batch, {
        onConflict: 'company_id,source_account',
      })

    if (error) {
      throw new Error(
        `Kunde inte spara kontomappningar: ${saved} av ` +
        `${mappingsToSave.length} sparades innan felet ` +
        `(${error.code ?? 'okänd kod'}: ${error.message}).`
      )
    }
    saved += batch.length
  }
}

/**
 * The company's remembered account mappings: the one reader of
 * sie_account_mappings that every SIE entry uses (the file upload's preview,
 * execute without supplied mappings, the v1 API, the MCP preflight and the
 * provider migration's /sie-data step).
 *
 * Paged, because a company that imported a provider's full chart holds more
 * than PostgREST's 1,000-row page (up to 3,515 in production). An unpaged read
 * returned an arbitrary 1,000, so a remembered non-identity mapping fell back
 * to a suggestion in the preview, and the dashboard sends the previewed
 * mappings to execute. Ordered by source_account, unique per company
 * (UNIQUE (company_id, source_account)), so the pages never overlap or skip.
 */
export async function loadMappings(
  supabase: SupabaseClient,
  companyId: string,
): Promise<SIEAccountMappingRecord[]> {
  return fetchAllRows<SIEAccountMappingRecord>(({ from, to }) =>
    supabase
      .from('sie_account_mappings')
      .select('*')
      .eq('company_id', companyId)
      .order('source_account')
      .range(from, to),
  )
}
