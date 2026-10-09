import type { SupabaseClient } from '@supabase/supabase-js'
import { formatVoucherLabel } from '@/lib/transactions/link-journal-entry'

/** The registry code a refused second IB answers with (structured-errors.ts). */
export const OPENING_BALANCE_EXISTS_CODE = 'OB_PERIOD_ALREADY_HAS_BALANCES'

export interface ExistingOpeningBalance {
  /** Null only when the year is flagged as having an IB but names no entry. */
  journal_entry_id: string | null
  voucher_label: string | null
  /**
   * True when fiscal_periods.opening_balance_entry_id points at this entry.
   * Only then can gnubok_correct_opening_balances replace it: that operation
   * reads the pointer and answers OB_CORRECT_NO_EXISTING without it.
   */
  linked: boolean
}

interface PeriodPointerRow {
  opening_balances_set: boolean | null
  opening_balance_entry_id: string | null
  opening_balance_entry?: { voucher_series?: string | null; voucher_number?: number | null } | null
}

/**
 * The fiscal year's existing ingående balans, or null when it has none.
 *
 * Two sources, because neither alone is proof: the period pointer
 * (opening_balances_set / opening_balance_entry_id) is set by the IB flows
 * and the year-end close, while an IB booked through gnubok_create_voucher
 * with is_opening_balance, or one a replaced SIE import left behind, is a
 * posted source_type='opening_balance' entry with no pointer. A reversed IB is
 * not counted: reverseEntry clears the pointer and the entry is no longer
 * 'posted', so storno then a new IB stays possible.
 *
 * Throws on a failed read so callers fail closed against a duplicate IB.
 */
export async function findExistingOpeningBalance(
  supabase: SupabaseClient,
  companyId: string,
  fiscalPeriodId: string,
): Promise<ExistingOpeningBalance | null> {
  const { data: period, error: periodError } = await supabase
    .from('fiscal_periods')
    .select(
      'opening_balances_set, opening_balance_entry_id, opening_balance_entry:journal_entries!opening_balance_entry_id(voucher_series, voucher_number)',
    )
    .eq('id', fiscalPeriodId)
    .eq('company_id', companyId)
    .maybeSingle()
  if (periodError) throw new Error(periodError.message)

  const pointer = (period as PeriodPointerRow | null) ?? null
  if (pointer?.opening_balance_entry_id) {
    const ref = pointer.opening_balance_entry
    return {
      journal_entry_id: pointer.opening_balance_entry_id,
      voucher_label: ref?.voucher_number ? formatVoucherLabel(ref.voucher_series, ref.voucher_number) : null,
      linked: true,
    }
  }

  const { data: entries, error: entriesError } = await supabase
    .from('journal_entries')
    .select('id, voucher_series, voucher_number')
    .eq('company_id', companyId)
    .eq('fiscal_period_id', fiscalPeriodId)
    .eq('source_type', 'opening_balance')
    .eq('status', 'posted')
    .order('voucher_number', { ascending: true })
    .limit(1)
  if (entriesError) throw new Error(entriesError.message)

  const first = (entries ?? [])[0] as
    | { id: string; voucher_series: string | null; voucher_number: number | null }
    | undefined
  if (first) {
    return {
      journal_entry_id: first.id,
      voucher_label: first.voucher_number ? formatVoucherLabel(first.voucher_series, first.voucher_number) : null,
      linked: false,
    }
  }

  if (pointer?.opening_balances_set) {
    return { journal_entry_id: null, voucher_label: null, linked: false }
  }
  return null
}

/**
 * Swedish refusal for a second IB in a year that already has one. A second IB
 * verifikat is read by every report as one IB plus one movement of the same
 * balances, so the year's balances count twice.
 */
export function existingOpeningBalanceMessage(existing: ExistingOpeningBalance): string {
  const which = existing.voucher_label ? ` (verifikation ${existing.voucher_label})` : ''
  const remedy = existing.linked
    ? 'Ändra den med gnubok_correct_opening_balances, eller makulera den med gnubok_reverse_journal_entry och bokför sedan en ny.'
    : 'Makulera den med gnubok_reverse_journal_entry och bokför sedan en ny.'
  return (
    `Räkenskapsåret har redan en ingående balans${which}. ` +
    'En andra IB-verifikation läses av rapporterna som IB plus en rörelse med samma belopp, så saldona räknas dubbelt. ' +
    remedy
  )
}
