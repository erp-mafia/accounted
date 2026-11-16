'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useLocale, useTranslations } from 'next-intl'
import { EmptyState, LoadError } from '@/components/ui/empty-state'
import { LateReveal, Skeleton } from '@/components/ui/skeleton'
import { ClipboardDocumentCheckIcon } from '@/components/icons'
import { Badge } from '@/components/ui/badge'
import { dayKindOf, mergeLatest } from './need-model'
import { formatDate } from '@/lib/utils'
import type { PendingOperation } from '@/types'

/**
 * Gjort (Att göra V8): what has been decided, newest first, a day at a time.
 * The source is the proposals that left Rutin (approved, rejected, closed),
 * read from the same route as Rutin's Historik, which the page links to: a
 * row is a line of the log, not a link, because Rutin has no address for one
 * settled proposal. The product keeps no company-wide activity feed, so
 * nothing else is listed here: the full trail is the behandlingshistorik
 * report.
 */

const PAGE = 50

type Row = Pick<PendingOperation, 'id' | 'title' | 'status' | 'resolved_at' | 'created_at' | 'actor_type' | 'actor_label'>

async function load(status: 'committed' | 'rejected'): Promise<{ rows: Row[]; total: number | null }> {
  const res = await fetch(`/api/pending-operations?status=${status}&order=desc&limit=${PAGE}`)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const json = await res.json()
  return { rows: (json.data ?? []) as Row[], total: typeof json.count === 'number' ? json.count : null }
}

const whenOf = (row: Row) => row.resolved_at ?? row.created_at
const dayOf = (iso: string | Date) => {
  const d = new Date(iso)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
const timeOf = (iso: string) => new Date(iso).toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit' })

export function HemDone() {
  const t = useTranslations('hem')
  const tPending = useTranslations('pending')
  const locale = useLocale()
  const [state, setState] = useState<
    { status: 'loading' } | { status: 'error' } | { status: 'ready'; rows: Row[]; total: number | null; today: string }
  >({ status: 'loading' })

  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let live = true
    Promise.all([load('committed'), load('rejected')])
      .then(([committed, rejected]) => {
        if (!live) return
        setState({
          status: 'ready',
          // Exactly the newest rows of the log: nothing older than what a full page reached.
          rows: mergeLatest([committed.rows, rejected.rows], PAGE, whenOf),
          total: committed.total !== null && rejected.total !== null ? committed.total + rejected.total : null,
          today: dayOf(new Date()),
        })
      })
      .catch(() => {
        if (live) setState({ status: 'error' })
      })
    return () => {
      live = false
    }
  }, [attempt])

  if (state.status === 'loading') {
    return (
      <LateReveal>
        <div className="-mx-2" aria-busy="true">
          {[1, 2, 3, 4, 5, 6].map((i) => (
            <div key={i} className="flex h-11 items-center gap-4 border-b-hairline px-2">
              <Skeleton className="h-4 w-10" />
              <Skeleton className="h-4 w-72" />
            </div>
          ))}
        </div>
      </LateReveal>
    )
  }
  if (state.status === 'error') {
    return (
      <LoadError
        title={t('done_load_failed')}
        onRetry={() => {
          setState({ status: 'loading' })
          setAttempt((n) => n + 1)
        }}
      />
    )
  }
  if (state.rows.length === 0) {
    return <EmptyState icon={ClipboardDocumentCheckIcon} title={t('done_empty')} actionLabel={t('back_home')} actionHref="/" />
  }

  const days: Array<{ day: string; rows: Row[] }> = []
  for (const row of state.rows) {
    const day = dayOf(whenOf(row))
    const last = days[days.length - 1]
    if (last && last.day === day) last.rows.push(row)
    else days.push({ day, rows: [row] })
  }
  // A day heading: today and yesterday in words, a day of this year by its weekday, an older one by its date.
  const dayHeading = (day: string): string => {
    if (day.slice(0, 4) !== state.today.slice(0, 4)) return formatDate(day)
    const [y, m, d] = day.split('-').map(Number)
    const long = new Intl.DateTimeFormat(locale === 'en' ? 'en-GB' : 'sv-SE', { weekday: 'long', day: 'numeric', month: 'long' }).format(new Date(y, m - 1, d))
    const kind = dayKindOf(day, state.today)
    if (kind === 'today') return t('done_day_today', { date: long })
    if (kind === 'yesterday') return t('done_day_yesterday', { date: long })
    return long.charAt(0).toLocaleUpperCase(locale === 'en' ? 'en-GB' : 'sv-SE') + long.slice(1)
  }
  const shown = state.rows.length
  const more = state.total !== null && state.total > shown

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-x-4 gap-y-1">
        {/* The top bar holds the page's h1. The count is what is listed; the whole log's size is said when it is larger. */}
        <h2 className="min-w-0 flex-1 basis-64 text-xl text-strong">
          {more ? t('done_headline_of', { count: shown, total: state.total as number }) : t('done_headline_all', { count: shown })}
        </h2>
        {/* Every row is a proposal that left Rutin: its Historik is where each one opens. */}
        <Link href="/pending" className="inline-flex min-h-7 items-center text-xs text-foreground underline underline-offset-[3px] pointer-coarse:min-h-10">
          {t('done_open_rutin')}
        </Link>
      </div>
      <div className="stagger-enter -mx-2">
        <div className="flex h-8 items-center gap-3 border-b-hairline px-2 text-xs font-medium text-muted-foreground" aria-hidden>
          <span className="w-12 shrink-0">{t('col_time')}</span>
          <span className="min-w-0 flex-1">{t('col_what')}</span>
        </div>
        {days.map(({ day, rows }) => (
          <section key={day} aria-labelledby={`done-day-${day}`}>
            <h3 id={`done-day-${day}`} className="flex items-end gap-2 border-b-hairline px-2 pb-1.5 pt-4 text-xs font-medium text-muted-foreground">
              {dayHeading(day)}
              <span className="font-normal tabular-nums">{rows.length}</span>
            </h3>
            <ul>
              {rows.map((row) => (
                <li key={row.id} className="flex min-h-11 items-center gap-3 border-b-hairline px-2 py-2">
                  <span className="w-12 shrink-0 text-xs tabular-nums text-muted-foreground">{timeOf(whenOf(row))}</span>
                  <span className="min-w-0 flex-1 truncate text-[13px] text-strong" data-ph-mask="">
                    {row.title}
                  </span>
                  {/* Approved is the normal outcome and reads as plain text; anything else is the exception and gets the chip. */}
                  {row.status === 'committed' ? (
                    <span className="shrink-0 text-xs text-muted-foreground">{tPending('badge_approved')}</span>
                  ) : (
                    <Badge variant={row.status === 'failed_partial' ? 'warning' : 'secondary'} className="shrink-0 font-normal">
                      {row.status === 'rejected'
                        ? tPending('badge_rejected')
                        : row.status === 'failed_partial'
                          ? tPending('badge_failed_partial')
                          : tPending('badge_unknown')}
                    </Badge>
                  )}
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </div>
  )
}
