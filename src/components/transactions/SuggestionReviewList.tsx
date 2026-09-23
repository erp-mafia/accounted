'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { MoreHorizontal, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { EmptyState } from '@/components/ui/empty-state'
import { TH_CLASS, TD_CLASS } from '@/components/ui/dry-table'
import { formatCurrency, formatDate, cn } from '@/lib/utils'
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
        <p className="text-[12.5px] text-muted-foreground">
          {t('intro', { count: items.length })}
        </p>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={rerunning || bulkBusy}
            onClick={() => void onRerunMatching()}
          >
            {rerunning && <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />}
            {t('rerun')}
          </Button>
          <Button size="sm" disabled={bulkBusy || items.length === 0} onClick={() => void confirmAll()}>
            {bulkBusy && <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />}
            {t('confirm_all', { count: items.length })}
          </Button>
        </div>
      </div>

      {items.length === 0 ? (
        <EmptyState title={t('empty_title')} description={t('empty_description')} />
      ) : (
        <div className="overflow-x-auto">
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
                    <td className={cn(TD_CLASS, 'whitespace-nowrap tabular-nums text-muted-foreground')}>
                      {formatDate(tx.date)}
                    </td>
                    <td className={cn(TD_CLASS, 'max-w-[280px]')}>
                      <span className="block truncate">{tx.description}</span>
                    </td>
                    <td className={cn(TD_CLASS, 'whitespace-nowrap text-right tabular-nums')}>
                      {formatCurrency(tx.amount, tx.currency)}
                    </td>
                    <td className={cn(TD_CLASS, 'whitespace-nowrap')}>
                      {voucher ? (
                        <span className="tabular-nums">
                          {voucher.voucher_series}-{voucher.voucher_number}
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
                          size="sm"
                          variant="outline"
                          className="h-7 px-3.5 text-xs"
                          disabled={busy || bulkBusy || !voucher}
                          onClick={() => void runRows([tx.id], onConfirm)}
                        >
                          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : t('confirm')}
                        </Button>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button
                              size="icon"
                              variant="ghost"
                              className="h-7 w-7"
                              disabled={busy || bulkBusy}
                              aria-label={t('row_menu')}
                            >
                              <MoreHorizontal className="h-4 w-4" />
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
