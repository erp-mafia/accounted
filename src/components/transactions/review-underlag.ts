import type { UploadedFile } from '@/components/bookkeeping/DocumentUploadZone'
import type { AvailableInboxDoc } from '@/components/bookkeeping/InboxDocumentPicker'
import type { DocumentLinkTarget } from '@/lib/documents/link-documents'
import type { TransactionUnderlag } from '@/lib/transactions/underlag-read'

/**
 * Underlag attached in a booking dialog (the Bokför review, the manual
 * booking dialog) before its verifikat exists: files uploaded there (stored
 * in the archive and read the moment they land) and documents picked from
 * the inkorg. The first one becomes the transaction's own underlag at once
 * (pinUnderlag), so closing the dialog keeps it (crm#1101); a transaction
 * pins one document, so any further one is only held by the dialog
 * (heldUnderlag). The booking links all of them once it returns the
 * verifikat (underlagLinkTargets).
 */
export interface ReviewUnderlag {
  files: UploadedFile[]
  inboxDocs: AvailableInboxDoc[]
}

/**
 * The transaction's own underlag, the one a booking dialog shows and the
 * booking anchors: what this dialog pinned or took off (`session`, undefined
 * while it did neither), else what the underlag route read (the pin, or an
 * inkorg item matched to the row; null when it found none, undefined while
 * loading), else the row's pin as the list loaded it.
 */
export function transactionUnderlagId(input: {
  session?: string | null
  read?: string | null
  rowPin?: string | null
}): string | null {
  if (input.session !== undefined) return input.session
  if (input.read !== undefined) return input.read
  return input.rowPin ?? null
}

/**
 * The underlag route's answer once a document was pinned here, written into
 * the shared cache ahead of the route's own answer: the drawer, and the next
 * dialog "Byt" or "Ändra rader" opens, read the pin at once instead of the
 * answer from before it. Its facts arrive with the revalidation.
 */
export function readAfterPin(
  prev: TransactionUnderlag | undefined,
  documentId: string,
  fileName: string | null,
): TransactionUnderlag {
  return {
    source: 'pinned',
    document: { id: documentId, file_name: fileName, mime_type: null },
    inbox_item_id: prev?.inbox_item_id ?? null,
    facts: prev?.document?.id === documentId ? prev.facts : null,
  }
}

/** The underlag route's answer once the row's underlag was taken off here (an inkorg match goes with it). */
export function readAfterUnpin(): TransactionUnderlag {
  return { source: null, document: null, inbox_item_id: null, facts: null }
}

/**
 * What only the dialog holds: everything attached in it except the
 * transaction's own underlag, which the row keeps when the dialog closes.
 * "Byt" carries these to the next review, and the manual booking dialog
 * shows the first of them when the row has no underlag.
 */
export function heldUnderlag(attached: ReviewUnderlag, transactionUnderlag: string | null): ReviewUnderlag {
  if (!transactionUnderlag) return attached
  return {
    files: attached.files.filter((f) => f.id !== transactionUnderlag),
    inboxDocs: attached.inboxDocs.filter((d) => d.document_id !== transactionUnderlag),
  }
}

/**
 * The links the booking makes for everything attached in the dialog, in the
 * order it was attached: finished uploads, then inkorg picks with the inbox
 * item each one consumes. The document the dialog pinned to the row is among
 * them although the booking route anchors the row's pin as well: a link to
 * the verifikat that already holds a document changes nothing, and one the
 * server failed to make is then reported by the dialog instead of lost in a
 * log (the contract in lib/documents/link-documents.ts). `transactionId`
 * lets the link route pin the first of them to a row that has no underlag
 * of its own (first linked doc wins).
 */
export function underlagLinkTargets(attached: ReviewUnderlag, transactionId: string): DocumentLinkTarget[] {
  return [
    ...attached.files
      .filter((f) => f.status === 'uploaded' && !!f.id)
      .map((f) => ({ documentId: f.id as string, fileName: f.fileName, transactionId })),
    ...attached.inboxDocs.map((d) => ({
      documentId: d.document_id,
      fileName: d.supplier_name ?? d.file_name,
      inboxItemId: d.inbox_item_id,
      transactionId,
    })),
  ]
}

/**
 * The finished upload that the x in DocumentUploadZone just took out of the
 * list, if any: `next` is the dialog's list with the zone's update applied,
 * and of the zone's updates only the x removes a file. The dialog then lets
 * it go (underlag-controller.ts withdraw), which takes it off the row when
 * the row holds it or is about to. Matched on uploadKey, not on the document
 * id: an upload still on its way has no id yet.
 */
export function removedUpload(prev: readonly UploadedFile[], next: readonly UploadedFile[]): UploadedFile | null {
  const kept = new Set(next.map((f) => f.uploadKey))
  return prev.find((f) => !!f.id && !kept.has(f.uploadKey)) ?? null
}

/** How pinning or unpinning the transaction's underlag went. */
export type UnderlagWrite = { ok: true } | { ok: false; status: number; body: unknown }

/**
 * Whether the attach route refused a pin (a 4xx answer: the document is
 * another verifikat's underlag, it is gone, the period is locked). The
 * booking's link of the document would be refused for the same reason, so
 * the person is told that reason. Offline (0) or a server error (5xx) is
 * not a refusal: the booking still links the document.
 */
export function pinRefused(status: number): boolean {
  return status >= 400 && status < 500
}

const defaultFetch: typeof fetch = (input, init) => globalThis.fetch(input, init)

async function writeUnderlag(url: string, init: RequestInit, fetchImpl: typeof fetch): Promise<UnderlagWrite> {
  try {
    const res = await fetchImpl(url, init)
    if (res.ok) return { ok: true }
    return { ok: false, status: res.status, body: await res.json().catch(() => null) }
  } catch {
    // Offline: the request never produced a response.
    return { ok: false, status: 0, body: null }
  }
}

/**
 * Pin a document attached in a booking dialog to the transaction the moment
 * it is attached (POST attach-document; the rules are
 * lib/transactions/document-attach.ts). The row then carries it: closing the
 * dialog keeps it, the list shows it, and the booking paths anchor the row's
 * pin to the verifikat. Never throws.
 */
export function pinUnderlag(
  transactionId: string,
  documentId: string,
  fetchImpl: typeof fetch = defaultFetch,
): Promise<UnderlagWrite> {
  return writeUnderlag(
    `/api/transactions/${encodeURIComponent(transactionId)}/attach-document`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ document_id: documentId }),
    },
    fetchImpl,
  )
}

/**
 * Take the transaction's underlag off again, the dialog's x (DELETE
 * attach-document): refused once the document is on a verifikat, and an
 * inkorg match is released with it. The document stays in the archive.
 * Never throws.
 */
export function unpinUnderlag(transactionId: string, fetchImpl: typeof fetch = defaultFetch): Promise<UnderlagWrite> {
  return writeUnderlag(
    `/api/transactions/${encodeURIComponent(transactionId)}/attach-document`,
    { method: 'DELETE' },
    fetchImpl,
  )
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
 * The review hands over what it holds (heldUnderlag): the transaction's own
 * underlag is on the row and the next review reads it from there.
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
 * such as the row's Bokför after the picker was dismissed, starts without
 * the documents the review only held, the way closing the review drops
 * them; the row's own underlag is read from the row.
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
