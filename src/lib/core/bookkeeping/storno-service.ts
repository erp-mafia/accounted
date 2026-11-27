import type { SupabaseClient } from '@supabase/supabase-js'
import { CustomerLossVoucherLockedError } from '@/lib/core/bookkeeping/customer-loss-voucher-lock'
import { SetoffVoucherLockedError } from '@/lib/core/bookkeeping/counterparty-setoff-voucher-lock'
import { eventBus } from '@/lib/events'
import type {
  CreateJournalEntryLineInput,
  JournalEntry,
  JournalEntryLine,
} from '@/types'
import {
  validateBalance,
  cancelOrphanedEntry,
  commitStornoOrCorrectionDraft,
  releaseBankRowsOfReversedEntry,
} from '@/lib/bookkeeping/engine'
import { linkBusinessEventToDraft, type BusinessEventLink } from '@/lib/bookkeeping/business-event-link'
import { buildStornoLines } from '@/lib/bookkeeping/line-side'
import { storedLineValues } from '@/lib/bookkeeping/line-balance'
import { isKronorCurrency } from '@/lib/bookkeeping/currency-utils'
import { roundOre } from '@/lib/money'
import { dimensionsBagKey, normalizeLineDimensions } from '@/lib/bookkeeping/dimension-resolver'
import { backfillStandardBASAccounts } from '@/lib/bookkeeping/account-backfill'
import { assertLinesWithinUnattendedCeiling } from '@/lib/bookkeeping/unattended-ceiling'
import { resolvePeriodStatusForDate } from '@/lib/core/bookkeeping/period-service'
import {
  assertStornoTarget,
  isStandingStorno,
  movedCorrectionDescription,
  movedStornoDescription,
} from '@/lib/core/bookkeeping/storno-target'
import { negatesOriginal } from '@/lib/core/bookkeeping/correction-shape'
import { postedLineAsInput } from '@/lib/core/bookkeeping/posted-line-input'
import { findKontantmetodCarry } from '@/lib/bookkeeping/kontantmetod-carry-guard'
import { assertCorrectedImportVatBase } from '@/lib/bookkeeping/import-vat-base'
import { assertCorrectionKeepsBankAccount } from '@/lib/core/bookkeeping/correction-bank-leg'
import {
  relinkPaymentRowsToEntry,
  relinkBookedRecordsToEntry,
} from '@/lib/core/bookkeeping/correction-payment-relink'
import {
  correctionChainDepth,
  CORRECTION_CHAIN_GUARD_DEPTH,
} from '@/lib/core/bookkeeping/correction-chain'
import {
  AccountsNotInChartError,
  BookkeepingDatabaseError,
  CannotCorrectNonPostedError,
  CorrectionChainTooDeepError,
  CutoffCarryCorrectionRefusedError,
  EntryAlreadyReversedError,
  EntryDateOutsideFiscalPeriodError,
  FiscalPeriodNotFoundError,
  JournalEntryNotBalancedError,
  JournalEntryNotFoundError,
  MeaninglessCorrectionError,
  NoOpenPeriodForDateError,
  TargetPeriodClosedError,
  TargetPeriodLockedError,
  UnattendedCommitLimitExceededError,
} from '@/lib/bookkeeping/errors'

/**
 * True when every account's (debit − credit) sum across the proposed lines is
 * zero. Such a rättelse describes no real affärshändelse and would erase the
 * original posting without representing anything in its place: disallowed by
 * BFL 5 kap. 5 § / BFNAR 2013:2.
 */
function netsToZeroPerAccount(lines: CreateJournalEntryLineInput[]): boolean {
  const nets = new Map<string, number>()
  for (const line of lines) {
    const delta = roundOre(line.debit_amount || 0) - roundOre(line.credit_amount || 0)
    nets.set(line.account_number, (nets.get(line.account_number) || 0) + delta)
  }
  return Array.from(nets.values()).every((n) => Math.abs(n) < 0.005)
}

type StoredLine = ReturnType<typeof storedLineValues>[number]

/** A line's account, amounts and dimensions bag, as stored. */
const amountsKey = (l: StoredLine) =>
  JSON.stringify([l.account_number, l.debit_amount, l.credit_amount, dimensionsBagKey(l.dimensions)])

/** Whether a stored line is in kronor, whatever the case of its code. */
const inKronor = (l: StoredLine) => isKronorCurrency(l.currency.trim())

/**
 * amountsKey plus the line's currency facts, as stored: a kronor line is
 * just SEK (a rate or an amount in currency on it means nothing), a foreign
 * one its code, amount in currency and rate.
 */
const fullKey = (l: StoredLine) =>
  JSON.stringify([
    amountsKey(l),
    inKronor(l) ? 'SEK' : [l.currency.trim().toUpperCase(), l.amount_in_currency, l.exchange_rate],
  ])

/**
 * Whether a proposed line names its currency. The dialog never does, and an
 * amount in currency or a rate without a code is not a currency: the MCP
 * doors turn a null into 0, so counting those would read every agent line as
 * stated.
 */
const namesCurrency = (l: CreateJournalEntryLineInput) => !!l.currency?.trim()

/** Both sides as journal_entry_lines stores them (storedLineValues). */
function storedSides(proposed: CreateJournalEntryLineInput[], original: JournalEntryLine[]) {
  const noAccountIds = new Map<string, string>()
  return {
    storedProposed: storedLineValues(proposed, noAccountIds),
    storedOriginal: storedLineValues(original.map(postedLineAsInput), noAccountIds),
  }
}

/**
 * True when proposed lines are the same multiset as the original lines
 * (account_number + debit + credit + dimensions bag, and the currency, amount
 * in currency and rate). A rättelse must actually change something, and a
 * changed tag is a change: in a locked period storno plus correction is the
 * only way to fix a wrong project or cost center (the retag path is
 * open-period only). So is a line's currency: a 1510 line without the
 * invoice's currency cannot be linked to a foreign-currency invoice, and this
 * is how it gets one (crm#2161).
 *
 * Both sides are compared as journal_entry_lines stores them
 * (storedLineValues), so key order, '01' vs '1', the cost_center/project
 * aliases, '' vs a missing key, an omitted SEK and numeric strings are not
 * differences, nor is 'eur' against 'EUR' or a rate on a kronor line. A
 * proposed line that names no currency (the correction dialog sends none)
 * matches the original line whatever its currency: restating the amounts is
 * not a request to drop the currency, and must not pass as a change that
 * does.
 */
function isIdenticalToOriginal(
  proposed: CreateJournalEntryLineInput[],
  original: JournalEntryLine[]
): boolean {
  if (proposed.length !== original.length) return false
  const { storedProposed, storedOriginal: remaining } = storedSides(proposed, original)
  // Lines that name a currency need their exact match; the rest take any
  // original with the same amounts, so they are matched last.
  const order = proposed
    .map((line, index) => ({ index, explicit: namesCurrency(line) }))
    .sort((a, b) => Number(b.explicit) - Number(a.explicit))
  for (const { index, explicit } of order) {
    const line = storedProposed[index]
    const key = explicit ? fullKey : amountsKey
    const match = remaining.findIndex((o) => key(o) === key(line))
    if (match < 0) return false
    remaining.splice(match, 1)
  }
  return true
}

/**
 * True when a rättelse that changes only currency facts (every line keeps its
 * account, amounts and dimensions) leaves a line's currency incomplete. Every
 * such correction was refused as identical before crm#2161, so this one is
 * strict:
 *
 * - A line that names no currency is stored in kronor (storedLineValues). If
 *   an original line with the same account, amounts and dimensions is in a
 *   foreign currency, that currency would go without anyone asking for it.
 *   With several such lines it cannot be told which original a bare line
 *   restates, so any foreign one refuses it.
 * - A line in a foreign currency needs its amount in currency and its rate:
 *   without them it cannot be linked to a foreign-currency invoice, which is
 *   what a currency-only correction is for. A line restated exactly as its
 *   original stored it is not judged (a revaluation leg carries amount 0).
 *
 * Refused before anything is written; the caller states the line's currency,
 * amount in currency and rate, or currency 'SEK' to post it in kronor. A
 * correction that changes amounts is not judged here.
 */
function incompleteCurrencyChange(
  proposed: CreateJournalEntryLineInput[],
  original: JournalEntryLine[]
): boolean {
  if (proposed.length !== original.length) return false
  const { storedProposed, storedOriginal } = storedSides(proposed, original)
  const proposedAmounts = storedProposed.map(amountsKey).sort()
  const originalAmounts = storedOriginal.map(amountsKey).sort()
  if (!proposedAmounts.every((k, i) => k === originalAmounts[i])) return false
  const foreignAmounts = new Set(storedOriginal.filter((l) => !inKronor(l)).map(amountsKey))
  const unrestated = [...storedOriginal]
  return storedProposed.some((line, index) => {
    if (!namesCurrency(proposed[index])) return foreignAmounts.has(amountsKey(line))
    if (inKronor(line)) return false
    if (line.amount_in_currency && Number(line.exchange_rate) > 0) return false
    const restated = unrestated.findIndex((o) => fullKey(o) === fullKey(line))
    if (restated < 0) return true
    unrestated.splice(restated, 1)
    return false
  })
}

/**
 * Storno Service - 3-step correction flow per Bokföringslagen
 *
 * Swedish bookkeeping law requires that committed entries cannot be modified.
 * To correct an error, you must:
 * 1. Create a storno (reversal) entry that nullifies the original
 * 2. Create a corrected entry with the right data
 * 3. Link all three via reverses_id, reversed_by_id, correction_of_id
 */

/**
 * Roll back an entry this correction created before a later step failed.
 * Goes through the engine's gated cleanup door (cancel_orphaned_entry), which
 * cancels the entry whether it is still a draft or already posted, and keeps
 * its lines as the record of the used voucher number. Never throws, so the
 * error that triggered the rollback is the one the caller sees.
 *
 * @returns true when the entry is now cancelled, false when the cleanup was
 * refused or failed (the entry is left as it was).
 */
async function cancelEntry(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  entryId: string,
): Promise<boolean> {
  const { error } = await cancelOrphanedEntry(supabase, companyId, userId, entryId)
  if (error) {
    console.error(`[storno] cancelEntry: failed to cancel ${entryId}:`, error.message)
    return false
  }
  return true
}

/**
 * Posting port (src/lib/posting, correctJournalEntry): the business events a
 * correction's two new verifikat come from, already recorded by the port.
 * The storno's (ledger.storno) is linked with role reversal, the corrected
 * verifikat's (ledger.correction) with role correction, each right after its
 * draft header and before commit_journal_entry draws its number. Absent
 * (every caller outside the port, and every correction while POSTING_EVENTS
 * is off), nothing is written and the drafts are exactly what they were.
 */
export interface CorrectionBusinessEvents {
  reversal?: BusinessEventLink
  correction?: BusinessEventLink
}

/**
 * Link a correction's draft to its business event, as the engine links its
 * own drafts (lib/bookkeeping/engine.ts, linkDraftToBusinessEvent). A
 * refusal under strict mode cancels the draft, which has no number yet,
 * through the same cleanup door as every other failure here, and stops the
 * correction; shadow mode and a missing table were already answered as a
 * success by the writer.
 */
async function linkCorrectionDraft(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  draftId: string,
  link: BusinessEventLink,
): Promise<void> {
  const linked = await linkBusinessEventToDraft(supabase, companyId, draftId, link)
  if (linked.ok) return
  await cancelEntry(supabase, companyId, userId, draftId)
  throw new BookkeepingDatabaseError('link_business_event', linked.message, linked.code)
}

/** Journal entry row fetched together with its lines (the embedded select). */
type OriginalWithLines = JournalEntry & { lines?: JournalEntryLine[] | null }

/**
 * The fiscal period a corrected verifikat dated `date` lands in, classified
 * with the same two layers the DB triggers enforce (company lock date, then
 * the covering period's is_closed/locked_at), so a closed, locked or
 * uncovered date answers with a typed Swedish refusal before anything is
 * written instead of a raw trigger rejection. Periods are never created here.
 */
async function resolveCorrectionPeriod(
  supabase: SupabaseClient,
  companyId: string,
  date: string,
): Promise<string> {
  const target = await resolvePeriodStatusForDate(supabase, companyId, date)
  if (target.status === 'closed') {
    throw new TargetPeriodClosedError(date)
  }
  if (target.status === 'locked') {
    throw new TargetPeriodLockedError(date, target.lock_date)
  }
  if (!target.period_id) {
    throw new NoOpenPeriodForDateError(date)
  }
  return target.period_id
}

/**
 * Correct an existing posted journal entry using the storno method.
 *
 * The storno (reversal) is created in the original entry's period and date,
 * so the original nets to zero where it was booked. The corrected entry
 * defaults to the original's date/period too, but `options.newEntryDate` /
 * `options.newFiscalPeriodId` let a caller re-book it elsewhere: used to move
 * a verifikation booked on the wrong year to its correct period (see
 * recordateEntry). When the date/period is the correction, identical lines are
 * allowed (the move itself is the meaningful change). A `newEntryDate` without
 * `newFiscalPeriodId` resolves its period here, refused when it is closed,
 * locked or uncovered (the ändringsverifikation dialog's date field).
 *
 * Lines that are the original with debit and credit swapped are refused
 * (MeaninglessCorrectionError 'negates_original') unless `sidesSwapped` says
 * the original itself was booked the wrong way round: the storno already
 * reverses the original, so the same reversal again as the rättelse leaves
 * every account at minus the original (crm#1397).
 *
 * An original whose own date takes no write (its year closed or locked, or
 * on or before the company lock date) is refused, unless
 * `inFirstOpenPeriodWhenLocked` is set (the person's correction doors): then
 * the storno and the corrected verifikat are rättelseposter dated in the
 * first open, unlocked period after it (assertStornoTarget), their texts name
 * the original's voucher and date, and nothing is written to the original or
 * its year: it stays 'posted' with its bank rows, payments and underlag, and
 * the links run from the new verifikat (reverses_id, correction_of_id).
 *
 * Returns: { reversal, corrected } - the two new entries created
 */
export async function correctEntry(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  originalEntryId: string,
  correctedLines: CreateJournalEntryLineInput[],
  options?: {
    newEntryDate?: string
    newFiscalPeriodId?: string
    /**
     * The original entry (with lines) already loaded by the caller. When
     * provided, we skip the redundant re-fetch: recordateEntry reads the
     * original to copy its lines and hands it through here. This also closes
     * the small TOCTOU window a second independent read would open.
     */
    preloadedOriginal?: OriginalWithLines
    /**
     * Verifikationstext for the corrected entry. Defaults to
     * "Rättelse: <original description>". Supplying it lets a user who
     * corrects the account BECAUSE the original label was wrong avoid the
     * stale label echoing in the correction header (issue #1031).
     */
    description?: string
    /**
     * Bypass the correction-chain depth guard. Correcting an entry that is
     * already CORRECTION_CHAIN_GUARD_DEPTH+ links deep in a rättelse chain
     * throws CorrectionChainTooDeepError unless this is set: the sanctioned
     * fix is one correction expressing the chain's net effect, not another
     * layer of storno+rättelse.
     */
    allowDeepChain?: boolean
    /**
     * The original was booked with debit and credit swapped, and the
     * corrected lines book it the right way round. Without it, lines that
     * negate the original are refused: to only cancel a verifikat, reverse it.
     */
    sidesSwapped?: boolean
    /**
     * The correction is a system step, not the person's verdict on the
     * kontering (the kontantmetod cut-off moving a paid cost to its clearing
     * account): the counterparty template the booking taught keeps its
     * occurrence (unlearn-on-reversal, crm#1858).
     */
    keepLearnedTemplates?: boolean
    /**
     * The original's own date takes no write: book the storno and the
     * corrected verifikat in the first open, unlocked period instead of
     * refusing. Set by the person's correction doors (the app, v1 and MCP);
     * the system corrections (a VAT basis fix, the kontantmetod cut-off) and
     * recordateEntry leave it unset and keep the refusal.
     */
    inFirstOpenPeriodWhenLocked?: boolean
    /** Posting port: the events of the two new verifikat (CorrectionBusinessEvents). */
    businessEvents?: CorrectionBusinessEvents
  }
): Promise<{
  reversal: JournalEntry
  corrected: JournalEntry
  transactionRelinkError?: string
  documentRelinkError?: string
  /** A payment row or a booked record (invoice, inbox item, utlägg) that stayed on the reversed original. */
  recordRelinkError?: string
}> {
  // Validate the corrected lines are balanced
  const balance = validateBalance(correctedLines)
  if (!balance.valid) {
    throw new JournalEntryNotBalancedError(balance.totalDebit, balance.totalCredit, 'correction')
  }

  // Reject a rättelse with no economic effect (e.g. 1930 debit 100 / 1930
  // credit 100). Such an entry would erase the original posting without
  // representing any affärshändelse: disallowed by BFL 5 kap. 5 §.
  if (netsToZeroPerAccount(correctedLines)) {
    throw new MeaninglessCorrectionError('net_zero_per_account')
  }

  // Fetch original entry with lines: unless the caller already loaded it.
  let original = options?.preloadedOriginal ?? null
  if (!original) {
    const { data, error: fetchError } = await supabase
      .from('journal_entries')
      .select('*, lines:journal_entry_lines(*)')
      .eq('id', originalEntryId)
      .eq('company_id', companyId)
      .single()

    if (fetchError || !data) {
      throw new JournalEntryNotFoundError()
    }
    original = data as OriginalWithLines
  }

  if (original.status !== 'posted') {
    throw new CannotCorrectNonPostedError(original.status)
  }
  // A kundförlust voucher's amounts and date are its decision's
  // (invoice_write_offs): storno the whole voucher instead.
  if (original.source_type === 'customer_loss') {
    throw new CustomerLossVoucherLockedError()
  }
  // A kvittning voucher's amount and date are its set-off's
  // (counterparty_setoffs): storno the whole voucher instead.
  if (original.source_type === 'counterparty_setoff') {
    throw new SetoffVoucherLockedError()
  }

  // A kontantmetod year-end carry (#3440) is never corrected in place: it is
  // stornoed on its own date and the cut-off is run again, which rebuilds it
  // from the invoice. The database refuses the same (kontantmetod_carry_on_
  // reversal), but only after this function has posted both of its entries,
  // and the refusal then reads as "already reversed".
  if (
    original.source_type === 'year_end' &&
    (await findKontantmetodCarry(supabase, companyId, original.id))
  ) {
    throw new CutoffCarryCorrectionRefusedError()
  }

  // Chain-depth guard: stop corrections stacking on corrections. Agents have
  // looped storno+rättelse on their own rättelser 10 deep (Christoffer case
  // 2026-08-11), turning a third of the journal into noise vouchers. Depth is
  // walked over the DB links, so a custom verifikationstext cannot dodge it.
  if (!options?.allowDeepChain) {
    const chain = await correctionChainDepth(supabase, companyId, original)
    if (chain.depth >= CORRECTION_CHAIN_GUARD_DEPTH) {
      throw new CorrectionChainTooDeepError(chain.depth, chain.rootVoucher)
    }
  }

  const originalLines = (original.lines as JournalEntryLine[]) || []

  // A second reversal is never a rättelse, whatever date it carries: the
  // storno below already takes the original out. Checked before the date's
  // period is resolved, so the refusal names the lines, not the date.
  if (!options?.sidesSwapped && negatesOriginal(correctedLines, originalLines)) {
    throw new MeaninglessCorrectionError('negates_original')
  }

  // Where the storno lands: on the original's date in the original's year,
  // which must be open, or (inFirstOpenPeriodWhenLocked, when that date takes
  // no write) in the first open, unlocked period after it. Refused before
  // anything is written, so a correction that cannot land leaves no draft
  // behind (the period-lock trigger would only refuse the insert).
  const stornoTarget = await assertStornoTarget(
    supabase,
    companyId,
    original,
    undefined,
    options?.inFirstOpenPeriodWhenLocked ? { inFirstOpenPeriodWhenLocked: true } : undefined,
  )
  const moved = stornoTarget.moved

  // Resolve where the corrected entry lands. Defaults to the original's own
  // date/period (a plain line-correction), or to the storno's when the storno
  // was moved out of a locked year. A caller may override either to re-book
  // the entry in another period (recordate / wrong-year fix); a date alone
  // finds its own period, and is always checked when the storno was moved.
  const correctedDate = options?.newEntryDate ?? (moved ? stornoTarget.date : original.entry_date)
  const correctedPeriodId =
    options?.newFiscalPeriodId ??
    (options?.newEntryDate && (moved || options.newEntryDate !== original.entry_date)
      ? await resolveCorrectionPeriod(supabase, companyId, options.newEntryDate)
      : moved
        ? stornoTarget.fiscal_period_id
        : original.fiscal_period_id)
  const dateOrPeriodChanged =
    correctedDate !== original.entry_date || correctedPeriodId !== original.fiscal_period_id
  // A move is the rättelse only when the original leaves its year with it
  // (recordate). A storno moved out of a locked year leaves the original
  // standing there, so the same lines again in the open year change nothing.
  const moveIsTheChange = dateOrPeriodChanged && !moved

  // Reject when the proposed lines are identical to the original entry: a
  // rättelse must actually change something. Skip this when the date/period is
  // the change (moving a verifikation to the right year keeps the same lines).
  if (!moveIsTheChange && isIdenticalToOriginal(correctedLines, originalLines)) {
    throw new MeaninglessCorrectionError('identical_to_original')
  }
  if (!moveIsTheChange && incompleteCurrencyChange(correctedLines, originalLines)) {
    throw new MeaninglessCorrectionError('currency_incomplete')
  }

  // Importmoms keeps its ruta 50 base in the corrected verifikat (#94), as at
  // the booking doors, and a bank row's money stays on the bank row's own
  // account (correction-bank-leg.ts). A pure move (recordate: the same lines
  // on another date) writes no new line and is not judged. Refused before
  // anything is written.
  if (!(moveIsTheChange && isIdenticalToOriginal(correctedLines, originalLines))) {
    await assertCorrectedImportVatBase(supabase, companyId, original.source_type, correctedLines)
    await assertCorrectionKeepsBankAccount(supabase, companyId, original.id, originalLines, correctedLines)
  }

  // When re-booking elsewhere, validate the corrected date falls within the
  // target period's bounds (mirrors createDraftEntry). recordateEntry resolves
  // the period from the date, so this also guards a mismatched explicit
  // override and fails fast before any storno is written.
  if (dateOrPeriodChanged) {
    const { data: targetPeriod, error: targetErr } = await supabase
      .from('fiscal_periods')
      .select('name, period_start, period_end')
      .eq('id', correctedPeriodId)
      .eq('company_id', companyId)
      .single()
    if (targetErr || !targetPeriod) {
      throw new FiscalPeriodNotFoundError()
    }
    if (correctedDate < targetPeriod.period_start || correctedDate > targetPeriod.period_end) {
      throw new EntryDateOutsideFiscalPeriodError(
        correctedDate,
        targetPeriod.name,
        targetPeriod.period_start,
        targetPeriod.period_end
      )
    }
  }

  // An API key's unattended ceiling, for both verifikat before either is
  // drafted: the storno (the original's amount) and the corrected one. The
  // commit asks again, but by then a refused correction would cancel a storno
  // that already drew its number.
  assertLinesWithinUnattendedCeiling(originalLines)
  assertLinesWithinUnattendedCeiling(correctedLines)

  // ===== Step 0: Resolve corrected-line accounts BEFORE any journal write =====
  // The old flow created and posted the storno first and only then discovered
  // that a corrected line referenced an account outside the chart. The storno
  // then had to be cancelled again, which left a voided 0 kr storno in the
  // correction chain and permanently burned voucher numbers (next_voucher_number
  // is a consuming counter → an unexplained BFNAR 2013:2 gap). Validate up
  // front instead: standard BAS accounts missing from the chart are seeded on
  // demand (same as createDraftEntry); unknown numbers or deliberately
  // deactivated accounts fail fast with nothing written.
  const accountNumbers = [...new Set(correctedLines.map((l) => l.account_number))]
  const resolveActiveAccountIds = async (): Promise<Map<string, string>> => {
    const { data: accounts } = await supabase
      .from('chart_of_accounts')
      .select('id, account_number')
      .eq('company_id', companyId)
      .eq('is_active', true)
      .in('account_number', accountNumbers)
    const map = new Map<string, string>()
    for (const account of accounts || []) {
      map.set(account.account_number, account.id)
    }
    return map
  }

  let accountIdMap = await resolveActiveAccountIds()
  let missingAccounts = accountNumbers.filter((num) => !accountIdMap.has(num))
  if (missingAccounts.length > 0) {
    const seeded = await backfillStandardBASAccounts(supabase, companyId, userId, missingAccounts)
    if (seeded.length > 0) {
      accountIdMap = await resolveActiveAccountIds()
      missingAccounts = accountNumbers.filter((num) => !accountIdMap.has(num))
    }
    if (missingAccounts.length > 0) {
      throw new AccountsNotInChartError(missingAccounts)
    }
  }

  // ===== Step 1: Create storno (reversal) entry =====
  // No note on the storno: the note describes the affärshändelse, which the
  // correction now represents (correction-column-policy.ts). Both new
  // verifikat are inserted as drafts without a number (voucher_number 0) and
  // posted through commit_journal_entry, which draws the next number in the
  // series and stamps WHO (the acting user, key, OAuth client or cron job)
  // and HOW in the same transaction (commitStornoOrCorrectionDraft). A moved
  // storno is numbered in its own year's series and names the original.
  const { data: reversalEntry, error: reversalError } = await supabase
    .from('journal_entries')
    .insert({
      company_id: companyId,
      user_id: userId,
      fiscal_period_id: stornoTarget.fiscal_period_id,
      voucher_number: 0,
      voucher_series: original.voucher_series || 'A',
      entry_date: stornoTarget.date,
      description: moved ? movedStornoDescription(original) : `Storno: ${original.description}`,
      source_type: 'storno',
      reverses_id: originalEntryId,
      status: 'draft',
    })
    .select()
    .single()

  if (reversalError || !reversalEntry) {
    throw new BookkeepingDatabaseError('create_reversal_entry', reversalError?.message)
  }

  // Posting port: the storno's event, linked before its lines and its number.
  if (options?.businessEvents?.reversal) {
    await linkCorrectionDraft(supabase, companyId, userId, reversalEntry.id, options.businessEvents.reversal)
  }

  // Insert reversed lines, the engine's storno of each (buildStornoLines: the
  // opposite side, swapped on the net, so a legacy negative-side line
  // reverses to a well-formed one), preserving dimensions.
  const reversalLineInserts = buildStornoLines(originalLines).map(({ line, ...storno }, index) => {
    const dimensions = normalizeLineDimensions(line)
    return {
      journal_entry_id: reversalEntry.id,
      account_number: line.account_number,
      account_id: line.account_id || null,
      debit_amount: storno.debit_amount,
      credit_amount: storno.credit_amount,
      currency: line.currency || 'SEK',
      amount_in_currency: storno.amount_in_currency,
      exchange_rate: line.exchange_rate || null,
      line_description: `Storno: ${line.line_description || ''}`,
      tax_code: line.tax_code || null,
      dimensions,
      sort_order: index,
    }
  })

  const { error: reversalLinesError } = await supabase
    .from('journal_entry_lines')
    .insert(reversalLineInserts)

  if (reversalLinesError) {
    await cancelEntry(supabase, companyId, userId, reversalEntry.id)
    throw new BookkeepingDatabaseError('create_reversal_lines', reversalLinesError.message)
  }

  // Post the reversal entry: number, status and commit stamp together.
  const { error: postReversalError } = await commitStornoOrCorrectionDraft(
    supabase,
    companyId,
    reversalEntry.id
  )

  if (postReversalError) {
    await cancelEntry(supabase, companyId, userId, reversalEntry.id)
    if (postReversalError instanceof UnattendedCommitLimitExceededError) throw postReversalError
    throw new BookkeepingDatabaseError('post_reversal_entry', postReversalError.message)
  }

  // A moved storno leaves the original 'posted', so no compare-and-set on it
  // keeps a concurrent second correction out: the one whose storno does not
  // stand (isStandingStorno) is cancelled here, before its corrected
  // verifikat exists.
  if (moved) {
    // A storno the cleanup door cannot cancel stands without its corrected
    // verifikat and nets the original out of the open year: never a refusal
    // that reads as nothing happened.
    const dropStorno = async (refusal: Error): Promise<never> => {
      if (await cancelEntry(supabase, companyId, userId, reversalEntry.id)) throw refusal
      console.error(
        `[storno] correctEntry: moved storno ${reversalEntry.id} of ${originalEntryId} could not be cancelled; it stands without a corrected verifikat`,
      )
      throw new BookkeepingDatabaseError(
        'post_reversal_entry',
        `storno ${reversalEntry.id} could not be cancelled after: ${refusal.message}`,
      )
    }
    let standing = false
    try {
      standing = await isStandingStorno(supabase, companyId, originalEntryId, reversalEntry.id)
    } catch (err) {
      await dropStorno(err instanceof Error ? err : new Error(String(err)))
    }
    if (!standing) await dropStorno(new EntryAlreadyReversedError())
  }

  // NOTE: Original entry is NOT marked as 'reversed' here. We defer that
  // until both the reversal and corrected entries are successfully posted.
  // This avoids the impossible reversed→posted rollback if step 2 fails.

  // ===== Step 2: Create corrected entry =====
  // If anything in this step fails, cancel the reversal entry.
  // The original entry was never modified, so no rollback needed.

  let correctedEntry: typeof reversalEntry

  try {
    // Account IDs were resolved (and standard BAS accounts seeded) in Step 0,
    // before the storno existed: nothing to clean up if we got this far.
    // The header is the columns written here plus the ones carried from the
    // original (the note). Every journal_entries column is classified in
    // correction-column-policy.ts, and storno-service.test.ts fails when this
    // insert and that table disagree.
    const { data: newEntry, error: correctedError } = await supabase
      .from('journal_entries')
      .insert({
        company_id: companyId,
        user_id: userId,
        fiscal_period_id: correctedPeriodId,
        voucher_number: 0, // drawn by commit_journal_entry when it is posted
        voucher_series: original.voucher_series || 'A',
        entry_date: correctedDate,
        // A caller-supplied verifikationstext wins; blank falls back to the
        // canonical auto text so the header never ends up empty. Moved out of
        // a locked year, the text names the original's voucher and date either
        // way.
        description: moved
          ? movedCorrectionDescription(original, options?.description)
          : options?.description?.trim() || `Rättelse: ${original.description}`,
        source_type: 'correction',
        correction_of_id: originalEntryId,
        status: 'draft',
        // Carried: what the user said about the affärshändelse follows it to
        // the verifikat that now represents it (crm#1078).
        notes: original.notes ?? null,
      })
      .select()
      .single()

    if (correctedError || !newEntry) {
      throw new BookkeepingDatabaseError('create_corrected_entry', correctedError?.message)
    }

    correctedEntry = newEntry

    // Posting port: the corrected verifikat's event, linked before its lines
    // and its number. Refused under strict, the draft is cancelled here and
    // the catch below cancels the posted storno, as for any failure in this
    // step: the storno keeps its number as a cancelled verifikat.
    if (options?.businessEvents?.correction) {
      await linkCorrectionDraft(supabase, companyId, userId, correctedEntry.id, options.businessEvents.correction)
    }

    // Insert corrected lines
    const correctedLineInserts = storedLineValues(correctedLines, accountIdMap).map((line) => ({
      journal_entry_id: correctedEntry.id,
      ...line,
    }))

    const { error: correctedLinesError } = await supabase
      .from('journal_entry_lines')
      .insert(correctedLineInserts)

    if (correctedLinesError) {
      await cancelEntry(supabase, companyId, userId, correctedEntry.id)
      throw new BookkeepingDatabaseError('create_corrected_lines', correctedLinesError.message)
    }

    // Post the corrected entry: number, status and commit stamp together.
    const { error: postCorrectedError } = await commitStornoOrCorrectionDraft(
      supabase,
      companyId,
      correctedEntry.id
    )

    if (postCorrectedError) {
      await cancelEntry(supabase, companyId, userId, correctedEntry.id)
      if (postCorrectedError instanceof UnattendedCommitLimitExceededError) throw postCorrectedError
      throw new BookkeepingDatabaseError('post_corrected_entry', postCorrectedError.message)
    }
  } catch (err) {
    // Cancel the reversal entry (posted → cancelled). Original was never
    // modified so no rollback needed: it's still 'posted'.
    await cancelEntry(supabase, companyId, userId, reversalEntry.id)
    throw err
  }

  // A moved storno writes nothing to the original or its locked stretch (the
  // period-lock trigger refuses any write to a locked or closed year, and
  // what lies on or before the lock date stands as it was locked): the
  // original keeps its status, bank rows, payment rows, the records it books
  // and its underlag, and the chain is read from the new verifikat
  // (reverses_id, correction_of_id).
  let transactionRelinkError: string | undefined
  let documentRelinkError: string | undefined
  let recordRelinkError: string | undefined
  if (!moved) {
    // ===== Mark original as reversed (CAS guard: only if still 'posted') =====
    const { data: updatedOriginal, error: casError } = await supabase
      .from('journal_entries')
      .update({
        status: 'reversed',
        reversed_by_id: reversalEntry.id,
      })
      .eq('id', originalEntryId)
      .eq('status', 'posted')
      .select('id')

    if (casError || !updatedOriginal || updatedOriginal.length === 0) {
      // Concurrent reversal beat us: cancel both our entries, the reversal
      // first. The replacement is only cancelled once the reversal is gone:
      // cancelling it while the reversal stays posted would leave the original
      // netted to zero with no replacement, erasing the affärshändelse.
      const reversalCancelled = await cancelEntry(supabase, companyId, userId, reversalEntry.id)
      if (reversalCancelled) {
        await cancelEntry(supabase, companyId, userId, correctedEntry!.id)
        throw new EntryAlreadyReversedError()
      }

      // The cleanup door refuses a reversal the original points at, which is
      // what an ambiguous CAS error that did land looks like. Then the chain is
      // complete (original reversed, reversal and replacement posted) and this
      // is a successful correction.
      const { data: originalNow } = await supabase
        .from('journal_entries')
        .select('status, reversed_by_id')
        .eq('id', originalEntryId)
        .eq('company_id', companyId)
        .single()
      if (originalNow?.status !== 'reversed' || originalNow.reversed_by_id !== reversalEntry.id) {
        // Anything else keeps the replacement posted beside the surviving
        // reversal, so the amounts stay right; the links need a manual look.
        console.error(
          `[storno] correctEntry: reversal ${reversalEntry.id} could not be cancelled after a failed CAS on ${originalEntryId}; replacement ${correctedEntry!.id} kept posted`,
        )
        throw new EntryAlreadyReversedError()
      }
    }

    // Re-point bank transactions and underlag from the original to the corrected
    // entry. The original is now status 'reversed'; the corrected entry is the
    // live representation of the affärshändelse, so the transaction row should
    // keep reading as booked against it (and stay correctable/uncategorizable),
    // and the underlag should travel with it. Best-effort: the correction_of_id
    // chain preserves traceability even if either relink fails, but a relink
    // failure is surfaced on the result so the caller can warn instead of
    // silently stranding a bank row or underlag on the reversed entry.
    transactionRelinkError = await relinkTransactionsToEntry(
      supabase,
      companyId,
      originalEntryId,
      correctedEntry!.id
    )
    // A correction that takes the bank leg out (to 2440 for a purchase rebooked
    // as a supplier invoice) leaves the bank row nothing to anchor:
    // guard_cash_transaction_binding refuses the move. Left on the reversed
    // original, the row read as booked and could be neither unlinked nor
    // stornoed (crm#1433). It is released the way a storno releases it, back to
    // Att bokföra, to be matched to the verifikat that now books the payment.
    // A correction that moves the leg to another bank account never gets here
    // (assertCorrectionKeepsBankAccount refuses it up front).
    if (transactionRelinkError) {
      await releaseBankRowsOfReversedEntry(supabase, companyId, originalEntryId)
    }
    // The invoice payment rows follow too, so the invoice reads as paid by the
    // verifikat that stands, not by the reversed original (PH 227).
    const paymentRowRelinkError = await relinkPaymentRowsToEntry(supabase, companyId, originalEntryId, correctedEntry!.id)
    // So do the records the original books, each by its own verifikat
    // pointer: the invoice, the inbox item it was booked from and the utlägg.
    // The corrected verifikat books them now.
    const bookedRecordRelinkError = await relinkBookedRecordsToEntry(supabase, companyId, originalEntryId, correctedEntry!.id)
    // Surfaced on the result like the two relinks beside them, so a caller
    // can warn instead of reporting a clean correction.
    recordRelinkError = paymentRowRelinkError ?? bookedRecordRelinkError
    documentRelinkError = await relinkDocumentsToEntry(
      supabase,
      userId,
      originalEntryId,
      correctedEntry!.id
    )
  }

  // ===== Step 3: Fetch complete entries =====
  const { data: finalReversal } = await supabase
    .from('journal_entries')
    .select('*, lines:journal_entry_lines(*)')
    .eq('id', reversalEntry.id)
    .single()

  const { data: finalCorrected } = await supabase
    .from('journal_entries')
    .select('*, lines:journal_entry_lines(*)')
    .eq('id', correctedEntry.id)
    .single()

  const result = {
    reversal: finalReversal as JournalEntry,
    corrected: finalCorrected as JournalEntry,
    ...(transactionRelinkError ? { transactionRelinkError } : {}),
    ...(documentRelinkError ? { documentRelinkError } : {}),
    ...(recordRelinkError ? { recordRelinkError } : {}),
  }

  // Both new verifikat are posted vouchers like any other: announce each as
  // committed, as reverseEntry does for its storno, so webhook subscribers to
  // journal_entry.committed see them (accounted#58). commit_journal_entry
  // already wrote their event_log rows; the handler's write for the same
  // dedupe_key adds nothing there.
  for (const entry of [result.reversal, result.corrected]) {
    if (!entry) continue
    await eventBus.emit({
      type: 'journal_entry.committed',
      payload: { entry, userId, companyId },
    })
  }

  await eventBus.emit({
    type: 'journal_entry.corrected',
    payload: {
      original: original as JournalEntry,
      storno: result.reversal,
      corrected: result.corrected,
      companyId,
      userId,
      ...(options?.keepLearnedTemplates ? { keepLearnedTemplates: true as const } : {}),
    },
  })

  return result
}

/**
 * Move a posted verifikation to a different date, and thereby a different
 * fiscal period: without changing its lines. Fixes a booking entered with the
 * wrong date/year (e.g. 2026-07-03 that should have been 2025-07-03).
 *
 * A posted verifikation is immutable (BFL), so this is a storno + re-book under
 * the hood: the original is reversed in its own period (netting it to zero
 * there) and an identical corrected verifikation is posted with `newDate` in
 * the target period. The underlag follows the corrected entry. The full chain
 * original → storno → correction stays linked (BFL 5 kap. 5 §).
 *
 * Fails fast with a typed error if the target date is not bookable: closed year
 * (TargetPeriodClosedError), locked period / company lock date
 * (TargetPeriodLockedError), or no covering period (NoOpenPeriodForDateError).
 */
export async function recordateEntry(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  originalEntryId: string,
  newDate: string,
  options?: {
    /**
     * Bypass the correction-chain depth guard (see correctEntry): a date
     * move IS another storno+rättelse layer, so moving an entry already
     * 3+ links deep needs the same explicit confirmation.
     */
    allowDeepChain?: boolean
    /** Posting port: the events of the storno and the moved verifikat, handed to correctEntry. */
    businessEvents?: CorrectionBusinessEvents
  }
): Promise<{ reversal: JournalEntry; corrected: JournalEntry }> {
  // Fetch original with lines
  const { data: original, error: fetchError } = await supabase
    .from('journal_entries')
    .select('*, lines:journal_entry_lines(*)')
    .eq('id', originalEntryId)
    .eq('company_id', companyId)
    .single()

  if (fetchError || !original) {
    throw new JournalEntryNotFoundError()
  }
  if (original.status !== 'posted') {
    throw new CannotCorrectNonPostedError(original.status)
  }
  // A kundförlust voucher's amounts and date are its decision's
  // (invoice_write_offs): storno the whole voucher instead.
  if (original.source_type === 'customer_loss') {
    throw new CustomerLossVoucherLockedError()
  }
  // A kvittning voucher's amount and date are its set-off's
  // (counterparty_setoffs): storno the whole voucher instead.
  if (original.source_type === 'counterparty_setoff') {
    throw new SetoffVoucherLockedError()
  }
  if (newDate === original.entry_date) {
    throw new MeaninglessCorrectionError('no_date_change')
  }

  // Classify the target date before anything is written (resolveCorrectionPeriod).
  const targetPeriodId = await resolveCorrectionPeriod(supabase, companyId, newDate)

  // Copy the original lines verbatim: they were correct; only the date was
  // wrong. correctEntry rebuilds the storno from the original anyway.
  const originalLines = (original.lines as JournalEntryLine[]) || []
  const copiedLines: CreateJournalEntryLineInput[] = originalLines
    .slice()
    .sort((a, b) => a.sort_order - b.sort_order)
    .map(postedLineAsInput)

  const result = await correctEntry(
    supabase,
    companyId,
    userId,
    originalEntryId,
    copiedLines,
    {
      newEntryDate: newDate,
      newFiscalPeriodId: targetPeriodId,
      // Hand the entry we already fetched (with lines) to correctEntry so it
      // doesn't re-read the same row.
      preloadedOriginal: original as OriginalWithLines,
      allowDeepChain: options?.allowDeepChain,
      ...(options?.businessEvents ? { businessEvents: options.businessEvents } : {}),
    }
  )

  // Underlag and bank-transaction links follow the corrected entry:
  // correctEntry handles both relinks for every correction flavour.
  return result
}

/**
 * Re-point every bank transaction from one entry to another. Used when a
 * verifikation is corrected so the transaction row keeps reading as booked
 * against the live (corrected) entry instead of the reversed original.
 *
 * A bank row has two anchors and both must follow the correction: the
 * pointer column (transactions.journal_entry_id, the 1:1 case) and the
 * transaction_voucher_links junction (bulk-book writes a bank_line row beside
 * the pointer for N=1 and as the ONLY anchor for a samlingsverifikat with
 * N>1; 1:N splits and residual bookings anchor through it too). Every junction
 * reader (is_transaction_booked(), the bulk_book RPC, the reconciliation
 * bridge) treats a surviving link as an anchor, so a
 * link left on the reversed original keeps the row double-anchored: a later
 * storno of the correction releases the pointer while the stale link keeps
 * the row out of Att bokföra (#2364, the split #2061 fixed on the storno
 * path). The links are re-pointed, not deleted: for a samlingsverifikat the
 * junction is the only anchor, and deleting it would push rows the corrected
 * verifikat still explains back into the worklist. role and allocated_amount
 * describe the bank row's share of the affärshändelse and are unchanged by
 * the correction.
 *
 * Failures are logged, not thrown (the correction chain stays traceable),
 * but the message is returned so correctEntry can surface a warning.
 */
async function relinkTransactionsToEntry(
  supabase: SupabaseClient,
  companyId: string,
  fromEntryId: string,
  toEntryId: string
): Promise<string | undefined> {
  const { error: pointerError } = await supabase
    .from('transactions')
    .update({ journal_entry_id: toEntryId })
    .eq('company_id', companyId)
    .eq('journal_entry_id', fromEntryId)
  if (pointerError) {
    console.error(
      `[storno] relinkTransactionsToEntry: failed to move transactions ${fromEntryId} → ${toEntryId}:`,
      pointerError.message
    )
  }
  const { error: junctionError } = await supabase
    .from('transaction_voucher_links')
    .update({ journal_entry_id: toEntryId })
    .eq('company_id', companyId)
    .eq('journal_entry_id', fromEntryId)
  if (junctionError) {
    console.error(
      `[storno] relinkTransactionsToEntry: failed to move voucher links ${fromEntryId} → ${toEntryId}:`,
      junctionError.message
    )
  }
  return pointerError?.message ?? junctionError?.message
}

/**
 * Re-point every document_attachment from one entry to another so the
 * underlag travels with the live (corrected) entry. Goes through the
 * relink_documents_to_correction RPC: a direct UPDATE on
 * document_attachments.journal_entry_id is categorically blocked by the
 * BFL immutability triggers (migration 20260506130000/150000); the RPC
 * validates the correction chain (source reversed, target posted,
 * target.correction_of_id = source) and performs the move under the narrow
 * gnubok.allow_correction_relink GUC. The line-level link is cleared because
 * the corrected entry has new line ids.
 *
 * Failures are logged, not thrown (the entry-level correction chain is the
 * source of truth for traceability), but the error message is returned so
 * correctEntry can surface a warning instead of pretending the underlag
 * moved.
 */
async function relinkDocumentsToEntry(
  supabase: SupabaseClient,
  userId: string,
  fromEntryId: string,
  toEntryId: string
): Promise<string | undefined> {
  const { error } = await supabase.rpc('relink_documents_to_correction', {
    p_user_id: userId,
    p_from_entry_id: fromEntryId,
    p_to_entry_id: toEntryId,
  })
  if (error) {
    console.error(
      `[storno] relinkDocumentsToEntry: failed to move documents ${fromEntryId} → ${toEntryId}:`,
      error.message
    )
    return error.message
  }
  return undefined
}
