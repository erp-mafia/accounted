import type { SupabaseClient } from '@supabase/supabase-js'
import { cancelDraftEntry, commitEntry, createDraftEntry } from '@/lib/bookkeeping/engine'
import {
  applyDimensionRules,
  assertMandatoryDimensions,
  fetchActiveDimensionRules,
  isDimensionRuleExemptSource,
} from '@/lib/bookkeeping/dimension-rules'
import { BookkeepingDatabaseError } from '@/lib/bookkeeping/errors'
import { createLogger } from '@/lib/logger'
import type { CreateJournalEntryInput, JournalEntry } from '@/types'

const log = createLogger('bookkeeping.journal-entry-batch')

/**
 * Post a set of verifikationer that belong to one business event (a salary
 * run's lön, arbetsgivaravgifter, semesteravsättning and pension) so that a
 * refusal of ANY of them posts NONE of them.
 *
 * Calling createJournalEntry() once per voucher validates voucher k only after
 * vouchers 1..k-1 are posted and immutable: a refusal on voucher 2 (a
 * 'required' dimension rule on its account, an archived dimension value, a
 * deactivated account, a voucher that does not balance) leaves voucher 1 in
 * the ledger with the business event half booked. Here the engine's checks run
 * for the whole set before the first voucher number is taken:
 *
 *   1. the 'required' dimension rules commitEntry() enforces, asserted with
 *      the engine's own helpers on every voucher's lines after the
 *      default/fixed rules createDraftEntry() applies (one refusal names every
 *      missing value across the set);
 *   2. createDraftEntry() for every voucher: line sides, balance,
 *      default/fixed rules, registry validation including archived values,
 *      entry date inside the period, active accounts. A draft has no voucher
 *      number, so a refusal cancels the drafts made so far and nothing reaches
 *      the ledger;
 *   3. commitEntry() per draft, in order (numbers assigned atomically, and
 *      commitEntry re-checks the required rules as the authority).
 *
 * What remains is non-deterministic: a transient database error, a rule or
 * lock changed between the phases, the function stopped mid-commit. The
 * vouchers committed by then stay posted (a posted verifikat is never
 * deleted), the remaining drafts are cancelled and the error is rethrown. A
 * caller that can be retried must look up what an earlier attempt posted
 * instead of posting it again (createSalaryRunEntries does).
 */
export async function createJournalEntries(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  inputs: CreateJournalEntryInput[],
): Promise<JournalEntry[]> {
  if (inputs.length === 0) return []

  await assertRequiredDimensions(supabase, companyId, inputs)

  const drafts: JournalEntry[] = []
  try {
    for (const input of inputs) {
      const draft = await createDraftEntry(supabase, companyId, userId, input)
      if (!draft?.id) {
        throw new BookkeepingDatabaseError('create_draft_entry', 'the draft could not be read back')
      }
      drafts.push(draft)
    }
  } catch (err) {
    await cancelDrafts(supabase, companyId, userId, drafts)
    throw err
  }

  const posted: JournalEntry[] = []
  for (let i = 0; i < drafts.length; i++) {
    try {
      const committed = await commitEntry(supabase, companyId, userId, drafts[i].id)
      // commitEntry returns the reloaded row; the voucher is committed even
      // when that reload came back empty, so the draft row stands in for it.
      posted.push(committed ?? ({ ...drafts[i], status: 'posted' } as JournalEntry))
    } catch (err) {
      await cancelDrafts(supabase, companyId, userId, drafts.slice(i))
      if (posted.length > 0) {
        log.error('voucher set stopped partway: the earlier vouchers stay posted', err as Error, {
          companyId,
          userId,
          postedEntryIds: posted.map((entry) => entry.id),
          failedEntryId: drafts[i].id,
        })
      }
      throw err
    }
  }
  return posted
}

/**
 * The commit-time policy of commitEntry(), pulled in front of the whole set:
 * the same fetch, the same default/fixed application createDraftEntry()
 * performs, the same assertion. A failed rule fetch fails open exactly as in
 * the engine (commitEntry still checks again at commit).
 */
async function assertRequiredDimensions(
  supabase: SupabaseClient,
  companyId: string,
  inputs: CreateJournalEntryInput[],
): Promise<void> {
  const governed = inputs.filter((input) => !isDimensionRuleExemptSource(input.source_type))
  if (governed.length === 0) return
  const rules = await fetchActiveDimensionRules(supabase, companyId)
  if (!rules || !rules.some((rule) => rule.rule_type === 'required')) return
  assertMandatoryDimensions(
    governed.flatMap((input) => applyDimensionRules(input.lines, rules)),
    rules,
  )
}

async function cancelDrafts(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  drafts: JournalEntry[],
): Promise<void> {
  for (const draft of drafts) {
    try {
      await cancelDraftEntry(supabase, companyId, userId, draft.id)
    } catch (cancelError) {
      log.error('draft cleanup failed (a phantom draft remains)', cancelError as Error, {
        companyId,
        entityType: 'journal_entry',
        entityId: draft.id,
      })
    }
  }
}
