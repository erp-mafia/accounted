/**
 * Link a ROT/RUT begäran to a payout verifikat that already exists.
 *
 * The settle flow (rot-rut-settle.ts) books the payout itself. A payout the
 * user booked by hand (often 1930 / 3740 öresavrundning / 1513, because the
 * begäran file truncates to whole kronor) had no way to reach the begäran,
 * which then read "Uppladdad" forever. This links the two without booking
 * anything: every rule lives in the link_rot_rut_payout_voucher RPC
 * (20260923100000), shared by the dashboard route and the MCP tool, so a
 * preview (p_dry_run) and the real link are judged by the same checks.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { roundOre } from '@/lib/money'

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

/**
 * Posted, unreversed verifikat that credit 1513, dated on or after the day
 * the begäran was created (a payout cannot precede its file), and not yet
 * the settlement verifikat of any begäran. Newest first. The RPC still makes
 * the final call on amounts; this only narrows the picker.
 */
export async function listRotRutPayoutVoucherCandidates(
  supabase: SupabaseClient,
  companyId: string,
  since: string,
): Promise<{ data: RotRutPayoutVoucherCandidate[]; error: unknown }> {
  const { data: lineRows, error: lineError } = await supabase
    .from('journal_entry_lines')
    .select('journal_entry_id, journal_entries!inner(company_id, status, entry_date)')
    .eq('account_number', '1513')
    .gt('credit_amount', 0)
    .eq('journal_entries.company_id', companyId)
    .eq('journal_entries.status', 'posted')
    .gte('journal_entries.entry_date', since)
    .limit(500)
  if (lineError) return { data: [], error: lineError }

  const ids = [...new Set(((lineRows ?? []) as Array<{ journal_entry_id: string }>).map((r) => r.journal_entry_id))]
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
        if (line.account_number === '1513') receivable -= net
        else if (line.account_number.startsWith('19')) bank += net
      }
      return {
        journal_entry_id: entry.id,
        entry_date: entry.entry_date,
        voucher_series: entry.voucher_series,
        voucher_number: entry.voucher_number,
        description: entry.description,
        bank_amount: roundOre(bank),
        receivable_credit: roundOre(receivable),
      }
    })
    .filter((candidate) => candidate.receivable_credit > 0)
    .sort(
      (a, b) =>
        b.entry_date.localeCompare(a.entry_date) ||
        a.voucher_series.localeCompare(b.voucher_series) ||
        b.voucher_number - a.voucher_number,
    )
    .slice(0, CANDIDATE_LIMIT)

  return { data: candidates, error: null }
}
