/**
 * Link a ROT/RUT begäran to a payout verifikat that already exists.
 *
 * The settle flow (rot-rut-settle.ts) books the payout itself. A payout the
 * user booked by hand (often 1930 / 3740 öresavrundning / 1513, because the
 * begäran file truncates to whole kronor) had no way to reach the begäran,
 * which then read "Uppladdad" forever. This links the two without booking
 * anything: every rule lives in the link_rot_rut_payout_voucher RPC
 * (20260923100000, and 20261023012000 for the two steps below), shared by
 * the dashboard route and the MCP tool, so a preview (p_dry_run) and the
 * real link are judged by the same checks.
 *
 * Under kontantmetoden the two steps (lib/invoices/rot-rut-payout-recognition.ts)
 * keep nothing on 1513 during the year: the payout is booked as the share's
 * försäljning and utgående moms. A payout booked by hand that way (the bank
 * against revenue and moms) is a candidate too, but only in that exact shape
 * (twoStepPayoutShape): every line on the bank, 1513, revenue, utgående moms
 * or öresavrundning, the money in exactly the begäran's expected payout, and
 * a source a hand-booked payout has. A customer payment of the same amount
 * carries its own source (invoice_cash_payment and the like) and stays out.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { ORE_ROUNDING_ACCOUNT, roundOre } from '@/lib/money'
import { PINNED_JURISDICTION, resolveAccountRole } from '@/lib/bookkeeping/account-roles'
import { accountClass } from '@/lib/invariants/account-number'
import { VAT_OUTPUT_ACCOUNTS } from '@/lib/reports/vat-declaration'
import { fetchEntryLines, type EntryLinesQuery } from '@/lib/bookkeeping/entry-lines'

export type LinkRotRutPayoutVoucherErrorCode =
  | 'ROT_RUT_REQUEST_NOT_FOUND'
  | 'ROT_RUT_SETTLE_INVALID_STATE'
  | 'ROT_RUT_LINK_VOUCHER_NOT_FOUND'
  | 'ROT_RUT_LINK_VOUCHER_NOT_ELIGIBLE'
  | 'ROT_RUT_LINK_ALREADY_SETTLED'
  | 'ROT_RUT_LINK_VOUCHER_IN_USE'
  | 'ROT_RUT_LINK_AMOUNT_MISMATCH'

export interface LinkRotRutPayoutVoucherResult {
  ok: true
  dry_run: boolean
  already_linked: boolean
  journal_entry_id: string
  voucher?: {
    entry_date: string
    voucher_series: string
    voucher_number: number
    description: string | null
  }
  expected_total?: number
  voucher_1513_credit?: number
  /** Kontantmetoden's two steps: revenue and moms the voucher books as the share. */
  share_credit?: number
  bank_amount?: number
  rounding?: number
  requests?: Array<{ request_id: string; name: string; amount: number; status: string }>
}

export type LinkRotRutPayoutVoucherOutcome =
  | { ok: true; result: LinkRotRutPayoutVoucherResult }
  | { ok: false; kind: 'code'; code: LinkRotRutPayoutVoucherErrorCode; details?: Record<string, unknown> }
  | { ok: false; kind: 'error'; error: unknown }

export async function linkRotRutPayoutVoucher(
  supabase: SupabaseClient,
  companyId: string,
  params: { requestIds: string[]; journalEntryId: string; dryRun?: boolean },
): Promise<LinkRotRutPayoutVoucherOutcome> {
  const { data, error } = await supabase.rpc('link_rot_rut_payout_voucher', {
    p_company_id: companyId,
    p_request_ids: params.requestIds,
    p_journal_entry_id: params.journalEntryId,
    p_dry_run: params.dryRun ?? false,
  })
  if (error) return { ok: false, kind: 'error', error }

  const result = data as
    | LinkRotRutPayoutVoucherResult
    | { ok: false; code: LinkRotRutPayoutVoucherErrorCode; details?: Record<string, unknown> }
  if (!result.ok) {
    return { ok: false, kind: 'code', code: result.code, details: result.details }
  }
  return { ok: true, result }
}

export interface RotRutPayoutVoucherCandidate {
  journal_entry_id: string
  entry_date: string
  voucher_series: string
  voucher_number: number
  description: string | null
  /** Net debit on 19xx: what reached the bank. */
  bank_amount: number
  /** Net credit on 1513: the receivable the voucher clears. */
  receivable_credit: number
  /**
   * Kontantmetoden's two steps: the net credit on revenue and utgående moms
   * the voucher books as Skatteverket's share instead of 1513. 0 otherwise.
   */
  share_credit: number
}

interface CandidateEntryRow {
  id: string
  entry_date: string
  voucher_series: string
  voucher_number: number
  description: string | null
  source_type: string
  lines: Array<{ account_number: string; debit_amount: number | string; credit_amount: number | string }>
}

const CANDIDATE_LIMIT = 50

/** The receivable a payout clears: Skatteverket's ROT/RUT share (1513 in the SE pack). */
const ROT_RUT_RECEIVABLE = resolveAccountRole(PINNED_JURISDICTION, 'rot_rut_receivable')

/**
 * BAS class 19, Kassa och bank: where a payout reaches the bank, the money
 * in this picker looks for. A set-off on the skattekonto is booked, and its
 * begäran linked, by the skattekonto booking itself (skattekonto-booking.ts);
 * the RPC also accepts one booked there by hand (1630 / 2012), for the MCP
 * link tool.
 */
function isBankAccount(account: string): boolean {
  return account.startsWith('19')
}

const OUTPUT_VAT_ACCOUNTS = new Set<string>(VAT_OUTPUT_ACCOUNTS)

/** The share's own accounts: revenue (BAS class 3, but öresavrundning) and utgående moms. */
function isShareAccount(account: string): boolean {
  return OUTPUT_VAT_ACCOUNTS.has(account) || (accountClass(account) === 3 && account !== ORE_ROUNDING_ACCOUNT)
}

/** The sources a payout booked by hand carries; never a document's own verifikat. */
export const TWO_STEP_PAYOUT_SOURCES = ['manual', 'bank_transaction', 'system', 'correction'] as const

/**
 * A payout booked by hand under kontantmetodens two steps, or null: every
 * line on a money-in account, 1513, the share's revenue and moms, or 3740,
 * and some revenue or moms credited. The amounts are the RPC's to judge;
 * this is the same shape link_rot_rut_payout_voucher accepts (20261023012000).
 */
export function twoStepPayoutShape(
  lines: ReadonlyArray<{ account_number: string; debit_amount: number | string; credit_amount: number | string }>,
): { moneyIn: number; receivable: number; share: number } | null {
  let moneyIn = 0
  let receivable = 0
  let share = 0
  for (const line of lines) {
    const net = Number(line.debit_amount) - Number(line.credit_amount)
    if (isBankAccount(line.account_number)) moneyIn += net
    else if (line.account_number === ROT_RUT_RECEIVABLE) receivable -= net
    else if (isShareAccount(line.account_number)) share -= net
    else if (line.account_number !== ORE_ROUNDING_ACCOUNT) return null
  }
  const shape = { moneyIn: roundOre(moneyIn), receivable: roundOre(receivable), share: roundOre(share) }
  return shape.share > 0 ? shape : null
}

/**
 * Posted, unreversed verifikat that credit 1513, dated on or after the day
 * the begäran was created (a payout cannot precede its file), and not yet
 * the settlement verifikat of any begäran. Newest first. The RPC still makes
 * the final call on amounts; this only narrows the picker.
 *
 * `twoStep` (a kontantmetod company): also the payouts booked by hand as the
 * share's revenue and moms, found by money in of exactly the begäran's
 * expected payout and kept only in twoStepPayoutShape from a hand-booked
 * source (TWO_STEP_PAYOUT_SOURCES).
 */
export async function listRotRutPayoutVoucherCandidates(
  supabase: SupabaseClient,
  companyId: string,
  since: string,
  twoStep?: { expectedAmount: number },
): Promise<{ data: RotRutPayoutVoucherCandidate[]; error: unknown }> {
  const expected = twoStep ? roundOre(twoStep.expectedAmount) : 0
  const withMoneyIn = Boolean(twoStep) && expected > 0

  // Entry first (lib/bookkeeping/entry-lines.ts): the company's verifikat
  // since the begäran, then only their lines that credit 1513 or (the two
  // steps) debit exactly the expected payout. These were journal_entry_lines
  // reads filtered through a journal_entries!inner embed, which PostgREST
  // plans from the line side: the debit filter has no index, so it scanned
  // every tenant's lines and ran into the statement timeout.
  let lineRows: Array<{ journal_entry_id: string; account_number: string; debit_amount: number | string; credit_amount: number | string }>
  try {
    lineRows = await fetchEntryLines({
      supabase,
      lineColumns: 'journal_entry_id, account_number, debit_amount, credit_amount',
      filterEntries: (q: EntryLinesQuery) =>
        q.eq('company_id', companyId).eq('status', 'posted').is('reversed_by_id', null).gte('entry_date', since),
      filterLines: (q: EntryLinesQuery) =>
        withMoneyIn
          ? q.or(`and(account_number.eq.${ROT_RUT_RECEIVABLE},credit_amount.gt.0),debit_amount.eq.${expected}`)
          : q.eq('account_number', ROT_RUT_RECEIVABLE).gt('credit_amount', 0),
      attachEntriesAs: null,
    })
  } catch (lineError) {
    return { data: [], error: lineError }
  }

  const ids = [
    ...new Set(
      lineRows
        .filter((row) =>
          row.account_number === ROT_RUT_RECEIVABLE
            ? Number(row.credit_amount) > 0
            : withMoneyIn && isBankAccount(row.account_number) && roundOre(Number(row.debit_amount)) === expected,
        )
        .map((row) => row.journal_entry_id),
    ),
  ]
  if (ids.length === 0) return { data: [], error: null }

  const [{ data: entries, error: entryError }, { data: used, error: usedError }] = await Promise.all([
    supabase
      .from('journal_entries')
      .select(
        'id, entry_date, voucher_series, voucher_number, description, source_type, lines:journal_entry_lines(account_number, debit_amount, credit_amount)',
      )
      .eq('company_id', companyId)
      .eq('status', 'posted')
      .is('reversed_by_id', null)
      .in('id', ids),
    supabase
      .from('rot_rut_payout_requests')
      .select('settlement_journal_entry_id')
      .eq('company_id', companyId)
      .in('settlement_journal_entry_id', ids),
  ])
  if (entryError) return { data: [], error: entryError }
  if (usedError) return { data: [], error: usedError }

  const usedIds = new Set(
    ((used ?? []) as Array<{ settlement_journal_entry_id: string | null }>).map((r) => r.settlement_journal_entry_id),
  )

  const candidates = ((entries ?? []) as CandidateEntryRow[])
    .filter((entry) => !usedIds.has(entry.id) && !['storno', 'opening_balance'].includes(entry.source_type))
    .map((entry) => {
      let bank = 0
      let receivable = 0
      for (const line of entry.lines ?? []) {
        const net = Number(line.debit_amount) - Number(line.credit_amount)
        if (line.account_number === ROT_RUT_RECEIVABLE) receivable -= net
        else if (isBankAccount(line.account_number)) bank += net
      }
      // The two steps: revenue and moms in place of 1513, money in exactly the expected payout.
      const shape =
        twoStep && (TWO_STEP_PAYOUT_SOURCES as readonly string[]).includes(entry.source_type)
          ? twoStepPayoutShape(entry.lines ?? [])
          : null
      const twoStepShare = shape && Math.abs(shape.moneyIn - expected) < 0.005 ? shape.share : 0
      return {
        journal_entry_id: entry.id,
        entry_date: entry.entry_date,
        voucher_series: entry.voucher_series,
        voucher_number: entry.voucher_number,
        description: entry.description,
        bank_amount: roundOre(bank),
        receivable_credit: roundOre(receivable),
        share_credit: twoStepShare,
      }
    })
    .filter((candidate) => candidate.receivable_credit > 0 || candidate.share_credit > 0)
    .sort(
      (a, b) =>
        b.entry_date.localeCompare(a.entry_date) ||
        a.voucher_series.localeCompare(b.voucher_series) ||
        b.voucher_number - a.voucher_number,
    )
    .slice(0, CANDIDATE_LIMIT)

  return { data: candidates, error: null }
}
