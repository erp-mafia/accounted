import type { SupabaseClient } from '@supabase/supabase-js'
import { resolveCompanyEntityType, resultClosingAccounts } from '@/lib/company/entity-type'
import { createJournalEntry } from '@/lib/bookkeeping/engine'
import { roundOre, ORE_TOLERANCE } from '@/lib/bokslut/rounding'
import { addDaysIso } from '@/lib/dates/iso'
import { createLogger } from '@/lib/logger'
import type {
  CreateJournalEntryLineInput,
  EntityType,
  JournalEntry,
  ResultAppropriationPreview,
} from '@/types'
import { carryAfterDispositions, priorResultCarry, type PriorResultCarry } from './prior-result-carry'
import { findNextPeriod } from './period-service'

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
  /** The form's "årets resultat" account (AB 2099, ideell förening 2069). */
  resultAccount: string
  /** Where last year's result is carried (AB 2098, ideell förening 2068). */
  priorResultAccount: string
  /**
   * Amount carried, credit-positive (a profit is > 0, a loss is < 0): the
   * result account's IB balance less what a disposition booked by hand in the
   * period already moved.
   */
  net: number
  /** Absolute, öre-rounded amount that moves between the two accounts. */
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
 *  - the period already has a POSTED result_appropriation entry (idempotency;
 *    a reversed one has been stornoed, no longer moves any balance, and must
 *    not block re-planning: the year-end undo flow reverses the omföring and
 *    the subsequent re-run has to be able to post a fresh one), or
 *  - 2099 carries no balance (within ORE_TOLERANCE), or
 *  - the automatic omföring or a disposition booked by hand in the period
 *    already moved it (see priorResultCarry).
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
  const entityType = await resolveCompanyEntityType(supabase, companyId, settings?.entity_type)
  // Only forms that close into a dedicated "årets resultat" account carry it
  // forward: AB 2099 -> 2098, ideell förening 2069 -> 2068. An enskild firma
  // closes straight into 2010 and has nothing to reclassify.
  const accounts = resultClosingAccounts(entityType)
  if (!accounts.priorYearCarry) return null

  if (await hasLiveAppropriation(supabase, companyId, periodId)) return null

  const { data: period } = await supabase
    .from('fiscal_periods')
    .select('period_start, name, opening_balance_entry_id')
    .eq('id', periodId)
    .eq('company_id', companyId)
    .single()
  if (!period) throw new Error('Fiscal period not found')

  // What is still carried on the result account: its ingående balans less
  // what a disposition already booked in this period moved (by the owner, or
  // the old system's vinstdisposition arriving by SIE). Carry only that, and
  // nothing when it is all moved: the omföring duplicated a disposition booked
  // before the close (PostHog PH 108). Same computation the readiness check uses.
  const carry = await priorResultCarry(supabase, companyId, { id: periodId, ...period }, entityType)
  if (!carry || carry.remaining === 0) {
    if (carry && carry.ibNet !== 0) {
      log.info('Prior result already disposed; no automatic omföring', {
        operation: 'result_appropriation.skip_disposed',
        companyId,
        entityType: 'fiscal_period',
        entityId: periodId,
        vouchers: carry.movedBy,
      })
    }
    return null
  }

  return {
    periodId,
    periodName: period.name,
    periodStart: period.period_start,
    ...omforingFor(carry),
  }
}

/**
 * The omföring that moves what is still carried (`carry.remaining`, non-zero)
 * off the result account onto the carry account. Pure: the close posts it
 * (planResultAppropriation) and the year-end previews disclose it
 * (previewResultAppropriation), so the two cannot differ.
 */
function omforingFor(
  carry: PriorResultCarry,
): Pick<ResultAppropriationPlan, 'resultAccount' | 'priorResultAccount' | 'net' | 'amount' | 'direction' | 'lines'> {
  const { resultAccount, priorResultAccount } = carry
  const net = carry.remaining
  const amount = roundOre(Math.abs(net))
  const lines: CreateJournalEntryLineInput[] =
    net > 0
      ? [
          // Profit: move the credit balance off the result account onto the carry.
          {
            account_number: resultAccount,
            debit_amount: amount,
            credit_amount: 0,
            line_description: 'Omföring av föregående års resultat',
          },
          {
            account_number: priorResultAccount,
            debit_amount: 0,
            credit_amount: amount,
            line_description: 'Föregående års resultat',
          },
        ]
      : [
          // Loss: move the debit balance off the result account onto the carry.
          {
            account_number: priorResultAccount,
            debit_amount: amount,
            credit_amount: 0,
            line_description: 'Föregående års resultat',
          },
          {
            account_number: resultAccount,
            debit_amount: 0,
            credit_amount: amount,
            line_description: 'Omföring av föregående års resultat',
          },
        ]
  return { resultAccount, priorResultAccount, net, amount, direction: net > 0 ? 'profit' : 'loss', lines }
}

/**
 * Idempotency: whether the period already has a LIVE omföring. Deliberately
 * posted-only: a reversed omföring is storno-cancelled (net zero effect on
 * 2099), so it must not block the re-run after an administrative year-end undo
 * (scripts/undo-year-end-closing.ts).
 */
async function hasLiveAppropriation(
  supabase: SupabaseClient,
  companyId: string,
  periodId: string,
): Promise<boolean> {
  const { data: existing } = await supabase
    .from('journal_entries')
    .select('id')
    .eq('company_id', companyId)
    .eq('fiscal_period_id', periodId)
    .eq('source_type', 'result_appropriation')
    .eq('status', 'posted')
    .limit(1)
    .maybeSingle()
  return Boolean(existing)
}

/**
 * The omföring the year-end close will book in the next period, disclosed
 * before the close (feedback seq 707985: run_year_end booked one the owner's
 * migrated books had already made, and no preview had said it would).
 *
 * Same rule as planResultAppropriation, applied to the next period's ingående
 * balans as the close will write it: `projectedIbNet` is this period's closing
 * balance on the result account after the closing entry. The next period may
 * not exist yet (the close creates it); when it does, a disposition already
 * booked there counts exactly as it will after the close. Null for forms that
 * close straight into equity (enskild firma) and when there is nothing to move.
 */
export async function previewResultAppropriation(
  supabase: SupabaseClient,
  companyId: string,
  closing: { periodId: string; periodEnd: string; entityType: EntityType; projectedIbNet: number },
): Promise<ResultAppropriationPreview | null> {
  const accounts = resultClosingAccounts(closing.entityType)
  if (!accounts.priorYearCarry || Math.abs(closing.projectedIbNet) < ORE_TOLERANCE) return null

  const next = await findNextPeriod(supabase, companyId, closing.periodId)
  const base = {
    from_account: accounts.closing,
    to_account: accounts.priorYearCarry,
    direction: closing.projectedIbNet > 0 ? ('profit' as const) : ('loss' as const),
    // The close creates a missing next period starting the day after this one.
    entry_date: next?.period_start ?? addDaysIso(closing.periodEnd, 1),
  }
  if (next && (await hasLiveAppropriation(supabase, companyId, next.id))) {
    return { ...base, amount: 0, skipped_reason: 'already_booked', disposed_by: [] }
  }

  const carry = await carryAfterDispositions(
    supabase,
    companyId,
    next?.id ?? null,
    closing.entityType,
    closing.projectedIbNet,
  )
  if (!carry || carry.ibNet === 0) return null
  if (carry.remaining === 0) {
    return { ...base, amount: 0, skipped_reason: 'already_disposed', disposed_by: carry.movedBy }
  }
  return { ...base, amount: omforingFor(carry).amount, skipped_reason: null, disposed_by: carry.movedBy }
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
    description: `Omföring av föregående års resultat (${plan.resultAccount} → ${plan.priorResultAccount})`,
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
