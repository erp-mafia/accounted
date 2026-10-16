import type { SupabaseClient } from '@supabase/supabase-js'
import { addDaysIso } from '@/lib/dates/iso'
import { roundOre } from '@/lib/money'
import { PINNED_JURISDICTION, resolveAccountRole } from '@/lib/bookkeeping/account-roles'
import {
  formatPeriodLabel,
  loadVatDeclarationLedger,
  resolvePeriodDates,
  vatClearingAccounts,
} from './vat-declaration'
import { buildFiledAmounts } from './vat-manual-filing'
import type { VatPeriodType } from '@/types'

/**
 * Momsredovisning settlement proposal (issue #980): the verifikat that closes
 * a VAT period by clearing every 26xx account the momsrapport reads from into
 * the redovisningskonto.
 *
 * Shape of the proposed entry (standard Swedish momsomföring, booked on the
 * period's last day, or the first day after it the books accept, see
 * firstBookableSettlementDate):
 *   - each output-VAT account (261x/262x/263x incl. reverse charge + import)
 *     is debited by its period balance, each input-VAT account (264x) is
 *     credited, at exact öre so the accounts land on zero for the period;
 *   - the net goes to 2650 (Redovisningskonto för moms, credit = att betala)
 *     or 1650 (Momsfordran, debit = att återfå) at the WHOLE-KRONA amount the
 *     declaration is filed with (buildFiledAmounts: öretal faller bort per
 *     SFF 2011:1261 22 kap. 1 §), so 2650/1650 always matches the skattekonto
 *     movement, whether the period is filed by file, by hand or through the
 *     Skatteverket integration (all three take their amounts from
 *     buildFiledAmounts);
 *   - the öre gap between the exact clearing lines and the filed net is
 *     balanced on 3740 (Öres- och kronutjämning).
 *
 * This is a PROPOSAL: the user reviews and edits the lines in the journal
 * entry form before committing, and the entry books through the normal
 * engine (balance validation, period locks, voucher numbering) with
 * source_type 'vat_settlement'. That source type is excluded from the
 * declaration projection (see fetchVatAccountTotals), so booking the
 * settlement never changes the report it was created from.
 */

/** Redovisningskonto för moms (2650): net VAT to pay (credit). */
export const VAT_SETTLEMENT_ACCOUNT = resolveAccountRole(PINNED_JURISDICTION, 'vat_settlement')
/** Momsfordran (1650): net VAT refund (debit). */
export const VAT_REFUND_ACCOUNT = resolveAccountRole(PINNED_JURISDICTION, 'vat_receivable')
/** Öres- och kronutjämning (3740): absorbs the filed whole-krona truncation gap. */
export const VAT_ROUNDING_ACCOUNT = resolveAccountRole(PINNED_JURISDICTION, 'rounding')

export interface VatSettlementProposalLine {
  account_number: string
  debit_amount: number
  credit_amount: number
  line_description?: string
}

/**
 * A settlement entry already booked (or drafted) inside the period: tagged
 * (source_type 'vat_settlement') or detected by shape (a manual momsomföring
 * clearing 26xx to 2650/1650, see fetchVatAccountTotals in vat-declaration.ts).
 */
export interface VatSettlementExistingEntry {
  id: string
  status: string
  entry_date: string
  source_type: string | null
  voucher_series: string | null
  voucher_number: number | null
}

/**
 * Why the proposed entry date is not the period's last day: the fiscal year
 * holding it is closed (bokslut done) or locked, or the company lock date
 * covers it. The DB triggers refuse a verifikat there, so the proposal moves
 * to the first date after it that is open.
 */
export type VatSettlementDateReason = 'period_closed' | 'period_locked' | 'company_lock_date'

export interface VatSettlementProposal {
  period: {
    type: VatPeriodType
    year: number
    period: number
    start: string
    end: string
  }
  /** Swedish period label, e.g. "Kvartal 1 2026" (Skatteverket-bound wording). */
  period_label: string
  /**
   * Proposed entry date: the period's last day when the books accept it,
   * otherwise the first open date after it (entry_date_reason says why).
   */
  entry_date: string
  /** Null when entry_date is the period's last day. */
  entry_date_reason: VatSettlementDateReason | null
  /** Proposed verifikationstext, e.g. "Momsredovisning Kvartal 1 2026". */
  description: string
  lines: VatSettlementProposalLine[]
  /** Ruta 49 as filed (whole kronor, signed: positive = att betala). */
  filed_net: number
  /** Signed öre gap balanced on 3740 (positive = credited, negative = debited). */
  rounding_amount: number
  /** True when the period has no VAT activity to clear. */
  is_empty: boolean
  existing_entries: VatSettlementExistingEntry[]
}

/**
 * Posted settlement that gates re-booking. Same rule as VatBookingCard:
 * tagged `vat_settlement` and shape-detected momsomföring both land in
 * `existing_entries`; the first posted row is the one the UI links to.
 */
export function findPostedVatSettlement(
  entries: VatSettlementExistingEntry[] | undefined,
): VatSettlementExistingEntry | undefined {
  return entries?.find((e) => e.status === 'posted')
}

/** Draft settlement, ignored when a posted one already exists. */
export function findDraftVatSettlement(
  entries: VatSettlementExistingEntry[] | undefined,
): VatSettlementExistingEntry | undefined {
  if (findPostedVatSettlement(entries)) return undefined
  return entries?.find((e) => e.status === 'draft')
}

export function vatSettlementBookingStatus(
  entries: VatSettlementExistingEntry[] | undefined,
): 'booked' | 'draft' | 'none' {
  if (findPostedVatSettlement(entries)) return 'booked'
  if (findDraftVatSettlement(entries)) return 'draft'
  return 'none'
}

interface BookableFiscalPeriod {
  period_start: string
  period_end: string
  is_closed: boolean | null
  locked_at: string | null
}

/**
 * The first date on or after the period's last day that a verifikat can be
 * posted on, by the same two layers the DB triggers enforce (company lock
 * date, then the fiscal period's is_closed / locked_at; see
 * resolvePeriodLockForDate). A momsredovisning for a period whose year is
 * already closed belongs on the first open day after it: it only moves 26xx
 * balances carried into the new year onto 2650/1650.
 *
 * A date no fiscal period covers is returned as is: the booking then answers
 * VAT_SETTLEMENT_NO_FISCAL_PERIOD, which names the missing year.
 */
export function firstBookableSettlementDate(
  periodEnd: string,
  lockedThrough: string | null,
  fiscalPeriods: BookableFiscalPeriod[],
): { entry_date: string; entry_date_reason: VatSettlementDateReason | null } {
  let date = periodEnd
  let reason: VatSettlementDateReason | null = null
  if (lockedThrough && date <= lockedThrough) {
    date = addDaysIso(lockedThrough, 1)
    reason = 'company_lock_date'
  }
  const ordered = [...fiscalPeriods].sort((a, b) => a.period_start.localeCompare(b.period_start))
  for (const fp of ordered) {
    if (fp.period_start > date || fp.period_end < date) continue
    if (!fp.is_closed && !fp.locked_at) break
    reason ??= fp.is_closed ? 'period_closed' : 'period_locked'
    date = addDaysIso(fp.period_end, 1)
  }
  return { entry_date: date, entry_date_reason: reason }
}

async function resolveSettlementEntryDate(
  supabase: SupabaseClient,
  companyId: string,
  periodEnd: string,
): Promise<{ entry_date: string; entry_date_reason: VatSettlementDateReason | null }> {
  const [settings, periods] = await Promise.all([
    supabase
      .from('company_settings')
      .select('bookkeeping_locked_through')
      .eq('company_id', companyId)
      .maybeSingle(),
    supabase
      .from('fiscal_periods')
      .select('period_start, period_end, is_closed, locked_at')
      .eq('company_id', companyId)
      .gte('period_end', periodEnd)
      .order('period_start', { ascending: true }),
  ])
  // Fail loud like the existing-settlement lookup: an unread lock state must
  // not turn into a date the books then refuse.
  if (settings.error) throw new Error(`settlement lock date lookup failed: ${settings.error.message}`)
  if (periods.error) throw new Error(`settlement fiscal period lookup failed: ${periods.error.message}`)
  return firstBookableSettlementDate(
    periodEnd,
    (settings.data as { bookkeeping_locked_through: string | null } | null)?.bookkeeping_locked_through ?? null,
    (periods.data ?? []) as BookableFiscalPeriod[],
  )
}

/**
 * Build the settlement verifikat proposal for a VAT period. Reads the rutor
 * from the same definition as the momsdeklaration (loadVatDeclarationLedger,
 * the company's own momskoder and momsrutor included), so the net it books is
 * the whole-krona net the eSKD file, the PDF and the Skatteverket integration
 * file (buildFiledAmounts).
 */
export async function buildVatSettlementProposal(
  supabase: SupabaseClient,
  companyId: string,
  periodType: VatPeriodType,
  year: number,
  period: number,
  options: { fiscalPeriodId?: string } = {}
): Promise<VatSettlementProposal> {
  // Yearly (helårsmoms) resolves to the räkenskapsår bounds when a fiscal
  // period is supplied: same resolution as the declaration itself.
  const { start, end } = await resolvePeriodDates(
    supabase, companyId, periodType, year, period, options.fiscalPeriodId
  )

  const periodLabel = formatPeriodLabel(periodType, year, period)
  const description = `Momsredovisning ${periodLabel}`

  const [{ totals, settlementShapedEntries, dynamicVatAccounts, rutor }, entryDate] = await Promise.all([
    loadVatDeclarationLedger(supabase, companyId, start, end),
    resolveSettlementEntryDate(supabase, companyId, end),
  ])

  // A settlement dated after the period (its year was closed) lies outside
  // the period's own range, so the lookup reaches the proposed date. Out
  // there only a verifikat with this period's own text counts: several
  // periods of a closed year all move to the same first open day, and one
  // period's settlement must not gate another's.
  const existingResult = await supabase
    .from('journal_entries')
    .select('id, status, entry_date, source_type, voucher_series, voucher_number, description')
    .eq('company_id', companyId)
    .eq('source_type', 'vat_settlement')
    .in('status', ['draft', 'posted'])
    .gte('entry_date', start)
    .lte('entry_date', entryDate.entry_date > end ? entryDate.entry_date : end)
    .order('entry_date', { ascending: false })
    .limit(20)

  // The existing-settlement lookup gates the UI's "already booked" warning
  // and its create button; a swallowed error here would silently re-enable
  // booking a period that already has a settlement, so fail loud instead.
  if (existingResult.error) {
    throw new Error(
      `existing vat_settlement lookup failed: ${existingResult.error.message}`
    )
  }

  // Shape-detected settlements (manual momsomföring, SIE imports) gate the
  // booking button exactly like tagged ones (#984): the proposal re-clears
  // the FULL period, so booking on top of a manual settlement would corrupt
  // the 26xx balances. Stornos are the CANCELLATION of a settlement and must
  // not gate, or annullera could never re-enable the button. Only posted
  // entries gate: the shape of an unposted draft has no balance effect.
  const shapedExisting = settlementShapedEntries.filter(
    (e) => e.status === 'posted' && e.source_type !== 'storno'
  )
  const taggedExisting = ((existingResult.data ?? []) as Array<VatSettlementExistingEntry & { description?: string | null }>)
    .filter((e) => e.entry_date <= end || e.description === description)
    .map(({ description: _description, ...entry }) => entry)
  const existingEntries = [
    ...taggedExisting,
    ...shapedExisting,
  ]
    .sort((a, b) => (a.entry_date < b.entry_date ? 1 : a.entry_date > b.entry_date ? -1 : 0))
    .slice(0, 5)

  const { net: filedNet } = buildFiledAmounts(rutor)

  // Clear every 26xx account the declaration reads from, at exact öre, so the
  // accounts land on zero for the period. A positive (credit) balance clears
  // with a debit and vice versa: the same formula handles credit-note-heavy
  // periods where an account sits on the "wrong" side. The company's own
  // momsruta accounts are cleared too: their balance is in the filed net, and
  // leaving them out would put the whole amount on 3740.
  const clearingAccounts = vatClearingAccounts(dynamicVatAccounts)
  const lines: VatSettlementProposalLine[] = []
  for (const account of clearingAccounts) {
    const t = totals.get(account)
    if (!t) continue
    const balance = roundOre(t.credit - t.debit)
    if (balance > 0) {
      lines.push({ account_number: account, debit_amount: balance, credit_amount: 0 })
    } else if (balance < 0) {
      lines.push({ account_number: account, debit_amount: 0, credit_amount: -balance })
    }
  }

  if (lines.length > 0) {
    if (filedNet > 0) {
      lines.push({
        account_number: VAT_SETTLEMENT_ACCOUNT,
        debit_amount: 0,
        credit_amount: filedNet,
        line_description: 'Moms att betala',
      })
    } else if (filedNet < 0) {
      lines.push({
        account_number: VAT_REFUND_ACCOUNT,
        debit_amount: -filedNet,
        credit_amount: 0,
        line_description: 'Moms att återfå',
      })
    }
  }

  // Balance the öre/krona gap left by the whole-krona filed net on 3740.
  let roundingAmount = 0
  if (lines.length > 0) {
    const gap = roundOre(
      lines.reduce((sum, l) => sum + l.debit_amount - l.credit_amount, 0)
    )
    if (gap !== 0) {
      roundingAmount = gap
      lines.push({
        account_number: VAT_ROUNDING_ACCOUNT,
        debit_amount: gap < 0 ? -gap : 0,
        credit_amount: gap > 0 ? gap : 0,
        line_description: 'Öres- och kronutjämning',
      })
    }
  }

  return {
    period: { type: periodType, year, period, start, end },
    period_label: periodLabel,
    entry_date: entryDate.entry_date,
    entry_date_reason: entryDate.entry_date_reason,
    description,
    lines,
    filed_net: filedNet,
    rounding_amount: roundingAmount,
    is_empty: lines.length === 0,
    existing_entries: existingEntries,
  }
}
