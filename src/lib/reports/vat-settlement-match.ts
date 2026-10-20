/**
 * Which momsperiod a momsredovisning verifikat settles, read by amount
 * (crm#1316).
 *
 * A momsredovisning is often dated outside the period it settles: on the day
 * Skatteverket moves ruta 49 on the skattekonto, on the filing day, or on the
 * first open day after a closed year. A yearly filer's due date is months
 * after the räkenskapsår (SFL 26 kap. 33-33b §§). So a verifikat dated inside
 * one period can be the previous period's, and a period can be settled by one
 * dated after it. The date cannot tell which period a verifikat settles; the
 * amounts can: it clears exactly that period's VAT balances and moves its
 * filed net, to 2650/1650 or straight to the skattekonto.
 *
 * Which verifikat count as a momsredovisning at all is the SQL's decision
 * (get_vat_declaration_totals' settlement shapes, with the declaration's own
 * account lists), never a TypeScript copy of it; the tagged ones the SQL
 * leaves out by source type are read beside it. The momsredovisning proposal
 * (vat-settlement.ts) reads these primitives, and the booking guard and the
 * vat_declared_not_settled check read the proposal.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { PINNED_JURISDICTION, resolveAccountRole } from '@/lib/bookkeeping/account-roles'
import { fetchEntryLines, type EntryLinesQuery } from '@/lib/bookkeeping/entry-lines'
import { addDaysIso } from '@/lib/dates/iso'
import { roundOre } from '@/lib/money'
import { VAT_SETTLEMENT_NET_ACCOUNTS, fetchVatAccountTotals, isMomsAccount } from './vat-declaration'

/** Ruta 49 is filed in whole kronor (öretal faller bort): the net may differ from the öre sum by under a krona. */
export const FILED_ROUNDING = 1

/** Öres- och kronutjämning, the account role vat-settlement.ts books the öre gap on. */
const ROUNDING_ACCOUNT = resolveAccountRole(PINNED_JURISDICTION, 'rounding')

/** A period's VAT as its momsredovisning clears it. */
export interface PeriodVatBalance {
  /**
   * The period's balances on the accounts the momsredovisning clears, as the
   * net they come to (credit minus debit, positive = att betala), at exact öre.
   */
  cleared: number
  /** Ruta 49 as filed, whole kronor (positive = att betala). */
  filed_net: number
}

/** A posted momsredovisning verifikat, summed the way a period's balances are. */
export interface SettlementVerifikat {
  journal_entry_id: string
  entry_date: string
  status: string
  source_type: string | null
  voucher_series: string | null
  voucher_number: number | null
  /** Voucher and text, "A13 Moms 2024". */
  label: string
  /** Debit minus credit over its 26xx lines but 2650: the VAT balances it clears. */
  cleared: number
  /** What it moves to 2650/1650, or else to the skattekonto: credit minus debit (positive = att betala). */
  net: number
  /** Where the net went: the settlement accounts (2650/1650) or straight to the skattekonto. */
  via: 'net_account' | 'tax_account'
}

export function nearFiled(a: number, b: number): boolean {
  return Math.abs(a - b) < FILED_ROUNDING
}

/**
 * Whether a momsredovisning settles a period: it clears exactly the period's
 * VAT balances and moves the net as filed (or at öre). A period with no net to
 * file has nothing a verifikat could be tied to by amount.
 */
export function settlesPeriod(settlement: Pick<SettlementVerifikat, 'cleared' | 'net'>, period: PeriodVatBalance): boolean {
  if (Math.abs(period.filed_net) < FILED_ROUNDING) return false
  return (
    nearFiled(settlement.cleared, period.cleared) &&
    (nearFiled(settlement.net, period.filed_net) || nearFiled(settlement.net, period.cleared))
  )
}

/**
 * Days after a period's end a momsredovisning dated late is looked for: the
 * latest statutory due date (SFL 26 kap. 33-33b §§: helårsmoms up to 17
 * August, 321 days after a räkenskapsår ending 30 September; monthly and
 * quarterly within 50 days) plus the time Skatteverket's debit and the
 * verifikat that follows it take, which also leaves months for a declaration
 * filed late. What ties a verifikat to the period is its amount; the window
 * only bounds the search.
 */
export const LATE_LOOKAHEAD_DAYS = 400

/** The last day a momsredovisning dated after the period is looked for; never before the date the proposal itself would book on. */
export function lateSettlementLookupEnd(periodEnd: string, proposedEntryDate: string): string {
  const ahead = addDaysIso(periodEnd, LATE_LOOKAHEAD_DAYS)
  return proposedEntryDate > ahead ? proposedEntryDate : ahead
}

type SettlementLine = {
  account_number: string
  debit_amount: number
  credit_amount: number
  journal_entry_id: string
  journal_entries: {
    entry_date: string
    status: string
    source_type: string | null
    voucher_series: string | null
    voucher_number: number | null
    description: string | null
  }
}

/** The momsredovisningar with these ids, each summed: what it clears and where its net went. */
export async function summarizeSettlements(
  supabase: SupabaseClient,
  companyId: string,
  ids: readonly string[],
): Promise<SettlementVerifikat[]> {
  if (ids.length === 0) return []
  const lines = await fetchEntryLines<SettlementLine>({
    supabase,
    entryColumns: 'entry_date, status, source_type, voucher_series, voucher_number, description',
    lineColumns: 'account_number, debit_amount, credit_amount',
    filterEntries: (q: EntryLinesQuery) => q.eq('company_id', companyId).in('id', [...ids]),
  })
  const net = new Set(VAT_SETTLEMENT_NET_ACCOUNTS)
  const byEntry = new Map<string, { head: SettlementLine['journal_entries']; cleared: number; toNet: number; toOther: number; hasNet: boolean }>()
  for (const line of lines) {
    const seen = byEntry.get(line.journal_entry_id) ?? { head: line.journal_entries, cleared: 0, toNet: 0, toOther: 0, hasNet: false }
    const debit = Number(line.debit_amount) || 0
    const credit = Number(line.credit_amount) || 0
    if (net.has(line.account_number)) {
      seen.hasNet = true
      seen.toNet += credit - debit
    } else if (isMomsAccount(line.account_number)) {
      seen.cleared += debit - credit
    } else if (line.account_number !== ROUNDING_ACCOUNT) {
      // A pure skattekonto movement has nothing else: these are its 1630 (or 2012) lines.
      seen.toOther += credit - debit
    }
    byEntry.set(line.journal_entry_id, seen)
  }
  return [...byEntry]
    .map(([id, e]) => ({
      journal_entry_id: id,
      entry_date: e.head.entry_date,
      status: e.head.status,
      source_type: e.head.source_type,
      voucher_series: e.head.voucher_series,
      voucher_number: e.head.voucher_number,
      label: `${e.head.voucher_series ?? ''}${e.head.voucher_number ?? ''} ${e.head.description ?? ''}`.trim(),
      cleared: roundOre(e.cleared),
      net: roundOre(e.hasNet ? e.toNet : e.toOther),
      via: e.hasNet ? ('net_account' as const) : ('tax_account' as const),
    }))
    .sort((a, b) => a.entry_date.localeCompare(b.entry_date) || a.journal_entry_id.localeCompare(b.journal_entry_id))
}

/**
 * The posted momsredovisningar dated from `from` through `to`, oldest first:
 * tagged vat_settlement, or by either shape of get_vat_declaration_totals (a
 * declaration account and a 2650/1650 line, or a pure 26xx movement against
 * the skattekonto). A storno of one cancels it and is no settlement.
 */
export async function settlementsDated(
  supabase: SupabaseClient,
  companyId: string,
  from: string,
  to: string,
): Promise<SettlementVerifikat[]> {
  if (to < from) return []
  const [ledger, tagged] = await Promise.all([
    fetchVatAccountTotals(supabase, companyId, from, to),
    supabase
      .from('journal_entries')
      .select('id')
      .eq('company_id', companyId)
      .eq('source_type', 'vat_settlement')
      .eq('status', 'posted')
      .gte('entry_date', from)
      .lte('entry_date', to),
  ])
  if (tagged.error) throw new Error(`vat_settlement lookup failed: ${tagged.error.message}`)
  const ids = new Set([
    ...ledger.settlementShapedEntries.filter((e) => e.status === 'posted' && e.source_type !== 'storno').map((e) => e.id),
    ...((tagged.data ?? []) as Array<{ id: string }>).map((e) => e.id),
  ])
  return summarizeSettlements(supabase, companyId, [...ids])
}

/**
 * What the opening balances dated from `start` through `end` carry onto the
 * moms accounts, read the way a period's balances are (credit minus debit).
 * The declaration counts an opening balance's 26xx lines as the period's
 * (carried-in VAT not yet settled), so a year closed before its
 * momsredovisning was booked opens the next year with the same balances.
 */
export async function carriedIntoPeriod(
  supabase: SupabaseClient,
  companyId: string,
  start: string,
  end: string,
): Promise<number> {
  const lines = await fetchEntryLines<{ account_number: string; debit_amount: number; credit_amount: number }>({
    supabase,
    lineColumns: 'account_number, debit_amount, credit_amount',
    filterEntries: (q: EntryLinesQuery) =>
      q
        .eq('company_id', companyId)
        .eq('source_type', 'opening_balance')
        .eq('status', 'posted')
        .gte('entry_date', start)
        .lte('entry_date', end),
    attachEntriesAs: null,
  })
  const net = new Set(VAT_SETTLEMENT_NET_ACCOUNTS)
  let carried = 0
  for (const line of lines) {
    if (!isMomsAccount(line.account_number) || net.has(line.account_number)) continue
    carried += (Number(line.credit_amount) || 0) - (Number(line.debit_amount) || 0)
  }
  return roundOre(carried)
}
