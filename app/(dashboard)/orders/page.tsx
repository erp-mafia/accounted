'use client'

import { useCallback, useEffect, useState } from 'react'
import dynamic from 'next/dynamic'
import Link from 'next/link'
import { useLocale, useTranslations } from 'next-intl'
import { MoreHorizontal, ShoppingCart } from 'lucide-react'
import { PageHeader } from '@/components/ui/page-header'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { EmptyState } from '@/components/ui/empty-state'
import { Skeleton } from '@/components/ui/skeleton'
import { useToast } from '@/components/ui/use-toast'
import { ContextPicker } from '@/components/common/ContextPicker'
import { TH_CLASS, TD_CLASS, QUIET_LINK_CLASS, CHECKBOX_REVEAL_CLASS } from '@/components/ui/dry-table'
import { cn, formatCurrency, formatDate } from '@/lib/utils'
import { getErrorMessage, type ErrorLocale } from '@/lib/errors/get-error-message'
import { useCanWrite } from '@/lib/hooks/use-can-write'
import type { WebshopOrder, WebshopStoreSettings } from '@/types'

const OrderBookingDialog = dynamic(() => import('@/components/orders/OrderBookingDialog'), {
  ssr: false,
})
const CreateInvoiceFromOrderDialog = dynamic(
  () => import('@/components/orders/CreateInvoiceFromOrderDialog'),
  { ssr: false },
)
const MarkOrderBookedDialog = dynamic(
  () => import('@/components/orders/MarkOrderBookedDialog'),
  { ssr: false },
)
const BulkOrderBookingDialog = dynamic(
  () => import('@/components/orders/BulkOrderBookingDialog'),
  { ssr: false },
)

/**
 * A row can join the bulk sweep exactly when its single-row Bokför button
 * would render: unbooked, uninvoiced, not marked as booked outside the
 * integration, and either a refund or a paid order. Legacy-overlap rows stay
 * selectable on purpose: the server guard decides and the per-order failure
 * report explains (no dead-end soft guard).
 */
function isBulkBookable(order: WebshopOrder, canWrite: boolean): boolean {
  return (
    canWrite &&
    order.journal_entry_id === null &&
    order.invoice_id === null &&
    order.manually_booked_at === null &&
    (order.row_type === 'refund' || order.is_paid)
  )
}

interface StoreFacet {
  platform: string
  store_scope: string
  store_label: string | null
}

type StatusTab = 'all' | 'unpaid' | 'paid' | 'refunds' | 'booked'

const PAGE_SIZE = 50

/** Server-side query params per status tab (pagination stays correct). */
function tabQuery(tab: StatusTab): string {
  switch (tab) {
    case 'unpaid':
      return '&paid=unpaid'
    case 'paid':
      return '&paid=paid&booked=unbooked'
    case 'refunds':
      return '&row_type=refund'
    case 'booked':
      return '&booked=booked'
    default:
      return ''
  }
}

export default function OrdersPage() {
  const t = useTranslations('webshop_orders')
  const errorLocale = useLocale() as ErrorLocale
  const { canWrite } = useCanWrite()
  const { toast } = useToast()
  const [rows, setRows] = useState<WebshopOrder[]>([])
  const [stores, setStores] = useState<StoreFacet[]>([])
  const [settings, setSettings] = useState<WebshopStoreSettings[]>([])
  const [count, setCount] = useState(0)
  const [loading, setLoading] = useState(true)
  // A transient fetch failure must not render as "no orders" with a connect
  // CTA (review finding): failure gets its own retry state.
  const [loadFailed, setLoadFailed] = useState(false)
  const [tab, setTab] = useState<StatusTab>('all')
  const [storeScope, setStoreScope] = useState<string | null>(null)
  const [page, setPage] = useState(0)
  const [bookingOrder, setBookingOrder] = useState<WebshopOrder | null>(null)
  const [invoicingOrder, setInvoicingOrder] = useState<WebshopOrder | null>(null)
  const [markingOrder, setMarkingOrder] = useState<WebshopOrder | null>(null)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  // Snapshot of the selection the bulk dialog opened with: the list refresh
  // after a partial failure clears the live selection, but the dialog must
  // keep showing its per-order report.
  const [bulkOrders, setBulkOrders] = useState<WebshopOrder[] | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    // A reload changes which rows exist and which are still bookable
    // (tab/page/store switch, or a completed sweep): start selection over.
    setSelectedIds(new Set())
    try {
      const storeParam = storeScope ? `&store_scope=${encodeURIComponent(storeScope)}` : ''
      const res = await fetch(
        `/api/webshop-orders?limit=${PAGE_SIZE}&offset=${page * PAGE_SIZE}${tabQuery(tab)}${storeParam}`,
      )
      if (!res.ok) throw new Error(`list failed: ${res.status}`)
      const json = (await res.json()) as {
        data: WebshopOrder[]
        count: number | null
        stores: StoreFacet[]
      }
      setRows(json.data)
      setCount(json.count ?? json.data.length)
      setStores(json.stores)
      setLoadFailed(false)
    } catch {
      setRows([])
      setCount(0)
      setLoadFailed(true)
    } finally {
      setLoading(false)
    }
  }, [tab, storeScope, page])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    fetch('/api/webshop-orders/settings')
      .then((r) => (r.ok ? r.json() : { data: [] }))
      .then((json: { data: WebshopStoreSettings[] }) => setSettings(json.data ?? []))
      .catch(() => setSettings([]))
  }, [])

  const visibleRows = rows

  const multiStore = stores.length > 1
  const activeStore = stores.find((s) => s.store_scope === storeScope) ?? null
  const storeItems = [
    { id: 'all', label: t('all_stores') },
    ...stores.map((s) => ({ id: s.store_scope, label: s.store_label || s.store_scope })),
  ]

  const settingsFor = useCallback(
    (order: WebshopOrder) =>
      settings.find(
        (s) => s.platform === order.platform && s.store_scope === order.store_scope,
      ) ?? null,
    [settings],
  )

  // Undo a manual "booked outside the integration" mark: no accounting
  // objects were created, so this simply returns the row to the to-book list.
  const unmarkOrder = useCallback(
    async (order: WebshopOrder) => {
      try {
        const res = await fetch(`/api/webshop-orders/${order.id}/mark-booked`, {
          method: 'DELETE',
        })
        const json = await res.json()
        if (!res.ok || json.error) {
          toast({
            title: t('unmark_failed'),
            description: getErrorMessage(json, {
              context: 'transaction',
              statusCode: res.status,
              locale: errorLocale,
            }),
            variant: 'destructive',
          })
          return
        }
        void load()
      } catch {
        toast({ title: t('unmark_failed'), variant: 'destructive' })
      }
    },
    [load, t, toast, errorLocale],
  )

  const selectableIds = visibleRows
    .filter((o) => isBulkBookable(o, canWrite))
    .map((o) => o.id)

  const toggleSelect = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const openBulkBooking = useCallback(() => {
    setBulkOrders(rows.filter((o) => selectedIds.has(o.id)))
  }, [rows, selectedIds])

  const tabs: Array<{ key: StatusTab; label: string }> = [
    { key: 'all', label: t('tab_all') },
    { key: 'unpaid', label: t('tab_unpaid') },
    { key: 'paid', label: t('tab_to_book') },
    { key: 'refunds', label: t('tab_refunds') },
    { key: 'booked', label: t('tab_booked') },
  ]

  return (
    <div className="space-y-8">
      <PageHeader title={t('title')} />

      <div className="flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap items-center gap-1">
          {tabs.map(({ key, label }) => (
            <button
              key={key}
              type="button"
              onClick={() => {
                setTab(key)
                setPage(0)
              }}
              className={cn(
                'rounded-full px-3 py-[5px] text-[13px] transition-colors duration-150',
                tab === key
                  ? 'bg-secondary text-foreground'
                  : 'text-muted-foreground hover:bg-secondary/60 hover:text-foreground',
              )}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="ml-auto">
          <ContextPicker
            items={storeItems}
            value={storeScope ?? 'all'}
            onChange={(id) => {
              setStoreScope(id === 'all' ? null : id)
              setPage(0)
            }}
            triggerLabel={
              activeStore ? activeStore.store_label || activeStore.store_scope : t('all_stores')
            }
            ariaLabel={t('store_picker_aria')}
          />
        </div>
      </div>

      {loading ? (
        <div className="space-y-2">
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-9 w-full" />
        </div>
      ) : loadFailed ? (
        <div className="space-y-4 py-8 text-center">
          <p className="text-sm text-muted-foreground">{t('load_failed')}</p>
          <Button variant="outline" size="sm" onClick={() => void load()}>
            {t('retry')}
          </Button>
        </div>
      ) : visibleRows.length === 0 ? (
        <EmptyState
          icon={ShoppingCart}
          title={t('empty_title')}
          description={t('empty_description')}
          actionLabel={t('empty_action')}
          // The import hub's e-handel section lists every connectable
          // platform; deep-linking one platform's connect panel here would
          // send Shopify users into the WooCommerce flow.
          actionHref="/import"
        />
      ) : (
        <div className="stagger-enter">
          {/* Bulkbar (transactions-page pattern): hidden until at least one
              bookable order is selected via the hover checkboxes. */}
          {selectedIds.size > 0 && (
            <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border-b border-border px-1 py-2.5 text-[12.5px] animate-fade-in">
              <span className="whitespace-nowrap">
                <strong className="font-semibold tabular-nums">{selectedIds.size}</strong>{' '}
                {t('bulk_selected', { count: selectedIds.size })}
              </span>
              <Button size="sm" onClick={openBulkBooking}>
                {t('bulk_book_selected')}
              </Button>
              {selectedIds.size < selectableIds.length && (
                <button
                  type="button"
                  className={QUIET_LINK_CLASS}
                  onClick={() => setSelectedIds(new Set(selectableIds))}
                >
                  {t('bulk_select_all', { count: selectableIds.length })}
                </button>
              )}
              <button
                type="button"
                className={QUIET_LINK_CLASS}
                onClick={() => setSelectedIds(new Set())}
              >
                {t('bulk_clear')}
              </button>
            </div>
          )}
          {/* Negative margin + matching padding: lets the hover-revealed
              selection checkbox hang into the page margins without being
              clipped by the overflow container (transactions-page pattern). */}
          <div className="-mx-5 overflow-x-auto px-5 md:-mx-8 md:px-8">
          <table className="w-full border-collapse text-[13px]">
            <thead>
              <tr>
                <th className={cn(TH_CLASS, 'w-0 !p-0')} aria-hidden="true"></th>
                <th className={TH_CLASS}>{t('col_date')}</th>
                <th className={TH_CLASS}>{t('col_order')}</th>
                {multiStore && <th className={TH_CLASS}>{t('col_store')}</th>}
                <th className={TH_CLASS}>{t('col_customer')}</th>
                <th className={TH_CLASS}>{t('col_payment_method')}</th>
                <th className={cn(TH_CLASS, 'text-right')}>{t('col_total')}</th>
                <th className={TH_CLASS}>{t('col_status')}</th>
                <th className={cn(TH_CLASS, 'w-0')} />
              </tr>
            </thead>
            <tbody>
              {visibleRows.map((order) => (
                <OrderRow
                  key={order.id}
                  order={order}
                  multiStore={multiStore}
                  canWrite={canWrite}
                  selectable={isBulkBookable(order, canWrite)}
                  isSelected={selectedIds.has(order.id)}
                  onToggleSelect={toggleSelect}
                  onBook={() => setBookingOrder(order)}
                  onInvoice={() => setInvoicingOrder(order)}
                  onMarkBooked={() => setMarkingOrder(order)}
                  onUnmark={() => void unmarkOrder(order)}
                  t={t}
                />
              ))}
            </tbody>
          </table>
          </div>
          {count > PAGE_SIZE && (
            <div className="mt-4 flex items-center justify-between text-[12.5px] text-muted-foreground">
              <span>
                {t('pagination', {
                  from: page * PAGE_SIZE + 1,
                  to: Math.min((page + 1) * PAGE_SIZE, count),
                  total: count,
                })}
              </span>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page === 0}
                  onClick={() => setPage((p) => p - 1)}
                >
                  {t('prev')}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={(page + 1) * PAGE_SIZE >= count}
                  onClick={() => setPage((p) => p + 1)}
                >
                  {t('next')}
                </Button>
              </div>
            </div>
          )}
        </div>
      )}

      {bookingOrder && (
        <OrderBookingDialog
          open={!!bookingOrder}
          onOpenChange={(open) => {
            if (!open) setBookingOrder(null)
          }}
          order={bookingOrder}
          storeSettings={settingsFor(bookingOrder)}
          onBooked={() => {
            setBookingOrder(null)
            void load()
          }}
          onSettingsSaved={(updated) => {
            setSettings((prev) => {
              const rest = prev.filter(
                (s) => !(s.platform === updated.platform && s.store_scope === updated.store_scope),
              )
              return [...rest, updated]
            })
          }}
        />
      )}
      {bulkOrders && (
        <BulkOrderBookingDialog
          open={!!bulkOrders}
          onOpenChange={(open) => {
            if (!open) setBulkOrders(null)
          }}
          orders={bulkOrders}
          settingsFor={settingsFor}
          onBooked={() => {
            setSelectedIds(new Set())
            void load()
          }}
        />
      )}
      {invoicingOrder && (
        <CreateInvoiceFromOrderDialog
          open={!!invoicingOrder}
          onOpenChange={(open) => {
            if (!open) setInvoicingOrder(null)
          }}
          order={invoicingOrder}
          onCreated={() => {
            setInvoicingOrder(null)
            void load()
          }}
        />
      )}
      {markingOrder && (
        <MarkOrderBookedDialog
          open={!!markingOrder}
          onOpenChange={(open) => {
            if (!open) setMarkingOrder(null)
          }}
          order={markingOrder}
          onMarked={() => {
            setMarkingOrder(null)
            void load()
          }}
        />
      )}
    </div>
  )
}

function OrderRow({
  order,
  multiStore,
  canWrite,
  selectable,
  isSelected,
  onToggleSelect,
  onBook,
  onInvoice,
  onMarkBooked,
  onUnmark,
  t,
}: {
  order: WebshopOrder
  multiStore: boolean
  canWrite: boolean
  selectable: boolean
  isSelected: boolean
  onToggleSelect: (id: string) => void
  onBook: () => void
  onInvoice: () => void
  onMarkBooked: () => void
  onUnmark: () => void
  t: ReturnType<typeof useTranslations<'webshop_orders'>>
}) {
  const isRefund = order.row_type === 'refund'
  const booked = order.journal_entry_id !== null
  const invoiced = order.invoice_id !== null
  const manuallyMarked = order.manually_booked_at !== null
  // Cross-marked rows (legacy_transaction_id) keep their action buttons: the
  // server guard decides (it allows booking once the feed row is booked-
  // elsewhere-no, ignored-yes) and its 409 message explains what to do.
  // Hiding the button would be a dead-end soft guard.
  const bookable =
    canWrite && !booked && !invoiced && !manuallyMarked && (isRefund || order.is_paid)
  const invoiceable = canWrite && !isRefund && !booked && !invoiced && !manuallyMarked
  // Secondary actions live in the overflow menu so the cell keeps one text
  // button (the two-button layout used to overflow the panel width).
  const markable = canWrite && !booked && !invoiced && !manuallyMarked
  const unmarkable = canWrite && manuallyMarked

  return (
    <tr
      className={cn(
        'group transition-colors duration-150 hover:bg-secondary/35',
        isSelected && 'bg-secondary/40',
      )}
    >
      {/* Hover-revealed selection checkbox (transactions-page pattern):
          zero-width cell, the checkbox hangs in the left page margin so the
          date column stays where it was. Selected rows keep it visible. */}
      <td className={cn(TD_CLASS, 'relative w-0 !p-0')}>
        {selectable && (
          <Checkbox
            checked={isSelected}
            onCheckedChange={() => onToggleSelect(order.id)}
            aria-label={t('select_order_aria', { number: order.order_number })}
            className={cn(
              'absolute -left-5 top-1/2 -translate-y-1/2 duration-150 md:-left-6',
              isSelected ? 'opacity-100' : CHECKBOX_REVEAL_CLASS,
            )}
          />
        )}
      </td>
      <td className={cn(TD_CLASS, 'whitespace-nowrap tabular-nums text-muted-foreground')}>
        {formatDate(order.order_date)}
      </td>
      <td className={cn(TD_CLASS, 'whitespace-nowrap')}>
        {isRefund ? (
          <span className="text-muted-foreground">
            {t('refund_prefix')} {order.order_number}
          </span>
        ) : (
          <span>{order.order_number}</span>
        )}
      </td>
      {multiStore && (
        <td className={cn(TD_CLASS, 'max-w-[160px] truncate text-muted-foreground')}>
          {order.store_label || order.store_scope}
        </td>
      )}
      {/* One-line rows (design convention 4): the full beställningsuppgifter
          (kontaktperson, orgnr, e-post) live in the native tooltip. */}
      <td
        className={cn(TD_CLASS, 'max-w-[220px] truncate')}
        title={
          [
            order.customer_company ? order.customer_name : null,
            order.customer_orgnr,
            order.customer_email,
          ]
            .filter(Boolean)
            .join(' · ') || undefined
        }
      >
        {order.customer_company || order.customer_name || (
          <span className="text-muted-foreground">{'–'}</span>
        )}
      </td>
      <td className={cn(TD_CLASS, 'whitespace-nowrap text-muted-foreground')}>
        {order.payment_method_title || order.payment_method || ''}
      </td>
      <td className={cn(TD_CLASS, 'whitespace-nowrap text-right tabular-nums')}>
        {formatCurrency(order.total, order.currency)}
      </td>
      <td className={cn(TD_CLASS, 'whitespace-nowrap')}>
        <OrderStatus order={order} t={t} />
      </td>
      {/* One action per row: Bokför when the money event is bookable, else
          Skapa faktura for unpaid invoice-flow orders. Two buttons side by
          side pushed the table past the panel width and the overflow clip
          swallowed single-button cells. */}
      <td className={cn(TD_CLASS, 'whitespace-nowrap text-right')}>
        <div className="flex items-center justify-end gap-1">
          {bookable ? (
            <Button variant="outline" size="sm" onClick={onBook}>
              {t('action_book')}
            </Button>
          ) : invoiceable ? (
            <Button variant="outline" size="sm" onClick={onInvoice}>
              {t('action_create_invoice')}
            </Button>
          ) : null}
          {(markable || unmarkable) && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 shrink-0"
                  aria-label={t('row_menu_aria', { number: order.order_number })}
                >
                  <MoreHorizontal className="h-4 w-4 text-muted-foreground" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {markable && (
                  <DropdownMenuItem onSelect={onMarkBooked}>
                    {t('action_mark_booked')}
                  </DropdownMenuItem>
                )}
                {unmarkable && (
                  <DropdownMenuItem onSelect={onUnmark}>
                    {t('action_unmark_booked')}
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </td>
    </tr>
  )
}

/**
 * Chips mark exceptions only (design convention 5): booked rows render as
 * muted text; deviations (unbooked-but-paid, unpaid, legacy overlap, remote
 * drift) get a Badge.
 */
function OrderStatus({
  order,
  t,
}: {
  order: WebshopOrder
  t: ReturnType<typeof useTranslations<'webshop_orders'>>
}) {
  if (order.remote_changed_after_freeze) {
    return <Badge variant="warning">{t('status_remote_changed')}</Badge>
  }
  if (order.journal_entry_id) {
    return <span className="text-xs text-muted-foreground">{t('status_booked')}</span>
  }
  // Marked as handled outside the integration: a normal done state, so muted
  // text, not a chip (convention 5). Links to the referenced verifikat when
  // the user picked one.
  if (order.manually_booked_at) {
    return order.manually_booked_journal_entry_id ? (
      <Link
        href={`/bookkeeping/${order.manually_booked_journal_entry_id}`}
        className="text-xs text-muted-foreground underline decoration-border underline-offset-4 hover:text-foreground"
      >
        {t('status_marked_booked')}
      </Link>
    ) : (
      <span className="text-xs text-muted-foreground">{t('status_marked_booked')}</span>
    )
  }
  if (order.invoice_id) {
    return (
      <Link
        href={`/invoices/${order.invoice_id}`}
        className="text-xs text-muted-foreground underline decoration-border underline-offset-4 hover:text-foreground"
      >
        {t('status_invoiced')}
      </Link>
    )
  }
  if (order.legacy_transaction_id) {
    return (
      <Link href="/transactions">
        <Badge variant="outline">{t('status_in_transactions')}</Badge>
      </Link>
    )
  }
  if (!order.is_paid && order.row_type === 'order') {
    return <Badge variant="secondary">{t('status_unpaid')}</Badge>
  }
  return <Badge variant="warning">{t('status_to_book')}</Badge>
}
