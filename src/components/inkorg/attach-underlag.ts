import { getErrorMessage, getResponseErrorMessage, type ErrorLocale } from '@/lib/errors/get-error-message'
import { notifySessionExpired } from '@/lib/auth/session-timeout-shared'
import { uploadViaSignedUrl } from '@/lib/documents/direct-upload'
import { shrinkImageForUpload } from '@/lib/documents/shrink-image'
import { exceedsHostedUploadLimit, exceedsInboxUploadLimit } from '@/lib/documents/upload-size'

const INBOX_URL = '/api/extensions/ext/invoice-inbox'

export type UploadOutcome =
  | { ok: true; itemId: string }
  | { ok: false; reason: 'too_large'; size: number }
  | { ok: false; reason: 'failed'; message: string }

/**
 * Leave a trace when an upload fails, as the Underlag workspace does: a
 * failed phone upload is otherwise invisible in the function logs. Sizes and
 * types only, never the file name.
 */
function reportUploadFailure(report: { status: number; size: number; type: string; reason: string }): void {
  void fetch('/api/log', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message: 'underlag upload failed', extra: { ...report, surface: 'inkorg' } }),
  }).catch(() => {
    // Reporting the failure must never become a second failure.
  })
}

/**
 * File one document in the inbox, the way the Underlag workspace does: an
 * oversized photo is shrunk first, a file over the platform's body limit
 * goes straight to Storage through a signed URL, everything else is a
 * multipart POST /upload. Only the inbox's own ceiling refuses a file here,
 * where its size can be named. Resolves to the new inbox item.
 */
export async function uploadToInbox(original: File, locale: ErrorLocale): Promise<UploadOutcome> {
  const file = exceedsHostedUploadLimit(original.size) ? await shrinkImageForUpload(original) : original
  if (exceedsInboxUploadLimit(file.size)) {
    reportUploadFailure({ status: 0, size: file.size, type: file.type || 'unknown', reason: 'over inbox ceiling' })
    return { ok: false, reason: 'too_large', size: file.size }
  }
  try {
    let res: Response
    if (exceedsHostedUploadLimit(file.size)) {
      res = await uploadViaSignedUrl(file)
    } else {
      const body = new FormData()
      body.append('file', file)
      res = await fetch(`${INBOX_URL}/upload`, { method: 'POST', body })
    }
    if (!res.ok) {
      notifySessionExpired(res)
      reportUploadFailure({ status: res.status, size: file.size, type: file.type || 'unknown', reason: 'route refused' })
      return { ok: false, reason: 'failed', message: await getResponseErrorMessage(res, undefined, locale) }
    }
    const json = (await res.json()) as { data?: { inbox_item_id?: string } }
    const itemId = json.data?.inbox_item_id
    if (!itemId) return { ok: false, reason: 'failed', message: getErrorMessage(null, { locale }) }
    return { ok: true, itemId }
  } catch {
    // fetch rejected before a response existed: the network, not the route.
    reportUploadFailure({ status: 0, size: file.size, type: file.type || 'unknown', reason: 'network' })
    return { ok: false, reason: 'failed', message: getErrorMessage(null, { locale }) }
  }
}

/**
 * Make an inbox item the underlag of one bank purchase: the match the
 * Underlag workspace makes after a purchase's upload, which also pins the
 * document on the transaction, so the purchase leaves Saknar underlag.
 */
export function matchToPurchase(itemId: string, transactionId: string): Promise<Response> {
  return fetch(`${INBOX_URL}/items/${itemId}/match-transaction`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ transaction_id: transactionId }),
  })
}

/**
 * Ångra for that match: release it. The pin comes off the transaction while
 * it is still this item's document, and the file stays in the inbox.
 */
export function releaseFromPurchase(itemId: string): Promise<Response> {
  return fetch(`${INBOX_URL}/items/${itemId}/unmatch-transaction`, { method: 'POST' })
}
