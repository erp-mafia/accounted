import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * The posted verifikat of a booked (or corrected) salary run, read back from
 * journal_entries. The run page's journal section and the per-run
 * bokföringsunderlag PDF both print these, never a recomputed projection: a
 * preview built by today's booking rules would contradict an immutable
 * voucher booked under earlier rules (e.g. the 2731/3740 whole-krona split).
 */

export interface PostedSalaryEntryLine {
  account_number: string
  line_description: string
  debit_amount: number | null
  credit_amount: number | null
}

export interface PostedSalaryEntry {
  description: string
  /** The verifikat id, so a reader can open it. */
  journal_entry_id: string
  /** "A-12", or null when the entry has no voucher number. */
  voucher: string | null
  lines: PostedSalaryEntryLine[]
}

export interface PostedSalaryRunEntries {
  salaryEntry: PostedSalaryEntry | null
  avgifterEntry: PostedSalaryEntry | null
  vacationEntry: PostedSalaryEntry | null
  pensionEntry: PostedSalaryEntry | null
}

export interface PostedSalaryRunRef {
  id: string
  salary_entry_id?: string | null
  avgifter_entry_id?: string | null
  vacation_entry_id?: string | null
  pension_entry_id?: string | null
}

export class PostedSalaryEntriesReadError extends Error {
  constructor(cause: unknown) {
    super('Kunde inte läsa lönekörningens bokförda verifikat')
    this.name = 'PostedSalaryEntriesReadError'
    this.cause = cause
  }
}

/**
 * Loads the run's posted entries keyed by the run's entry ids. Throws
 * PostedSalaryEntriesReadError on a failed lookup: that must not masquerade
 * as "booked run with no vouchers".
 */
export async function loadPostedSalaryRunEntries(
  supabase: SupabaseClient,
  companyId: string,
  run: PostedSalaryRunRef,
): Promise<PostedSalaryRunEntries> {
  const { data: posted, error } = await supabase
    .from('journal_entries')
    .select(
      'id, description, voucher_series, voucher_number, lines:journal_entry_lines(account_number, line_description, debit_amount, credit_amount)',
    )
    .eq('company_id', companyId)
    .eq('source_type', 'salary_payment')
    .eq('source_id', run.id)

  if (error) throw new PostedSalaryEntriesReadError(error)

  const byId = new Map(((posted ?? []) as Array<{ id: string }>).map((e) => [e.id, e] as const))
  const toEntry = (entryId: string | null | undefined): PostedSalaryEntry | null => {
    const entry = entryId
      ? (byId.get(entryId) as
          | {
              description: string
              voucher_series: string | null
              voucher_number: number | null
              lines: Array<{
                account_number: string
                line_description: string | null
                debit_amount: number | null
                credit_amount: number | null
              }>
            }
          | undefined)
      : undefined
    if (!entry || !entryId) return null
    const voucher =
      entry.voucher_number != null
        ? `${entry.voucher_series ?? ''}${entry.voucher_series ? '-' : ''}${entry.voucher_number}`
        : null
    return {
      description: entry.description,
      journal_entry_id: entryId,
      voucher,
      lines: entry.lines.map((l) => ({
        account_number: l.account_number,
        line_description: l.line_description ?? '',
        debit_amount: l.debit_amount,
        credit_amount: l.credit_amount,
      })),
    }
  }

  return {
    salaryEntry: toEntry(run.salary_entry_id),
    avgifterEntry: toEntry(run.avgifter_entry_id),
    vacationEntry: toEntry(run.vacation_entry_id),
    pensionEntry: toEntry(run.pension_entry_id),
  }
}
