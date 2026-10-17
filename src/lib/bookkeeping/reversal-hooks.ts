/**
 * Reversal hooks: the business-state mirrors a storno must run.
 *
 * reverseEntry() restores the general ledger; some source types also leave
 * state outside it that must follow the storno (an invoice reads paid, a
 * ROT/RUT begäran reads reclaimed). Those mirrors are reversal hooks. This
 * file is the ledger's side of the contract and imports no block: the hook
 * list itself is wired in lib/composition/reversal-hooks.ts, which engine.ts
 * imports statically, so every runtime that can call reverseEntry has the
 * hooks (no lib/init, no event bus, no parameter a caller could leave empty).
 *
 * A hook's beforeReversal runs before anything is written and may throw to
 * refuse the storno; its afterReversal runs after the storno is posted, the
 * original is marked reversed and the engine's own releases are done, and
 * before the journal_entry.committed / journal_entry.reversed emits. Nothing
 * catches a hook's throw: it propagates, the storno stands and the emits are
 * skipped.
 *
 * Hooks always run, whatever package switches a company has: they keep a
 * sub-ledger in step with the ledger, which is data integrity, not a
 * feature. correctEntry (storno plus rättelse) runs none of them.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import type { ModuleId } from '@/lib/modules/manifest'
import type { JournalEntry, JournalEntrySourceType } from '@/types'
import { ReversalHookMissingError } from '@/lib/bookkeeping/errors'

export { ReversalHookMissingError }

export interface ReversalHookContext {
  readonly supabase: SupabaseClient
  readonly companyId: string
  /** The posted original being reversed, with its lines, exactly as reverseEntry read it. */
  readonly entry: JournalEntry
}

export interface ReversalHook {
  /** Stable, kebab-case, unique in the list. */
  readonly id: string
  /** The module that owns the code the hook runs (lib/modules/manifest.ts). */
  readonly module: ModuleId
  /** The source types whose storno runs this hook. */
  readonly sourceTypes: readonly JournalEntrySourceType[]
  /** Before anything is written. A throw refuses the storno; no voucher number is spent. */
  beforeReversal?(ctx: ReversalHookContext): Promise<void>
  /** After the storno is posted and the original marked reversed, before the emits. */
  afterReversal?(ctx: ReversalHookContext): Promise<void>
}

/**
 * The source types whose storno must run a business-state mirror: exactly
 * the source types a hook covers today. A storno of one of these with no
 * registered hook is refused (selectReversalHooks).
 */
export const REVERSAL_MIRROR_REQUIRED: readonly JournalEntrySourceType[] = Object.freeze([
  'invoice_paid',
  'invoice_cash_payment',
  'supplier_invoice_paid',
  'supplier_invoice_cash_payment',
  'rot_rut_reclaim',
  'rot_rut_reclassification',
] satisfies JournalEntrySourceType[])

/**
 * The hooks in `all` that cover `sourceType`, in list order. Throws
 * ReversalHookMissingError when the source type is in
 * REVERSAL_MIRROR_REQUIRED and no hook covers it: reverseEntry calls this
 * before anything is written, so the refusal leaves nothing behind.
 */
export function selectReversalHooks(
  all: readonly ReversalHook[],
  sourceType: string | null | undefined,
): ReversalHook[] {
  if (!sourceType) return []
  const selected = all.filter((hook) => (hook.sourceTypes as readonly string[]).includes(sourceType))
  if (selected.length === 0 && (REVERSAL_MIRROR_REQUIRED as readonly string[]).includes(sourceType)) {
    throw new ReversalHookMissingError(sourceType)
  }
  return selected
}
