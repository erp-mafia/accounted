import { getResponseErrorMessage } from '@/lib/errors/get-error-message'
import { notifySessionExpired } from '@/lib/auth/session-timeout-shared'

/** A company portal as /api/inkorg/portals answers it, as far as the page reads it. */
export interface SavedPortal {
  id: string
  vendor_name: string
  url: string
}

export type PortalAnswer<T> = { ok: true; data: T } | { ok: false; message: string }

/** One call to /api/inkorg/portals. Never throws: a failure is an answer the page tells the person about. */
async function call<T>(path: string, init: RequestInit, locale: 'sv' | 'en'): Promise<PortalAnswer<T>> {
  try {
    const res = await fetch(path, { ...init, headers: { 'content-type': 'application/json' } })
    if (!res.ok) {
      notifySessionExpired(res)
      return { ok: false, message: await getResponseErrorMessage(res, undefined, locale) }
    }
    const json = (await res.json()) as { data?: T }
    return json.data ? { ok: true, data: json.data } : { ok: false, message: '' }
  } catch {
    return { ok: false, message: '' }
  }
}

/** "The invoice is in a portal": the server reads the supplier off the purchase. */
export function addPortal(transactionId: string, url: string, locale: 'sv' | 'en') {
  return call<SavedPortal>('/api/inkorg/portals', { method: 'POST', body: JSON.stringify({ transaction_id: transactionId, url }) }, locale)
}

export function changePortal(id: string, url: string, locale: 'sv' | 'en') {
  return call<SavedPortal>(`/api/inkorg/portals/${id}`, { method: 'PATCH', body: JSON.stringify({ url }) }, locale)
}

export function removePortal(id: string, locale: 'sv' | 'en') {
  return call<{ id: string }>(`/api/inkorg/portals/${id}`, { method: 'DELETE' }, locale)
}
