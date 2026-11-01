/**
 * The two duplicate shapes of a typed verifikat, read against the books as
 * they are before it is posted.
 *
 *   - POSSIBLE_DUPLICATE_VOUCHER: a posted verifikat on the same date with the
 *     same text and the same amounts. The accounts are left out of the
 *     comparison on purpose: the duplicate the 2026-10-26 sweep confirmed was
 *     an agent re-posting a batch 90 minutes later with 2641 where the first
 *     run had 2640, instead of correcting the first run.
 *   - BANK_MOVEMENT_ALREADY_BOOKED: a line on a bank account whose money a
 *     bank row of that account already books, within the window the bank
 *     side's own guard uses. The bank booking guard
 *     (lib/transactions/booking-duplicate-detection.ts) covers the order
 *     "voucher first, bank row later"; this covers the other order, which is
 *     46 of the 49 cross-path double bookings the sweep found.
 *
 * Both are warnings, never refusals: four fishing permits sold on one day are
 * four identical vouchers, and two equal payments in a week are real.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { roundOre } from '@/lib/money'
import { formatAmount } from '@/lib/utils'
import { formatVoucher } from '@/lib/bookkeeping/voucher-series-resolver'
import { isBankRangeAccount } from '@/lib/transactions/booking-duplicate-detection'
import { addDaysIso } from '@/lib/dates/iso'
import type { PlausibilityLine, VoucherWarning } from './voucher-plausibility'

export interface DuplicateCheckInput {
  entry_date: string
  description: string
  lines: readonly PlausibilityLine[]
}

/** ± days a booked bank row may lie from the voucher date and still be the same money (the bank guard's voucher window). */
const BANK_ROW_WINDOW_DAYS = 7
/** Posted verifikat on one date read for the same-voucher comparison. */
const SAME_DAY_LIMIT = 500
/** Rows of one amount on one account inside the window, booked or not. */
const BANK_ROW_LIMIT = 20

function normalizedText(text: string): string {
  return text.trim().replace(/\s+/g, ' ').toLowerCase()
}

/** The verifikat's amounts as a sorted multiset in öre, accounts left out. */
function amountKey(lines: ReadonlyArray<{ debit_amount: number | string; credit_amount: number | string }>): string {
  return lines
    .map((l) => {
      const debit = Math.round(Number(l.debit_amount) * 100)
      return debit > 0 ? `D${debit}` : `C${Math.round(Number(l.credit_amount) * 100)}`
    })
    .sort()
    .join(',')
}

async function findSameVoucher(
  supabase: SupabaseClient,
  companyId: string,
  input: DuplicateCheckInput,
  excludeJournalEntryId: string | undefined,
): Promise<VoucherWarning | null> {
  const text = normalizedText(input.description)
  if (!text) return null
  const { data, error } = await supabase
    .from('journal_entries')
    .select('id, voucher_series, voucher_number, description, lines:journal_entry_lines(debit_amount, credit_amount)')
    .eq('company_id', companyId)
    .eq('entry_date', input.entry_date)
    .eq('status', 'posted')
    .order('created_at', { ascending: true })
    .limit(SAME_DAY_LIMIT)
  if (error) throw new Error(`same-day vouchers: ${error.message}`)

  const key = amountKey(input.lines)
  type Row = { id: string; voucher_series: string | null; voucher_number: number | null; description: string | null; lines: Array<{ debit_amount: number; credit_amount: number }> | null }
  const twin = ((data ?? []) as Row[]).find(
    (row) => row.id !== excludeJournalEntryId && normalizedText(row.description ?? '') === text && amountKey(row.lines ?? []) === key,
  )
  if (!twin) return null
  const voucher = formatVoucher(twin)
  return {
    code: 'POSSIBLE_DUPLICATE_VOUCHER',
    message_sv: `Verifikation ${voucher} har samma datum, text och belopp. Bokför inte samma affärshändelse två gånger: är den befintliga fel, rätta den i stället för att bokföra en ny.`,
    message_en: `Voucher ${voucher} has the same date, text and amounts. Do not book one business event twice: if the existing voucher is wrong, correct it instead of posting a new one.`,
    details: { journal_entry_id: twin.id, voucher, entry_date: input.entry_date },
  }
}

async function findBookedBankRow(
  supabase: SupabaseClient,
  companyId: string,
  input: DuplicateCheckInput,
): Promise<VoucherWarning | null> {
  const bankLines = input.lines.filter((l) => isBankRangeAccount(l.account_number))
  if (bankLines.length === 0) return null

  const accounts = [...new Set(bankLines.map((l) => l.account_number))]
  const { data: cashAccounts, error: cashError } = await supabase
    .from('cash_accounts')
    .select('id, ledger_account')
    .eq('company_id', companyId)
    .in('ledger_account', accounts)
  if (cashError) throw new Error(`cash accounts: ${cashError.message}`)

  for (const line of bankLines) {
    const signed = roundOre((Number(line.debit_amount) || 0) - (Number(line.credit_amount) || 0))
    const cashIds = ((cashAccounts ?? []) as Array<{ id: string; ledger_account: string }>)
      .filter((c) => c.ledger_account === line.account_number)
      .map((c) => c.id)
    if (signed === 0 || cashIds.length === 0) continue

    const { data: rows, error } = await supabase
      .from('transactions')
      .select('id, date, amount, description')
      .eq('company_id', companyId)
      .in('cash_account_id', cashIds)
      .eq('amount', signed)
      .or('currency.is.null,currency.eq.SEK')
      .gte('date', addDaysIso(input.entry_date, -BANK_ROW_WINDOW_DAYS))
      .lte('date', addDaysIso(input.entry_date, BANK_ROW_WINDOW_DAYS))
      .limit(BANK_ROW_LIMIT)
    if (error) throw new Error(`bank rows: ${error.message}`)
    const candidates = (rows ?? []) as Array<{ id: string; date: string; amount: number; description: string | null }>
    if (candidates.length === 0) continue

    // The live verifikat that book these rows, however they are anchored.
    const { data: anchors, error: anchorError } = await supabase
      .from('bank_row_anchors')
      .select('transaction_id, journal_entry_id')
      .eq('company_id', companyId)
      .in('transaction_id', candidates.map((c) => c.id))
    if (anchorError) throw new Error(`bank row anchors: ${anchorError.message}`)
    const anchorOf = new Map(((anchors ?? []) as Array<{ transaction_id: string; journal_entry_id: string }>).map((a) => [a.transaction_id, a.journal_entry_id]))
    const hit = candidates.find((c) => anchorOf.has(c.id))
    if (!hit) continue
    const journalEntryId = anchorOf.get(hit.id)!

    const { data: entry, error: entryError } = await supabase
      .from('journal_entries')
      .select('id, voucher_series, voucher_number')
      .eq('company_id', companyId)
      .eq('id', journalEntryId)
      .maybeSingle()
    if (entryError) throw new Error(`bank row vouchers: ${entryError.message}`)
    if (!entry) continue

    const voucher = formatVoucher(entry as { voucher_series: string | null; voucher_number: number | null })
    const amount = `${formatAmount(Math.abs(signed))} kr`
    return {
      code: 'BANK_MOVEMENT_ALREADY_BOOKED',
      message_sv: `Bankraden ${hit.date} på ${amount} på konto ${line.account_number} är redan bokförd som ${voucher}. Samma pengar bokförs bara en gång: hör underlaget till den raden, koppla det till ${voucher} i stället.`,
      message_en: `The bank row of ${hit.date} for ${amount} on account ${line.account_number} is already booked as ${voucher}. The same money is booked once: if the underlag belongs to that row, attach it to ${voucher} instead.`,
      details: { transaction_id: hit.id, transaction_date: hit.date, amount: signed, account: line.account_number, journal_entry_id: journalEntryId, voucher },
    }
  }
  return null
}

export async function detectVoucherDuplicates(
  supabase: SupabaseClient,
  companyId: string,
  input: DuplicateCheckInput,
  options: { excludeJournalEntryId?: string } = {},
): Promise<VoucherWarning[]> {
  const [sameVoucher, bankRow] = await Promise.all([
    findSameVoucher(supabase, companyId, input, options.excludeJournalEntryId),
    findBookedBankRow(supabase, companyId, input),
  ])
  return [sameVoucher, bankRow].filter((w): w is VoucherWarning => w !== null)
}
