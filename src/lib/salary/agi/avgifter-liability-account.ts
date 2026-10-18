import type { SupabaseClient } from '@supabase/supabase-js'
import { addMonthsIso } from '@/lib/dates/iso'
import { createLogger } from '@/lib/logger'
import { roundOre } from '@/lib/money'
import { SALARY_ACCOUNTS } from '@/lib/salary/account-mapping'

const log = createLogger('salary/agi/avgifter-liability-account')

/**
 * Which account a company carries its arbetsgivaravgifter liability on.
 *
 * BAS offers two for the same liability: 2731 Avräkning lagstadgade sociala
 * avgifter, what the salary module credits (SALARY_ACCOUNTS.AVGIFTER_LIABILITY),
 * and the group account 2730 Lagstadgade sociala avgifter och särskild
 * löneskatt, what many other payroll systems book and what their SIE files
 * bring in. swedish-payroll (references/bas-7xxx.md): use 2731 or 2730
 * consistently, never both in one company. So when Skatteverket draws the
 * avgifter from the skattekonto, the draw must clear the account the
 * liability was booked on; clearing the other one leaves 2730 and 2731 with
 * opposite balances that are only right in sum (issue #1870, accounted#68).
 */
export const AVGIFTER_LIABILITY_GROUP_ACCOUNT = '2730'

/** The two accounts the liability can sit on: the salary module's first. */
export const AVGIFTER_LIABILITY_ACCOUNTS: readonly string[] = Object.freeze([
  SALARY_ACCOUNTS.AVGIFTER_LIABILITY,
  AVGIFTER_LIABILITY_GROUP_ACCOUNT,
])

/**
 * How far back the latest liability booking is looked for. A month's avgifter
 * are drawn the month after (SFL 62 kap. 3 §), and a company that pays one
 * salary a year still has it inside thirteen months.
 */
const LOOKBACK_MONTHS = 13

/** The newest verifikat read: a month carries about one credit and one draw. */
const LOOKBACK_ENTRIES = 50

interface LiabilityLine {
  account_number: string
  debit_amount: number | string | null
  credit_amount: number | string | null
}

export interface AvgifterLiabilityEntry {
  entry_date: string
  journal_entry_lines: LiabilityLine[] | null
}

/**
 * The liability account one verifikat leaves the liability on: the one
 * account it nets a credit to. A salary or avgifter booking credits one; a
 * move between the two (an omföring) credits the account it moves the
 * liability to. Null when it is no liability booking: it only debits (a draw
 * or a payment), or it credits both (an ingående balans that carries both),
 * which says nothing about which one the company uses.
 */
function creditedLiabilityAccount(lines: LiabilityLine[]): string | null {
  const netCredit = new Map<string, number>()
  for (const line of lines) {
    if (!AVGIFTER_LIABILITY_ACCOUNTS.includes(line.account_number)) continue
    netCredit.set(
      line.account_number,
      (netCredit.get(line.account_number) ?? 0) + Number(line.credit_amount || 0) - Number(line.debit_amount || 0),
    )
  }
  const credited = [...netCredit].filter(([, net]) => roundOre(net) > 0).map(([account]) => account)
  return credited.length === 1 ? credited[0] : null
}

/**
 * Pure core: the account of the newest liability booking among `entries`
 * (newest first). Null when none credits the liability, or when the newest
 * date holds bookings on both accounts: no single answer, so the caller
 * keeps its own account.
 */
export function pickAvgifterLiabilityAccount(entries: AvgifterLiabilityEntry[]): string | null {
  let newestDate: string | null = null
  const found = new Set<string>()
  for (const entry of entries) {
    if (newestDate !== null && entry.entry_date !== newestDate) break
    const account = creditedLiabilityAccount(entry.journal_entry_lines ?? [])
    if (!account) continue
    newestDate = entry.entry_date
    found.add(account)
  }
  return found.size === 1 ? [...found][0] : null
}

/**
 * The account the company's own avgifter liability was last booked on, on or
 * before `cutoffDate`: 2731 after a salary run here, 2730 when the company's
 * payroll (or the SIE history it brought) books the group account. The
 * ingående balans counts (it carries last year's liability into the first
 * draw of the year). Skattekonto verifikat (source_type system) and storno
 * entries are left out: neither books the liability, and the skattekonto's
 * own earlier draws must not vote for the account they were booked on.
 *
 * Null when nothing within the lookback credits either account, or on a
 * failed read: the caller keeps its default.
 */
export async function findAvgifterLiabilityAccount(
  supabase: SupabaseClient,
  companyId: string,
  cutoffDate: string,
): Promise<string | null> {
  const { data, error } = await supabase
    .from('journal_entries')
    .select('entry_date, journal_entry_lines!inner(account_number, debit_amount, credit_amount)')
    .eq('company_id', companyId)
    .eq('status', 'posted')
    .not('source_type', 'in', '(system,storno)')
    .lte('entry_date', cutoffDate)
    .gte('entry_date', addMonthsIso(cutoffDate, -LOOKBACK_MONTHS))
    .in('journal_entry_lines.account_number', [...AVGIFTER_LIABILITY_ACCOUNTS])
    .order('entry_date', { ascending: false })
    .limit(LOOKBACK_ENTRIES)
  if (error) {
    log.warn('avgifter liability account read failed', { companyId, cutoffDate, error: error.message })
    return null
  }
  return pickAvgifterLiabilityAccount((data ?? []) as AvgifterLiabilityEntry[])
}
