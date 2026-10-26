'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { useLocale, useTranslations } from 'next-intl'
import { PageHeader } from '@/components/ui/page-header'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { EmptyState } from '@/components/ui/empty-state'
import { TH_CLASS, TD_CLASS, QUIET_LINK_CLASS } from '@/components/ui/dry-table'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  SlideOver,
  SlideOverBody,
  SlideOverContent,
  SlideOverFooter,
  SlideOverHeader,
} from '@/components/ui/slide-over'
import { DocumentTextIcon } from '@/components/icons'
import { useToast } from '@/components/ui/use-toast'
import { useCanWrite } from '@/lib/hooks/use-can-write'
import { downloadFile } from '@/lib/browser/download-file'
import { failureDescription } from '@/lib/browser/action-failure'
import { getErrorMessage, type ErrorLocale } from '@/lib/errors/get-error-message'
import { cn, formatCurrency, formatDate } from '@/lib/utils'
import { collectPages } from '@/lib/lists/collect-pages'
import type { SupplierPaymentBatch, SupplierPaymentBatchItem } from '@/types'

type BatchListRow = SupplierPaymentBatch & { settled_count: number }

type BatchItemWithInvoice = SupplierPaymentBatchItem & {
  invoice: {
    id: string
    status: string
    remaining_amount: number
    supplier_invoice_number: string | null
    arrival_number: number
  } | null
}

type BatchDetail = SupplierPaymentBatch & { items: BatchItemWithInvoice[] }

/** Mirrors the öre epsilon the server derives settled_count with. */
const SETTLED_EPSILON = 0.005

// Files per page, and the most the list API returns per request
// (SupplierPaymentBatchListQuerySchema).
const LIST_PAGE_SIZE = 50
const BATCH_API_MAX_LIMIT = 100

/** The name to save under should the response name none; the server's (supplierPaymentBatchFilename) comes first. */
function batchFilename(batch: Pick<SupplierPaymentBatch, 'id' | 'created_at' | 'format'>): string {
  const datePart = batch.created_at.slice(0, 10).replace(/-/g, '')
  return `betalfil_${datePart}_${batch.id.replace(/-/g, '').slice(0, 8)}.${batch.format === 'bg_lb' ? 'txt' : 'xml'}`
}

export default function PaymentFilesPage() {
  const t = useTranslations('supplier_payment_files')
  const tCommon = useTranslations('common')
  const locale = useLocale() as ErrorLocale
  const { toast } = useToast()
  const { canWrite } = useCanWrite()

  const [batches, setBatches] = useState<BatchListRow[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [detail, setDetail] = useState<BatchDetail | null>(null)
  const [detailId, setDetailId] = useState<string | null>(null)
  const [downloadingId, setDownloadingId] = useState<string | null>(null)
  const [confirmCancelId, setConfirmCancelId] = useState<string | null>(null)
  const [cancelling, setCancelling] = useState(false)
  const [markingAll, setMarkingAll] = useState(false)

  // Files loaded so far. "Ladda fler" grows it; a refetch after a cancel or
  // a mark-paid reloads the whole grown window in chunks so the list never
  // collapses back to the newest page.
  const [windowSize, setWindowSize] = useState(LIST_PAGE_SIZE)
  const [hasMore, setHasMore] = useState(false)
  const [isLoadingMore, setIsLoadingMore] = useState(false)

  const fetchBatches = useCallback(async () => {
    // A grown window refreshes in place: the skeleton would hide the rows
    // the user paged to.
    if (windowSize === LIST_PAGE_SIZE) setIsLoading(true)
    try {
      const { data, count } = await collectPages<BatchListRow>(
        async (offset, limit) => {
          const res = await fetch(
            `/api/supplier-invoices/payment-batches?status=all&limit=${limit}&offset=${offset}`,
          )
          if (!res.ok) throw new Error(`HTTP ${res.status}`)
          const body = await res.json()
          return { data: (body.data as BatchListRow[]) ?? [], count: body.count ?? null }
        },
        { want: windowSize, chunkSize: BATCH_API_MAX_LIMIT },
      )
      setBatches(data)
      setHasMore(count !== null && count > data.length)
    } catch {
      toast({ title: tCommon('load_error'), variant: 'destructive' })
    } finally {
      setIsLoading(false)
      setIsLoadingMore(false)
    }
  }, [windowSize, tCommon, toast])

  useEffect(() => {
    fetchBatches()
  }, [fetchBatches])

  const openDetail = useCallback(async (id: string) => {
    setDetailId(id)
    setDetail(null)
    const res = await fetch(`/api/supplier-invoices/payment-batches/${id}`)
    if (!res.ok) {
      setDetailId(null)
      return
    }
    const body = await res.json()
    setDetail(body.data as BatchDetail)
  }, [])

  async function handleDownload(batch: Pick<SupplierPaymentBatch, 'id' | 'created_at' | 'format'>) {
    if (downloadingId) return
    setDownloadingId(batch.id)
    try {
      const result = await downloadFile({
        url: `/api/supplier-invoices/payment-batches/${batch.id}/file`,
        filename: batchFilename(batch),
        preferServerFilename: true,
        locale,
      })
      if (!result.ok) {
        toast({
          title: t('download_failed_title'),
          description: failureDescription(result, {
            timeout: t('download_timeout'),
            network: t('download_network'),
          }),
          variant: 'destructive',
        })
      }
    } finally {
      setDownloadingId(null)
    }
  }

  async function handleCancel() {
    if (!confirmCancelId || cancelling) return
    setCancelling(true)
    try {
      const res = await fetch(
        `/api/supplier-invoices/payment-batches/${confirmCancelId}/cancel`,
        { method: 'POST' },
      )
      const body = await res.json()
      if (!res.ok) {
        toast({
          title: t('cancel_failed_title'),
          description: getErrorMessage(body, { locale }),
          variant: 'destructive',
        })
      } else {
        toast({ title: t('cancelled_toast') })
      }
      setConfirmCancelId(null)
      setDetailId(null)
      fetchBatches()
    } finally {
      setCancelling(false)
    }
  }

  // Sequential mark-paid per item, reusing the existing per-invoice route with
  // its duplicate-payment guard intact. Never force: a 409 duplicate means a
  // matching bank transaction is already in the feed and bank matching is the
  // right way to settle that invoice.
  async function handleMarkAllPaid() {
    if (!detail || markingAll) return
    setMarkingAll(true)
    let booked = 0
    let skippedSettled = 0
    let skippedDuplicate = 0
    let failed = 0
    try {
      for (const item of detail.items) {
        const invoice = item.invoice
        if (!invoice || invoice.remaining_amount <= SETTLED_EPSILON) {
          skippedSettled += 1
          continue
        }
        try {
          const res = await fetch(`/api/supplier-invoices/${item.supplier_invoice_id}/mark-paid`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              amount: Math.min(item.amount, invoice.remaining_amount),
              payment_date: item.payment_date,
            }),
          })
          if (res.ok) {
            booked += 1
            continue
          }
          const body = await res.json()
          if (body?.error?.code === 'SI_PAID_LIKELY_DUPLICATE') skippedDuplicate += 1
          else failed += 1
        } catch {
          failed += 1
        }
      }

      toast({
        title: t('mark_all_result_title', { booked }),
        description:
          skippedDuplicate > 0
            ? t('mark_all_result_duplicates', { count: skippedDuplicate })
            : failed > 0
              ? t('mark_all_result_failed', { count: failed })
              : skippedSettled > 0
                ? t('mark_all_result_settled', { count: skippedSettled })
                : undefined,
        variant: failed > 0 ? 'destructive' : undefined,
      })
      await fetchBatches()
      if (detailId) await openDetail(detailId)
    } finally {
      setMarkingAll(false)
    }
  }

  const detailUnsettled =
    detail?.items.filter(
      (item) => item.invoice && item.invoice.remaining_amount > SETTLED_EPSILON,
    ).length ?? 0

  return (
    <div className="space-y-8">
      <PageHeader title={t('history_title')} />

      {isLoading ? (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="flex items-center gap-4 px-4 py-3">
              <Skeleton className="h-4 w-28" />
              <Skeleton className="h-4 w-20 flex-1" />
              <Skeleton className="h-4 w-24" />
            </div>
          ))}
        </div>
      ) : batches.length === 0 ? (
        <EmptyState
          icon={DocumentTextIcon}
          title={t('empty_title')}
          description={t('empty_description')}
          actionLabel={t('empty_action')}
          actionHref="/supplier-invoices"
        />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-[13px]">
            <thead>
              <tr>
                <th className={TH_CLASS}>{t('th_created')}</th>
                <th className={cn(TH_CLASS, 'text-right')}>{t('th_count')}</th>
                <th className={cn(TH_CLASS, 'text-right')}>{t('th_total')}</th>
                <th className={cn(TH_CLASS, 'w-full')}>{t('th_status')}</th>
                <th className={cn(TH_CLASS, 'w-[180px]')} aria-hidden="true"></th>
              </tr>
            </thead>
            <tbody className="stagger-enter">
              {batches.map((batch) => (
                <tr
                  key={batch.id}
                  className="group cursor-pointer transition-colors duration-150 hover:bg-secondary/35"
                  onClick={() => openDetail(batch.id)}
                >
                  <td className={cn(TD_CLASS, 'whitespace-nowrap tabular-nums')}>
                    {formatDate(batch.created_at)}
                  </td>
                  <td className={cn(TD_CLASS, 'whitespace-nowrap text-right tabular-nums')}>
                    {batch.item_count}
                  </td>
                  <td className={cn(TD_CLASS, 'whitespace-nowrap text-right tabular-nums rr-mask')}>
                    {formatCurrency(batch.total_amount)}
                  </td>
                  <td className={cn(TD_CLASS, 'whitespace-nowrap')}>
                    {batch.status === 'cancelled' ? (
                      <Badge variant="outline" className="font-normal">
                        {t('status_cancelled')}
                      </Badge>
                    ) : (
                      <span className="text-muted-foreground">
                        {t('settled_count', {
                          settled: batch.settled_count,
                          total: batch.item_count,
                        })}
                      </span>
                    )}
                  </td>
                  <td
                    className={cn(TD_CLASS, 'whitespace-nowrap text-right')}
                    onClick={(e) => e.stopPropagation()}
                  >
                    <span className="flex items-center justify-end gap-4 opacity-0 transition-opacity duration-150 focus-within:opacity-100 group-hover:opacity-100 pointer-coarse:opacity-100">
                      {batch.status === 'created' && (
                        <button
                          type="button"
                          className={QUIET_LINK_CLASS}
                          onClick={() => handleDownload(batch)}
                          disabled={downloadingId !== null}
                        >
                          {t('download_again')}
                        </button>
                      )}
                      {batch.status === 'created' && canWrite && (
                        <button
                          type="button"
                          className={QUIET_LINK_CLASS}
                          onClick={() => setConfirmCancelId(batch.id)}
                        >
                          {t('cancel_batch')}
                        </button>
                      )}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {/* The list is paged: keep the way to older files reachable
              whenever the server holds more than the loaded window. */}
          {hasMore && (
            <div className="flex justify-center pt-3">
              <Button
                variant="outline"
                loading={isLoadingMore}
                onClick={() => {
                  setIsLoadingMore(true)
                  setWindowSize((size) => size + LIST_PAGE_SIZE)
                }}
              >
                {tCommon('load_more')}
              </Button>
            </div>
          )}
        </div>
      )}

      {/* Batch detail: right slide-over (convention 13). */}
      <SlideOver
        open={detailId != null}
        onOpenChange={(open) => {
          if (!open) {
            setDetailId(null)
            setDetail(null)
          }
        }}
      >
        <SlideOverContent aria-describedby={undefined}>
          {detail ? (
            <>
              <SlideOverHeader
                kicker={formatDate(detail.created_at)}
                title={t('detail_title', { count: detail.item_count })}
              />
              <SlideOverBody className="space-y-4">
                {detail.status === 'cancelled' && (
                  <Badge variant="outline" className="font-normal">
                    {t('status_cancelled')}
                  </Badge>
                )}
                <div className="space-y-0">
                  {detail.items.map((item) => {
                    const settled =
                      !item.invoice || item.invoice.remaining_amount <= SETTLED_EPSILON
                    return (
                      <div
                        key={item.id}
                        className="flex items-center gap-3 border-b border-border py-2.5 text-[13px]"
                      >
                        <div className="min-w-0 flex-1">
                          <Link
                            href={`/supplier-invoices/${item.supplier_invoice_id}`}
                            className="block truncate hover:underline"
                          >
                            {item.payee_name}
                          </Link>
                          <span className="block text-[11px] text-muted-foreground tabular-nums">
                            {item.invoice?.supplier_invoice_number ?? item.reference}
                            {' · '}
                            {formatDate(item.payment_date)}
                          </span>
                        </div>
                        {settled ? (
                          <span className="whitespace-nowrap text-[11px] text-muted-foreground">
                            {t('item_settled')}
                          </span>
                        ) : (
                          <Badge variant="outline" className="font-normal">
                            {t('item_unsettled')}
                          </Badge>
                        )}
                        <span className="whitespace-nowrap text-right tabular-nums rr-mask">
                          {formatCurrency(item.amount)}
                        </span>
                      </div>
                    )
                  })}
                </div>
                <div className="flex items-center justify-between text-[13px]">
                  <span className="text-muted-foreground">{t('total_label')}</span>
                  <span className="font-medium tabular-nums rr-mask">
                    {formatCurrency(detail.total_amount)}
                  </span>
                </div>
                {detail.status === 'created' && detailUnsettled > 0 && (
                  <p className="text-xs text-muted-foreground">{t('mark_all_hint')}</p>
                )}
              </SlideOverBody>
              <SlideOverFooter>
                <div className="flex w-full flex-wrap items-center justify-end gap-3">
                  {detail.status === 'created' && (
                    <Button
                      variant="outline"
                      onClick={() => handleDownload(detail)}
                      disabled={downloadingId !== null}
                    >
                      {t('download_again')}
                    </Button>
                  )}
                  {detail.status === 'created' && canWrite && detailUnsettled > 0 && (
                    <Button onClick={handleMarkAllPaid} loading={markingAll}>
                      {t('mark_all_paid', { count: detailUnsettled })}
                    </Button>
                  )}
                </div>
              </SlideOverFooter>
            </>
          ) : (
            <SlideOverBody className="space-y-3 pt-6">
              {[1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-5 w-full" />
              ))}
            </SlideOverBody>
          )}
        </SlideOverContent>
      </SlideOver>

      {/* Cancel confirm (convention 10): describe the outcome up front. */}
      <Dialog
        open={confirmCancelId != null}
        onOpenChange={(open) => {
          if (!open && !cancelling) setConfirmCancelId(null)
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t('cancel_confirm_title')}</DialogTitle>
            <DialogDescription>{t('cancel_confirm_body')}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setConfirmCancelId(null)}
              disabled={cancelling}
            >
              {t('cancel_confirm_abort')}
            </Button>
            <Button variant="destructive" onClick={handleCancel} loading={cancelling}>
              {t('cancel_confirm_action')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
