/**
 * Moms that Skatteverket has already charged or paid out but that still sits
 * on the redovisningskonto för moms (2650) or the momsfordran (1650).
 *
 * A momsredovisning moves a period's net onto 2650 (to pay) or 1650 (to get
 * back); Skatteverket debits or pays it on the period's deadline, at the
 * latest about 130 days after the period ends (a yearly filer's 12 May). So
 * on any date the two accounts may hold only what was moved onto them in the
 * last 150 days. Whatever exceeds that is older moms whose charge or payout
 * was never booked against the account: the 2026-10-26 forensic sweep found
 * 176 active companies with such moms built up while they booked in Accounted,
 * with Skatteverket's moms rows left unbooked or ignored, and nothing checked
 * that 2650 clears (the VAT settlement check stops at 26xx into 2650).
 *
 * Deadline-free on purpose. A company that dates the momsredovisning on
 * Skatteverket's charge day, or clears 26xx straight against 1630, never
 * carries anything here and is never flagged. The balance is taken oldest
 * first: every credit to 2650 (debit to 1650) inside the window counts as
 * recent, whatever booked it, so one payment covering two periods, a storno
 * pair or a migrated opening balance never reads as drift.
 *
 * The balance is the huvudbok's: the latest ingående balans on the account
 * plus what is booked after it (findOpeningBalanceFloor, the floor every
 * balance reader stands on). The sum over all history this file made first
 * counted a year once more for each ingående balans, so from the day an IB
 * was 150 days old the finding named more than the account held (crm#1924).
 * An ingående balans restates what stood on the account; it moves nothing
 * onto it. So when the window reaches back past it, the verifikat before it
 * say how much of it is recent, and only an IB with nothing on the account
 * before it (a balance migrated without its verifikat) counts as moved on at
 * its own date.
 *
 * What was already stale on the day of the last imported verifikat is the
 * previous system's and reported apart (inherited): the finding is what
 * built up since.
 *
 * The finding names the verifikat it comes from, so it can be laid beside
 * the huvudbok: the latest ones that moved moms onto the account before the
 * window, as far back as the amount reaches, because payments are counted
 * against the oldest moms first. The ledger records no allocation of a
 * payment to a period, so this is the check's own order, said in its hint.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { roundOre } from '@/lib/money'
import { addDaysIso } from '@/lib/dates/iso'
import { fetchEntriesWithAccountLines } from '@/lib/bookkeeping/entry-lines'
import { findOpeningBalanceFloor, LEDGER_BALANCE_STATUSES } from '@/lib/bookkeeping/ledger-balance'
import { formatVoucher } from '@/lib/bookkeeping/voucher-series-resolver'
import { VAT_REFUND_ACCOUNT, VAT_SETTLEMENT_ACCOUNT } from '@/lib/reports/vat-settlement'

/** Days a period's net may lie on 2650/1650 before Skatteverket has charged or paid it. */
export const SETTLEMENT_WINDOW_DAYS = 150

/** Before any verifikat: the read runs over all history, the floors decide what counts. */
const LEDGER_START = '1900-01-01'

/** What one verifikat books on 2650 or 1650: its lines on the account, summed. */
export interface SettlementEntryRow {
  account_number: string
  entry_date: string
  debit: number | string
  credit: number | string
  journal_entry_id: string
  voucher_label: string
  /** An ingående balans verifikat (source_type opening_balance). */
  opening_balance: boolean
  /** Stornerad, or the storno of another verifikat: the pair cancels and is never named as a source. */
  cancelled: boolean
}

/** The latest ingående balans on an account on or before a date (findOpeningBalanceFloor). */
export interface SettlementFloor {
  date: string
  entryIds: readonly string[]
}

/** The floor per account number on the two dates the drift is taken on. */
export interface SettlementFloors {
  asOf: { [account: string]: SettlementFloor | null | undefined }
  cutover: { [account: string]: SettlementFloor | null | undefined }
}

/** One verifikat the drift comes from. */
export interface SettlementDriftEntry {
  journal_entry_id: string
  voucher_label: string
  entry_date: string
  /** What the verifikat moved onto the account. */
  amount: number
  /** The part of it that is in the drift, payments counted against the oldest moms first. */
  counted: number
  /** An ingående balans: the moms came in with the year's opening balance, so its verifikat are in the year before. */
  opening_balance: boolean
}

/** One account on as_of: the balance, how old it is and where the old part comes from. */
export interface SettlementAccountAging {
  account_number: string
  /** The huvudbok balance on as_of: moms att betala on 2650, att få tillbaka on 1650 (negative when the account stands the other way). */
  balance: number
  /** The ingående balans the balance is counted from, null when the account never had one. */
  counted_from: string | null
  /** First day of the window: what was moved onto the account from this day on is recent. */
  window_start: string
  /** Moved onto the account inside the window. */
  recent: number
  /** The balance less the recent part, never below zero. */
  older: number
  /** What was already older than the window at the last imported verifikat. */
  inherited: number
  /** older less inherited: the finding. */
  drift: number
  /** The verifikat the drift comes from, newest first. */
  entries: SettlementDriftEntry[]
  /** The part of the drift no verifikat on the account accounts for (an ingående balans that differs from the verifikat before it). */
  unattributed: number
}

export interface SettlementAccountDrift {
  as_of: string
  /** 2650: moms att betala. */
  payable: SettlementAccountAging
  /** 1650: moms att få tillbaka. */
  receivable: SettlementAccountAging
}

/** What a verifikat moves onto its account (credit on 2650, debit on 1650) or takes off it, net. */
function movement(row: SettlementEntryRow): { on: number; off: number } {
  const debit = Number(row.debit) || 0
  const credit = Number(row.credit) || 0
  const net = row.account_number === VAT_SETTLEMENT_ACCOUNT ? credit - debit : debit - credit
  return net >= 0 ? { on: net, off: 0 } : { on: 0, off: -net }
}

function windowStartOn(date: string): string {
  return addDaysIso(date, -(SETTLEMENT_WINDOW_DAYS - 1))
}

/** One account on `date`: its balance from the floor, and the part not moved onto it in the window before. */
function ageOn(
  rows: readonly SettlementEntryRow[],
  date: string,
  floor: SettlementFloor | null,
): { balance: number; recent: number; older: number } {
  const windowStart = windowStartOn(date)
  const floorDate = floor?.date ?? null
  const floorEntries = new Set(floor?.entryIds ?? [])
  // The verifikat before an ingående balans say how old it is; with none, it counts from its own date.
  const floorRestatesRows = floorDate !== null && rows.some((row) => row.entry_date < floorDate)
  let balance = 0
  let recent = 0
  for (const row of rows) {
    if (row.entry_date > date) continue
    const { on, off } = movement(row)
    if (floorDate === null || row.entry_date >= floorDate) balance += on - off
    const restated = floorRestatesRows && floorEntries.has(row.journal_entry_id)
    if (row.entry_date >= windowStart && !restated) recent += on
  }
  balance = roundOre(balance)
  recent = roundOre(recent)
  return { balance, recent, older: Math.max(0, roundOre(balance - recent)) }
}

/**
 * The verifikat `amount` of older moms comes from: the latest ones that moved
 * moms onto the account before the window, newest first, until the amount is
 * reached. An ingående balans ends the walk, since nothing before it is told
 * apart from it, and a floor that lies before the window bounds it: what the
 * balance is counted from is as far back as its sources go.
 */
function sourcesOf(
  rows: readonly SettlementEntryRow[],
  date: string,
  amount: number,
  floor: SettlementFloor | null,
): { entries: SettlementDriftEntry[]; unattributed: number } {
  const windowStart = windowStartOn(date)
  const from = floor && floor.date < windowStart ? floor.date : null
  const older = rows
    .filter((row) => row.entry_date < windowStart && (from === null || row.entry_date >= from))
    .filter((row) => !row.cancelled && movement(row).on > 0)
    .sort((a, b) => {
      if (a.entry_date !== b.entry_date) return a.entry_date < b.entry_date ? 1 : -1
      if (a.opening_balance !== b.opening_balance) return a.opening_balance ? 1 : -1
      return b.voucher_label.localeCompare(a.voucher_label, 'sv', { numeric: true })
    })
  const entries: SettlementDriftEntry[] = []
  let remaining = amount
  for (const row of older) {
    if (remaining <= 0) break
    const moved = roundOre(movement(row).on)
    const counted = Math.min(moved, remaining)
    entries.push({
      journal_entry_id: row.journal_entry_id,
      voucher_label: row.voucher_label,
      entry_date: row.entry_date,
      amount: moved,
      counted,
      opening_balance: row.opening_balance,
    })
    remaining = roundOre(remaining - counted)
    if (row.opening_balance) break
  }
  return { entries, unattributed: Math.max(0, remaining) }
}

function agingOf(
  rows: readonly SettlementEntryRow[],
  account: string,
  asOf: string,
  cutover: string | null,
  floors: SettlementFloors,
): SettlementAccountAging {
  const own = rows.filter((row) => row.account_number === account)
  const floor = floors.asOf[account] ?? null
  const now = ageOn(own, asOf, floor)
  const inherited = cutover && cutover < asOf ? ageOn(own, cutover, floors.cutover[account] ?? null).older : 0
  const drift = Math.max(0, roundOre(now.older - inherited))
  return {
    account_number: account,
    balance: now.balance,
    counted_from: floor?.date ?? null,
    window_start: windowStartOn(asOf),
    recent: now.recent,
    older: now.older,
    inherited,
    drift,
    ...sourcesOf(own, asOf, drift, floor),
  }
}

/**
 * Pure core: the drift on `asOf`, less what was already stale at `cutover`
 * (the last imported verifikat). `rows` is every verifikat on the two
 * accounts through `asOf`; `floors` the latest ingående balans per account
 * on each of the two dates (none: the balance runs over all history).
 */
export function settlementAccountDrift(
  rows: readonly SettlementEntryRow[],
  asOf: string,
  cutover: string | null,
  floors: SettlementFloors = { asOf: {}, cutover: {} },
): SettlementAccountDrift {
  return {
    as_of: asOf,
    payable: agingOf(rows, VAT_SETTLEMENT_ACCOUNT, asOf, cutover, floors),
    receivable: agingOf(rows, VAT_REFUND_ACCOUNT, asOf, cutover, floors),
  }
}

export async function computeSettlementAccountDrift(
  supabase: SupabaseClient,
  companyId: string,
  asOf: string,
): Promise<SettlementAccountDrift> {
  const accounts = [VAT_SETTLEMENT_ACCOUNT, VAT_REFUND_ACCOUNT]
  const [entries, lastImport, floorsAsOf] = await Promise.all([
    // A handful of verifikat per momsperiod, read with their lines on the two accounts in one call.
    fetchEntriesWithAccountLines(supabase, companyId, {
      start: LEDGER_START,
      end: asOf,
      accounts,
      statuses: LEDGER_BALANCE_STATUSES,
      allLines: false,
    }),
    supabase
      .from('journal_entries')
      .select('entry_date')
      .eq('company_id', companyId)
      .eq('source_type', 'import')
      .in('status', ['posted', 'reversed'])
      .order('entry_date', { ascending: false })
      .limit(1)
      .maybeSingle(),
    Promise.all(accounts.map((account) => findOpeningBalanceFloor(supabase, companyId, account, asOf))),
  ])
  if (!entries) throw new Error('get_entries_with_account_lines is not available')
  if (lastImport.error) throw new Error(`last imported verifikat: ${lastImport.error.message}`)
  const cutover = (lastImport.data as { entry_date: string } | null)?.entry_date ?? null

  // The floor on the cutover is the one on as_of unless an ingående balans lies between the two days.
  const floorsCutover = await Promise.all(
    accounts.map((account, i) => {
      const floor = floorsAsOf[i]
      if (!cutover || cutover >= asOf || !floor || floor.date <= cutover) return floor
      return findOpeningBalanceFloor(supabase, companyId, account, cutover)
    }),
  )

  const rows: SettlementEntryRow[] = entries.flatMap((entry) =>
    accounts.flatMap((account) => {
      const lines = entry.lines.filter((line) => line.account_number === account)
      if (lines.length === 0) return []
      return [{
        account_number: account,
        entry_date: entry.entry_date,
        debit: roundOre(lines.reduce((sum, line) => sum + (Number(line.debit_amount) || 0), 0)),
        credit: roundOre(lines.reduce((sum, line) => sum + (Number(line.credit_amount) || 0), 0)),
        journal_entry_id: entry.id,
        voucher_label: formatVoucher(entry, { separator: '-' }),
        opening_balance: entry.source_type === 'opening_balance',
        cancelled: entry.status === 'reversed' || entry.reverses_id !== null,
      }]
    }),
  )
  const byAccount = (floors: ReadonlyArray<SettlementFloor | null>) =>
    Object.fromEntries(accounts.map((account, i) => [account, floors[i]]))
  return settlementAccountDrift(rows, asOf, cutover, {
    asOf: byAccount(floorsAsOf),
    cutover: byAccount(floorsCutover),
  })
}
