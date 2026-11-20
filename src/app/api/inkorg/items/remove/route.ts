import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { RemoveInboxItemsSchema } from '@/lib/api/schemas'
import { deleteInboxItems } from '@/lib/documents/inbox-item-actions'
import { getErrorEntry } from '@/lib/errors/structured-errors'
import type { InboxItemRemovalResult } from '@/lib/inkorg/remove-items'

/**
 * POST /api/inkorg/items/remove
 *
 * Several items leave the Inkorg in one request (body: inbox_item_ids, at
 * most MAX_INBOX_ITEMS_PER_REMOVAL). Each one goes through the single
 * removal's own function (deleteInboxItem, lib/documents/inbox-item-actions.ts),
 * so the rules are the same per item: only the inbox item is deleted, its
 * document stays in the archive, and an item that became a supplier invoice
 * or was booked is refused.
 *
 * Answers 200 { data: { results, removed, refused } } whenever the request
 * itself is valid: one refused item never fails the rest. Each result is
 * { id, removed: true } or { id, removed: false, code, message, message_en }
 * with the code and words the single removal answers (INBOX_ITEM_NOT_FOUND
 * for an id that is not the company's).
 */
export const POST = withRouteContext(
  'inkorg.remove_items',
  async (request, { supabase, companyId, user, log }) => {
    const validation = await validateBody(request, RemoveInboxItemsSchema, { log, operation: 'inkorg.remove_items' })
    if (!validation.success) return validation.response

    const outcomes = await deleteInboxItems({ supabase, companyId, userId: user.id, log }, validation.data.inbox_item_ids)
    const results: InboxItemRemovalResult[] = outcomes.map((outcome) => {
      if (outcome.removed) return outcome
      const entry = getErrorEntry(outcome.code) ?? getErrorEntry('UNKNOWN_ERROR')
      return { ...outcome, message: entry?.message_sv ?? '', message_en: entry?.message_en ?? '' }
    })
    const removed = results.filter((result) => result.removed).length
    log.info('inbox items removed', { asked: results.length, removed, refused: results.length - removed })
    return NextResponse.json({ data: { results, removed, refused: results.length - removed } })
  },
  { requireWrite: true },
)
