import type { SupabaseClient } from '@supabase/supabase-js'
import { isAretsResultatAccount } from '@/lib/bookkeeping/bas-data/result-accounts'
import { roundOre } from '@/lib/money'
import { generateTrialBalance } from '@/lib/reports/trial-balance'
import { isIncomeTaxAccount } from './income-tax-accounts'

/** BAS classes 3-8, read as INK2 and result_closing_entry_ids read them. */
const isResultAccount = (account: string) => account >= '3' && account < '9'

/** BAS 88xx: bokslutsdispositioner. */
const DISPOSITION_PREFIX = '88'

export interface YearResult {
  /** Resultat efter finansiella poster: every result account but the dispositions and the tax. */
  beforeDispositions: number
  /** Resultat före skatt: the same with the booked dispositions in it. */
  beforeTax: number
}

/**
 * The year's result as the declaration and the årsredovisning read it: the
 * trial balance without the resultatavslut ('exclude-final', the view INK2R
 * and the resultaträkning are built from). Every result account counts,
 * whichever voucher booked it, because whatever the bokslut books carries
 * source_type 'year_end': depreciation and dispositions, but also the stock
 * count (49xx), pågående arbeten (3xxx), finance leases and the kontantmetod
 * cut-off. No list of accounts here: a new voucher type joins the tax base
 * the day it joins the declaration. The tax itself (the income-tax accounts,
 * INK2 3.25) and årets resultat (899x) stay out.
 *
 * The bolagsskatt and the periodiseringsfond's 25 % cap (IL 30 kap 5 §) both
 * start here: the result INK2S 4.1 starts from, with the tax added back (4.3a).
 */
export async function readYearResult(
  supabase: SupabaseClient,
  companyId: string,
  fiscalPeriodId: string,
): Promise<YearResult> {
  const { rows } = await generateTrialBalance(supabase, companyId, fiscalPeriodId, {
    closingEntry: 'exclude-final',
    // The chart only labels rows; the amounts never depend on it.
    chart: [],
  })
  let beforeDispositions = 0
  let dispositions = 0
  for (const row of rows) {
    const account = row.account_number
    if (!isResultAccount(account) || isIncomeTaxAccount(account) || isAretsResultatAccount(account)) continue
    const result = row.closing_credit - row.closing_debit
    if (account.startsWith(DISPOSITION_PREFIX)) dispositions += result
    else beforeDispositions += result
  }
  return {
    beforeDispositions: roundOre(beforeDispositions),
    beforeTax: roundOre(beforeDispositions + dispositions),
  }
}
