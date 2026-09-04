'use client'

import { Suspense, useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useLocale, useTranslations } from 'next-intl'
import { ClipboardList, Lock, Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { EmptyState } from '@/components/ui/empty-state'
import { ToolbarSearch } from '@/components/ui/toolbar-search'
import { ContextPicker } from '@/components/common/ContextPicker'
import { TH_CLASS, TD_CLASS } from '@/components/ui/dry-table'
import { useToast } from '@/components/ui/use-toast'
import { useCanWrite } from '@/lib/hooks/use-can-write'
import { getErrorMessage, type ErrorLocale } from '@/lib/errors/get-error-message'
import { cn, formatCurrency, formatDate } from '@/lib/utils'
import {
  DELIVERY_LABEL_KEY,
  INVOICING_LABEL_KEY,
  STATUS_BADGE_VARIANT,
  STATUS_LABEL_KEY,
} from '@/components/sales-orders/labels'
import type { SalesOrder, SalesOrderStatus } from '@/types'

const ALL = 'all'
const STATUSES: SalesOrderStatus[] = ['draft', 'confirmed', 'completed', 'cancelled']
const INITIAL_VISIBLE_ROWS = 100

function isStatus(value: string | null): value is SalesOrderStatus {
  return !!value && (STATUSES as string[]).includes(value)
}

function SalesOrdersPageInner() {
  const t = useTranslations('sales_orders')
  const tCommon = useTranslations('common')
  const errorLocale = useLocale() as ErrorLocale
  const { canWrite } = useCanWrite()
  const { toast } = useToast()
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()

  const statusParam = searchParams.get('status')
  const statusFilter: SalesOrderStatus | typeof ALL = isStatus(statusParam) ? statusParam : ALL

  const [orders, setOrders] = useState<SalesOrder[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [searchTerm, setSearchTerm] = useState('')
  const [visibleCount, setVisibleCount] = useState(INITIAL_VISIBLE_ROWS)

  const updateStatus = useCallback(
    (next: string) => {
      setVisibleCount(INITIAL_VISIBLE_ROWS)
      const params = new URLSearchParams(searchParams.toString())
      if (next === ALL) params.delete('status')
      else params.set('status', next)
      const query = params.toString()
      router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false })
    },
    [searchParams, router, pathname],
  )

  useEffect(() => {
    let cancelled = false
    setIsLoading(true)
    const query = statusFilter === ALL ? '' : `?status=${statusFilter}`
    fetch(`/api/sales-orders${query}`)
      .then(async (res) => {
        const json = await res.json().catch(() => null)
        if (!res.ok) throw Object.assign(new Error('load failed'), { body: json, status: res.status })
        return (json?.data ?? []) as SalesOrder[]
      })
      .then((data) => {
        if (!cancelled) setOrders(data)
      })
      .catch((err) => {
        if (cancelled) return
        toast({
          title: t('load_failed_title'),
          description: getErrorMessage(err.body ?? err, { locale: errorLocale, statusCode: err.status }),
          variant: 'destructive',
        })
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false)
      })
    return () => {
      cancelled = true
    }
    // toast/t are stable enough; the fetch keys on the status filter only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statusFilter])

  const filtered = useMemo(() => {
    const term = searchTerm.trim().toLowerCase()
    if (!term) return orders
    return orders.filter(
      (o) =>
        (o.order_number ?? '').toLowerCase().includes(term) ||
        (o.customer?.name ?? '').toLowerCase().includes(term),
    )
  }, [orders, searchTerm])
  const visible = filtered.slice(0, visibleCount)

  const statusItems = [
    { id: ALL, label: t('status_all') },
    ...STATUSES.map((s) => ({ id: s, label: t(STATUS_LABEL_KEY[s]) })),
  ]

  return (
    <div className="space-y-8">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <h1 className="font-display text-2xl leading-8 tracking-tight">{t('title')}</h1>
        <Button asChild={canWrite} disabled={!canWrite} title={!canWrite ? t('viewer_disabled_tooltip') : undefined}>
          {canWrite ? (
            <Link href="/sales-orders/new">
              <Plus className="mr-2 h-4 w-4" />
              {t('new_order')}
            </Link>
          ) : (
            <span>
              <Lock className="mr-2 h-4 w-4" />
              {t('new_order')}
            </span>
          )}
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <ContextPicker
          value={statusFilter}
          onChange={updateStatus}
          ariaLabel={t('status_picker_aria')}
          triggerLabel={statusFilter === ALL ? t('status_all') : t(STATUS_LABEL_KEY[statusFilter])}
          items={statusItems}
        />
        <ToolbarSearch
          containerClassName="min-w-[190px]"
          placeholder={t('search_placeholder')}
          value={searchTerm}
          onChange={(e) => {
            setSearchTerm(e.target.value)
            setVisibleCount(INITIAL_VISIBLE_ROWS)
          }}
        />
      </div>

      {isLoading ? (
        <div className="space-y-3">
          {[1, 2, 3, 4, 5].map((i) => (
            <Skeleton key={i} className="h-10 w-full" />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        searchTerm ? (
          <EmptyState
            icon={ClipboardList}
            title={t('no_search_results_title')}
            description={<span data-ph-mask="">{t('no_search_results_description', { term: searchTerm })}</span>}
          />
        ) : statusFilter !== ALL ? (
          <EmptyState
            icon={ClipboardList}
            title={t('no_search_results_title')}
            description={t('no_status_results_description')}
          />
        ) : (
          <EmptyState
            icon={ClipboardList}
            title={t('empty_title')}
            description={t('empty_description')}
            actionLabel={canWrite ? t('empty_action') : undefined}
            actionHref={canWrite ? '/sales-orders/new' : undefined}
          />
        )
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-[13px]">
              <thead>
                <tr>
                  <th className={TH_CLASS}>{t('col_number')}</th>
                  <th className={cn(TH_CLASS, 'w-full')}>{t('col_customer')}</th>
                  <th className={cn(TH_CLASS, 'hidden md:table-cell')}>{t('col_date')}</th>
                  <th className={TH_CLASS}>{t('col_status')}</th>
                  <th className={cn(TH_CLASS, 'hidden lg:table-cell')}>{t('col_delivery')}</th>
                  <th className={cn(TH_CLASS, 'hidden lg:table-cell')}>{t('col_invoicing')}</th>
                  <th className={cn(TH_CLASS, 'text-right')}>{t('col_total')}</th>
                </tr>
              </thead>
              <tbody className="stagger-enter">
                {visible.map((order) => {
                  const badgeVariant = STATUS_BADGE_VARIANT[order.status]
                  return (
                    <tr
                      key={order.id}
                      className="group cursor-pointer transition-colors duration-150 hover:bg-secondary/35"
                      onClick={() => router.push(`/sales-orders/${order.id}`)}
                    >
                      <td className={cn(TD_CLASS, 'whitespace-nowrap tabular-nums text-muted-foreground')}>
                        {order.order_number || '-'}
                      </td>
                      <td className={cn(TD_CLASS, 'max-w-0 w-full')}>
                        <Link
                          href={`/sales-orders/${order.id}`}
                          className="block truncate hover:underline"
                          onClick={(e) => e.stopPropagation()}
                        >
                          {order.customer?.name || '-'}
                        </Link>
                      </td>
                      <td className={cn(TD_CLASS, 'hidden whitespace-nowrap tabular-nums text-muted-foreground md:table-cell')}>
                        {formatDate(order.order_date)}
                      </td>
                      <td className={cn(TD_CLASS, 'whitespace-nowrap')}>
                        {badgeVariant ? (
                          <Badge variant={badgeVariant} className="font-normal">
                            {t(STATUS_LABEL_KEY[order.status])}
                          </Badge>
                        ) : (
                          <span className="text-muted-foreground">{t(STATUS_LABEL_KEY[order.status])}</span>
                        )}
                      </td>
                      <td className={cn(TD_CLASS, 'hidden whitespace-nowrap text-muted-foreground lg:table-cell')}>
                        {t(DELIVERY_LABEL_KEY[order.delivery_progress ?? 'none'])}
                      </td>
                      <td className={cn(TD_CLASS, 'hidden whitespace-nowrap text-muted-foreground lg:table-cell')}>
                        {t(INVOICING_LABEL_KEY[order.invoicing_progress ?? 'none'])}
                      </td>
                      <td className={cn(TD_CLASS, 'whitespace-nowrap text-right tabular-nums')}>
                        {formatCurrency(order.total, order.currency)}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>

          <p className="px-1 text-xs text-muted-foreground tabular-nums">
            {t('count_footer', { count: filtered.length })}
          </p>

          {visibleCount < filtered.length && (
            <div className="flex justify-center">
              <Button
                type="button"
                variant="outline"
                onClick={() => setVisibleCount((count) => count + INITIAL_VISIBLE_ROWS)}
              >
                {tCommon('load_more')}
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  )
}

export default function SalesOrdersPage() {
  return (
    <Suspense
      fallback={
        <div className="space-y-8">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <Skeleton className="h-9 w-40" />
            <Skeleton className="h-10 w-32" />
          </div>
          <div className="space-y-3">
            {[1, 2, 3, 4].map((i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </div>
        </div>
      }
    >
      <SalesOrdersPageInner />
    </Suspense>
  )
}
