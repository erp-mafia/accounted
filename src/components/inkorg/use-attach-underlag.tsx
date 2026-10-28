'use client'

import { useCallback, useRef, useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { ToastAction } from '@/components/ui/toast'
import { useToast } from '@/components/ui/use-toast'
import { getResponseErrorMessage } from '@/lib/errors/get-error-message'
import { notifySessionExpired } from '@/lib/auth/session-timeout-shared'
import { formatMegabytes, INBOX_MAX_UPLOAD_BYTES } from '@/lib/documents/upload-size'
import { splitDroppedFiles } from '@/lib/inkorg/missing'
import { failureCode, matchToPurchase, releaseFromPurchase, uploadToInbox } from './attach-underlag'

export interface AttachUnderlag {
  /** Upload the files and make the first one this purchase's underlag. */
  attach: (purchaseId: string, files: File[]) => Promise<void>
  /** The purchase whose file is on its way, or null. One at a time. */
  busyId: string | null
}

/**
 * Getting a purchase its underlag from a file: the first file is uploaded to
 * the inbox and matched to the purchase (the Underlag workspace's two
 * calls), any further ones are filed in the inbox. The purchase then has its
 * underlag (the page keeps its row in place, marked, crm#1479), and Ångra
 * releases the match again: the one step here an endpoint truly undoes. The
 * upload itself stays, so the file is never lost.
 */
export function useAttachUnderlag({
  onAttached,
  onReleased,
  onFiled,
}: {
  /** The purchase has its underlag (the file's name): read the list again. */
  onAttached: (purchaseId: string, fileName: string) => Promise<void>
  /** Ångra released it: read the list again (it is back). */
  onReleased: (purchaseId: string) => Promise<void>
  /** Files landed in the inbox without reaching the purchase: read the inbox again. */
  onFiled: () => Promise<void>
}): AttachUnderlag {
  const t = useTranslations('inkorg')
  const locale = useLocale() === 'en' ? 'en' : 'sv'
  const { toast } = useToast()
  const [busyId, setBusyId] = useState<string | null>(null)
  const busy = useRef(false)

  const release = useCallback(
    async (itemId: string, purchaseId: string) => {
      const res = await releaseFromPurchase(itemId)
      if (!res.ok) {
        notifySessionExpired(res)
        toast({
          title: t('undo_failed'),
          description: await getResponseErrorMessage(res, undefined, locale),
          variant: 'destructive',
        })
        return
      }
      toast({ title: t('undone'), description: t('attach_released') })
      await onReleased(purchaseId)
    },
    [t, locale, toast, onReleased],
  )

  /** The match made: read the list again and offer Ångra. */
  const attached = useCallback(
    async (itemId: string, purchaseId: string, extras: number, fileName: string) => {
      await onAttached(purchaseId, fileName)
      toast({
        title: t('attached'),
        description: extras > 0 ? t('attached_extras', { count: extras }) : undefined,
        action: (
          <ToastAction altText={t('undo')} onClick={() => void release(itemId, purchaseId)}>
            {t('undo')}
          </ToastAction>
        ),
      })
    },
    [t, toast, onAttached, release],
  )

  /** "Attach anyway" after the server said the document looks like another purchase's. */
  const confirmMismatch = useCallback(
    async (itemId: string, purchaseId: string, extras: number, fileName: string) => {
      const res = await matchToPurchase(itemId, purchaseId, true)
      if (!res.ok) {
        notifySessionExpired(res)
        toast({ title: t('attach_not_linked'), description: t('attach_not_linked_body'), variant: 'destructive' })
        await onFiled()
        return
      }
      await attached(itemId, purchaseId, extras, fileName)
    },
    [t, toast, onFiled, attached],
  )

  const attach = useCallback(
    async (purchaseId: string, files: File[]) => {
      const { underlag, extras } = splitDroppedFiles(files)
      if (!underlag || busy.current) return
      busy.current = true
      setBusyId(purchaseId)
      try {
        const first = await uploadToInbox(underlag, locale)
        // The others cannot all be this purchase's underlag; they are filed, not dropped.
        for (const extra of extras) await uploadToInbox(extra, locale)

        if (!first.ok) {
          toast({
            title: t('attach_failed'),
            description:
              first.reason === 'too_large'
                ? t('attach_too_large', { size: formatMegabytes(first.size), limit: formatMegabytes(INBOX_MAX_UPLOAD_BYTES) })
                : first.message,
            variant: 'destructive',
          })
          if (extras.length > 0) await onFiled()
          return
        }

        const itemId = first.itemId
        const res = await matchToPurchase(itemId, purchaseId)
        if (!res.ok && (await failureCode(res)) === 'DOC_ROW_MISMATCH') {
          // The document reads as another purchase (another seller, a larger
          // amount): it is filed, not linked, until the person says it belongs.
          toast({
            title: t('attach_mismatch'),
            description: await getResponseErrorMessage(res, undefined, locale),
            variant: 'destructive',
            action: (
              <ToastAction
                altText={t('attach_anyway')}
                onClick={() => void confirmMismatch(itemId, purchaseId, extras.length, underlag.name)}
              >
                {t('attach_anyway')}
              </ToastAction>
            ),
          })
          await onFiled()
          return
        }
        if (!res.ok) {
          // The document is filed either way; only the link failed, and it can be made from the inbox.
          notifySessionExpired(res)
          toast({ title: t('attach_not_linked'), description: t('attach_not_linked_body'), variant: 'destructive' })
          await onFiled()
          return
        }

        await attached(itemId, purchaseId, extras.length, underlag.name)
      } finally {
        busy.current = false
        setBusyId(null)
      }
    },
    [t, locale, toast, onFiled, attached, confirmMismatch],
  )

  return { attach, busyId }
}
