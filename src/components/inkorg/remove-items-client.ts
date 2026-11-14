import { getResponseErrorMessage } from '@/lib/errors/get-error-message'
import { notifySessionExpired } from '@/lib/auth/session-timeout-shared'
import { removalBatches, type InboxItemRemovalResult } from '@/lib/inkorg/remove-items'

export const REMOVE_ITEMS_URL = '/api/inkorg/items/remove'

/**
 * What became of a removal of several items: every answered item's outcome,
 * and, when a request itself failed (signed out, the server down), why: the
 * items of that request and of any after it were not tried.
 */
export interface RemoveItemsAnswer {
  results: InboxItemRemovalResult[]
  failure: string | null
}

/**
 * Several items leave the Inkorg: one request, or one per
 * MAX_INBOX_ITEMS_PER_REMOVAL for a larger selection, in order. Never
 * throws: a failed request ends the run and is part of the answer.
 */
export async function removeInboxItems(ids: readonly string[], locale: 'sv' | 'en'): Promise<RemoveItemsAnswer> {
  const results: InboxItemRemovalResult[] = []
  for (const batch of removalBatches(ids)) {
    try {
      const res = await fetch(REMOVE_ITEMS_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ inbox_item_ids: batch }),
      })
      if (!res.ok) {
        notifySessionExpired(res)
        return { results, failure: await getResponseErrorMessage(res, undefined, locale) }
      }
      const json = (await res.json()) as { data?: { results?: InboxItemRemovalResult[] } }
      results.push(...(json.data?.results ?? []))
    } catch {
      // The request never reached the server, or its answer was not JSON: the caller says it failed.
      return { results, failure: '' }
    }
  }
  return { results, failure: null }
}
