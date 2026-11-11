import type { SupabaseClient } from '@supabase/supabase-js'
import { addDaysIso } from '@/lib/dates/iso'
import { roundOre } from '@/lib/money'
import { PINNED_JURISDICTION, resolveAccountRole } from '@/lib/bookkeeping/account-roles'
import {
  calculatePeriodDates,
  formatPeriodLabel,
  loadVatDeclarationLedger,
  resolvePeriodDates,
  vatClearingAccounts,
  type VatDeclarationLedger,
} from './vat-declaration'
import { buildFiledAmounts } from './vat-manual-filing'
import {
  FILED_ROUNDING,
  carriedIntoPeriod,
  clearedByAccount,
  lateSettlementLookupEnd,
  nearFiled,
  settlementsDated,
  settlesPeriod,
  summarizeSettlements,
  vatBalancesCarriedInto,
  type PeriodVatBalance,
  type SettlementVerifikat,
} from './vat-settlement-match'
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
 * A settlement entry already booked (or drafted) for the period: inside it,
 * tagged (source_type 'vat_settlement') or detected by shape (a manual
 * momsomföring clearing 26xx to 2650/1650 or straight to the skattekonto, see
 * fetchVatAccountTotals in vat-declaration.ts), unless its amounts make it
 * the previous period's or the settlement of a balance carried in from before
 * the period (carriedBalanceSettlements); or dated after it, tagged with this
 * period's text or tied to it by amount (late_settlement).
 */
export interface VatSettlementExistingEntry {
  id: string
  status: string
  entry_date: string
  source_type: string | null
  voucher_series: string | null
  voucher_number: number | null
  /**
   * Set on a posted momsredovisning dated after the period that settles it by
   * amount: it clears exactly the period's VAT balances (`cleared`) and moves
   * the filed net (`net`) to 2650/1650 or straight to the skattekonto (`via`).
   */
  late_settlement?: Pick<SettlementVerifikat, 'cleared' | 'net' | 'via'>
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
 * The momsredovisning lines of a period's ledger: every 26xx account the
 * declaration reads cleared at exact öre, the whole-krona filed net on
 * 2650/1650, the öre gap on 3740. Pure.
 */
function settlementLines(ledger: Pick<VatDeclarationLedger, 'totals' | 'dynamicVatAccounts' | 'rutor'>): {
  lines: VatSettlementProposalLine[]
  filed_net: number
  rounding_amount: number
} {
  const { net: filedNet } = buildFiledAmounts(ledger.rutor)

  // Clear every 26xx account the declaration reads from, at exact öre, so the
  // accounts land on zero for the period. A positive (credit) balance clears
  // with a debit and vice versa: the same formula handles credit-note-heavy
  // periods where an account sits on the "wrong" side. The company's own
  // momsruta accounts are cleared too: their balance is in the filed net, and
  // leaving them out would put the whole amount on 3740.
  const lines: VatSettlementProposalLine[] = []
  for (const account of vatClearingAccounts(ledger.dynamicVatAccounts)) {
    const t = ledger.totals.get(account)
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

  return { lines, filed_net: filedNet, rounding_amount: roundingAmount }
}

const NET_LINE_ACCOUNTS = new Set([VAT_SETTLEMENT_ACCOUNT, VAT_REFUND_ACCOUNT, VAT_ROUNDING_ACCOUNT])

/**
 * The period's VAT as the proposal clears it: its clearing lines, debit minus
 * credit (the net that should reach 2650/1650, at exact öre), and ruta 49 as
 * filed. What a momsredovisning is compared with to tell which period it
 * settles (vat-settlement-match.ts).
 */
export function proposalBalance(proposal: Pick<VatSettlementProposal, 'lines' | 'filed_net'>): PeriodVatBalance {
  let cleared = 0
  for (const line of proposal.lines) {
    if (!NET_LINE_ACCOUNTS.has(line.account_number)) cleared += roundOre(line.debit_amount - line.credit_amount)
  }
  return { cleared: roundOre(cleared), filed_net: proposal.filed_net }
}

interface PeriodRange {
  type: VatPeriodType
  start: string
  end: string
}

/**
 * The momsperiod of the same cadence that holds a date: its calendar month or
 * quarter, or for helårsmoms the räkenskapsår (the fiscal period covering
 * it, the calendar year when none does, as resolvePeriodDates falls back).
 */
async function vatPeriodHolding(
  supabase: SupabaseClient,
  companyId: string,
  type: VatPeriodType,
  date: string,
): Promise<PeriodRange> {
  if (type === 'yearly') {
    const { data, error } = await supabase
      .from('fiscal_periods')
      .select('period_start, period_end')
      .eq('company_id', companyId)
      .lte('period_start', date)
      .gte('period_end', date)
      .limit(1)
      .maybeSingle()
    if (error) throw new Error(`fiscal period lookup failed: ${error.message}`)
    const fp = data as { period_start: string; period_end: string } | null
    if (fp?.period_start && fp?.period_end) return { type, start: fp.period_start, end: fp.period_end }
  }
  const year = Number(date.slice(0, 4))
  const month = Number(date.slice(5, 7))
  const period = type === 'monthly' ? month : type === 'quarterly' ? Math.ceil(month / 3) : 1
  return { type, ...calculatePeriodDates(type, year, period) }
}

/**
 * Reads the VAT balances of other periods while one proposal is built, each
 * period's ledger once. The proposal's own ledger seeds it.
 */
function periodBalances(
  supabase: SupabaseClient,
  companyId: string,
  own: { period: PeriodRange; ledger: VatDeclarationLedger },
) {
  const keyOf = (period: PeriodRange) => `${period.start}:${period.end}`
  const ledgers = new Map<string, Promise<VatDeclarationLedger>>([[keyOf(own.period), Promise.resolve(own.ledger)]])
  const ledgerOf = (period: PeriodRange): Promise<VatDeclarationLedger> => {
    const key = keyOf(period)
    if (!ledgers.has(key)) ledgers.set(key, loadVatDeclarationLedger(supabase, companyId, period.start, period.end))
    return ledgers.get(key)!
  }
  const balances = new Map<string, Promise<PeriodVatBalance>>()
  const carried = new Map<string, Promise<number>>()
  return {
    balance(period: PeriodRange): Promise<PeriodVatBalance> {
      const key = keyOf(period)
      if (!balances.has(key)) {
        balances.set(key, ledgerOf(period).then((ledger) => proposalBalance(settlementLines(ledger))))
      }
      return balances.get(key)!
    },
    carried(period: PeriodRange): Promise<number> {
      const key = keyOf(period)
      if (!carried.has(key)) {
        carried.set(key, ledgerOf(period).then((ledger) => carriedIntoPeriod(supabase, companyId, ledger)))
      }
      return carried.get(key)!
    },
  }
}

type Balances = ReturnType<typeof periodBalances>

/**
 * The posted momsredovisningar dated inside the period that settle the period
 * before it instead. One booked on the filing or debit day lies inside the
 * next period (crm#1316), and its shape alone would count it as this period's
 * own, offering this period as already booked. It is the previous period's
 * when it clears neither this period's balances nor what an opening balance
 * the declaration counts in it (part of this period's balances, see
 * carriedIntoPeriod), but exactly the previous period's, and nothing dated in
 * the previous period settles that one. An IB the declaration leaves out is
 * no part of them (crm#1333), so clearing it settles the earlier period.
 * Anything less certain stays this period's, so it gates booking as before.
 */
async function previousPeriodSettlements(
  supabase: SupabaseClient,
  companyId: string,
  period: PeriodRange,
  balance: PeriodVatBalance,
  candidateIds: string[],
  balances: Balances,
): Promise<Set<string>> {
  const earlier = new Set<string>()
  if (candidateIds.length === 0) return earlier
  const suspects = (await summarizeSettlements(supabase, companyId, candidateIds)).filter(
    (s) => !nearFiled(s.cleared, balance.cleared),
  )
  if (suspects.length === 0) return earlier
  const previous = await vatPeriodHolding(supabase, companyId, period.type, addDaysIso(period.start, -1))
  const [previousBalance, carried, previousOwn] = await Promise.all([
    balances.balance(previous),
    balances.carried(period),
    settlementsDated(supabase, companyId, previous.start, previous.end),
  ])
  if (previousOwn.some((s) => settlesPeriod(s, previousBalance))) return earlier
  for (const s of suspects) {
    if (!settlesPeriod(s, previousBalance)) continue
    if (Math.abs(carried) >= FILED_ROUNDING && nearFiled(s.cleared, carried)) continue
    earlier.add(s.journal_entry_id)
  }
  return earlier
}

/**
 * The posted momsredovisningar recognised by shape and dated inside the
 * period that settle a balance carried in from before it, not the period's
 * own VAT (crm#1755). A corrected declaration for an older period is often
 * settled as its difference only, a 26xx account straight against the
 * skattekonto, on the day Skatteverket debits it: inside whatever period that
 * day falls in, where its shape alone made it the period's own momsredovisning
 * and refused booking the period.
 *
 * It is not this period's when it clears neither the period's net nor, on any
 * moms account it moves, the period's balance in full, and on every one of
 * them exactly what the books carried into the period (vatBalancesCarriedInto),
 * less what the earlier periods' momsredovisningar dated inside it cleared.
 * Nothing of the period's own VAT is cleared then, and the proposal clears
 * only that. The period's own momsredovisning gates as before (#984): split
 * in two verifikat (output and input VAT apart) each clears its accounts in
 * full, and one that no longer clears any account in full (a verifikat added
 * after it, a quarter settled month by month) moves the period's VAT, not
 * what was carried in. An opening balance the period's declaration counts
 * is both the period's and carried in, so nothing is set apart then.
 * Anything less certain stays this period's.
 */
async function carriedBalanceSettlements(
  supabase: SupabaseClient,
  companyId: string,
  period: PeriodRange,
  ledger: Pick<VatDeclarationLedger, 'countedOpeningBalances'>,
  lines: VatSettlementProposalLine[],
  balance: PeriodVatBalance,
  candidateIds: string[],
  earlier: ReadonlySet<string>,
): Promise<Set<string>> {
  const carriedOver = new Set<string>()
  if (candidateIds.length === 0) return carriedOver
  if (ledger.countedOpeningBalances.some((e) => e.status === 'posted')) return carriedOver
  const own = new Map<string, number>()
  for (const line of lines) {
    if (!NET_LINE_ACCOUNTS.has(line.account_number)) own.set(line.account_number, roundOre(line.debit_amount - line.credit_amount))
  }
  const moved = await clearedByAccount(supabase, companyId, [...candidateIds, ...earlier])
  const suspects = candidateIds.filter((id) => {
    const accounts = moved.get(id)
    if (!accounts || accounts.size === 0) return false
    const cleared = roundOre([...accounts.values()].reduce((sum, amount) => sum + amount, 0))
    if (nearFiled(cleared, balance.cleared)) return false
    return ![...accounts].some(([account, amount]) => nearFiled(amount, own.get(account) ?? 0))
  })
  if (suspects.length === 0) return carriedOver
  const carried = await vatBalancesCarriedInto(supabase, companyId, period.start)
  if (!carried) return carriedOver
  for (const id of earlier) {
    for (const [account, amount] of moved.get(id) ?? []) carried.set(account, roundOre((carried.get(account) ?? 0) - amount))
  }
  for (const id of suspects) {
    const clearsCarried = [...moved.get(id)!].every(([account, amount]) => {
      const left = carried.get(account) ?? 0
      return Math.abs(left) >= FILED_ROUNDING && nearFiled(amount, left)
    })
    if (clearsCarried) carriedOver.add(id)
  }
  return carriedOver
}

/**
 * The momsredovisning dated after the period that settles it, if one does
 * (crm#1316): a verifikat dated up to LATE_LOOKAHEAD_DAYS after the period (or
 * the first open day the proposal itself moved to) that clears exactly the
 * period's balances and moves the filed net, to 2650/1650 or straight to the
 * skattekonto. It is not this period's when it is the own momsredovisning of
 * the period it is dated in (it clears that period's activity, an opening
 * balance its declaration counts aside) or of a period between the two: equal VAT
 * in two periods (a fixed rent, a monthly subscription) is common, and the
 * latest period it fits is the one it was booked for.
 */
async function lateSettlement(
  supabase: SupabaseClient,
  companyId: string,
  period: PeriodRange,
  balance: PeriodVatBalance,
  proposedEntryDate: string,
  balances: Balances,
): Promise<SettlementVerifikat | null> {
  if (Math.abs(balance.filed_net) < FILED_ROUNDING) return null
  const candidates = await settlementsDated(
    supabase,
    companyId,
    addDaysIso(period.end, 1),
    lateSettlementLookupEnd(period.end, proposedEntryDate),
  )
  for (const candidate of candidates) {
    if (!settlesPeriod(candidate, balance)) continue
    const datedIn = await vatPeriodHolding(supabase, companyId, period.type, candidate.entry_date)
    const [own, carried] = await Promise.all([balances.balance(datedIn), balances.carried(datedIn)])
    if (nearFiled(candidate.cleared, roundOre(own.cleared - carried))) continue
    let fitsLater = false
    for (
      let between = await vatPeriodHolding(supabase, companyId, period.type, addDaysIso(datedIn.start, -1));
      between.end > period.end;
      between = await vatPeriodHolding(supabase, companyId, period.type, addDaysIso(between.start, -1))
    ) {
      if (settlesPeriod(candidate, await balances.balance(between))) {
        fitsLater = true
        break
      }
    }
    if (!fitsLater) return candidate
  }
  return null
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

  const [ledger, entryDate] = await Promise.all([
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

  const { lines, filed_net: filedNet, rounding_amount: roundingAmount } = settlementLines(ledger)
  const balance = proposalBalance({ lines, filed_net: filedNet })
  const range: PeriodRange = { type: periodType, start, end }
  const balances = periodBalances(supabase, companyId, { period: range, ledger })

  // Shape-detected settlements (manual momsomföring, SIE imports) gate the
  // booking button exactly like tagged ones (#984): the proposal re-clears the
  // FULL period, so booking on top of a manual settlement would corrupt the
  // 26xx balances. Stornos are the CANCELLATION of a settlement and must not
  // gate, or annullera could never re-enable the button. Only posted entries
  // gate: the shape of an unposted draft has no balance effect.
  const shapedExisting = ledger.settlementShapedEntries.filter(
    (e) => e.status === 'posted' && e.source_type !== 'storno'
  )
  const taggedExisting = ((existingResult.data ?? []) as Array<VatSettlementExistingEntry & { description?: string | null }>)
    .filter((e) => e.entry_date <= end || e.description === description)

  // A posted one dated inside the period without this period's text may be
  // the previous period's momsredovisning, booked on its filing or debit day.
  const earlier = await previousPeriodSettlements(
    supabase,
    companyId,
    range,
    balance,
    [
      ...shapedExisting.map((e) => e.id),
      ...taggedExisting.filter((e) => e.status === 'posted' && e.description !== description).map((e) => e.id),
    ],
    balances,
  )

  // One recognised by shape alone may settle a balance carried in from
  // before the period instead, a corrected older declaration's difference.
  const carriedOver = await carriedBalanceSettlements(
    supabase,
    companyId,
    range,
    ledger,
    lines,
    balance,
    shapedExisting.filter((e) => !earlier.has(e.id)).map((e) => e.id),
    earlier,
  )

  const existing: VatSettlementExistingEntry[] = [
    ...taggedExisting.map(({ description: _description, ...entry }) => entry),
    ...shapedExisting,
  ].filter((e) => !earlier.has(e.id) && !carriedOver.has(e.id))

  // No posted momsredovisning for the period yet: one dated after it may
  // settle it by amount, and booking another would clear its accounts twice.
  if (lines.length > 0 && !findPostedVatSettlement(existing)) {
    const late = await lateSettlement(supabase, companyId, range, balance, entryDate.entry_date, balances)
    if (late) {
      existing.push({
        id: late.journal_entry_id,
        status: late.status,
        entry_date: late.entry_date,
        source_type: late.source_type,
        voucher_series: late.voucher_series,
        voucher_number: late.voucher_number,
        late_settlement: { cleared: late.cleared, net: late.net, via: late.via },
      })
    }
  }

  const existingEntries = existing
    .sort((a, b) => (a.entry_date < b.entry_date ? 1 : a.entry_date > b.entry_date ? -1 : 0))
    .slice(0, 5)

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
