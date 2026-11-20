'use client'

import { Suspense, useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useLocale, useTranslations } from 'next-intl'
import { ClipboardDocumentListIcon, LockClosedIcon, PlusIcon } from '@/components/icons'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { LateReveal, Skeleton } from '@/components/ui/skeleton'
import { EmptyState, LoadError } from '@/components/ui/empty-state'
import { AttnLine } from '@/components/ui/attn-line'
import { ListPageSkeleton } from '@/components/common/ListPageSkeleton'
import { ToolbarSearch, TOOLBAR_SEARCH_END_CLASS } from '@/components/ui/toolbar-search'
import { ContextPicker } from '@/components/common/ContextPicker'
import { TH_CLASS, TD_CLASS, SHOW_MORE_STEP, ShowMoreFooter } from '@/components/ui/dry-table'
import { useCanWrite } from '@/lib/hooks/use-can-write'
import { getErrorMessage, type ErrorLocale } from '@/lib/errors/get-error-message'
import { cn, formatDate, formatRowAmount } from '@/lib/utils'
import {
  DELIVERY_LABEL_KEY,
  INVOICING_LABEL_KEY,
  STATUS_BADGE_VARIANT,
  STATUS_LABEL_KEY,
} from '@/components/sales-orders/labels'
import type { SalesOrder, SalesOrderStatus } from '@/types'

const ALL = 'all'
const STATUSES: SalesOrderStatus[] = ['draft', 'confirmed', 'completed', 'cancelled']

function isStatus(value: string | null): value is SalesOrderStatus {
  return !!value && (STATUSES as string[]).includes(value)
}

function SalesOrdersPageInner() {
  const t = useTranslations('sales_orders')
  const tCommon = useTranslations('common')
  const errorLocale = useLocale() as ErrorLocale
  const { canWrite } = useCanWrite()
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()

  const statusParam = searchParams.get('status')
  const statusFilter: SalesOrderStatus | typeof ALL = isStatus(statusParam) ? statusParam : ALL

  const [orders, setOrders] = useState<SalesOrder[]>([])
  const [isLoading, setIsLoading] = useState(true)
  // The last read failed (the description says why). With no rows on screen
  // the list says so in place of them; rows already on screen stay, with one
  // line above them. "Försök igen" bumps reloadKey.
  const [loadError, setLoadError] = useState<string | null>(null)
  const [reloadKey, setReloadKey] = useState(0)
  const reload = useCallback(() => setReloadKey((key) => key + 1), [])
  const [searchTerm, setSearchTerm] = useState('')
  const [visibleCount, setVisibleCount] = useState(SHOW_MORE_STEP)

  const updateStatus = useCallback(
    (next: string) => {
      setVisibleCount(SHOW_MORE_STEP)
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
        if (cancelled) return
        setOrders(data)
        setLoadError(null)
      })
      .catch((err) => {
        if (cancelled) return
        setLoadError(getErrorMessage(err.body ?? err, { locale: errorLocale, statusCode: err.status }))
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false)
      })
    return () => {
      cancelled = true
    }
    // errorLocale is stable enough; the fetch keys on the status filter (and a retry) only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statusFilter, reloadKey])

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
      <div className="page-header flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <h1 className="page-header-title">{t('title')}</h1>
        <Button size="toolbar" asChild={canWrite} disabled={!canWrite} title={!canWrite ? t('viewer_disabled_tooltip') : undefined}>
          {canWrite ? (
            <Link href="/sales-orders/new">
              <PlusIcon className="h-4 w-4" />
              {t('new_order')}
            </Link>
          ) : (
            <span>
              <LockClosedIcon className="h-4 w-4" />
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
          containerClassName={TOOLBAR_SEARCH_END_CLASS}
          placeholder={t('search_placeholder')}
          value={searchTerm}
          onChange={(e) => {
            setSearchTerm(e.target.value)
            setVisibleCount(SHOW_MORE_STEP)
          }}
        />
      </div>

      {loadError && orders.length > 0 && !isLoading && (
        <AttnLine action={{ label: tCommon('retry'), onClick: reload }}>{tCommon('refresh_failed')}</AttnLine>
      )}

      {isLoading ? (
        <LateReveal>
          {[1, 2, 3, 4, 5, 6].map((i) => (
            <div key={i} className="flex h-11 items-center gap-8 border-b-hairline">
              <Skeleton className="h-3.5 w-12" />
              <Skeleton className="h-3.5 w-48" />
              <Skeleton className="hidden h-3.5 w-20 md:block" />
              <Skeleton className="h-3.5 w-16" />
              <Skeleton className="ml-auto h-3.5 w-20" />
            </div>
          ))}
        </LateReveal>
      ) : loadError && orders.length === 0 ? (
        <LoadError title={t('load_failed_title')} description={loadError} onRetry={reload} />
      ) : filtered.length === 0 ? (
        searchTerm ? (
          <div className="flex flex-wrap items-center gap-x-3 py-3 text-[13px] text-muted-foreground">
            <span data-ph-mask="">{t('no_search_results_description', { term: searchTerm })}</span>
            <Button variant="link" onClick={() => setSearchTerm('')}>
              {tCommon('clear_search')}
            </Button>
          </div>
        ) : statusFilter !== ALL ? (
          <p className="py-3 text-[13px] text-muted-foreground">{t('no_status_results_description')}</p>
        ) : (
          <EmptyState
            icon={ClipboardDocumentListIcon}
            title={t('empty_title')}
            description={t('empty_description')}
            actionLabel={canWrite ? t('empty_action') : undefined}
            actionHref={canWrite ? '/sales-orders/new' : undefined}
          />
        )
      ) : (
        <>
          <div className="-mx-2 overflow-x-auto">
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
                      <td className={cn(TD_CLASS, 'hidden whitespace-nowrap date-figures text-muted-foreground md:table-cell')}>
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
                        {formatRowAmount(order.total, order.currency)}
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

          <ShowMoreFooter
            shown={visibleCount}
            total={filtered.length}
            onMore={() => setVisibleCount((count) => count + SHOW_MORE_STEP)}
          />
        </>
      )}
    </div>
  )
}

export default function SalesOrdersPage() {
  return (
    <Suspense fallback={<ListPageSkeleton />}>
      <SalesOrdersPageInner />
    </Suspense>
  )
}
