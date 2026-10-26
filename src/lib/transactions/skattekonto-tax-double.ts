/**
 * Booking-time guard, skattekonto half (issue #50): a bank line booked
 * straight to a tax account when the skattekonto has already booked the
 * same tax.
 *
 * A payment to Skatteverket is not earmarked (SFL 62 kap. 11 §), so the bank
 * line only ever touches the skattekonto account (1630, or 2012 for an
 * enskild firma that runs it there) and the liabilities (2650, 2710, 2731,
 * 2510 ...) are cleared from the skattekontoutdrag (.claude/skills/
 * swedish-daily-bookkeeping/references/skattekonto-and-owner.md §1.1,
 * §1.3). A company that books the skattekonto rows (D 2650 / K 1630) and
 * then categorises the bank payment as D 2650 / K 1930 clears the moms
 * twice: 2650 ends up overpaid by the amount and 1630 shows a debt that does
 * not exist (felaktig bokföring, BFL 5 kap. 1-2 §). The forward order (bank
 * first, skattekonto row second) is refused by the skattekonto booking
 * guard (LEDGER_DIRECT_EXISTS, extensions/general/skatteverket/lib/
 * skattekonto-direct.ts); this is its mirror on the bank side.
 *
 * The rule, the mirror of that guard: the booking about to be made puts a
 * tax account against the cash leg (money out: a debit on it; money in: a
 * credit) and has no line on the skattekonto account, and a live verifikat
 * of the same calendar month moves that tax account by exactly the same
 * amount on the same side together with the skattekonto account. A fixed
 * monthly amount (F-skatt, the same salary's AGI) recurs every month, so the
 * neighbouring month's verifikat never counts. Excluded: storno entries and
 * reversed originals, the opening balance, and a verifikat that another one
 * of the month mirrors exactly on both accounts (an imported annulment
 * pair). Measured on production before it shipped: no bank booking in the
 * reverse order would have been warned, and the six same-amount matches the
 * rule saw without its direction test (salary payouts crediting 2710 against
 * a storno of a skattekonto booking) are all excluded.
 *
 * Like every half of the booking guard it is a warning, never a block: the
 * refusal is TRANSACTION_BOOK_POSSIBLE_DUPLICATE with the candidate marked
 * `skattekonto`, and force bound to it books anyway. The fix it points at is
 * different from a twin's: book the bank line against the skattekonto
 * account instead of linking it to the verifikat found, which has no bank
 * leg.
 *
 * Only a door that knows the kontering can ask: it passes `counter_lines`.
 * The manual booking (/api/transactions/[id]/book) knows them up front and
 * asks detectKonteringBookingDuplicate; categorize knows them only after its
 * mapping and asks runSkattekontoTaxGuard (lib/transactions/
 * booking-duplicate-guard.ts) there. Bulk book does not ask yet. Silent
 * (null) without counter lines, without a direct tax line, and on any read
 * error: a failed check never blocks.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchEntryLines, type EntryLinesQuery } from '@/lib/bookkeeping/entry-lines'
import { roundOre } from '@/lib/money'
import { createLogger } from '@/lib/logger'
import { formatVoucher } from '@/lib/bookkeeping/voucher-series-resolver'
import { SKATTEKONTO_LEDGER_ACCOUNT_SET, SKATTEKONTO_TAX_ACCOUNTS } from '@/lib/transactions/skattekonto-tax-accounts'
import {
  detectBookingDuplicate,
  type BookedDuplicateCandidate,
  type BookingDuplicateExclusions,
  type BookingTarget,
} from '@/lib/transactions/booking-duplicate-detection'

const log = createLogger('transactions/skattekonto-tax-double')

/** One line of the kontering about to be booked, ledger sign (debit positive). */
export interface BookingCounterLine {
  account_number: string
  net: number
}

/** A booking target that also says what the verifikat would book. */
export interface KonteringBookingTarget extends BookingTarget {
  /** Every line of the verifikat about to be booked, the cash leg included. */
  counter_lines?: ReadonlyArray<BookingCounterLine>
}

/** What the skattekonto half found (kr, ledger sign of the tax line). */
export interface SkattekontoTaxDoubleFacts {
  /** The tax account the booking would clear a second time. */
  tax_account: string
  /** The skattekonto account the verifikat found moves (1630 or 2012). */
  skattekonto_account: string
}

export type SkattekontoTaxDoubleCandidate = BookedDuplicateCandidate & { skattekonto: SkattekontoTaxDoubleFacts }

export function isSkattekontoTaxDouble(
  candidate: BookedDuplicateCandidate | null | undefined,
): candidate is SkattekontoTaxDoubleCandidate {
  return !!candidate && typeof (candidate as { skattekonto?: unknown }).skattekonto === 'object' &&
    (candidate as { skattekonto?: unknown }).skattekonto !== null
}

const toOre = (n: number | string | null | undefined) => Math.round(Number(n || 0) * 100)

/**
 * Pure: the tax lines of a kontering that clear a tax liability straight
 * from the cash leg, netted per account. Empty when the kontering has a
 * line on the skattekonto account (it goes through it), for a zero amount,
 * or when no tax line sits on the cash leg's other side (a salary payout
 * crediting 2710 withholds tax, it pays none).
 */
export function directTaxCounterLines(
  cashAmount: number,
  lines: ReadonlyArray<BookingCounterLine>,
): BookingCounterLine[] {
  const cashSign = Math.sign(Number(cashAmount))
  if (!cashSign) return []
  if (lines.some((l) => SKATTEKONTO_LEDGER_ACCOUNT_SET.has(l.account_number))) return []
  const net = new Map<string, number>()
  for (const l of lines) {
    if (!SKATTEKONTO_TAX_ACCOUNTS.has(l.account_number)) continue
    net.set(l.account_number, (net.get(l.account_number) ?? 0) + toOre(l.net))
  }
  return [...net.entries()]
    .filter(([, ore]) => ore !== 0 && Math.sign(ore) === -cashSign)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([account_number, ore]) => ({ account_number, net: ore / 100 }))
}

/** One line on a tax or skattekonto account of a verifikat in the month. */
export interface MonthEntryLine {
  account_number: string
  debit_amount: number | string
  credit_amount: number | string
  journal_entry: {
    id: string
    entry_date: string
    description: string | null
    voucher_series: string | null
    voucher_number: number | null
    source_type: string | null
    reverses_id: string | null
  }
}

/** First and last day of the calendar month of an ISO date, or null for a malformed date. */
export function calendarMonthOf(date: string): { from: string; to: string } | null {
  const match = /^(\d{4})-(\d{2})-\d{2}$/.exec(date)
  if (!match) return null
  const year = Number(match[1])
  const month = Number(match[2])
  if (month < 1 || month > 12) return null
  const last = new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10)
  return { from: `${match[1]}-${match[2]}-01`, to: last }
}

/**
 * Pure: the verifikat among `lines` that already clears one of `probes`
 * through the skattekonto (see the module comment), nearest the booking's
 * date first, then lowest id, so a force re-detect returns the candidate the
 * user reviewed.
 */
export function pickSkattekontoTaxTwin(
  bookingDate: string,
  probes: ReadonlyArray<BookingCounterLine>,
  lines: ReadonlyArray<MonthEntryLine>,
  excludeEntryIds: ReadonlySet<string> = new Set(),
): { entry: MonthEntryLine['journal_entry']; probe: BookingCounterLine; skattekontoAccount: string } | null {
  type Seen = { entry: MonthEntryLine['journal_entry']; net: Map<string, number> }
  const byEntry = new Map<string, Seen>()
  for (const line of lines) {
    const e = line.journal_entry
    if (!e || excludeEntryIds.has(e.id) || e.reverses_id || e.source_type === 'opening_balance') continue
    let seen = byEntry.get(e.id)
    if (!seen) {
      seen = { entry: e, net: new Map() }
      byEntry.set(e.id, seen)
    }
    seen.net.set(line.account_number, (seen.net.get(line.account_number) ?? 0) + toOre(line.debit_amount) - toOre(line.credit_amount))
  }
  const skattekontoOf = (s: Seen) => [...SKATTEKONTO_LEDGER_ACCOUNT_SET].find((a) => (s.net.get(a) ?? 0) !== 0) ?? null
  const viaSkattekonto = [...byEntry.values()].filter((s) => skattekontoOf(s) !== null)

  const day = (iso: string) => Date.parse(`${iso}T00:00:00Z`)
  const found: Array<{ seen: Seen; probe: BookingCounterLine; account: string }> = []
  for (const probe of probes) {
    const ore = toOre(probe.net)
    for (const s of viaSkattekonto) {
      if ((s.net.get(probe.account_number) ?? 0) !== ore) continue
      const account = skattekontoOf(s)!
      const sk = s.net.get(account) ?? 0
      // An annulment pair: another verifikat of the month undoes this one on
      // both accounts, so neither books the tax.
      const annulled = viaSkattekonto.some(
        (o) => o !== s && (o.net.get(probe.account_number) ?? 0) === -ore && (o.net.get(account) ?? 0) === -sk,
      )
      if (!annulled) found.push({ seen: s, probe, account })
    }
  }
  if (found.length === 0) return null
  const target = day(bookingDate)
  found.sort((a, b) => {
    const da = Math.abs(day(a.seen.entry.entry_date) - target)
    const db = Math.abs(day(b.seen.entry.entry_date) - target)
    if (da !== db) return da - db
    if (a.seen.entry.id !== b.seen.entry.id) return a.seen.entry.id.localeCompare(b.seen.entry.id)
    return a.probe.account_number.localeCompare(b.probe.account_number)
  })
  const best = found[0]
  return { entry: best.seen.entry, probe: best.probe, skattekontoAccount: best.account }
}

/** The skattekonto half (see the module comment). Null when it does not fire or a read fails. */
export async function detectSkattekontoTaxDouble(
  supabase: SupabaseClient,
  companyId: string,
  target: KonteringBookingTarget,
  opts?: BookingDuplicateExclusions,
): Promise<SkattekontoTaxDoubleCandidate | null> {
  try {
    if (!target.counter_lines?.length) return null
    const probes = directTaxCounterLines(Number(target.amount), target.counter_lines)
    if (probes.length === 0) return null
    const month = calendarMonthOf(target.date)
    if (!month) return null
    const accounts = [...probes.map((p) => p.account_number), ...SKATTEKONTO_LEDGER_ACCOUNT_SET]

    const lines = await fetchEntryLines<MonthEntryLine>({
      supabase,
      entryColumns: 'id, entry_date, description, voucher_series, voucher_number, source_type, reverses_id',
      lineColumns: 'account_number, debit_amount, credit_amount',
      filterEntries: (q: EntryLinesQuery) =>
        q
          .eq('company_id', companyId)
          .gte('entry_date', month.from)
          .lte('entry_date', month.to)
          .in('status', ['draft', 'posted']),
      filterLines: (q: EntryLinesQuery) => q.in('account_number', accounts),
      attachEntriesAs: 'journal_entry',
    })
    const pick = pickSkattekontoTaxTwin(target.date, probes, lines, new Set(opts?.excludeJournalEntryIds ?? []))
    if (!pick) return null
    const { entry, probe, skattekontoAccount } = pick
    return {
      transaction_id: null,
      journal_entry_id: entry.id,
      voucher_label: formatVoucher(entry),
      entry_date: entry.entry_date,
      description: entry.description,
      amount: roundOre(Math.abs(probe.net)),
      // No bank leg to link to: the verifikat found books the skattekonto.
      account_number: null,
      currency: null,
      amount_in_currency: null,
      amount_verified: true,
      unverified_reason: null,
      skattekonto: { tax_account: probe.account_number, skattekonto_account: skattekontoAccount },
    }
  } catch (err) {
    log.warn('skattekonto tax double probe failed: no double-booking warning shown', err)
    return null
  }
}

/**
 * Whether `journalEntryId` can be a skattekonto candidate for a bank line of
 * `bookingDate`: a live verifikat of the same calendar month, no storno, with
 * a line on the skattekonto account and one on a tax account. The
 * categorize door asks this before its kontering is known, when force names
 * a verifikat the bank-line halves did not detect: a plausible one is bound
 * once the kontering is known (runSkattekontoTaxGuard re-detects it exactly);
 * anything else is refused as before. False on any read error.
 */
export async function isSkattekontoTaxCandidateFor(
  supabase: SupabaseClient,
  companyId: string,
  bookingDate: string,
  journalEntryId: string,
): Promise<boolean> {
  try {
    const month = calendarMonthOf(bookingDate)
    if (!month) return false
    const { data } = await supabase
      .from('journal_entries')
      .select('id, entry_date, status, reverses_id, source_type, journal_entry_lines(account_number)')
      .eq('company_id', companyId)
      .eq('id', journalEntryId)
      .maybeSingle()
    const entry = data as {
      entry_date?: string
      status?: string
      reverses_id?: string | null
      source_type?: string | null
      journal_entry_lines?: Array<{ account_number: string }> | null
    } | null
    if (!entry?.entry_date || !['draft', 'posted'].includes(entry.status ?? '')) return false
    if (entry.reverses_id || entry.source_type === 'opening_balance') return false
    if (entry.entry_date < month.from || entry.entry_date > month.to) return false
    const accounts = (entry.journal_entry_lines ?? []).map((l) => l.account_number)
    return accounts.some((a) => SKATTEKONTO_LEDGER_ACCOUNT_SET.has(a)) && accounts.some((a) => SKATTEKONTO_TAX_ACCOUNTS.has(a))
  } catch (err) {
    log.warn('skattekonto tax candidate check failed: treated as no candidate', err)
    return false
  }
}

/**
 * The booking guard's detection for a door that knows its kontering: the
 * bank-line halves (detectBookingDuplicate) first, then the skattekonto
 * half. A door without counter lines gets exactly detectBookingDuplicate.
 */
export async function detectKonteringBookingDuplicate(
  supabase: SupabaseClient,
  companyId: string,
  target: KonteringBookingTarget,
  opts?: BookingDuplicateExclusions,
): Promise<BookedDuplicateCandidate | null> {
  const found = await detectBookingDuplicate(supabase, companyId, target, opts)
  if (found) return found
  return detectSkattekontoTaxDouble(supabase, companyId, target, opts)
}

/** The agent doors' refusal text for a skattekonto candidate (Swedish, like agentDuplicateMessage). */
export function skattekontoTaxDoubleAgentMessage(candidate: SkattekontoTaxDoubleCandidate): string {
  const voucher = candidate.voucher_label ? `verifikat ${candidate.voucher_label}` : 'en befintlig verifikation'
  const amount = Math.abs(candidate.amount ?? 0).toLocaleString('sv-SE', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
  return (
    `Möjlig dubbelbokförd skatt: ${voucher} (${candidate.entry_date}) bokför redan ${amount} kr på ` +
    `${candidate.skattekonto.tax_account} mot skattekontot (${candidate.skattekonto.skattekonto_account}) samma månad. ` +
    `En betalning till Skatteverket bokförs mot ${candidate.skattekonto.skattekonto_account}, inte direkt mot ` +
    `${candidate.skattekonto.tax_account}: bokför transaktionen mot ${candidate.skattekonto.skattekonto_account} i stället. ` +
    'Kör om med allow_duplicate=true bara om betalningen verkligen avser en annan skatt.'
  )
}
