'use client'

import { useCallback } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { ToastAction, type ToastActionElement } from '@/components/ui/toast'
import { useToast } from '@/components/ui/use-toast'
import { restoreRemovedItem } from './removed-items-client'

/**
 * Ångra on the toast of a removal: the items just deleted are put back
 * (POST /api/inkorg/items/restore, once per item) and the page reads the
 * inbox again. What came back and what could not is said in one toast, with
 * the server's own sentence for a refusal. The Inkorg and the Underlag
 * workspace both offer it; later the same items are under Senast borttagna.
 * The caller offers it only for a removal that can be put back
 * (removalCanBePutBack, lib/documents/inbox-item-state.ts): an item without a
 * file keeps no copy, so its toast gets no Ångra.
 */
export function useUndoRemoval(
  /** The items that are back, so the page can read the inbox again (and open the one that was in focus). */
  onRestored: (inboxItemIds: string[]) => void | Promise<void>,
): (inboxItemIds: readonly string[]) => ToastActionElement {
  const t = useTranslations('inkorg')
  const locale = useLocale() === 'en' ? 'en' : 'sv'
  const { toast } = useToast()

  const putBack = useCallback(
    async (inboxItemIds: readonly string[]) => {
      const restored: string[] = []
      const refusals = new Set<string>()
      let failed = 0
      for (const id of inboxItemIds) {
        const answer = await restoreRemovedItem(id, locale)
        if (answer.ok) {
          restored.push(id)
          continue
        }
        failed += 1
        if (answer.message) refusals.add(answer.message)
      }
      if (restored.length > 0) await onRestored(restored)
      const reason = [...refusals].join(' ')
      if (failed === 0) {
        toast({ title: t('removed_restored', { count: restored.length }) })
      } else if (restored.length === 0) {
        toast({ title: t('removed_restore_failed'), description: reason || undefined, variant: 'destructive' })
      } else {
        toast({
          title: t('removed_restored', { count: restored.length }),
          description: [t('removed_restore_some_failed', { count: failed }), reason].filter(Boolean).join(' '),
          variant: 'destructive',
        })
      }
    },
    [locale, onRestored, t, toast],
  )

  return useCallback(
    (inboxItemIds: readonly string[]) => (
      <ToastAction altText={t('undo')} onClick={() => void putBack(inboxItemIds)}>
        {t('undo')}
      </ToastAction>
    ),
    [putBack, t],
  )
}
