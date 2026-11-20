'use client'

import { formatVoucher } from '@/lib/bookkeeping/voucher-series-resolver'
import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { EllipsisHorizontalIcon } from '@/components/icons'
import { Button } from '@/components/ui/button'
import { useViewerLock } from '@/components/ui/viewer-lock'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { EmptyState } from '@/components/ui/empty-state'
import { TH_CLASS, TD_CLASS } from '@/components/ui/dry-table'
import { formatDate, cn, formatRowAmount } from '@/lib/utils'
import type { TransactionWithInvoice } from './transaction-types'

/**
 * "Granska migrerad historik": the review surface for journal-entry match
 * suggestions the reconciliation sweep persisted (the 0.75-0.89 band). Each
 * row shows the bank transaction beside its suggested verifikat; confirming
 * goes through the server-side revalidating bulk endpoint, so a stale pair
 * degrades to a reported skip, never a wrong link. Per-row fallbacks: open the
 * match dialog to pick another verifikat, or reject the suggestion (the row
 * returns to the ordinary "Att bokföra" flow as backstop).
 */
interface SuggestionReviewListProps {
  items: TransactionWithInvoice[]
  /** Bulk/single confirm: resolves when the API call and list refresh are done. */
  onConfirm: (transactionIds: string[]) => Promise<void>
  onReject: (transactionIds: string[]) => Promise<void>
  onOpenMatchVoucher: (tx: TransactionWithInvoice) => void
  onRerunMatching: () => Promise<void>
  rerunning: boolean
}

export function SuggestionReviewList({
  items,
  onConfirm,
  onReject,
  onOpenMatchVoucher,
  onRerunMatching,
  rerunning,
}: SuggestionReviewListProps) {
  const t = useTranslations('tx_review')
  const { canWrite, lockedTitle } = useViewerLock()
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set())
  const [bulkBusy, setBulkBusy] = useState(false)

  const runRows = async (ids: string[], action: (ids: string[]) => Promise<void>) => {
    setBusyIds((prev) => new Set([...prev, ...ids]))
    try {
      await action(ids)
    } finally {
      setBusyIds((prev) => {
        const next = new Set(prev)
        for (const id of ids) next.delete(id)
        return next
      })
    }
  }

  const confirmAll = async () => {
    setBulkBusy(true)
    try {
      await runRows(items.map((i) => i.id), onConfirm)
    } finally {
      setBulkBusy(false)
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground">
          {t('intro', { count: items.length })}
        </p>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            disabled={!canWrite || bulkBusy}
            title={lockedTitle}
            loading={rerunning}
            onClick={() => void onRerunMatching()}
          >
            {t('rerun')}
          </Button>
          <Button disabled={!canWrite || items.length === 0} title={lockedTitle} loading={bulkBusy} onClick={() => void confirmAll()}>
            {t('confirm_all', { count: items.length })}
          </Button>
        </div>
      </div>

      {items.length === 0 ? (
        <EmptyState title={t('empty_title')} description={t('empty_description')} />
      ) : (
        <div className="-mx-2 overflow-x-auto">
          <table className="w-full border-collapse text-[13px]">
            <thead>
              <tr>
                <th className={TH_CLASS}>{t('th_date')}</th>
                <th className={TH_CLASS}>{t('th_description')}</th>
                <th className={cn(TH_CLASS, 'text-right')}>{t('th_amount')}</th>
                <th className={TH_CLASS}>{t('th_suggestion')}</th>
                <th className={TH_CLASS} aria-label={t('th_actions')} />
              </tr>
            </thead>
            <tbody className="stagger-enter">
              {items.map((tx) => {
                const busy = busyIds.has(tx.id)
                const voucher = tx.potential_voucher
                return (
                  <tr key={tx.id} className="group transition-colors duration-150 hover:bg-secondary/35">
                    <td className={cn(TD_CLASS, 'whitespace-nowrap date-figures text-muted-foreground')}>
                      {formatDate(tx.date)}
                    </td>
                    <td className={cn(TD_CLASS, 'max-w-[280px]')}>
                      <span className="block truncate">{tx.description}</span>
                    </td>
                    <td className={cn(TD_CLASS, 'whitespace-nowrap text-right tabular-nums')}>
                      {formatRowAmount(tx.amount, tx.currency)}
                    </td>
                    <td className={cn(TD_CLASS, 'whitespace-nowrap date-figures')}>
                      {voucher ? (
                        <span className="tabular-nums">
                          {formatVoucher(voucher)}
                          <span className="text-muted-foreground">
                            {' · '}
                            {formatDate(voucher.entry_date)}
                            {typeof tx.potential_match_confidence === 'number' && (
                              <> {' · '}{Math.round(tx.potential_match_confidence * 100)} %</>
                            )}
                          </span>
                        </span>
                      ) : (
                        <span className="text-muted-foreground">{t('suggestion_gone')}</span>
                      )}
                    </td>
                    <td className={cn(TD_CLASS, 'whitespace-nowrap text-right')}>
                      <div className="flex items-center justify-end gap-1">
                        <Button
                          variant="outline"
                          disabled={!canWrite || bulkBusy || !voucher}
                          title={lockedTitle}
                          loading={busy}
                          onClick={() => void runRows([tx.id], onConfirm)}
                        >
                          {busy ? null : t('confirm')}
                        </Button>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button
                              size="icon"
                              variant="ghost"
                              disabled={!canWrite || busy || bulkBusy}
                              aria-label={t('row_menu')}
                            >
                              <EllipsisHorizontalIcon className="h-4 w-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem onClick={() => onOpenMatchVoucher(tx)}>
                              {t('open_match_dialog')}
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={() => void runRows([tx.id], onReject)}>
                              {t('reject')}
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
