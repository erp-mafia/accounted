'use client'

import { useCallback, useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Undo2 } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { useToast } from '@/components/ui/use-toast'
import { DestructiveConfirmDialog } from '@/components/ui/destructive-confirm-dialog'
import { TH_CLASS, TD_CLASS } from '@/components/ui/dry-table'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { cn, formatDate } from '@/lib/utils'

/**
 * Subset of the sie_imports row (GET /api/import/sie) actually rendered here.
 * `status` stays a plain string: the DB CHECK also allows values this table
 * never renders specially (e.g. the legacy 'mapped'), which fall back to raw
 * muted text instead of crashing on a missing translation key.
 */
interface SIEImportListRow {
  id: string
  filename: string
  fiscal_year_start: string | null
  fiscal_year_end: string | null
  transactions_count: number
  status: string
  imported_at: string | null
  created_at: string
}

/**
 * At or above this voucher count the undo confirm adds a warning that undoing
 * can leave gaps in the voucher numbering when other vouchers were booked
 * after the import (gaps need a documented explanation per BFNAR 2013:2).
 */
const GAP_WARNING_VOUCHER_COUNT = 100

const STATUS_LABEL_KEY: Record<string, string> = {
  completed: 'sie_history_status_completed',
  undone: 'sie_history_status_undone',
  replaced: 'sie_history_status_replaced',
  failed: 'sie_history_status_failed',
  pending: 'sie_history_status_pending',
}

/**
 * Chips mark exceptions (design.md convention 5): the normal 'completed'
 * state renders as muted text; only deviating states get a Badge.
 */
const STATUS_BADGE_VARIANT: Record<string, 'secondary' | 'warning' | 'destructive'> = {
  undone: 'secondary',
  replaced: 'secondary',
  failed: 'destructive',
  pending: 'warning',
}

/**
 * History of past SIE imports with per-row undo for completed ones.
 * Rendered fold-open from the 'Tidigare SIE-importer' row on the import tab.
 */
export default function SIEImportHistory() {
  const t = useTranslations('import')
  const { toast } = useToast()
  const [rows, setRows] = useState<SIEImportListRow[] | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)
  const [pendingUndo, setPendingUndo] = useState<SIEImportListRow | null>(null)

  const fetchImports = useCallback(async () => {
    try {
      const res = await fetch('/api/import/sie?limit=20')
      if (!res.ok) {
        setLoadFailed(true)
        return
      }
      const data = await res.json()
      setRows(Array.isArray(data.data) ? data.data : [])
      setLoadFailed(false)
    } catch {
      setLoadFailed(true)
    }
  }, [])

  useEffect(() => {
    void fetchImports()
  }, [fetchImports])

  // Deliberately no client-side timeout: undoing a large import can take
  // minutes (the route runs with maxDuration 300) and the confirm dialog
  // stays open with its spinner until this resolves.
  const handleUndoConfirm = useCallback(async () => {
    if (!pendingUndo) return
    try {
      const res = await fetch(`/api/import/sie/${pendingUndo.id}/undo`, { method: 'DELETE' })
      const data = await res.json()

      if (!res.ok) {
        toast({
          title: t('sie_history_undo_failed'),
          description: getErrorMessage(data),
          variant: 'destructive',
        })
        return
      }

      toast({
        title: t('sie_history_undo_success_title'),
        description: t('sie_history_undo_success', { count: data.deletedEntries ?? 0 }),
      })
      await fetchImports()
    } catch (err) {
      toast({
        title: t('sie_history_undo_failed'),
        description: getErrorMessage(err),
        variant: 'destructive',
      })
    }
  }, [pendingUndo, fetchImports, t, toast])

  const fiscalYearLabel = (row: SIEImportListRow): string => {
    if (row.fiscal_year_start && row.fiscal_year_end) {
      return t('sie_history_fiscal_year_range', {
        start: formatDate(row.fiscal_year_start),
        end: formatDate(row.fiscal_year_end),
      })
    }
    if (row.fiscal_year_start) return formatDate(row.fiscal_year_start)
    if (row.fiscal_year_end) return formatDate(row.fiscal_year_end)
    return '-'
  }

  const statusCell = (status: string) => {
    const labelKey = STATUS_LABEL_KEY[status]
    const label = labelKey ? t(labelKey) : status
    const variant = STATUS_BADGE_VARIANT[status]
    if (!variant) {
      return <span className="text-xs text-muted-foreground">{label}</span>
    }
    return (
      <Badge variant={variant} className="font-normal">
        {label}
      </Badge>
    )
  }

  if (loadFailed) {
    return <p className="px-1 text-xs leading-5 text-muted-foreground">{t('sie_history_load_error')}</p>
  }

  if (rows === null) {
    return (
      <div className="space-y-2" role="status">
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-8 w-full" />
      </div>
    )
  }

  if (rows.length === 0) {
    return <p className="px-1 text-xs leading-5 text-muted-foreground">{t('sie_history_empty')}</p>
  }

  const confirmDescription = pendingUndo
    ? t('sie_history_undo_confirm_description', { count: pendingUndo.transactions_count }) +
      (pendingUndo.transactions_count >= GAP_WARNING_VOUCHER_COUNT
        ? '\n\n' + t('sie_history_undo_gap_warning')
        : '')
    : ''

  return (
    <div>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-[13px]">
          <thead>
            <tr>
              <th className={TH_CLASS}>{t('sie_history_col_file')}</th>
              <th className={TH_CLASS}>{t('sie_history_col_date')}</th>
              <th className={TH_CLASS}>{t('sie_history_col_fiscal_year')}</th>
              <th className={cn(TH_CLASS, 'text-right')}>{t('sie_history_col_vouchers')}</th>
              <th className={TH_CLASS}>{t('sie_history_col_status')}</th>
              <th className={TH_CLASS}>
                <span className="sr-only">{t('sie_history_undo_button')}</span>
              </th>
            </tr>
          </thead>
          <tbody className="stagger-enter">
            {rows.map((row) => (
              <tr key={row.id} className="transition-colors duration-150 hover:bg-secondary/35">
                <td className={TD_CLASS}>{row.filename}</td>
                <td className={cn(TD_CLASS, 'whitespace-nowrap tabular-nums')}>
                  {formatDate(row.imported_at ?? row.created_at)}
                </td>
                <td className={cn(TD_CLASS, 'whitespace-nowrap tabular-nums')}>
                  {fiscalYearLabel(row)}
                </td>
                <td className={cn(TD_CLASS, 'text-right tabular-nums')}>{row.transactions_count}</td>
                <td className={TD_CLASS}>{statusCell(row.status)}</td>
                <td className={cn(TD_CLASS, 'text-right')}>
                  {row.status === 'completed' && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="text-destructive hover:text-destructive"
                      onClick={() => setPendingUndo(row)}
                    >
                      <Undo2 className="mr-2 h-4 w-4" />
                      {t('sie_history_undo_button')}
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
        title={t('sie_history_undo_confirm_title')}
        description={confirmDescription}
        confirmLabel={t('sie_history_undo_confirm_label')}
        onConfirm={handleUndoConfirm}
      />
    </div>
  )
}
