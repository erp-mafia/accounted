import { getResponseErrorMessage } from '@/lib/errors/get-error-message'
import { notifySessionExpired } from '@/lib/auth/session-timeout-shared'
import type { RemovedInboxItem } from '@/lib/operations/inbox-restore'

export const REMOVED_ITEMS_URL = '/api/inkorg/items/removed'
export const RESTORE_ITEM_URL = '/api/inkorg/items/restore'

/** Senast borttagna: the deleted items that can still be put back, newest first. Throws when the list could not be read. */
export async function fetchRemovedItems(): Promise<RemovedInboxItem[]> {
  const res = await fetch(REMOVED_ITEMS_URL)
  if (!res.ok) {
    notifySessionExpired(res)
    throw new Error(`${REMOVED_ITEMS_URL}: ${res.status}`)
  }
  const json = (await res.json()) as { data?: { removed_items?: RemovedInboxItem[] } }
  return json.data?.removed_items ?? []
}

/** Whether a deleted item came back, and when it did not, the server's sentence on why. */
export type RestoreAnswer = { ok: true } | { ok: false; message: string }

/** Put one deleted item back in the Inkorg. Never throws: a refusal or a failed request is the answer. */
export async function restoreRemovedItem(inboxItemId: string, locale: 'sv' | 'en'): Promise<RestoreAnswer> {
  try {
    const res = await fetch(RESTORE_ITEM_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ inbox_item_id: inboxItemId }),
    })
    if (res.ok) return { ok: true }
    notifySessionExpired(res)
    return { ok: false, message: await getResponseErrorMessage(res, undefined, locale) }
  } catch {
    // The request never reached the server: the caller says it failed.
    return { ok: false, message: '' }
  }
}
