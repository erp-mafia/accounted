/**
 * An API key's unattended ceiling (api_keys.unattended_commit_limit) at the
 * engine: while a key credential acts, no verifikat above its ceiling is
 * committed. The ceiling rides on the commit actor of the surrounding
 * runWithActor() scope (actor-context.ts), which every door binds for the
 * request: withApiV1 for every v1 route, so a new route is covered without
 * doing anything. The engine's commit doors ask here before a voucher number
 * is drawn, so a refusal posts nothing and leaves no gap (BFL 5 kap. 7 §).
 *
 * Where the rest of the ceiling lives, so each check has one home:
 *   - a staged operation is priced on its preview by commitPendingOperation
 *     before its claim, and the refusal keeps it pending for a person. Its
 *     dispatch runs without the ceiling: the operation is the unit that was
 *     approved, and a refusal inside the claim would consume it;
 *   - a v1 operation write is priced the same way, on the preview its staged
 *     twin would carry (lib/operations/v1.ts). That covers the SQL posting
 *     functions (bulk booking, batch allocation, voucher links, payouts,
 *     set-off, the IB cascade), which draft and commit inside one database
 *     call and are reached by a key only through an operation;
 *   - an attest, which posts nothing but releases a supplier invoice for
 *     payment, is priced by the attest service on the invoice's SEK total;
 *   - an act that posts several verifikat asks for all of them before the
 *     first (a voucher set, a correction, a bank match's payment), and one
 *     whose amounts are only known as it posts them, a year-end close, is
 *     refused outright.
 *
 * Like the rest of the ceiling this is a blast-radius cap on a looping or
 * prompt-injected agent, not a security boundary (unattended-limit.ts).
 *
 * Isomorphic like engine.ts, which imports it.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { roundOre } from '@/lib/money'
import { unattendedCeiling } from '@/lib/pending-operations/unattended-limit'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { getActor, type CommitActor } from './actor-context'
import { UnattendedCommitLimitExceededError } from './errors'

/** The ceiling binding the actor (default: the current scope's), or null. */
export function actorUnattendedCeiling(actor: CommitActor | undefined = getActor()): number | null {
  return unattendedCeiling(actor?.type, actor?.unattendedCommitLimit)
}

/**
 * The refusal for `amount` SEK, or null when no ceiling binds the actor or
 * the amount is within it.
 */
export function unattendedCeilingRefusal(
  amount: number,
  actor: CommitActor | undefined = getActor(),
): UnattendedCommitLimitExceededError | null {
  const ceiling = actorUnattendedCeiling(actor)
  if (ceiling === null) return null
  const attempted = roundOre(Math.abs(amount))
  return attempted > ceiling ? new UnattendedCommitLimitExceededError(attempted, ceiling) : null
}

/**
 * A verifikat's amount: its debit side. Debits equal credits on any entry
 * that can be committed (the balance trigger enforces it), so one side is
 * the whole.
 */
export function debitTotal(lines: ReadonlyArray<{ debit_amount?: number | string | null }>): number {
  return roundOre(lines.reduce((sum, line) => sum + (Number(line.debit_amount) || 0), 0))
}

/** Throws when the lines' verifikat is above the acting key's ceiling. */
export function assertLinesWithinUnattendedCeiling(
  lines: ReadonlyArray<{ debit_amount?: number | string | null }>,
  actor: CommitActor | undefined = getActor(),
): void {
  const refusal = unattendedCeilingRefusal(debitTotal(lines), actor)
  if (refusal) throw refusal
}

/** An entry's amount (a draft's, or the original a storno reverses), read from its lines. */
export async function entryDebitTotal(supabase: SupabaseClient, entryId: string): Promise<number> {
  const lines = await fetchAllRows<{ id: string; debit_amount: number | null }>(
    ({ from, to }) =>
      supabase
        .from('journal_entry_lines')
        .select('id, debit_amount')
        .eq('journal_entry_id', entryId)
        .order('id')
        .range(from, to),
    // The sum is money: a regressed order must not double-count a line and
    // refuse a legitimate commit.
    { dedupeBy: (line) => line.id },
  )
  return debitTotal(lines)
}

/**
 * The refusal for committing this draft (or reversing this entry), or null.
 * Reads the lines only when a ceiling binds the actor, so a commit without
 * one costs nothing.
 */
export async function entryUnattendedCeilingRefusal(
  supabase: SupabaseClient,
  entryId: string,
  actor: CommitActor | undefined = getActor(),
): Promise<UnattendedCommitLimitExceededError | null> {
  if (actorUnattendedCeiling(actor) === null) return null
  return unattendedCeilingRefusal(await entryDebitTotal(supabase, entryId), actor)
}
