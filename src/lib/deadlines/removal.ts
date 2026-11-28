/**
 * Taking a deadline off the company's list. One rule for every door: the
 * dashboard (DELETE /api/deadlines/:id) and the operation deadlines.delete
 * (lib/operations/deadlines.ts), which gnubok_delete_deadline is generated
 * from.
 *
 * The rule:
 *   - the deadline is the company's and still on its list. A dismissed system
 *     deadline is hidden everywhere (lib/deadlines/open.ts), so it is not
 *     found here either;
 *   - a deadline added by hand (source 'user') is deleted;
 *   - a deadline generated from the tax settings (source 'system') is
 *     dismissed, never deleted: the nightly repair recreates a missing
 *     upcoming system row within a day, while a dismissed one satisfies the
 *     generator and the repair the way a completed one does, so the removal
 *     holds. The row stays in the table, hidden from every surface;
 *   - open or ticked off alike. A deadline is a reminder: no verifikat,
 *     period or filing is touched, and a recorded moms or AGI filing stays on
 *     record without it;
 *   - a row that vanishes between the read and the write (a regeneration
 *     replacing the set) is not found, never a success that persisted nothing.
 *
 * A dry run reads and says what would happen; it writes nothing (it is also
 * the MCP staging preview).
 */
import type { OperationContext, OperationOutcome } from '@/lib/operations/types'
import type { Deadline } from '@/types'
import { deadlinePreviewHead, findListedDeadline } from './completion'

type Ctx = Pick<OperationContext, 'supabase' | 'companyId'>

/** What the removal did: a deadline added by hand is deleted, a generated one dismissed. */
export type DeadlineRemovalEffect = 'deleted' | 'dismissed'

export interface DeadlineRemoval {
  deadline_id: string
  title: string
  source: Deadline['source']
  effect: DeadlineRemovalEffect
}

type RemovableDeadline = Pick<
  Deadline,
  'id' | 'title' | 'due_date' | 'source' | 'is_completed' | 'tax_deadline_type' | 'tax_period'
>

const REMOVABLE_SELECT = 'id, title, due_date, source, is_completed, tax_deadline_type, tax_period'

const notFound = (deadlineId: string) =>
  ({ ok: false, code: 'DEADLINE_NOT_FOUND', details: { deadline_id: deadlineId } }) as const
const failed = (error: unknown) => ({ ok: false, code: 'UNKNOWN_ERROR', error }) as const

export async function removeDeadline(
  ctx: Ctx,
  deadlineId: string,
  { dryRun }: { dryRun: boolean },
): Promise<OperationOutcome<DeadlineRemoval>> {
  const { supabase, companyId } = ctx
  const found = await findListedDeadline<RemovableDeadline>(ctx, deadlineId, REMOVABLE_SELECT)
  if (!found.ok) return found
  const existing = found.row

  const effect: DeadlineRemovalEffect = existing.source === 'system' ? 'dismissed' : 'deleted'

  if (dryRun) {
    return {
      ok: true,
      dryRun: true,
      preview: {
        ...deadlinePreviewHead(existing),
        source: existing.source,
        is_completed: Boolean(existing.is_completed),
        effect,
      },
    }
  }

  if (effect === 'dismissed') {
    const { data: dismissed, error } = await supabase
      .from('deadlines')
      .update({ dismissed_at: new Date().toISOString() })
      .eq('id', existing.id)
      .eq('company_id', companyId)
      .eq('source', 'system')
      .is('dismissed_at', null)
      .select('id')
    if (error) return failed(error)
    if (!dismissed || dismissed.length === 0) return notFound(deadlineId)
  } else {
    // Never a generated row: it is dismissed above, so the repair cannot bring it back.
    const { error, count } = await supabase
      .from('deadlines')
      .delete({ count: 'exact' })
      .eq('id', existing.id)
      .eq('company_id', companyId)
      .neq('source', 'system')
    if (error) return failed(error)
    if (count === 0) return notFound(deadlineId)
  }

  return { ok: true, data: { deadline_id: existing.id, title: existing.title, source: existing.source, effect } }
}
