import type { UploadedFile } from '@/components/bookkeeping/DocumentUploadZone'
import type { AvailableInboxDoc } from '@/components/bookkeeping/InboxDocumentPicker'

/**
 * Underlag attached in the Bokför review before its verifikat exists: files
 * uploaded there (stored in the archive and read the moment they land) and
 * documents picked from the inkorg. The review holds them and links them
 * once the booking returns the verifikat.
 */
export interface ReviewUnderlag {
  files: UploadedFile[]
  inboxDocs: AvailableInboxDoc[]
}

/** What "Byt" handed over, and the row it belongs to. */
export interface CarriedUnderlag extends ReviewUnderlag {
  transactionId: string
}

/**
 * What "Byt" carries into the review that reopens on the picked template:
 * the uploads that finished (they have a document id to link; a failed one
 * has none) and the inkorg picks. Null when nothing is attached, so the next
 * review starts as it always did. Before this, the switch closed the review
 * and the next one opened empty: the upload was archived but never linked,
 * and from 500 kr the button read "Bokför utan underlag" (PostHog PH 118).
 */
export function underlagToCarry(held: ReviewUnderlag): ReviewUnderlag | null {
  const files = held.files.filter((f) => f.status === 'uploaded' && !!f.id)
  if (files.length === 0 && held.inboxDocs.length === 0) return null
  return { files, inboxDocs: held.inboxDocs }
}

/**
 * The underlag a review opens with: what "Byt" carried, when the review is
 * opened from the picker on the same row (only "Byt" leaves an underlag for
 * the picker; one opened from the row starts without). Every other way in,
 * such as the row's Bokför after the picker was dismissed, starts empty, the
 * way closing the review drops what was attached in it.
 */
export function underlagForReview(
  carried: CarriedUnderlag | null,
  opening: { transactionId: string; fromPicker: boolean },
): ReviewUnderlag | null {
  if (!carried || !opening.fromPicker || carried.transactionId !== opening.transactionId) return null
  return { files: carried.files, inboxDocs: carried.inboxDocs }
}

/**
 * The carried documents, which the reopened review does not have the
 * assistant read again: they were attached before the person picked this
 * template, so the pick is the person's answer to them. A read here would
 * let the assistant's pick replace the one the person just made. Their
 * facts (the moms) still reach the review.
 */
export function carriedDocumentIds(carried: ReviewUnderlag | null | undefined): ReadonlySet<string> {
  const ids = new Set<string>()
  for (const f of carried?.files ?? []) if (f.id) ids.add(f.id)
  for (const d of carried?.inboxDocs ?? []) ids.add(d.document_id)
  return ids
}

/** An upload still on its way has no document id yet: "Byt" waits for it rather than drop it. */
export function uploadInFlight(files: readonly UploadedFile[]): boolean {
  return files.some((f) => f.status === 'uploading')
}
