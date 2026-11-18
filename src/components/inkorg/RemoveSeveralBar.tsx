'use client'

import { useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { BulkSelectionBar } from '@/components/ui/bulk-selection-bar'
import { DestructiveConfirmDialog, useDestructiveConfirm } from '@/components/ui/destructive-confirm-dialog'
import { useToast } from '@/components/ui/use-toast'
import type { BulkSelection } from '@/lib/hooks/use-bulk-selection'
import { removalUndoSentence, summariseRemovals } from '@/lib/inkorg/remove-items'
import { removeInboxItems } from './remove-items-client'
import { useUndoRemoval } from './use-undo-removal'

/**
 * The Inkorg list's bulk bar: the rows picked leave the Inkorg in one go.
 * It is the single "Ta bort ur Inkorgen" once per item (the same rules on
 * the server, the document stays in the archive), behind one confirm that
 * says how many and what can be put back afterwards (all of them, none, or
 * how many of each); what the server refused is named afterwards, by reason,
 * and Ångra on that toast puts back what left and can come back.
 */
export function RemoveSeveralBar({
  selection,
  selectableCount,
  putBackIds,
  onRemoved,
}: {
  selection: BulkSelection
  /** How many rows of the view can be picked. */
  selectableCount: number
  /** The rows whose removal can be undone (removalCanBePutBack): the confirm and Ångra promise nothing for the others. */
  putBackIds: ReadonlySet<string>
  /** Something left the Inkorg: the list is read again. */
  onRemoved: () => Promise<void>
}) {
  const t = useTranslations('inkorg')
  const locale = useLocale() === 'en' ? 'en' : 'sv'
  const { toast } = useToast()
  const { dialogProps, confirm } = useDestructiveConfirm()
  const undoRemoval = useUndoRemoval(onRemoved)
  const [busy, setBusy] = useState(false)
  const count = selection.selectedIds.size

  async function removeSelected() {
    const ids = [...selection.selectedIds]
    if (ids.length === 0) return
    // As the rows stand now: once they are gone the page no longer lists them.
    const putBack = new Set(ids.filter((id) => putBackIds.has(id)))
    const undo = removalUndoSentence(ids.length, putBack.size)
    await confirm(
      {
        title: t('bulk_drop_confirm_title', { count: ids.length }),
        description: t(undo.key, undo.values),
        confirmLabel: t('drop_confirm_label'),
        variant: 'destructive',
      },
      async () => {
        setBusy(true)
        try {
          const answer = await removeInboxItems(ids, locale)
          const summary = summariseRemovals(answer.results, locale)
          const removed = summary.removedIds.length
          const undoable = summary.removedIds.filter((id) => putBack.has(id))
          const lines = summary.refused.map((reason) => t('bulk_drop_refused_line', { count: reason.count, reason: reason.message }))
          if (answer.failure !== null) {
            const untried = ids.length - answer.results.length
            lines.push([t('bulk_drop_untried', { count: untried }), answer.failure].filter(Boolean).join(' '))
          }
          toast({
            title: removed > 0 ? t('bulk_drop_done', { count: removed }) : t('drop_failed'),
            description: lines.length > 0 ? lines.join(' ') : undefined,
            variant: removed === 0 ? 'destructive' : 'default',
            action: undoable.length > 0 ? undoRemoval(undoable) : undefined,
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
        <Button variant="outline" onClick={() => void removeSelected()} disabled={busy}>
          {t('action_not_underlag')}
        </Button>
      </BulkSelectionBar>
      <DestructiveConfirmDialog {...dialogProps} />
    </>
  )
}
