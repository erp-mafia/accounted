'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import dynamic from 'next/dynamic'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { useLocale, useTranslations } from 'next-intl'
import { CreditCardIcon } from '@/components/icons'
import { PageHeader } from '@/components/ui/page-header'
import { HelpPopover } from '@/components/ui/help-popover'
import { AttnLine } from '@/components/ui/attn-line'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { Skeleton } from '@/components/ui/skeleton'
import { useToast } from '@/components/ui/use-toast'
import { ContextPicker } from '@/components/common/ContextPicker'
import { TH_CLASS, TD_CLASS, HOVER_REVEAL_CLASS } from '@/components/ui/dry-table'
import { getErrorMessage, type ErrorLocale } from '@/lib/errors/get-error-message'
import { useCanWrite } from '@/lib/hooks/use-can-write'
import { cn, formatCurrency, formatDate } from '@/lib/utils'
import { useSpendHealthText, useSpendKindText } from '@/components/spend/reason-text'
import type { SpendConnectionJson, SpendItemJson } from '@/components/spend/types'

const SpendItemDialog = dynamic(() => import('@/components/spend/SpendItemDialog'), { ssr: false })

type StatusFilter = 'all' | 'ready' | 'review' | 'rejected' | 'booked'

const PAGE_SIZE = 60
/** The most expenses one bulk booking takes (lib/spend/book-item.ts). */
const BOOK_BATCH_MAX = 50

/**
 * Kortköp: one row per expense a company card or spend platform delivered
 * through Accounted Connect, coded and with its receipts, and where it
 * stands. An expense books as its own verifikat from the dialog; ready ones
 * book together with "Bokför klara". The regular run receives new
 * expenses every few minutes, "Hämta nu" does it at once.
 */
export default function SpendPage() {
  const t = useTranslations('spend')
  const errorLocale = useLocale() as ErrorLocale
  const { canWrite } = useCanWrite()
  const { toast } = useToast()
  const healthText = useSpendHealthText()
  const kindText = useSpendKindText()
  const searchParams = useSearchParams()
  const [items, setItems] = useState<SpendItemJson[]>([])
  const [total, setTotal] = useState(0)
  const [connections, setConnections] = useState<SpendConnectionJson[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadFailed, setLoadFailed] = useState(false)
  const [filter, setFilter] = useState<StatusFilter>('all')
  const [page, setPage] = useState(0)
  const [openItemId, setOpenItemId] = useState<string | null>(searchParams.get('item'))
  const [fetching, setFetching] = useState(false)
  const [bookingAll, setBookingAll] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(page * PAGE_SIZE) })
      if (filter !== 'all') params.set('status', filter)
      const [itemsRes, connectionsRes] = await Promise.all([fetch(`/api/spend/items?${params.toString()}`), fetch('/api/spend/connections')])
      if (!itemsRes.ok || !connectionsRes.ok) throw new Error('spend list failed')
      const itemsJson = (await itemsRes.json()) as { data: { items: SpendItemJson[]; total: number } }
      const connectionsJson = (await connectionsRes.json()) as { data: { connections: SpendConnectionJson[] } }
      setItems(itemsJson.data.items)
      setTotal(itemsJson.data.total)
      setConnections(connectionsJson.data.connections)
      setLoadFailed(false)
    } catch {
      setItems([])
      setTotal(0)
      setLoadFailed(true)
    } finally {
      setLoading(false)
    }
  }, [filter, page])

  useEffect(() => {
    void load()
  }, [load])

  const activeConnections = useMemo(() => (connections ?? []).filter((c) => c.status === 'active'), [connections])
  const stuck = activeConnections.find((c) => c.health === 'action_required') ?? null
  const readyIds = useMemo(
    () => items.filter((i) => i.status === 'ready' && !i.journal_entry_id && i.ack_outcome === 'received').map((i) => i.id).slice(0, BOOK_BATCH_MAX),
    [items],
  )

  async function fetchNow() {
    setFetching(true)
    try {
      const res = await fetch('/api/spend/fetch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) })
      const json = await res.json()
      if (!res.ok || json.error) {
        toast({ title: t('fetch_failed'), description: getErrorMessage(json, { statusCode: res.status, locale: errorLocale }), variant: 'destructive' })
        return
      }
      const results = (json.data?.results ?? []) as Array<{ status: string; received: number; errorCode?: string }>
      const failed = results.find((r) => r.status === 'failed')
      const received = results.reduce((sum, r) => sum + r.received, 0)
      if (failed) toast({ title: t('fetch_failed'), description: healthText(failed.errorCode ?? null), variant: 'destructive' })
      else toast({ title: received > 0 ? t('fetch_done', { count: received }) : t('fetch_nothing') })
      void load()
    } catch {
      toast({ title: t('fetch_failed'), variant: 'destructive' })
    } finally {
      setFetching(false)
    }
  }

  async function bookReady() {
    if (readyIds.length === 0) return
    setBookingAll(true)
    try {
      const res = await fetch('/api/spend/items/book', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ item_ids: readyIds }),
      })
      const json = await res.json()
      if (!res.ok || json.error) {
        toast({ title: t('book_failed'), description: getErrorMessage(json, { statusCode: res.status, locale: errorLocale }), variant: 'destructive' })
        return
      }
      const booked = (json.data?.booked ?? []).length as number
      const failed = (json.data?.failed ?? []).length as number
      toast({ title: failed > 0 ? t('booked_many_partial', { booked, failed }) : t('booked_many', { count: booked }) })
      void load()
    } catch {
      toast({ title: t('book_failed'), variant: 'destructive' })
    } finally {
      setBookingAll(false)
    }
  }

  const filters: Array<{ id: StatusFilter; label: string }> = [
    { id: 'all', label: t('filter_all') },
    { id: 'ready', label: t('filter_ready') },
    { id: 'review', label: t('filter_review') },
    { id: 'rejected', label: t('filter_rejected') },
    { id: 'booked', label: t('filter_booked') },
  ]
  const noConnection = connections !== null && connections.length === 0

  return (
    <div className="space-y-8">
      <PageHeader
        title={t('title')}
        help={<HelpPopover>{t('help')}</HelpPopover>}
        action={
          activeConnections.length > 0 && canWrite ? (
            <div className="flex items-center gap-2">
              <Button size="toolbar" variant="outline" loading={fetching} onClick={() => void fetchNow()}>
                {t('fetch_now')}
              </Button>
              <Button size="toolbar" disabled={readyIds.length === 0} loading={bookingAll} onClick={() => void bookReady()}>
                {t('book_ready', { count: readyIds.length })}
              </Button>
            </div>
          ) : undefined
        }
      />

      {stuck ? (
        <AttnLine action={{ label: t('attn_fix'), href: '/settings/spend' }}>
          {t('attn_stuck', { provider: stuck.provider_name, reason: healthText(stuck.health_code) })}
        </AttnLine>
      ) : null}

      {!noConnection ? (
        <div className="flex flex-wrap items-center gap-2">
          <ContextPicker
            items={filters}
            value={filter}
            onChange={(id) => {
              setFilter(id as StatusFilter)
              setPage(0)
            }}
            triggerLabel={filters.find((f) => f.id === filter)?.label ?? t('filter_all')}
            ariaLabel={t('col_status')}
          />
        </div>
      ) : null}

      {loading ? (
        <div className="space-y-2">
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-9 w-full" />
        </div>
      ) : loadFailed ? (
        <div className="space-y-4 py-8 text-center">
          <p className="text-[13px] text-muted-foreground">{t('load_failed')}</p>
          <Button variant="outline" onClick={() => void load()}>
            {t('retry')}
          </Button>
        </div>
      ) : noConnection ? (
        <EmptyState
          icon={CreditCardIcon}
          title={t('no_connection_title')}
          description={t('no_connection_description')}
          actionLabel={t('no_connection_action')}
          actionHref="/settings/spend"
        />
      ) : items.length === 0 ? (
        <div role="status" aria-live="polite">
          <EmptyState
            icon={CreditCardIcon}
            title={filter === 'all' ? t('empty_title') : t('empty_filtered_title')}
            description={filter === 'all' ? t('empty_description') : undefined}
          />
        </div>
      ) : (
        <div className="stagger-enter">
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-[13px]">
              <thead>
                <tr>
                  <th className={TH_CLASS}>{t('col_date')}</th>
                  <th className={TH_CLASS}>{t('col_kind')}</th>
                  <th className={TH_CLASS}>{t('col_merchant')}</th>
                  <th className={TH_CLASS}>{t('col_person')}</th>
                  <th className={cn(TH_CLASS, 'text-right')}>{t('col_amount')}</th>
                  <th className={cn(TH_CLASS, 'text-right')}>{t('col_receipts')}</th>
                  <th className={TH_CLASS}>{t('col_status')}</th>
                  <th className={cn(TH_CLASS, 'w-0')} />
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr
                    key={item.id}
                    className="group cursor-pointer transition-colors duration-150 hover:bg-secondary/35"
                    onClick={() => setOpenItemId(item.id)}
                  >
                    <td className={cn(TD_CLASS, 'whitespace-nowrap tabular-nums')}>{formatDate(item.expense_date)}</td>
                    <td className={cn(TD_CLASS, 'whitespace-nowrap text-muted-foreground')}>{kindText(item.kind)}</td>
                    <td className={cn(TD_CLASS, 'max-w-[220px] truncate')}>{item.merchant_name ?? ''}</td>
                    <td className={cn(TD_CLASS, 'max-w-[160px] truncate text-muted-foreground')}>{item.person_name ?? ''}</td>
                    <td className={cn(TD_CLASS, 'whitespace-nowrap text-right tabular-nums')}>{formatCurrency(item.amount)}</td>
                    <td className={cn(TD_CLASS, 'whitespace-nowrap text-right tabular-nums text-muted-foreground')}>
                      {item.document_ids.length > 0 ? item.document_ids.length : ''}
                    </td>
                    <td className={cn(TD_CLASS, 'whitespace-nowrap')}>
                      <ItemStatus item={item} t={t} />
                    </td>
                    <td className={cn(TD_CLASS, 'whitespace-nowrap text-right')} onClick={(e) => e.stopPropagation()}>
                      {canWrite && !item.journal_entry_id && (item.status === 'ready' || item.status === 'review') ? (
                        <Button variant="outline" className={HOVER_REVEAL_CLASS} onClick={() => setOpenItemId(item.id)}>
                          {item.status === 'ready' ? t('action_book') : t('action_review')}
                        </Button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {total > PAGE_SIZE ? (
            <div className="mt-4 flex items-center justify-between text-xs text-muted-foreground">
              <span>{t('pagination', { from: page * PAGE_SIZE + 1, to: Math.min((page + 1) * PAGE_SIZE, total), total })}</span>
              <div className="flex gap-2">
                <Button variant="outline" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
                  {t('prev')}
                </Button>
                <Button variant="outline" disabled={(page + 1) * PAGE_SIZE >= total} onClick={() => setPage((p) => p + 1)}>
                  {t('next')}
                </Button>
              </div>
            </div>
          ) : null}
        </div>
      )}

      {openItemId ? (
        <SpendItemDialog
          itemId={openItemId}
          open={!!openItemId}
          onOpenChange={(open) => {
            if (!open) setOpenItemId(null)
          }}
          onBooked={() => {
            setOpenItemId(null)
            void load()
          }}
        />
      ) : null}
    </div>
  )
}

/**
 * Chips mark exceptions (convention 5): a booked expense and one booked from
 * the bank row are muted text; one to book, to review, sent back or changed
 * after booking gets a chip.
 */
function ItemStatus({ item, t }: { item: SpendItemJson; t: ReturnType<typeof useTranslations<'spend'>> }) {
  if (item.changed_after_booking) return <Badge variant="destructive">{t('status_changed')}</Badge>
  if (item.journal_entry_id) {
    return (
      <Link
        href={`/bookkeeping/${item.journal_entry_id}`}
        onClick={(e) => e.stopPropagation()}
        className="text-xs text-muted-foreground underline decoration-border underline-offset-4 hover:text-foreground"
      >
        {t('status_booked')}
      </Link>
    )
  }
  if (item.status === 'no_entry') return <span className="text-xs text-muted-foreground">{t('status_no_entry')}</span>
  if (item.status === 'rejected') return <Badge variant="destructive">{t('status_rejected')}</Badge>
  if (item.ack_outcome !== 'received') return <span className="text-xs text-muted-foreground">{t('status_receiving')}</span>
  if (item.status === 'review') return <Badge variant="warning">{t('status_review')}</Badge>
  return <Badge variant="outline">{t('status_ready')}</Badge>
}
