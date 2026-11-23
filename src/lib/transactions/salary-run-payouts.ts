/**
 * Which open bank rows pay out a booked salary run's net pay, and which pay
 * salary with no booked run near them (crm#1462).
 *
 * A booked salary run's salary verifikat credits the company's bank account
 * with the run's total net pay (lib/salary/salary-entries.ts,
 * buildSalaryLines). The bank row that pays it out is already booked by
 * that verifikat: the row is linked to it, never categorized. Booking it as
 * "Lön (netto)" (personnel_salary, 7210 against the bank) a second time
 * counts the salary twice; the categorize door refuses that duplicate
 * (detectLedgerDuplicateVoucher), but nothing offered the link before the
 * refusal.
 *
 * Proposals only, read only, and only for salary runs: a run's verifikat is
 * the one voucher whose bank leg is known to be a payout, so naming it never
 * attributes an arbitrary hand-posted verifikat to a bank row. The link
 * itself goes through the ordinary reconciliation link path, which
 * revalidates everything at click time.
 */
import type { SupabaseDataClient } from '@/lib/supabase/data-client'
import { isCashLedger } from '@/lib/bookkeeping/bank-leg'
import { isLedgerCurrency } from '@/lib/bookkeeping/currency-utils'
import { formatVoucher } from '@/lib/bookkeeping/voucher-series-resolver'
import { addDaysIso } from '@/lib/dates/iso'
import type { Transaction } from '@/types'

/** The window, in days either side, a payout may sit from the run's payment date. */
export const SALARY_PAYOUT_WINDOW_DAYS = 7


export interface SalaryRunPayout {
  journal_entry_id: string
  salary_run_id: string
  /** "L12" when the verifikat has a number, else null. */
  voucher: string | null
  entry_date: string
  /** The run's period, "2026-10". */
  period: string
}

export interface SalaryRunPayouts {
  /** Open outbound rows that pay out a booked run's net pay, by transaction id. */
  links: Map<string, SalaryRunPayout>
  /**
   * Open outbound rows with no salary run (booked or not) paid within the
   * window, in a company that has active employees: a row booked as net
   * salary there should wait for the run.
   */
  without_run: Set<string>
}

type AskedRow = Pick<Transaction, 'id' | 'date' | 'amount' | 'journal_entry_id' | 'is_ignored' | 'cash_account_id'> & {
  /** Any spelling the row carries: only the ledger currency is asked about. */
  currency: string | null
}

function ore(amount: number | string | null | undefined): number {
  return Math.round(Number(amount) * 100)
}

function dayDistance(a: string, b: string): number {
  return Math.abs(new Date(a).getTime() - new Date(b).getTime()) / 86_400_000
}

/** An open row that may be a salary payout: money out, in the ledger currency, not booked, not ignored. */
function isOpenPayoutCandidate(tx: AskedRow): boolean {
  if (!(ore(tx.amount) < 0)) return false
  if (tx.journal_entry_id || tx.is_ignored) return false
  return isLedgerCurrency(tx.currency ? tx.currency.toUpperCase() : null)
}

/**
 * The salary-run payouts among `transactions`. Reads nothing when no row is
 * an open outbound row in the ledger currency; otherwise one salary_runs read, and the
 * verifikat, lines, links and cash accounts only when a booked run sits in
 * the window. `withoutRunFor` names the rows to check for a missing run (the
 * ones a net-salary booking was proposed for); the employee count is read
 * only when one of them has no run nearby.
 */
export async function findSalaryRunPayouts(
  supabase: SupabaseDataClient,
  companyId: string,
  transactions: readonly AskedRow[],
  withoutRunFor: ReadonlySet<string> = new Set(),
): Promise<SalaryRunPayouts> {
  const links = new Map<string, SalaryRunPayout>()
  const without_run = new Set<string>()
  const asked = transactions.filter(isOpenPayoutCandidate)
  if (asked.length === 0) return { links, without_run }

  const dates = asked.map((t) => t.date).sort()
  const from = addDaysIso(dates[0], -SALARY_PAYOUT_WINDOW_DAYS)
  const to = addDaysIso(dates[dates.length - 1], SALARY_PAYOUT_WINDOW_DAYS)

  const { data: runRows, error: runError } = await supabase
    .from('salary_runs')
    .select('id, period_year, period_month, payment_date, salary_entry_id')
    .eq('company_id', companyId)
    .gte('payment_date', from)
    .lte('payment_date', to)
  if (runError) throw runError
  const runs = (runRows ?? []) as Array<{
    id: string
    period_year: number
    period_month: number
    payment_date: string
    salary_entry_id: string | null
  }>

  // A row asked about that has no run of any status paid near it.
  const lonely = asked.filter(
    (tx) =>
      withoutRunFor.has(tx.id) &&
      !runs.some((r) => dayDistance(r.payment_date, tx.date) <= SALARY_PAYOUT_WINDOW_DAYS),
  )
  if (lonely.length > 0) {
    const { count, error } = await supabase
      .from('employees')
      .select('id', { count: 'exact', head: true })
      .eq('company_id', companyId)
      .eq('is_active', true)
    if (error) throw error
    if ((count ?? 0) > 0) for (const tx of lonely) without_run.add(tx.id)
  }

  const booked = runs.filter((r): r is typeof r & { salary_entry_id: string } => !!r.salary_entry_id)
  if (booked.length === 0) return { links, without_run }
  const entryIds = booked.map((r) => r.salary_entry_id)
  const cashAccountIds = Array.from(new Set(asked.flatMap((t) => (t.cash_account_id ? [t.cash_account_id] : []))))

  const [entriesRes, linesRes, linkedRes, voucherLinksRes, cashRes] = await Promise.all([
    supabase
      .from('journal_entries')
      .select('id, voucher_series, voucher_number, entry_date')
      .eq('company_id', companyId)
      .eq('status', 'posted')
      .in('id', entryIds),
    supabase
      .from('journal_entry_lines')
      .select('journal_entry_id, account_number, credit_amount')
      .in('journal_entry_id', entryIds)
      .gt('credit_amount', 0),
    // A verifikat another bank row already books is paid out: never offered twice.
    supabase.from('transactions').select('journal_entry_id').eq('company_id', companyId).in('journal_entry_id', entryIds),
    supabase
      .from('transaction_voucher_links')
      .select('journal_entry_id')
      .eq('company_id', companyId)
      .in('journal_entry_id', entryIds),
    cashAccountIds.length > 0
      ? supabase.from('cash_accounts').select('id, ledger_account').eq('company_id', companyId).in('id', cashAccountIds)
      : Promise.resolve({ data: [], error: null }),
  ])
  for (const res of [entriesRes, linesRes, linkedRes, voucherLinksRes, cashRes]) {
    if (res.error) throw res.error
  }

  const taken = new Set<string>([
    ...((linkedRes.data ?? []) as Array<{ journal_entry_id: string | null }>).flatMap((r) => (r.journal_entry_id ? [r.journal_entry_id] : [])),
    ...((voucherLinksRes.data ?? []) as Array<{ journal_entry_id: string }>).map((r) => r.journal_entry_id),
  ])
  const ledgerOf = new Map(
    ((cashRes.data ?? []) as Array<{ id: string; ledger_account: string }>).map((c) => [c.id, c.ledger_account]),
  )
  const entries = new Map(
    ((entriesRes.data ?? []) as Array<{ id: string; voucher_series: string | null; voucher_number: number | null; entry_date: string }>).map(
      (e) => [e.id, e],
    ),
  )
  const runByEntry = new Map(booked.map((r) => [r.salary_entry_id, r]))

  // Each open net-pay leg goes to the closest asked row on the same bank
  // account with the same öre: one payout, one row.
  const legs = ((linesRes.data ?? []) as Array<{ journal_entry_id: string; account_number: string; credit_amount: number | string }>)
    .filter((l) => isCashLedger(l.account_number) && entries.has(l.journal_entry_id) && !taken.has(l.journal_entry_id))
    .sort((a, b) => a.journal_entry_id.localeCompare(b.journal_entry_id) || a.account_number.localeCompare(b.account_number))
  for (const leg of legs) {
    const entry = entries.get(leg.journal_entry_id)!
    const run = runByEntry.get(leg.journal_entry_id)!
    const match = asked
      .filter((tx) => !links.has(tx.id))
      .filter((tx) => -ore(tx.amount) === ore(leg.credit_amount))
      .filter((tx) => dayDistance(tx.date, entry.entry_date) <= SALARY_PAYOUT_WINDOW_DAYS)
      .filter((tx) => {
        const ledger = tx.cash_account_id ? ledgerOf.get(tx.cash_account_id) : undefined
        return !ledger || ledger === leg.account_number
      })
      .sort((a, b) => dayDistance(a.date, entry.entry_date) - dayDistance(b.date, entry.entry_date) || a.id.localeCompare(b.id))[0]
    if (!match) continue
    links.set(match.id, {
      journal_entry_id: entry.id,
      salary_run_id: run.id,
      voucher: entry.voucher_number ? formatVoucher(entry) : null,
      entry_date: entry.entry_date,
      period: `${run.period_year}-${String(run.period_month).padStart(2, '0')}`,
    })
    taken.add(entry.id)
  }
  return { links, without_run }
}

/** The hint on a net-salary proposal for a row no salary run is paid near (MCP, Swedish like `why`). */
export const SALARY_RUN_MISSING_HINT =
  'Ingen lönekörning betalas ut nära radens datum. Skapa och bokför lönekörningen först (gnubok_create_salary_run): den bokför bruttolön, skatt och arbetsgivaravgifter. Koppla sedan raden till dess verifikat.'

/**
 * The link an agent is offered for a row a booked run pays out: first in the
 * row's list, never booked from the row, linked with gnubok_reconcile_match.
 * Null for a row with no cash account (the link names the bank account).
 */
export function salaryPayoutLinkProposal(
  tx: Pick<Transaction, 'id' | 'cash_account_id'>,
  payout: SalaryRunPayout,
): Record<string, unknown> | null {
  if (!tx.cash_account_id) return null
  const voucher = payout.voucher ? `verifikat ${payout.voucher}` : 'dess verifikat'
  return {
    id: 'salary_run_payout',
    source: 'ledger_link',
    label: 'Koppla till lönekörningens verifikat',
    why: `Lönekörningen för ${payout.period} är bokförd (${voucher}, ${payout.entry_date}) och bokför redan nettolönen från banken. Koppla raden; bokförs den igen räknas lönen två gånger.`,
    confidence: 0.95,
    books_without_review: false,
    link_args: {
      account_key: `bank:${tx.cash_account_id}`,
      pairs: [{ external_ids: [tx.id], journal_entry_ids: [payout.journal_entry_id] }],
    },
  }
}
