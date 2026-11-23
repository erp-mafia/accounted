'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { UploadedFile } from '@/components/bookkeeping/DocumentUploadZone'
import type { UploadedFilesUpdate } from '@/components/bookkeeping/upload-list'
import type { AvailableInboxDoc } from '@/components/bookkeeping/InboxDocumentPicker'
import { linkDocuments, type LinkDocumentsResult } from '@/lib/documents/link-documents'
import {
  heldUnderlag,
  removedUpload,
  shownUnderlag,
  underlagLinkTargets,
  withInboxDoc,
  withoutDocument,
  type ReviewUnderlag,
} from './review-underlag'
import { useTransactionUnderlag, type TransactionUnderlagState } from './use-transaction-underlag'

const NOTHING_ATTACHED: ReviewUnderlag = { files: [], inboxDocs: [] }

export interface HeldUnderlagState {
  /** The transaction's own underlag (useTransactionUnderlag). */
  underlag: TransactionUnderlagState
  /** Everything attached while booking: uploads and inkorg picks. */
  attached: ReviewUnderlag
  /** What only this booking holds: attached minus the row's own underlag. */
  held: ReviewUnderlag
  /** The document shown beside the kontering (shownUnderlag). */
  shown: { documentId: string | null; mime: string | null; fileName: string | null }
  /** The row had its underlag before this booking opened: it gets a row (and an x) of its own. */
  ownFromBefore: boolean
  /** A finished upload is offered to the row at once. */
  claimUpload: (file: UploadedFile) => void
  /** Every change from the upload zone; the x on a finished upload lets it go. */
  onFilesChange: (update: UploadedFilesUpdate) => void
  /** The x on an attached document: off the row when the row holds it, then out of the lists. */
  letGo: (documentId: string) => Promise<void>
  /** An inkorg pick: attached once and offered to the row. */
  pickInboxDoc: (doc: AvailableInboxDoc) => void
  /** The x on the underlag the row had before: confirmed first (useTransactionUnderlag). */
  detachEarlier: (row: { description: string; amount: string }) => Promise<void>
  /**
   * Links everything attached to the verifikat once no pin or take-off is on
   * its way, minus what was let go. `ownUnderlag` is the row's underlag at
   * that moment.
   */
  link: (journalEntryId: string, transactionId: string) => Promise<LinkDocumentsResult & { ownUnderlag: string | null }>
  /** Forget what is attached here (the row keeps its own underlag). */
  clear: () => void
}

/**
 * The underlag of a bank row being booked by hand, for the booking dialog
 * and the booking screen alike: the row's own underlag (pinned the moment
 * the first document is attached, so leaving keeps it, crm#1101) and every
 * upload and inkorg pick held until the booking links them to the
 * verifikat. The orderings live in underlag-controller.ts and the pure
 * steps in review-underlag.ts.
 *
 * `found` is an inbox document someone else found for the row (the booking
 * screen's Kvitto hittat): it starts attached, like an inkorg pick, but is
 * only held, never pinned to the row, so opening the row writes nothing. The
 * booking links it with the rest.
 */
export function useHeldUnderlag(options: {
  transactionId: string | null
  rowDocumentId: string | null
  open: boolean
  onChange?: (transactionId: string, documentId: string | null) => void
  found?: AvailableInboxDoc | null
}): HeldUnderlagState {
  const underlag = useTransactionUnderlag(options)
  const { claim, withdraw, settled, isLetGo } = underlag
  const [attached, setAttached] = useState<ReviewUnderlag>(() =>
    options.found ? withInboxDoc(NOTHING_ATTACHED, options.found) : NOTHING_ATTACHED,
  )
  // The latest list, for a link that first waits for a pin or a take-off:
  // an upload that finishes during the wait is linked too.
  const latest = useRef(attached)
  useEffect(() => {
    latest.current = attached
  }, [attached])

  const claimUpload = useCallback(
    (file: UploadedFile) => {
      if (file.id) void claim(file.id, file.fileName)
    },
    [claim],
  )

  // Listed until the row has let it go: a refused take-off keeps it, as does
  // attaching it again meanwhile.
  const letGo = useCallback(
    async (documentId: string) => {
      if (!(await withdraw(documentId))) return
      setAttached((current) => withoutDocument(current, documentId))
    },
    [withdraw],
  )

  // Every change from the upload zone is an update of the list as it is when
  // it lands, so an upload finishing after another drop or a removal keeps
  // both. The x on a finished upload is the one change taken over here.
  const onFilesChange = (update: UploadedFilesUpdate) => {
    const gone = removedUpload(attached.files, update(attached.files))
    if (gone?.id) {
      void letGo(gone.id)
      return
    }
    setAttached((current) => ({ files: update(current.files), inboxDocs: current.inboxDocs }))
  }

  const pickInboxDoc = (doc: AvailableInboxDoc) => {
    if (attached.inboxDocs.some((d) => d.document_id === doc.document_id)) return
    setAttached((current) => withInboxDoc(current, doc))
    void claim(doc.document_id, doc.supplier_name ?? doc.file_name)
  }

  const detachEarlier = async (row: { description: string; amount: string }) => {
    const released = await underlag.detachEarlier(row)
    if (released) setAttached((current) => withoutDocument(current, released))
  }

  const link = async (journalEntryId: string, transactionId: string) => {
    const ownUnderlag = await settled()
    const targets = underlagLinkTargets(latest.current, transactionId).filter((target) => !isLetGo(target.documentId))
    const result = await linkDocuments(targets, journalEntryId)
    return { ...result, ownUnderlag }
  }

  return {
    underlag,
    attached,
    held: heldUnderlag(attached, underlag.documentId),
    shown: shownUnderlag(attached, { documentId: underlag.documentId, fileName: underlag.fileName }),
    ownFromBefore: !!underlag.documentId && underlag.documentId !== underlag.attachedHere,
    claimUpload,
    onFilesChange,
    letGo,
    pickInboxDoc,
    detachEarlier,
    link,
    clear: () => setAttached(NOTHING_ATTACHED),
  }
}
