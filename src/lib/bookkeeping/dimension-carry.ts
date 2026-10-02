import type { SupabaseClient } from '@supabase/supabase-js'
import type { CreateJournalEntryLineInput } from '@/types'
import { roundOre } from '@/lib/money'

/**
 * Which dimension tags cross the fiscal-year boundary (issue #3313).
 *
 * The registry flag `dimensions.resets_annually` says it per dimension:
 * false = the dimension accumulates across years (projekt, SIE dimension 6:
 * a project's work in progress or receivable is still there on 1 January),
 * true = its balances start from zero every year (kostnadsställe and every
 * custom dimension by default). Every path that projects a line's bag onto
 * an opening balance (year-end IB, SIE #OIB import) keeps the accumulating
 * keys and drops the rest, as the substrate comment on the column asks
 * (migration 20260702084500): the year-end projection happens in SQL
 * (compute_object_closing_balances), the SIE import's in planObjectBalances.
 * Which accounts carry object balances at all: carriesObjectBalances.
 */

/**
 * Whether an account's opening balance is split per object. Every
 * balance-sheet account is, except the VAT accounts (BAS 26xx, moms): a
 * project-tagged invoice puts its bag on the output VAT line, but the VAT
 * settlement (momsredovisning) books 26xx untagged, so a per-project 26xx
 * balance never clears. Carried, it would put an offsetting project line and
 * untagged line into every future IB, growing each year. A 26xx IB is
 * therefore always one untagged line (founder decision 2026-10-01). Account
 * numbers are identifiers: a prefix check on the string, never arithmetic.
 */
export function carriesObjectBalances(accountNumber: string): boolean {
  return !accountNumber.startsWith('26')
}

/**
 * The SIE convention the registry seeds (ensure_company_dimensions: 1 resets,
 * 6 accumulates; the SIE import creates custom dimensions resetting). Used
 * only where no company registry can be consulted, e.g. the SIE preview.
 */
export const DEFAULT_ACCUMULATING_DIMENSIONS: ReadonlySet<string> = new Set(['6'])

/**
 * The company's accumulating dimensions as SIE dimension numbers ('6').
 * Throws on a read error: callers choose their own fallback, because a
 * silent empty set would drop every project tag from the IB.
 */
export async function fetchAccumulatingDimensions(
  supabase: SupabaseClient,
  companyId: string
): Promise<ReadonlySet<string>> {
  const { data, error } = await supabase
    .from('dimensions')
    .select('sie_dim_no')
    .eq('company_id', companyId)
    .eq('resets_annually', false)
  if (error) throw new Error(`Failed to read the dimension registry: ${error.message}`)
  return new Set(((data ?? []) as Array<{ sie_dim_no: number | string }>).map((row) => String(Number(row.sie_dim_no))))
}

/** Stable identity of a bag: keys in numeric order. '' for the empty bag. */
export function dimensionBagKey(bag: Record<string, string>): string {
  const keys = Object.keys(bag).sort((a, b) => Number(a) - Number(b))
  return keys.length === 0 ? '' : JSON.stringify(keys.map((key) => [key, bag[key]]))
}

export interface ObjectBalanceSplit {
  /** The object's bag, projected onto accumulating dimensions: {"6": "P1"}. */
  dimensions: Record<string, string>
  amount: number
}

/**
 * Split one account's balance into journal lines: one per object part plus
 * an untagged remainder (`total - sum(parts)`, any sign, omitted at zero).
 * The lines always net to `total`, so the entry's balance never moves.
 */
export function splitBalanceLines(
  targetAccount: string,
  total: number,
  parts: readonly ObjectBalanceSplit[] | undefined,
  lineDescription: string
): CreateJournalEntryLineInput[] {
  const lines: CreateJournalEntryLineInput[] = []
  const push = (amount: number, dimensions?: Record<string, string>) => {
    const rounded = roundOre(amount)
    if (rounded === 0) return
    lines.push({
      account_number: targetAccount,
      debit_amount: rounded > 0 ? rounded : 0,
      credit_amount: rounded < 0 ? Math.abs(rounded) : 0,
      line_description: lineDescription,
      ...(dimensions ? { dimensions } : {}),
    })
  }

  let tagged = 0
  for (const part of parts ?? []) {
    push(part.amount, part.dimensions)
    tagged = roundOre(tagged + roundOre(part.amount))
  }
  push(roundOre(total - tagged))
  return lines
}

