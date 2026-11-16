'use client'

import { useCallback, useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { ArrowUturnLeftIcon } from '@/components/icons'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { LoadError } from '@/components/ui/empty-state'
import { AttnLine } from '@/components/ui/attn-line'
import { useToast } from '@/components/ui/use-toast'
import { useViewerLock } from '@/components/ui/viewer-lock'
import { DestructiveConfirmDialog } from '@/components/ui/destructive-confirm-dialog'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { TH_CLASS, TD_CLASS } from '@/components/ui/dry-table'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import type {
  RegisterImportRunListRow,
  RegisterKind,
  RegisterUndoKeptRow,
  RegisterUndoResult,
} from '@/lib/import/register-runs'
import { cn, formatDateTime } from '@/lib/utils'
import { useImportHistoryRows, ImportHistorySkeleton } from './import-history-parts'

const KIND_LABEL_KEY: Record<RegisterKind, string> = {
  customers: 'register_history_kind_customers',
  suppliers: 'register_history_kind_suppliers',
  articles: 'register_history_kind_articles',
}

const CONFIRM_KEY: Record<RegisterKind, string> = {
  customers: 'register_history_undo_confirm_customers',
  suppliers: 'register_history_undo_confirm_suppliers',
  articles: 'register_history_undo_confirm_articles',
}

const CONFIRM_RESTORE_KEY: Record<RegisterKind, string> = {
  customers: 'register_history_undo_confirm_restore_customers',
  suppliers: 'register_history_undo_confirm_restore_suppliers',
  articles: 'register_history_undo_confirm_restore_articles',
}

/**
 * The tables the undo RPC reports in `referenced_by`, as the user knows them.
 * The RPC reads every foreign key from the catalog, so a table added later
 * that is missing here falls back to "annan data" instead of a raw name.
 */
const REFERRER_LABEL_KEY: Record<string, string> = {
  invoices: 'register_history_ref_invoices',
  invoice_items: 'register_history_ref_invoice_items',
  sales_orders: 'register_history_ref_sales_orders',
  sales_order_items: 'register_history_ref_sales_order_items',
  recurring_invoice_schedules: 'register_history_ref_recurring_invoice_schedules',
  deadlines: 'register_history_ref_deadlines',
  supplier_invoices: 'register_history_ref_supplier_invoices',
  invoice_inbox_items: 'register_history_ref_invoice_inbox_items',
}

/**
 * History of customer, supplier and article imports with per-run undo.
 * Rendered fold-open from the 'Tidigare registerimporter' row on the import
 * tab; mirrors BankFileImportHistory. What an undo keeps (rows already in
 * use, rows edited again since the import) opens in a dialog right after
 * the undo and stays one click away on the run's row afterwards (one-line
 * rows, design.md convention 4).
 */
export default function RegisterImportHistory() {
  const t = useTranslations('import')
  const tCommon = useTranslations('common')
  const { canWrite, lockedTitle } = useViewerLock()
  const locale = useLocale()
  const { toast } = useToast()
  const { rows, loadFailed, reload: fetchRuns } = useImportHistoryRows<RegisterImportRunListRow>('/api/import/registers')
  const [pendingUndo, setPendingUndo] = useState<RegisterImportRunListRow | null>(null)
  const [keptView, setKeptView] = useState<RegisterUndoKeptRow[] | null>(null)


  const handleUndoConfirm = useCallback(async () => {
    if (!pendingUndo) return
    try {
      const res = await fetch(`/api/import/registers/${pendingUndo.id}/undo`, {
        method: 'DELETE',
      })
      const data = await res.json()

      if (!res.ok) {
        toast({
          title: t('register_history_undo_failed'),
          description: getErrorMessage(data),
          variant: 'destructive',
        })
        return
      }

      const result = data.data as RegisterUndoResult
      const parts = [t('register_history_undo_success_deleted', { count: result.deleted })]
      if (result.restored > 0) {
        parts.push(t('register_history_undo_success_restored', { count: result.restored }))
      }
      if (result.kept.length > 0) {
        parts.push(t('register_history_undo_success_kept', { count: result.kept.length }))
      }
      toast({ title: t('register_history_undo_success_title'), description: parts.join(' ') })
      // Nothing disappears silently: what was kept opens straight away.
      if (result.kept.length > 0) setKeptView(result.kept)
      await fetchRuns()
    } catch (err) {
      toast({
        title: t('register_history_undo_failed'),
        description: getErrorMessage(err),
        variant: 'destructive',
      })
    }
  }, [pendingUndo, fetchRuns, t, toast])

  const keptReason = (row: RegisterUndoKeptRow): string => {
    if (row.reason === 'changed_since_import') return t('register_history_kept_reason_changed')
    if (row.reason === 'conflict') return t('register_history_kept_reason_conflict')
    const places = (row.referenced_by ?? []).map((table) => {
      const key = REFERRER_LABEL_KEY[table]
      return key ? t(key) : t('register_history_ref_other')
    })
    const unique = [...new Set(places)]
    const list = unique.length > 0
      ? new Intl.ListFormat(locale, { style: 'long', type: 'conjunction' }).format(unique)
      : t('register_history_ref_other')
    return row.reason === 'used_since_import'
      ? t('register_history_kept_reason_used_since', { places: list })
      : t('register_history_kept_reason_referenced', { places: list })
  }

  // What the undo will do, both halves only when the run did both.
  const confirmDescription = (run: RegisterImportRunListRow): string =>
    [
      run.created_count > 0 ? t(CONFIRM_KEY[run.kind], { count: run.created_count }) : null,
      run.updated_count > 0 ? t(CONFIRM_RESTORE_KEY[run.kind], { count: run.updated_count }) : null,
    ]
      .filter((part): part is string => part !== null)
      .join('\n\n')

  const statusCell = (row: RegisterImportRunListRow) => {
    if (!row.undone_at) {
      return <span className="text-xs text-muted-foreground">{t('register_history_status_completed')}</span>
    }
    const kept = row.undo_result?.kept ?? []
    return (
      <span className="inline-flex items-center gap-2">
        <Badge variant="secondary" className="font-normal">
          {t('register_history_status_undone')}
        </Badge>
        {kept.length > 0 && (
          <Button
            variant="link"
            className="h-auto p-0 text-xs text-muted-foreground"
            onClick={() => setKeptView(kept)}
          >
            {t('register_history_kept_link', { count: kept.length })}
          </Button>
        )}
      </span>
    )
  }

  if (loadFailed && rows === null) {
    return <LoadError title={t('register_history_load_error')} onRetry={() => void fetchRuns()} />
  }

  if (rows === null) {
    return <ImportHistorySkeleton />
  }

  if (rows.length === 0) {
    return (
      <p className="px-1 text-xs leading-5 text-muted-foreground">
        {t('register_history_empty')}
      </p>
    )
  }

  return (
    <div>
      {loadFailed && (
        <AttnLine className="mb-3" action={{ label: tCommon('retry'), onClick: () => void fetchRuns() }}>
          {tCommon('refresh_failed')}
        </AttnLine>
      )}
      <div className="-mx-2 overflow-x-auto">
        <table className="w-full border-collapse text-[13px]">
          <thead>
            <tr>
              <th className={TH_CLASS}>{t('register_history_col_register')}</th>
              <th className={TH_CLASS}>{t('register_history_col_date')}</th>
              <th className={cn(TH_CLASS, 'text-right')}>{t('register_history_col_created')}</th>
              <th className={cn(TH_CLASS, 'text-right')}>{t('register_history_col_updated')}</th>
              <th className={TH_CLASS}>{t('register_history_col_status')}</th>
              <th className={TH_CLASS}>
                <span className="sr-only">{t('register_history_undo_button')}</span>
              </th>
            </tr>
          </thead>
          <tbody className="stagger-enter">
            {rows.map((row) => (
              <tr key={row.id} className="transition-colors duration-150 hover:bg-secondary/35">
                <td className={TD_CLASS}>{t(KIND_LABEL_KEY[row.kind])}</td>
                <td className={cn(TD_CLASS, 'whitespace-nowrap tabular-nums')}>
                  {formatDateTime(row.created_at)}
                </td>
                <td className={cn(TD_CLASS, 'text-right tabular-nums')}>{row.created_count}</td>
                <td className={cn(TD_CLASS, 'text-right tabular-nums')}>{row.updated_count}</td>
                <td className={TD_CLASS}>{statusCell(row)}</td>
                <td className={cn(TD_CLASS, 'text-right')}>
                  {!row.undone_at && (
                    <Button
                      variant="outline"
                      className="text-destructive hover:text-destructive"
                      onClick={() => setPendingUndo(row)}
                      disabled={!canWrite}
                      title={lockedTitle}
                    >
                      <ArrowUturnLeftIcon className="h-4 w-4" />
                      {t('register_history_undo_button')}
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
        title={t('register_history_undo_confirm_title')}
        description={pendingUndo ? confirmDescription(pendingUndo) : ''}
        confirmLabel={t('register_history_undo_confirm_label')}
        onConfirm={handleUndoConfirm}
      />

      <Dialog
        open={keptView !== null}
        onOpenChange={(open) => {
          if (!open) setKeptView(null)
        }}
      >
        <DialogContent size="form">
          <DialogHeader>
            <DialogTitle>{t('register_history_kept_title')}</DialogTitle>
            <DialogDescription>{t('register_history_kept_description')}</DialogDescription>
          </DialogHeader>
          <ul className="max-h-80 divide-y divide-border overflow-y-auto text-[13px]">
            {(keptView ?? []).map((row) => (
              <li key={row.id} className="flex items-baseline justify-between gap-4 py-2">
                <span className="truncate">{row.name}</span>
                <span className="shrink-0 text-xs text-muted-foreground">{keptReason(row)}</span>
              </li>
            ))}
          </ul>
        </DialogContent>
      </Dialog>
    </div>
  )
}
