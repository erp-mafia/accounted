'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useLocale, useTranslations } from 'next-intl'
import { Skeleton } from '@/components/ui/skeleton'
import { QUIET_LINK_CLASS } from '@/components/ui/dry-table'
import type { HistoryEvent } from '@/lib/arkiv/history'
import { DOC_TYPES } from '@/lib/documents/classify/taxonomy'

/** /arkiv/historik: one line per thing that happened to a document, newest first. */
export function ArkivHistory() {
  const t = useTranslations('arkiv')
  const locale = useLocale()
  const [events, setEvents] = useState<HistoryEvent[] | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let cancelled = false
    fetch('/api/arkiv/history')
      .then(async (res) => {
        if (!res.ok) throw new Error(String(res.status))
        const json = (await res.json()) as { data: { events: HistoryEvent[] } }
        if (!cancelled) setEvents(json.data.events)
      })
      .catch(() => {
        if (!cancelled) setFailed(true)
      })
    return () => {
      cancelled = true
    }
  }, [])

  if (failed) return <p className="text-[13px] text-muted-foreground">{t('load_failed')}</p>
  if (!events) return <Skeleton className="h-40 w-full" />
  if (events.length === 0) return <p className="text-[13px] text-muted-foreground">{t('history_empty')}</p>

  const when = (iso: string) => new Date(iso).toLocaleString(locale === 'sv' ? 'sv-SE' : 'en-GB', { dateStyle: 'medium', timeStyle: 'short' })
  const actorLabel = (e: HistoryEvent) => e.actor.label ?? t(`history_actor_${e.actor.kind}` as never)
  const detailLabel = (e: HistoryEvent) => (e.detail && (e.kind === 'typed' || e.kind === 'retyped') && (DOC_TYPES as readonly string[]).includes(e.detail) ? t(`types.${e.detail}` as never) : e.detail)

  return (
    <ul className="m-0 list-none divide-y divide-border p-0">
      {events.map((e) => (
        <li key={e.id} className="grid gap-x-4 gap-y-0.5 py-2 text-[13px] sm:grid-cols-[150px_minmax(0,1fr)]">
          <span className="tabular-nums text-muted-foreground">{when(e.at)}</span>
          <span>
            <span className="text-muted-foreground">{actorLabel(e)}</span>
            {' · '}
            {t(`history_event_${e.kind}` as never)}
            {detailLabel(e) ? <span className="text-muted-foreground">{` · ${detailLabel(e)}`}</span> : null}
            {e.document ? (
              <>
                {' · '}
                <Link href={`/arkiv/dokument/${e.document.id}`} className={QUIET_LINK_CLASS}>
                  {e.document.file_name || e.document.id}
                </Link>
              </>
            ) : null}
          </span>
        </li>
      ))}
    </ul>
  )
}
