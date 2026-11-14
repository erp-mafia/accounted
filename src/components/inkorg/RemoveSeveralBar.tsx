'use client'

import { useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { BulkSelectionBar } from '@/components/ui/bulk-selection-bar'
import { DestructiveConfirmDialog, useDestructiveConfirm } from '@/components/ui/destructive-confirm-dialog'
import { useToast } from '@/components/ui/use-toast'
import type { BulkSelection } from '@/lib/hooks/use-bulk-selection'
import { summariseRemovals } from '@/lib/inkorg/remove-items'
import { removeInboxItems } from './remove-items-client'

/**
 * The Inkorg list's bulk bar: the rows picked leave the Inkorg in one go.
 * It is the single "Ta bort ur Inkorgen" once per item (the same rules on
 * the server, the document stays in the archive), behind one confirm that
 * says how many; what the server refused is named afterwards, by reason.
 */
export function RemoveSeveralBar({
  selection,
  selectableCount,
  onRemoved,
}: {
  selection: BulkSelection
  /** How many rows of the view can be picked. */
  selectableCount: number
  /** Something left the Inkorg: the list is read again. */
  onRemoved: () => Promise<void>
}) {
  const t = useTranslations('inkorg')
  const locale = useLocale() === 'en' ? 'en' : 'sv'
  const { toast } = useToast()
  const { dialogProps, confirm } = useDestructiveConfirm()
  const [busy, setBusy] = useState(false)
  const count = selection.selectedIds.size

  async function removeSelected() {
    const ids = [...selection.selectedIds]
    if (ids.length === 0) return
    await confirm(
      {
        title: t('bulk_drop_confirm_title', { count: ids.length }),
        description: t('bulk_drop_confirm_body', { count: ids.length }),
        confirmLabel: t('drop_confirm_label'),
        variant: 'destructive',
      },
      async () => {
        setBusy(true)
        try {
          const answer = await removeInboxItems(ids, locale)
          const summary = summariseRemovals(answer.results, locale)
          const removed = summary.removedIds.length
          const lines = summary.refused.map((reason) => t('bulk_drop_refused_line', { count: reason.count, reason: reason.message }))
          if (answer.failure !== null) {
            const untried = ids.length - answer.results.length
            lines.push([t('bulk_drop_untried', { count: untried }), answer.failure].filter(Boolean).join(' '))
          }
          toast({
            title: removed > 0 ? t('bulk_drop_done', { count: removed }) : t('drop_failed'),
            description: lines.length > 0 ? lines.join(' ') : undefined,
            variant: removed === 0 ? 'destructive' : 'default',
          })
          if (removed > 0) {
            selection.deselect(summary.removedIds)
            await onRemoved()
          }
        } finally {
          setBusy(false)
        }
      },
    )
  }

  return (
    <>
      <BulkSelectionBar
        selection={selection}
        selectableCount={selectableCount}
        countLabel={t('bulk_selected', { count })}
        selectAllLabel={t('bulk_select_all', { count: selectableCount })}
        clearLabel={t('bulk_clear')}
        busy={busy}
      >
        <Button size="sm" variant="outline" onClick={() => void removeSelected()} disabled={busy}>
          {t('action_not_underlag')}
        </Button>
      </BulkSelectionBar>
      <DestructiveConfirmDialog {...dialogProps} />
    </>
  )
}
