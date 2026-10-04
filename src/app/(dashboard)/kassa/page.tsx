'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import dynamic from 'next/dynamic'
import Link from 'next/link'
import { useLocale, useTranslations } from 'next-intl'
import { MoreHorizontal, Store } from 'lucide-react'
import { PageHeader } from '@/components/ui/page-header'
import { HelpPopover } from '@/components/ui/help-popover'
import { AttnLine } from '@/components/ui/attn-line'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { EmptyState } from '@/components/ui/empty-state'
import { Skeleton } from '@/components/ui/skeleton'
import { useToast } from '@/components/ui/use-toast'
import { ContextPicker } from '@/components/common/ContextPicker'
import { TH_CLASS, TD_CLASS, HOVER_REVEAL_CLASS } from '@/components/ui/dry-table'
import { getErrorMessage, type ErrorLocale } from '@/lib/errors/get-error-message'
import { useCanWrite } from '@/lib/hooks/use-can-write'
import { cn, formatCurrency, formatDate } from '@/lib/utils'
import { usePosHealthText } from '@/components/pos-sales/reason-text'
import { tenderAmount, type PosConnectionJson, type PosDayJson } from '@/components/pos-sales/types'

const PosDayDialog = dynamic(() => import('@/components/pos-sales/PosDayDialog'), { ssr: false })

type StatusFilter = 'all' | 'ready' | 'needs_review' | 'booked'

const PAGE_SIZE = 60

/**
 * Kassarapporter: one row per business day a POS venue delivered through
 * Accounted Connect, with the sales, the payment split and where the day
 * stands. A day books as its daily takings voucher from the dialog; the
 * morning run fetches new days, "Hämta nu" does it at once.
 */
export default function PosSalesPage() {
  const t = useTranslations('pos_sales')
  const errorLocale = useLocale() as ErrorLocale
  const { canWrite } = useCanWrite()
  const { toast } = useToast()
  const healthText = usePosHealthText()
  const [days, setDays] = useState<PosDayJson[]>([])
  const [total, setTotal] = useState(0)
  const [connections, setConnections] = useState<PosConnectionJson[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadFailed, setLoadFailed] = useState(false)
  const [filter, setFilter] = useState<StatusFilter>('all')
  const [venue, setVenue] = useState<string | null>(null)
  const [page, setPage] = useState(0)
  const [openDayId, setOpenDayId] = useState<string | null>(null)
  const [fetching, setFetching] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(page * PAGE_SIZE) })
      if (filter !== 'all') params.set('status', filter)
      if (venue) params.set('connection_id', venue)
      const [daysRes, connectionsRes] = await Promise.all([
        fetch(`/api/pos-sales/days?${params.toString()}`),
        fetch('/api/pos-sales/connections'),
      ])
      if (!daysRes.ok || !connectionsRes.ok) throw new Error('pos list failed')
      const daysJson = (await daysRes.json()) as { data: { days: PosDayJson[]; total: number } }
      const connectionsJson = (await connectionsRes.json()) as { data: { connections: PosConnectionJson[] } }
      setDays(daysJson.data.days)
      setTotal(daysJson.data.total)
      setConnections(connectionsJson.data.connections)
      setLoadFailed(false)
    } catch {
      setDays([])
      setTotal(0)
      setLoadFailed(true)
    } finally {
      setLoading(false)
    }
  }, [filter, venue, page])

  useEffect(() => {
    void load()
  }, [load])

  const activeConnections = useMemo(() => (connections ?? []).filter((c) => c.status === 'active'), [connections])
  const venueNames = useMemo(() => new Map((connections ?? []).map((c) => [c.id, c.venue_name])), [connections])
  const stuck = activeConnections.find((c) => c.health === 'action_required') ?? null

  async function fetchNow(businessDates?: string[], connectionId?: string) {
    setFetching(true)
    try {
      const res = await fetch('/api/pos-sales/fetch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...(businessDates ? { business_dates: businessDates } : {}), ...(connectionId ? { connection_id: connectionId } : {}) }),
      })
      const json = await res.json()
      if (!res.ok || json.error) {
        toast({
          title: t('fetch_failed'),
          description: getErrorMessage(json, { statusCode: res.status, locale: errorLocale }),
          variant: 'destructive',
        })
        return
      }
      const results = (json.data?.results ?? []) as Array<{ status: string; fetched: string[]; errorCode?: string }>
      const failed = results.find((r) => r.status === 'failed')
      const fetched = results.reduce((sum, r) => sum + r.fetched.length, 0)
      if (failed) {
        toast({ title: t('fetch_failed'), description: healthText(failed.errorCode ?? null), variant: 'destructive' })
      } else {
        toast({ title: fetched > 0 ? t('fetch_done', { count: fetched }) : t('fetch_nothing') })
      }
      void load()
    } catch {
      toast({ title: t('fetch_failed'), variant: 'destructive' })
    } finally {
      setFetching(false)
    }
  }

  const filters: Array<{ id: StatusFilter; label: string }> = [
    { id: 'all', label: t('filter_all') },
    { id: 'ready', label: t('filter_ready') },
    { id: 'needs_review', label: t('filter_review') },
    { id: 'booked', label: t('filter_booked') },
  ]
  const multiVenue = (connections ?? []).length > 1
  const venueItems = [{ id: 'all', label: t('venue_all') }, ...(connections ?? []).map((c) => ({ id: c.id, label: c.venue_name }))]

  const noConnection = connections !== null && connections.length === 0

  return (
    <div className="space-y-8">
      <PageHeader
        title={t('title')}
        help={<HelpPopover>{t('help')}</HelpPopover>}
        action={
          activeConnections.length > 0 && canWrite ? (
            <Button size="sm" loading={fetching} onClick={() => void fetchNow()}>
              {t('fetch_now')}
            </Button>
          ) : undefined
        }
      />

      {stuck ? (
        <AttnLine action={{ label: t('attn_fix'), href: '/settings/pos' }}>
          {t('attn_stuck', { venue: stuck.venue_name, reason: healthText(stuck.health_code) })}
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
          {multiVenue ? (
            <div className="ml-auto">
              <ContextPicker
                items={venueItems}
                value={venue ?? 'all'}
                onChange={(id) => {
                  setVenue(id === 'all' ? null : id)
                  setPage(0)
                }}
                triggerLabel={venue ? venueNames.get(venue) ?? t('venue_all') : t('venue_all')}
                ariaLabel={t('venue_picker_aria')}
              />
            </div>
          ) : null}
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
          <Button variant="outline" size="sm" onClick={() => void load()}>
            {t('retry')}
          </Button>
        </div>
      ) : noConnection ? (
        <EmptyState
          icon={Store}
          title={t('no_connection_title')}
          description={t('no_connection_description')}
          actionLabel={t('no_connection_action')}
          actionHref="/settings/pos"
        />
      ) : days.length === 0 ? (
        <div role="status" aria-live="polite">
          <EmptyState
            icon={Store}
            title={filter === 'all' && !venue ? t('empty_title') : t('empty_filtered_title')}
            description={filter === 'all' && !venue ? t('empty_description') : undefined}
          />
        </div>
      ) : (
        <div className="stagger-enter">
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-[13px]">
              <thead>
                <tr>
                  <th className={TH_CLASS}>{t('col_date')}</th>
                  {multiVenue ? <th className={TH_CLASS}>{t('col_venue')}</th> : null}
                  <th className={cn(TH_CLASS, 'text-right')}>{t('col_sales')}</th>
                  <th className={cn(TH_CLASS, 'text-right')}>{t('col_vat')}</th>
                  <th className={cn(TH_CLASS, 'text-right')}>{t('col_card')}</th>
                  <th className={cn(TH_CLASS, 'text-right')}>{t('col_swish')}</th>
                  <th className={cn(TH_CLASS, 'text-right')}>{t('col_cash')}</th>
                  <th className={cn(TH_CLASS, 'text-right')}>{t('col_tips')}</th>
                  <th className={cn(TH_CLASS, 'text-right')}>{t('col_receipts')}</th>
                  <th className={TH_CLASS}>{t('col_status')}</th>
                  <th className={cn(TH_CLASS, 'w-0')} />
                </tr>
              </thead>
              <tbody>
                {days.map((day) => (
                  <tr
                    key={day.id}
                    className="group cursor-pointer transition-colors duration-150 hover:bg-secondary/35"
                    onClick={() => setOpenDayId(day.id)}
                  >
                    <td className={cn(TD_CLASS, 'whitespace-nowrap tabular-nums')}>{formatDate(day.business_date)}</td>
                    {multiVenue ? (
                      <td className={cn(TD_CLASS, 'max-w-[160px] truncate text-muted-foreground')}>{venueNames.get(day.connection_id) ?? ''}</td>
                    ) : null}
                    <td className={cn(TD_CLASS, 'whitespace-nowrap text-right tabular-nums')}>{formatCurrency(day.gross)}</td>
                    <td className={cn(TD_CLASS, 'whitespace-nowrap text-right tabular-nums text-muted-foreground')}>{formatCurrency(day.vat)}</td>
                    <td className={cn(TD_CLASS, 'whitespace-nowrap text-right tabular-nums')}>{amountCell(tenderAmount(day, 'card'))}</td>
                    <td className={cn(TD_CLASS, 'whitespace-nowrap text-right tabular-nums')}>{amountCell(tenderAmount(day, 'swish'))}</td>
                    <td className={cn(TD_CLASS, 'whitespace-nowrap text-right tabular-nums')}>{amountCell(tenderAmount(day, 'cash'))}</td>
                    <td className={cn(TD_CLASS, 'whitespace-nowrap text-right tabular-nums text-muted-foreground')}>{amountCell(day.tips)}</td>
                    <td className={cn(TD_CLASS, 'whitespace-nowrap text-right tabular-nums text-muted-foreground')}>{day.receipt_count}</td>
                    <td className={cn(TD_CLASS, 'whitespace-nowrap')}>
                      <DayStatus day={day} t={t} />
                    </td>
                    <td className={cn(TD_CLASS, 'whitespace-nowrap text-right')} onClick={(e) => e.stopPropagation()}>
                      <div className="flex items-center justify-end gap-1">
                        {canWrite && !day.journal_entry_id && day.status !== 'empty' ? (
                          <Button variant="outline" size="sm" className={HOVER_REVEAL_CLASS} onClick={() => setOpenDayId(day.id)}>
                            {day.status === 'ready' ? t('action_book') : t('action_review')}
                          </Button>
                        ) : null}
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon-sm"
                              className={cn('shrink-0', HOVER_REVEAL_CLASS, 'data-[state=open]:opacity-100')}
                              aria-label={t('row_menu_aria', { date: formatDate(day.business_date) })}
                            >
                              <MoreHorizontal className="h-4 w-4 text-muted-foreground" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem asChild>
                              <a href={`/api/pos-sales/days/${day.id}/report`} target="_blank" rel="noopener noreferrer">
                                {t('view_report')}
                              </a>
                            </DropdownMenuItem>
                            {canWrite && !day.journal_entry_id ? (
                              <DropdownMenuItem onSelect={() => void fetchNow([day.business_date], day.connection_id)}>
                                {t('action_refetch')}
                              </DropdownMenuItem>
                            ) : null}
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {total > PAGE_SIZE ? (
            <div className="mt-4 flex items-center justify-between text-[12.5px] text-muted-foreground">
              <span>{t('pagination', { from: page * PAGE_SIZE + 1, to: Math.min((page + 1) * PAGE_SIZE, total), total })}</span>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
                  {t('prev')}
                </Button>
                <Button variant="outline" size="sm" disabled={(page + 1) * PAGE_SIZE >= total} onClick={() => setPage((p) => p + 1)}>
                  {t('next')}
                </Button>
              </div>
            </div>
          ) : null}
        </div>
      )}

      {openDayId ? (
        <PosDayDialog
          dayId={openDayId}
          open={!!openDayId}
          onOpenChange={(open) => {
            if (!open) setOpenDayId(null)
          }}
          onBooked={() => {
            setOpenDayId(null)
            void load()
          }}
        />
      ) : null}
    </div>
  )
}

function amountCell(amount: number): string {
  return amount === 0 ? '' : formatCurrency(amount)
}

/**
 * Chips mark exceptions (convention 5): a booked day and a day without sales
 * are muted text; a day to book, to review or changed after booking gets a chip.
 */
function DayStatus({ day, t }: { day: PosDayJson; t: ReturnType<typeof useTranslations<'pos_sales'>> }) {
  if (day.changed_after_booking) return <Badge variant="destructive">{t('status_changed')}</Badge>
  if (day.journal_entry_id) {
    return (
      <Link
        href={`/bookkeeping/${day.journal_entry_id}`}
        onClick={(e) => e.stopPropagation()}
        className="text-xs text-muted-foreground underline decoration-border underline-offset-4 hover:text-foreground"
      >
        {t('status_booked')}
      </Link>
    )
  }
  if (day.status === 'empty') return <span className="text-xs text-muted-foreground">{t('status_empty')}</span>
  if (day.status === 'needs_review') return <Badge variant="warning">{t('status_review')}</Badge>
  return <Badge variant="outline">{t('status_ready')}</Badge>
}
