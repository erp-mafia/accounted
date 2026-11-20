'use client'

import { useCallback, useEffect, useState } from 'react'
import useSWR, { mutate as globalMutate } from 'swr'
import { useLocale, useTranslations } from 'next-intl'
import { toast } from '@/components/ui/use-toast'
import { useDestructiveConfirm } from '@/components/ui/destructive-confirm-dialog'
import { getErrorMessage, type ErrorLocale } from '@/lib/errors/get-error-message'
import type { TransactionUnderlag } from '@/lib/transactions/underlag-read'
import { pinRefused, pinUnderlag, readAfterPin, readAfterUnpin, transactionUnderlagId, unpinUnderlag } from './review-underlag'
import { createUnderlagController, type UnderlagControllerState } from './underlag-controller'
import { resolveDetachErrorMessage } from './detach-underlag'

/** The underlag route's SWR key, shared with the drawer and the transactions page. */
export function underlagKey(transactionId: string): string {
  return `/api/transactions/${transactionId}/underlag`
}

async function fetchUnderlag(url: string): Promise<TransactionUnderlag> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${url} ${res.status}`)
  return ((await res.json()) as { data: TransactionUnderlag }).data
}

interface Options {
  transactionId: string | null
  /** transactions.document_id as the list loaded it: stands in until the route's read lands. */
  rowDocumentId: string | null
  /** Read only while the dialog is open. */
  open: boolean
  /** The page keeps its rows in step: the row's underlag indicator and the next open. */
  onChange?: (transactionId: string, documentId: string | null) => void
}

export interface TransactionUnderlagState {
  /** The transaction's own underlag: pinned to the row, or an inkorg item matched to it. */
  documentId: string | null
  /** How the row holds it: pinned (transactions.document_id) or matched in the inkorg. */
  source: 'pinned' | 'matched' | null
  /** Its file name, once known. */
  fileName: string | null
  /** What the underlag route read (the document, its facts); undefined while loading. */
  read: TransactionUnderlag | undefined
  /** The document this dialog pinned, while it is still the transaction's underlag. */
  attachedHere: string | null
  /** A pin or a take-off is queued or on its way. */
  busy: boolean
  /** Offer a document attached in the dialog to the row (underlag-controller.ts). */
  claim: (documentId: string, fileName: string | null) => Promise<boolean>
  /** The person removed a document in the dialog: true once the row no longer holds it. */
  withdraw: (documentId: string) => Promise<boolean>
  /** Removed in the dialog and not attached again: never linked at booking. */
  isLetGo: (documentId: string) => boolean
  /** The row's underlag once no pin or take-off is on its way: a booking waits for it. */
  settled: () => Promise<string | null>
  /**
   * The x on an underlag the row had before this dialog: confirmed first, as
   * the row's "Ta bort underlag" is, since the indicator goes at once and the
   * match may be someone else's. The document taken off, or null.
   */
  detachEarlier: (row: { description: string; amount: string }) => Promise<string | null>
  /** Props for the DestructiveConfirmDialog the dialog renders inside its content. */
  confirmProps: ReturnType<typeof useDestructiveConfirm>['dialogProps']
}

/**
 * The transaction's own underlag in a booking dialog (crm#1101). A document
 * attached in the dialog used to live in its state until the booking linked
 * it, so closing the dialog forgot it although the file was already
 * archived. It is now pinned to the transaction the moment it is attached,
 * through the same attach route as "Matcha mot underlag" and the agent's
 * attach tool. Both booking dialogs read and write it here, so they behave
 * the same; the orderings live in underlag-controller.ts.
 */
export function useTransactionUnderlag({ transactionId, rowDocumentId, open, onChange }: Options): TransactionUnderlagState {
  const t = useTranslations('tx_booking_underlag')
  const tDetach = useTranslations('tx_detach')
  const locale = useLocale() as ErrorLocale
  const { data: read } = useSWR<TransactionUnderlag>(
    open && transactionId ? underlagKey(transactionId) : null,
    fetchUnderlag,
  )
  const readId = transactionUnderlagId({
    read: read ? (read.document?.id ?? null) : undefined,
    rowPin: rowDocumentId,
  })

  const [snapshot, setSnapshot] = useState<UnderlagControllerState>({ session: undefined, busy: false })
  const [controller] = useState(() =>
    createUnderlagController({
      // Configured after the first render, before anything can be attached.
      read: () => ({ transactionId: null, documentId: null }),
      pin: pinUnderlag,
      unpin: unpinUnderlag,
      onState: setSnapshot,
    }),
  )
  // The controller's writes run from upload callbacks that close over an
  // older render (DocumentUploadZone keeps uploading through later renders,
  // and after the dialog has closed), so it is handed the latest read and
  // callbacks after every render.
  useEffect(() => {
    controller.configure({
      read: () => ({ transactionId, documentId: readId }),
      onPinned: (txId, docId, name) => {
        void globalMutate(
          underlagKey(txId),
          (prev?: TransactionUnderlag) => readAfterPin(prev, docId, name),
          { revalidate: true },
        )
        // The inbox card flips its indicator on this, as for the other attach doors.
        window.dispatchEvent(
          new CustomEvent('Accounted:transaction-document-linked', {
            detail: { transaction_id: txId, document_id: docId },
          }),
        )
        onChange?.(txId, docId)
      },
      onUnpinned: (txId) => {
        void globalMutate(underlagKey(txId), readAfterUnpin(), { revalidate: true })
        window.dispatchEvent(
          new CustomEvent('Accounted:transaction-document-unlinked', { detail: { transaction_id: txId } }),
        )
        onChange?.(txId, null)
      },
      onPinFailed: (refusal) => {
        toast({
          title: t('pin_failed_title'),
          // A refusal (the document is another verifikat's underlag, gone,
          // or the period is locked) says why: the booking's link of it
          // would be refused too. Offline or a server error: the booking
          // still links it.
          description: pinRefused(refusal.status)
            ? getErrorMessage(refusal.body, { context: 'transaction', statusCode: refusal.status, locale })
            : t('pin_failed_description'),
          variant: 'destructive',
        })
      },
      onUnpinFailed: (refusal) => {
        toast({
          title: tDetach('toast_failed'),
          description: resolveDetachErrorMessage(refusal.status, refusal.body),
          variant: 'destructive',
        })
      },
    })
  })

  const { dialogProps: confirmProps, confirm } = useDestructiveConfirm()
  const detachEarlier = useCallback(
    async (row: { description: string; amount: string }): Promise<string | null> => {
      const outcome: { released: string | null } = { released: null }
      const ok = await confirm(
        {
          title: tDetach('confirm_title'),
          description: tDetach('confirm_body', row),
          confirmLabel: tDetach('confirm_label'),
          cancelLabel: tDetach('cancel_label'),
          variant: 'warning',
        },
        async () => {
          outcome.released = await controller.release()
          // A refused take-off was toasted by the controller; the confirm
          // resolves false so nothing below runs.
          if (!outcome.released) throw new Error('underlag not released')
        },
      )
      if (!ok || !outcome.released) return null
      toast({ title: tDetach('toast_done') })
      return outcome.released
    },
    [confirm, controller, tDetach],
  )

  const session = snapshot.session && snapshot.session.transactionId === transactionId ? snapshot.session : undefined
  const documentId = transactionUnderlagId({
    session: session?.documentId,
    read: read ? (read.document?.id ?? null) : undefined,
    rowPin: rowDocumentId,
  })
  const source: TransactionUnderlagState['source'] = session
    ? session.documentId
      ? 'pinned'
      : null
    : read
      ? read.source
      : rowDocumentId
        ? 'pinned'
        : null
  const fileName =
    session && session.documentId === documentId
      ? session.fileName
      : read?.document && read.document.id === documentId
        ? read.document.file_name
        : null

  return {
    documentId,
    source,
    fileName,
    read,
    attachedHere: session?.documentId ?? null,
    busy: snapshot.busy,
    claim: controller.claim,
    withdraw: controller.withdraw,
    isLetGo: controller.isLetGo,
    settled: controller.settled,
    detachEarlier,
    confirmProps,
  }
}
