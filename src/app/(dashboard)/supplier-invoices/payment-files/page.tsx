'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { useLocale, useTranslations } from 'next-intl'
import { PageHeader } from '@/components/ui/page-header'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { LateReveal, Skeleton } from '@/components/ui/skeleton'
import { EmptyState, LoadError, NotFoundState } from '@/components/ui/empty-state'
import { AttnLine } from '@/components/ui/attn-line'
import { TH_CLASS, TD_CLASS, QUIET_LINK_CLASS } from '@/components/ui/dry-table'
import {
  Dialog,
  DialogConsequence,
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
import { cn, formatCurrency, formatDate, formatRowAmount } from '@/lib/utils'
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

/** One invoice "Markera alla som betalda" could not book, with the server's reason. */
type MarkPaidFailure = { id: string; label: string; reason: string }

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
  const tNav = useTranslations('nav')
  const tCommon = useTranslations('common')
  const locale = useLocale() as ErrorLocale
  const { toast } = useToast()
  const { canWrite } = useCanWrite()

  const [batches, setBatches] = useState<BatchListRow[]>([])
  const [isLoading, setIsLoading] = useState(true)
  // The last read failed. With no files on screen the list says so in place
  // of them; files already on screen stay, with one line above them.
  const [loadFailed, setLoadFailed] = useState(false)
  const [detail, setDetail] = useState<BatchDetail | null>(null)
  const [detailId, setDetailId] = useState<string | null>(null)
  // The detail read failed: 'not_found' (the file is gone) or 'failed' (retry).
  const [detailError, setDetailError] = useState<'not_found' | 'failed' | null>(null)
  const [downloadingId, setDownloadingId] = useState<string | null>(null)
  const [confirmCancelId, setConfirmCancelId] = useState<string | null>(null)
  const [cancelling, setCancelling] = useState(false)
  const [cancelError, setCancelError] = useState<string | null>(null)
  const [markingAll, setMarkingAll] = useState(false)
  // The invoices the last "Markera alla som betalda" could not book, each
  // with the server's reason, shown in the sheet of the file they belong to.
  const [markAllFailures, setMarkAllFailures] = useState<{
    batchId: string
    items: MarkPaidFailure[]
  } | null>(null)

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
      setLoadFailed(false)
    } catch {
      setLoadFailed(true)
    } finally {
      setIsLoading(false)
      setIsLoadingMore(false)
    }
  }, [windowSize])

  useEffect(() => {
    fetchBatches()
  }, [fetchBatches])

  const openDetail = useCallback(async (id: string) => {
    setDetailId(id)
    setDetail(null)
    setDetailError(null)
    try {
      const res = await fetch(`/api/supplier-invoices/payment-batches/${id}`)
      if (!res.ok) {
        setDetailError(res.status === 404 ? 'not_found' : 'failed')
        return
      }
      const body = await res.json()
      setDetail(body.data as BatchDetail)
    } catch {
      setDetailError('failed')
    }
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
    setCancelError(null)
    try {
      const res = await fetch(
        `/api/supplier-invoices/payment-batches/${confirmCancelId}/cancel`,
        { method: 'POST' },
      )
      if (!res.ok) {
        // The refusal stays in the dialog, where the action is, with the
        // server's sentence: the file is not cancelled.
        const body = await res.json().catch(() => null)
        setCancelError(
          getErrorMessage(body, { locale, statusCode: res.status, fallback: t('cancel_failed_title') }),
        )
        return
      }
      toast({ title: t('cancelled_toast') })
      setConfirmCancelId(null)
      setDetailId(null)
      fetchBatches()
    } catch (err) {
      setCancelError(getErrorMessage(err, { locale, fallback: t('cancel_failed_title') }))
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
    setMarkAllFailures(null)
    let booked = 0
    let skippedSettled = 0
    let skippedDuplicate = 0
    const failures: MarkPaidFailure[] = []
    try {
      for (const item of detail.items) {
        const invoice = item.invoice
        if (!invoice || invoice.remaining_amount <= SETTLED_EPSILON) {
          skippedSettled += 1
          continue
        }
        const label = `${item.payee_name} · ${invoice.supplier_invoice_number ?? item.reference}`
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
          const body = await res.json().catch(() => null)
          if (body?.error?.code === 'SI_PAID_LIKELY_DUPLICATE') skippedDuplicate += 1
          else {
            failures.push({
              id: item.id,
              label,
              reason: getErrorMessage(body, {
                locale,
                statusCode: res.status,
                context: 'supplier_invoice',
              }),
            })
          }
        } catch (err) {
          failures.push({
            id: item.id,
            label,
            reason: getErrorMessage(err, { locale, context: 'supplier_invoice' }),
          })
        }
      }

      // Every outcome is told, not only the first: duplicates and failures
      // can happen in the same run. Each failed invoice and its reason stays
      // listed in the sheet.
      const failed = failures.length
      const outcomes = [
        skippedDuplicate > 0 ? t('mark_all_result_duplicates', { count: skippedDuplicate }) : null,
        failed > 0 ? t('mark_all_result_failed', { count: failed }) : null,
        skippedSettled > 0 ? t('mark_all_result_settled', { count: skippedSettled }) : null,
      ].filter((line): line is string => line !== null)
      toast({
        title: t('mark_all_result_title', { booked }),
        description: outcomes.length > 0 ? outcomes.join(' ') : undefined,
        variant: failed > 0 ? 'destructive' : undefined,
      })
      if (failed > 0) setMarkAllFailures({ batchId: detail.id, items: failures })
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
      <PageHeader parent={{ label: tNav('supplier_invoices'), href: '/supplier-invoices' }} title={t('history_title')} />

      {loadFailed && batches.length > 0 && (
        <AttnLine action={{ label: tCommon('retry'), onClick: () => void fetchBatches() }}>
          {tCommon('refresh_failed')}
        </AttnLine>
      )}

      {isLoading ? (
        <LateReveal>
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="flex h-11 items-center gap-8 border-b-hairline">
              <Skeleton className="h-3.5 w-20" />
              <Skeleton className="h-3.5 w-8" />
              <Skeleton className="h-3.5 w-20" />
              <Skeleton className="h-3.5 w-32" />
            </div>
          ))}
        </LateReveal>
      ) : loadFailed && batches.length === 0 ? (
        <LoadError onRetry={() => void fetchBatches()} />
      ) : batches.length === 0 ? (
        <EmptyState
          icon={DocumentTextIcon}
          title={t('empty_title')}
          description={t('empty_description')}
          actionLabel={t('empty_action')}
          actionHref="/supplier-invoices"
        />
      ) : (
        <div className="-mx-2 overflow-x-auto">
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
                  <td className={cn(TD_CLASS, 'whitespace-nowrap date-figures')}>
                    {formatDate(batch.created_at)}
                  </td>
                  <td className={cn(TD_CLASS, 'whitespace-nowrap text-right tabular-nums')}>
                    {batch.item_count}
                  </td>
                  <td className={cn(TD_CLASS, 'whitespace-nowrap text-right tabular-nums rr-mask')}>
                    {formatRowAmount(batch.total_amount)}
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
            setDetailError(null)
            setMarkAllFailures(null)
          }
        }}
      >
        <SlideOverContent aria-describedby={undefined}>
          {detailError ? (
            <>
              <SlideOverHeader title={t('history_title')} />
              <SlideOverBody>
                {detailError === 'not_found' ? (
                  <NotFoundState
                    title={t('detail_not_found')}
                    backHref="/supplier-invoices"
                    backLabel={t('empty_action')}
                  />
                ) : (
                  <LoadError
                    title={t('detail_load_failed')}
                    onRetry={() => {
                      if (detailId) void openDetail(detailId)
                    }}
                  />
                )}
              </SlideOverBody>
            </>
          ) : detail ? (
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
                        className="flex items-center gap-3 border-b-hairline py-2.5 text-[13px]"
                      >
                        <div className="min-w-0 flex-1">
                          <Link
                            href={`/supplier-invoices/${item.supplier_invoice_id}`}
                            className="block truncate hover:underline"
                          >
                            {item.payee_name}
                          </Link>
                          <span className="block text-xs text-muted-foreground tabular-nums">
                            {item.invoice?.supplier_invoice_number ?? item.reference}
                            {' · '}
                            {formatDate(item.payment_date)}
                          </span>
                        </div>
                        {settled ? (
                          <span className="whitespace-nowrap text-xs text-muted-foreground">
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
                {markAllFailures?.batchId === detail.id && markAllFailures.items.length > 0 && (
                  <AttnLine>
                    <p>{t('mark_all_failures_line', { count: markAllFailures.items.length })}</p>
                    <ul className="mt-1 space-y-0.5" data-ph-mask="">
                      {markAllFailures.items.map((failure) => (
                        <li key={failure.id}>
                          <span className="tabular-nums text-strong">{failure.label}</span>
                          {': '}
                          {failure.reason}
                        </li>
                      ))}
                    </ul>
                  </AttnLine>
                )}
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
            <SlideOverBody className="pt-6">
              <LateReveal className="space-y-3">
                {[1, 2, 3].map((i) => (
                  <Skeleton key={i} className="h-5 w-full" />
                ))}
              </LateReveal>
            </SlideOverBody>
          )}
        </SlideOverContent>
      </SlideOver>

      {/* Cancel confirm (convention 10): describe the outcome up front. */}
      <Dialog
        open={confirmCancelId != null}
        onOpenChange={(open) => {
          if (!open && !cancelling) {
            setConfirmCancelId(null)
            setCancelError(null)
          }
        }}
      >
        <DialogContent size="confirm">
          <DialogHeader>
            <DialogTitle>{t('cancel_confirm_title')}</DialogTitle>
            <DialogDescription>{t('cancel_confirm_body')}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            {cancelError && (
              <DialogConsequence role="alert" className="text-destructive">
                {cancelError}
              </DialogConsequence>
            )}
            <Button
              variant="ghost"
              onClick={() => {
                setConfirmCancelId(null)
                setCancelError(null)
              }}
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
