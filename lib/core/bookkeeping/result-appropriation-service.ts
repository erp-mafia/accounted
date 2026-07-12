import type { SupabaseClient } from '@supabase/supabase-js'
import { createJournalEntry } from '@/lib/bookkeeping/engine'
import { getOpeningBalances } from '@/lib/reports/opening-balances'
import { roundOre, ORE_TOLERANCE } from '@/lib/bokslut/rounding'
import { createLogger } from '@/lib/logger'
import type { JournalEntry, CreateJournalEntryLineInput } from '@/types'

const log = createLogger('result-appropriation-service')

/** Årets resultat (current-year result, aktiebolag). */
export const RESULT_ACCOUNT = '2099'
/** Vinst eller förlust från föregående år. */
export const PRIOR_RESULT_ACCOUNT = '2098'

export interface ResultAppropriationPlan {
  periodId: string
  periodName: string
  /** entry_date for the omföring: the new period's first day. */
  periodStart: string
  /** Net 2099 balance, credit-positive (a profit is > 0, a loss is < 0). */
  net: number
  /** Absolute, öre-rounded amount that moves between 2099 and 2098. */
  amount: number
  direction: 'profit' | 'loss'
  /** Balanced lines for the omföring verifikat. */
  lines: CreateJournalEntryLineInput[]
}

/**
 * Read-only computation of the year-open omföring (no writes). Returns the plan
 * to move 2099 "Årets resultat" onto 2098 "Vinst eller förlust från föregående
 * år", or null when there is nothing to do.
 *
 * Returns null when:
 *  - the company is not an aktiebolag (enskild firma books to 2010, no 2099),
 *  - the period already has a result_appropriation entry (idempotency), or
 *  - 2099 carries no balance (within ORE_TOLERANCE).
 *
 * Shared by generateResultAppropriation (which posts the plan) and the
 * retroactive catch-up script (which previews it in dry-run) so the preview
 * and the committed entry can never diverge.
 */
export async function planResultAppropriation(
  supabase: SupabaseClient,
  companyId: string,
  periodId: string,
): Promise<ResultAppropriationPlan | null> {
  // Aktiebolag only. Same resolution as previewYearEndClosing's closing-account
  // decision, so the omföring runs exactly when the result was posted to 2099.
  const { data: settings } = await supabase
    .from('company_settings')
    .select('entity_type')
    .eq('company_id', companyId)
    .maybeSingle()
  const entityType = settings?.entity_type ?? 'aktiebolag'
  if (entityType !== 'aktiebolag') return null

  // Idempotency: never plan a second omföring for a period that already has one.
  const { data: existing } = await supabase
    .from('journal_entries')
    .select('id')
    .eq('company_id', companyId)
    .eq('fiscal_period_id', periodId)
    .eq('source_type', 'result_appropriation')
    .in('status', ['posted', 'reversed'])
    .limit(1)
    .maybeSingle()
  if (existing) return null

  const { data: period } = await supabase
    .from('fiscal_periods')
    .select('period_start, name, opening_balance_entry_id')
    .eq('id', periodId)
    .eq('company_id', companyId)
    .single()
  if (!period) throw new Error('Fiscal period not found')

  // Read 2099 from the period's INGÅENDE BALANS only: the carried-forward
  // prior result that the IB entry mirrored from last year's UB: NOT the full
  // trial balance. The omföring must reclassify exactly that carried amount;
  // scoping to IB makes it correct even when the period already has current-year
  // 2099 activity (e.g. the retroactive catch-up script running mid-year, where
  // closing = IB + activity would over/under-reclassify). getOpeningBalances
  // reads the committed opening_balance entry, falling back to a server-side
  // aggregate of prior posted lines when none is set. credit − debit is positive
  // for a profit (2099 is credit-normal).
  const { balances } = await getOpeningBalances(supabase, companyId, period)
  const ib2099 = balances.get(RESULT_ACCOUNT)
  const net = ib2099 ? roundOre(ib2099.credit - ib2099.debit) : 0
  if (Math.abs(net) < ORE_TOLERANCE) return null

  const amount = roundOre(Math.abs(net))
  const lines: CreateJournalEntryLineInput[] =
    net > 0
      ? [
          // Profit: move the credit balance off 2099 onto 2098.
          {
            account_number: RESULT_ACCOUNT,
            debit_amount: amount,
            credit_amount: 0,
            line_description: 'Omföring av föregående års resultat',
          },
          {
            account_number: PRIOR_RESULT_ACCOUNT,
            debit_amount: 0,
            credit_amount: amount,
            line_description: 'Föregående års resultat',
          },
        ]
      : [
          // Loss: move the debit balance off 2099 onto 2098.
          {
            account_number: PRIOR_RESULT_ACCOUNT,
            debit_amount: amount,
            credit_amount: 0,
            line_description: 'Föregående års resultat',
          },
          {
            account_number: RESULT_ACCOUNT,
            debit_amount: 0,
            credit_amount: amount,
            line_description: 'Omföring av föregående års resultat',
          },
        ]

  return {
    periodId,
    periodName: period.name,
    periodStart: period.period_start,
    net,
    amount,
    direction: net > 0 ? 'profit' : 'loss',
    lines,
  }
}

/**
 * Omföring av föregående års resultat: reclassify 2099 at new-year open.
 *
 * After a new fiscal year's opening balances are generated, account 2099
 * "Årets resultat" carries the prior year's result forward (the IB entry is a
 * faithful mirror of the prior period's UB). Per BAS practice the prior result
 * must not remain on 2099: each year must start with 2099 = 0 so it only ever
 * holds the *current* year's result. This posts the year-open reclassification
 * as a SEPARATE verifikat in the new period:
 *
 *   profit (2099 has a credit balance):  Dr 2099 / Cr 2098
 *   loss   (2099 has a debit balance):   Dr 2098 / Cr 2099
 *
 * It is deliberately NOT folded into the opening-balance entry. The IB entry
 * must stay a faithful mirror of the prior UB, or validateBalanceContinuity():
 * which reads IB solely from the period's opening_balance entry, would flag
 * 2099 and 2098 as discrepancies and executeYearEndClosing would self-reverse.
 * A standalone entry is invisible to that check.
 *
 * The further disposition 2098 → 2091 (balanserat resultat) / 2898 (utdelning)
 * is the bolagsstämma's decision and is intentionally left to a separate step.
 *
 * Idempotent / AB-only: see planResultAppropriation for the no-op conditions.
 * Powers both executeYearEndClosing (steady state) and the retroactive
 * catch-up script (clears any accumulated 2099 in a company's open period).
 */
export async function generateResultAppropriation(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  periodId: string,
): Promise<JournalEntry | null> {
  const plan = await planResultAppropriation(supabase, companyId, periodId)
  if (!plan) return null

  const entry = await createJournalEntry(supabase, companyId, userId, {
    fiscal_period_id: periodId,
    entry_date: plan.periodStart,
    description: `Omföring av föregående års resultat (${RESULT_ACCOUNT} → ${PRIOR_RESULT_ACCOUNT})`,
    source_type: 'result_appropriation',
    voucher_series: 'A',
    lines: plan.lines,
  })

  log.info('Posted result appropriation omföring', {
    operation: 'result_appropriation.post',
    companyId,
    entityType: 'journal_entry',
    entityId: entry.id,
    amount: plan.amount,
    direction: plan.direction,
  })

  return entry
}
