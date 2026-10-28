import { getErrorMessage, getResponseErrorMessage, type ErrorLocale } from '@/lib/errors/get-error-message'
import { notifySessionExpired } from '@/lib/auth/session-timeout-shared'
import { uploadViaSignedUrl } from '@/lib/documents/direct-upload'
import { shrinkImageForUpload } from '@/lib/documents/shrink-image'
import { exceedsHostedUploadLimit, exceedsInboxUploadLimit } from '@/lib/documents/upload-size'

const INBOX_URL = '/api/extensions/ext/invoice-inbox'

/**
 * The file was already in the company's archive: the upload joined the item
 * that came in first instead of filing a new one, and this is where that
 * item stands (booked, in Dokument, or still in the inbox). PH 225.
 */
export interface UploadDuplicate {
  receivedAt: string | null
  state: 'booked' | 'arkiv' | 'inbox'
}

export type UploadOutcome =
  | { ok: true; itemId: string; duplicateOf?: UploadDuplicate }
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

const DUPLICATE_STATES = new Set<UploadDuplicate['state']>(['booked', 'arkiv', 'inbox'])

/** The earlier copy a content duplicate joined, as the upload route names it; nothing for a new item. */
function duplicateOf(data: {
  skip_reason?: string | null
  duplicate_of?: { received_at?: string | null; state?: string }
} | undefined): { duplicateOf?: UploadDuplicate } {
  if (data?.skip_reason !== 'duplicate_content') return {}
  const state = data.duplicate_of?.state
  return {
    duplicateOf: {
      receivedAt: data.duplicate_of?.received_at ?? null,
      // A state the client does not know: the item exists, so it is at least in the inbox's records.
      state: state && DUPLICATE_STATES.has(state as UploadDuplicate['state']) ? (state as UploadDuplicate['state']) : 'inbox',
    },
  }
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
    const json = (await res.json()) as {
      data?: {
        inbox_item_id?: string
        skip_reason?: string | null
        duplicate_of?: { received_at?: string | null; state?: string }
      }
    }
    const itemId = json.data?.inbox_item_id
    if (!itemId) return { ok: false, reason: 'failed', message: getErrorMessage(null, { locale }) }
    return { ok: true, itemId, ...duplicateOf(json.data) }
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
 *
 * The file was dropped without its contents in view, so the server compares
 * the document with the purchase first (check_fit) and answers
 * DOC_ROW_MISMATCH when it plainly belongs to another one (crm#1479);
 * `confirmed` is the person's "attach anyway".
 */
export function matchToPurchase(itemId: string, transactionId: string, confirmed = false): Promise<Response> {
  return fetch(`${INBOX_URL}/items/${itemId}/match-transaction`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      transaction_id: transactionId,
      check_fit: true,
      ...(confirmed ? { mismatch_reason: 'confirmed_in_app' } : {}),
    }),
  })
}

/** The refusal code a failed match answered with, or null. Reads a clone: the body stays readable. */
export async function failureCode(res: Response): Promise<string | null> {
  try {
    const body = (await res.clone().json()) as { error?: { code?: unknown } }
    return typeof body.error?.code === 'string' ? body.error.code : null
  } catch {
    // A body that is not the JSON error envelope carries no code: the caller
    // shows the generic "not linked" answer, as before this read existed.
    return null
  }
}

/**
 * Ångra for that match: release it. The pin comes off the transaction while
 * it is still this item's document, and the file stays in the inbox.
 */
export function releaseFromPurchase(itemId: string): Promise<Response> {
  return fetch(`${INBOX_URL}/items/${itemId}/unmatch-transaction`, { method: 'POST' })
}
