'use client'

import { useCallback, useState } from 'react'
import { useTranslations } from 'next-intl'
import { ArrowUturnLeftIcon } from '@/components/icons'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { LoadError } from '@/components/ui/empty-state'
import { AttnLine } from '@/components/ui/attn-line'
import { useToast } from '@/components/ui/use-toast'
import { DestructiveConfirmDialog } from '@/components/ui/destructive-confirm-dialog'
import { TH_CLASS, TD_CLASS } from '@/components/ui/dry-table'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { getFormat } from '@/lib/import/bank-file/formats'
import type { BankFileFormatId } from '@/lib/import/bank-file/types'
import { cn, formatDate } from '@/lib/utils'
import { useImportHistoryRows, ImportHistorySkeleton, ImportStatus } from './import-history-parts'
import { useViewerLock } from '@/components/ui/viewer-lock'

/**
 * Subset of the bank_file_imports row (GET /api/import/bank-file) actually
 * rendered here. `status` stays a plain string: unknown values fall back to
 * raw muted text instead of crashing on a missing translation key (same
 * defensive shape as SIEImportHistory).
 */
interface BankFileImportListRow {
  id: string
  filename: string
  file_format: string
  imported_count: number
  status: string
  created_at: string
}

const STATUS_LABEL_KEY: Record<string, string> = {
  completed: 'bankfile_history_status_completed',
  undone: 'bankfile_history_status_undone',
  failed: 'bankfile_history_status_failed',
  pending: 'bankfile_history_status_pending',
  processing: 'bankfile_history_status_processing',
}

/**
 * Chips mark exceptions (design.md convention 5): the normal 'completed'
 * state renders as muted text; only deviating states get a Badge.
 */
const STATUS_BADGE_VARIANT: Record<string, 'secondary' | 'warning' | 'destructive'> = {
  undone: 'secondary',
  failed: 'destructive',
  pending: 'warning',
  processing: 'warning',
}

/**
 * The undo report returned by DELETE /api/import/bank-file/[id]/undo:
 * deleted rows plus what was deliberately left alone (booked rows are
 * räkenskapsinformation; rows with payment_match_log history keep their
 * append-only log).
 */
interface UndoReport {
  deletedTransactions?: number
  skippedBooked?: number
  skippedMatchHistory?: number
}

/**
 * History of past bank file imports with per-row undo for completed ones.
 * Rendered fold-open from the 'Tidigare bankfilsimporter' row on the import
 * tab; mirrors SIEImportHistory. The undo itself is owner/admin-only,
 * enforced server-side by the undo_bank_file_import RPC's actor gate.
 */
export default function BankFileImportHistory() {
  const t = useTranslations('import')
  const tCommon = useTranslations('common')
  const { canWrite, lockedTitle } = useViewerLock()
  const { toast } = useToast()
  const { rows, loadFailed, reload: fetchImports } = useImportHistoryRows<BankFileImportListRow>('/api/import/bank-file?limit=20')
  const [pendingUndo, setPendingUndo] = useState<BankFileImportListRow | null>(null)


  // Deliberately no client-side timeout: undoing a large import can take
  // minutes (the route runs with maxDuration 300) and the confirm dialog
  // stays open with its spinner until this resolves.
  const handleUndoConfirm = useCallback(async () => {
    if (!pendingUndo) return
    try {
      const res = await fetch(`/api/import/bank-file/${pendingUndo.id}/undo`, {
        method: 'DELETE',
      })
      const data = await res.json()

      if (!res.ok) {
        toast({
          title: t('bankfile_history_undo_failed'),
          description: getErrorMessage(data),
          variant: 'destructive',
        })
        return
      }

      // The full report, clearly: X removed, and any rows the undo refused
      // to touch (booked / match history) so nothing disappears silently.
      const report = data as UndoReport
      const skippedBooked = report.skippedBooked ?? 0
      const skippedMatchHistory = report.skippedMatchHistory ?? 0
      const parts = [
        t('bankfile_history_undo_success_deleted', {
          count: report.deletedTransactions ?? 0,
        }),
      ]
      if (skippedBooked > 0) {
        parts.push(t('bankfile_history_undo_skipped_booked', { count: skippedBooked }))
      }
      if (skippedMatchHistory > 0) {
        parts.push(
          t('bankfile_history_undo_skipped_match_history', { count: skippedMatchHistory }),
        )
      }

      toast({
        title: t('bankfile_history_undo_success_title'),
        description: parts.join(' '),
      })
      await fetchImports()
    } catch (err) {
      toast({
        title: t('bankfile_history_undo_failed'),
        description: getErrorMessage(err),
        variant: 'destructive',
      })
    }
  }, [pendingUndo, fetchImports, t, toast])

  // 'swedbank' → 'Swedbank' via the format registry; unknown ids (a format
  // removed from the registry) fall back to the raw stored code.
  const formatLabel = (row: BankFileImportListRow): string =>
    getFormat(row.file_format as BankFileFormatId)?.name ?? row.file_format

  const statusCell = (status: string) => {
    const labelKey = STATUS_LABEL_KEY[status]
    return <ImportStatus label={labelKey ? t(labelKey) : status} variant={STATUS_BADGE_VARIANT[status]} />
  }

  if (loadFailed && rows === null) {
    return <LoadError title={t('bankfile_history_load_error')} onRetry={() => void fetchImports()} />
  }

  if (rows === null) {
    return <ImportHistorySkeleton />
  }

  if (rows.length === 0) {
    return (
      <p className="px-1 text-xs leading-5 text-muted-foreground">
        {t('bankfile_history_empty')}
      </p>
    )
  }

  return (
    <div>
      {loadFailed && (
        <AttnLine className="mb-3" action={{ label: tCommon('retry'), onClick: () => void fetchImports() }}>
          {tCommon('refresh_failed')}
        </AttnLine>
      )}
      <div className="-mx-2 overflow-x-auto">
        <table className="w-full border-collapse text-[13px]">
          <thead>
            <tr>
              <th className={TH_CLASS}>{t('bankfile_history_col_file')}</th>
              <th className={TH_CLASS}>{t('bankfile_history_col_date')}</th>
              <th className={TH_CLASS}>{t('bankfile_history_col_format')}</th>
              <th className={cn(TH_CLASS, 'text-right')}>
                {t('bankfile_history_col_transactions')}
              </th>
              <th className={TH_CLASS}>{t('bankfile_history_col_status')}</th>
              <th className={TH_CLASS}>
                <span className="sr-only">{t('bankfile_history_undo_button')}</span>
              </th>
            </tr>
          </thead>
          <tbody className="stagger-enter">
            {rows.map((row) => (
              <tr key={row.id} className="transition-colors duration-150 hover:bg-secondary/35">
                <td className={TD_CLASS}>{row.filename}</td>
                <td className={cn(TD_CLASS, 'whitespace-nowrap date-figures')}>
                  {formatDate(row.created_at)}
                </td>
                <td className={cn(TD_CLASS, 'whitespace-nowrap')}>{formatLabel(row)}</td>
                <td className={cn(TD_CLASS, 'text-right tabular-nums')}>{row.imported_count}</td>
                <td className={TD_CLASS}>{statusCell(row.status)}</td>
                <td className={cn(TD_CLASS, 'text-right')}>
                  {row.status === 'completed' && (
                    <Button
                      variant="outline"
                      className="text-destructive hover:text-destructive"
                      onClick={() => setPendingUndo(row)}
                      disabled={!canWrite}
                      title={lockedTitle}
                    >
                      <ArrowUturnLeftIcon className="h-4 w-4" />
                      {t('bankfile_history_undo_button')}
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <DestructiveConfirmDialog
        open={pendingUndo !== null}
        onOpenChange={(open) => {
          if (!open) setPendingUndo(null)
        }}
        title={t('bankfile_history_undo_confirm_title')}
        description={t('bankfile_history_undo_confirm_description')}
        confirmLabel={t('bankfile_history_undo_confirm_label')}
        onConfirm={handleUndoConfirm}
      />
    </div>
  )
}
