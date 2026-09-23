'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { Skeleton } from '@/components/ui/skeleton'
import { ToolbarSearch } from '@/components/ui/toolbar-search'
import { QUIET_LINK_CLASS } from '@/components/ui/dry-table'
import type { ArkivSearchHit, ArkivSearchView } from '@/app/api/arkiv/search/route'
import { SourceLink } from './DefList'

/**
 * The Arkiv search (phase 9c): one field over documents, agreements and
 * facts, answered with the record to open and the page it was read from.
 * Search is the in-app way to a fact; asking is done through the person's
 * own assistant, so the field carries the way there.
 */
export const SEARCH_MIN = 2

const GROUPS: Array<{ kind: ArkivSearchHit['kind']; labelKey: 'search_group_documents' | 'search_group_agreements' | 'search_group_facts' }> = [
  { kind: 'document', labelKey: 'search_group_documents' },
  { kind: 'agreement', labelKey: 'search_group_agreements' },
  { kind: 'fact', labelKey: 'search_group_facts' },
]

/** ts_headline marks matches with <b>; rendered as emphasis, never as HTML. */
function Passage({ text }: { text: string }) {
  const parts = text.split(/<\/?b>/)
  return (
    <>
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <mark key={i} className="bg-transparent font-medium text-foreground">
            {part}
          </mark>
        ) : (
          <span key={i}>{part}</span>
        ),
      )}
    </>
  )
}

export function ArkivSearch({ query, onQueryChange }: { query: string; onQueryChange: (query: string) => void }) {
  const t = useTranslations('arkiv')
  const [view, setView] = useState<ArkivSearchView | null>(null)
  const [failedQuery, setFailedQuery] = useState<string | null>(null)
  const trimmed = query.trim()
  const active = trimmed.length >= SEARCH_MIN

  useEffect(() => {
    if (!active) return
    let cancelled = false
    const timer = setTimeout(() => {
      fetch(`/api/arkiv/search?q=${encodeURIComponent(trimmed)}`)
        .then(async (res) => {
          if (!res.ok) throw new Error(String(res.status))
          const { data } = (await res.json()) as { data: ArkivSearchView }
          if (!cancelled) setView(data)
        })
        .catch(() => {
          if (!cancelled) setFailedQuery(trimmed)
        })
    }, 250)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [active, trimmed])

  // The answer on screen is always the answer to the words in the field: an older one is never shown as the current one.
  const current = active && view && view.query === trimmed ? view : null
  const failed = active && failedQuery === trimmed
  const loading = active && !failed && !current

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <ToolbarSearch id="arkiv-search" value={query} onChange={(e) => onQueryChange(e.target.value)} placeholder={t('search_documents')} containerClassName="w-full max-w-md" autoComplete="off" />
        <p className="text-[12.5px] text-muted-foreground">
          {t('search_ask_lead')}{' '}
          <Link href="/settings/api" className={`${QUIET_LINK_CLASS} text-foreground`}>
            {t('search_ask_link')}
          </Link>
          {t('search_ask_tail')}
        </p>
      </div>

      {failed && <p className="text-[13px] text-muted-foreground">{t('load_failed')}</p>}
      {loading && (
        <div className="space-y-3">
          <Skeleton className="h-5 w-1/3" />
          <Skeleton className="h-5 w-2/3" />
        </div>
      )}
      {current && current.hits.length === 0 && <p className="text-[13px] text-muted-foreground">{t('search_empty', { query: current.query })}</p>}
      {current && current.hits.length > 0 && (
        <div className="space-y-5">
          {GROUPS.map((group) => {
            const hits = current.hits.filter((h) => h.kind === group.kind)
            if (hits.length === 0) return null
            return (
              <section key={group.kind} aria-label={t(group.labelKey)}>
                <h3 className="mb-1 text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
                  {t(group.labelKey)} <span className="tabular-nums">({hits.length})</span>
                </h3>
                <ul className="divide-y divide-border">
                  {hits.map((hit) => (
                    <li key={`${hit.record_ref}:${hit.page ?? 0}`} className="flex items-start justify-between gap-4 py-2">
                      <div className="min-w-0">
                        {hit.href ? (
                          <Link href={hit.href} className={`${QUIET_LINK_CLASS} text-[13px] text-foreground`}>
                            {hit.title}
                          </Link>
                        ) : (
                          <span className="text-[13px] text-foreground">{hit.title}</span>
                        )}
                        {hit.subtitle ? <span className="ml-2 text-[11px] text-muted-foreground">{hit.subtitle}</span> : null}
                        {hit.snippet ? (
                          <div className="mt-0.5 text-[12.5px] leading-relaxed text-muted-foreground">
                            <Passage text={hit.snippet} />
                          </div>
                        ) : null}
                      </div>
                      {hit.page ? <SourceLink href={hit.source_href} label={t('source_page_short_only', { page: hit.page })} /> : null}
                    </li>
                  ))}
                </ul>
              </section>
            )
          })}
        </div>
      )}
    </div>
  )
}
