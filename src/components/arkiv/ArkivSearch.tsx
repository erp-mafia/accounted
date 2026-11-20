'use client'

import { useEffect, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { LateReveal, Skeleton } from '@/components/ui/skeleton'
import { LoadError } from '@/components/ui/empty-state'
import { Button } from '@/components/ui/button'
import { ToolbarSearch, TOOLBAR_SEARCH_END_CLASS } from '@/components/ui/toolbar-search'
import { QUIET_LINK_CLASS } from '@/components/ui/dry-table'
import type { ArkivSearchHit, ArkivSearchView } from '@/app/api/arkiv/search/route'
import { SourceLink } from './DefList'

/**
 * The Arkiv search (phase 9c): one field over documents, agreements and
 * facts, answered with the record to open and the page it was read from.
 * Search is the in-app way to a fact; asking is done through the person's
 * own assistant, and the way there sits in the page's "?" help (ArkivHome).
 */
export const SEARCH_MIN = 2

const GROUPS: Array<{ kind: ArkivSearchHit['kind']; labelKey: 'search_group_documents' | 'search_group_agreements' | 'search_group_facts' }> = [
  { kind: 'document', labelKey: 'search_group_documents' },
  { kind: 'agreement', labelKey: 'search_group_agreements' },
  { kind: 'fact', labelKey: 'search_group_facts' },
]

/** One document, however many of its pages matched: the first passage, the pages beside it. */
interface DocumentGroup {
  record_ref: string
  title: string
  subtitle: string | null
  snippet: string | null
  href: string
  pages: Array<{ page: number; href: string }>
}

/** A seven-page loan agreement came back as seven rows with the same title; a person reads one row and picks the page. */
export function groupDocumentHits(hits: ArkivSearchHit[]): DocumentGroup[] {
  const groups = new Map<string, DocumentGroup>()
  for (const hit of hits) {
    if (hit.kind !== 'document') continue
    const id = hit.record_ref.slice(hit.record_ref.indexOf(':') + 1)
    let group = groups.get(hit.record_ref)
    if (!group) {
      group = { record_ref: hit.record_ref, title: hit.title, subtitle: hit.subtitle, snippet: hit.snippet, href: `/arkiv/dokument/${id}`, pages: [] }
      groups.set(hit.record_ref, group)
    }
    if (hit.page && hit.href && !group.pages.some((p) => p.page === hit.page)) group.pages.push({ page: hit.page, href: hit.href })
  }
  for (const group of groups.values()) group.pages.sort((a, b) => a.page - b.page)
  return [...groups.values()]
}

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

export function ArkivSearch({
  query,
  onQueryChange,
  filters,
}: {
  query: string
  onQueryChange: (query: string) => void
  /** The list's filters, first in the toolbar row; the search sits at its right end. */
  filters?: ReactNode
}) {
  const t = useTranslations('arkiv')
  const tCommon = useTranslations('common')
  const [view, setView] = useState<ArkivSearchView | null>(null)
  const [failedQuery, setFailedQuery] = useState<string | null>(null)
  // Bumped by "Försök igen" to run the same search again.
  const [attempt, setAttempt] = useState(0)
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
  }, [active, trimmed, attempt])

  // The answer on screen is always the answer to the words in the field: an older one is never shown as the current one.
  const current = active && view && view.query === trimmed ? view : null
  const failed = active && failedQuery === trimmed
  const loading = active && !failed && !current

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        {filters}
        <ToolbarSearch id="arkiv-search" value={query} onChange={(e) => onQueryChange(e.target.value)} placeholder={t('search_documents')} containerClassName={TOOLBAR_SEARCH_END_CLASS} autoComplete="off" />
      </div>

      {failed && (
        <LoadError
          onRetry={() => {
            setFailedQuery(null)
            setAttempt((n) => n + 1)
          }}
        />
      )}
      {loading && (
        <LateReveal className="space-y-3">
          <Skeleton className="h-5 w-1/3" />
          <Skeleton className="h-5 w-2/3" />
        </LateReveal>
      )}
      {current && current.hits.length === 0 && (
        <div className="flex flex-wrap items-center gap-x-3 py-3 text-[13px] text-muted-foreground">
          <span data-ph-mask="">{t('search_empty', { query: current.query })}</span>
          <Button variant="link" onClick={() => onQueryChange('')}>
            {tCommon('clear_search')}
          </Button>
        </div>
      )}
      {current && current.hits.length > 0 && (
        <div className="space-y-5">
          {GROUPS.map((group) => {
            const hits = current.hits.filter((h) => h.kind === group.kind)
            if (hits.length === 0) return null
            if (group.kind === 'document') {
              const documents = groupDocumentHits(hits)
              return (
                <section key={group.kind} aria-label={t(group.labelKey)}>
                  <h3 className="mb-1 text-xs font-medium text-muted-foreground">
                    {t(group.labelKey)} <span className="tabular-nums">({documents.length})</span>
                  </h3>
                  <ul className="divide-y divide-border">
                    {documents.map((doc) => (
                      <li key={doc.record_ref} className="flex items-start justify-between gap-4 py-2">
                        <div className="min-w-0">
                          <Link href={doc.href} className={`${QUIET_LINK_CLASS} text-[13px] text-foreground`}>
                            {doc.title}
                          </Link>
                          {doc.subtitle ? <span className="ml-2 text-xs text-muted-foreground">{doc.subtitle}</span> : null}
                          {doc.snippet ? (
                            <div className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                              <Passage text={doc.snippet} />
                            </div>
                          ) : null}
                        </div>
                        {doc.pages.length > 0 ? (
                          <div className="flex shrink-0 flex-wrap justify-end gap-x-2 text-xs text-muted-foreground">
                            {doc.pages.map((p) => (
                              <Link key={p.page} href={p.href} className={QUIET_LINK_CLASS}>
                                {t('source_page_short_only', { page: p.page })}
                              </Link>
                            ))}
                          </div>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                </section>
              )
            }
            return (
              <section key={group.kind} aria-label={t(group.labelKey)}>
                <h3 className="mb-1 text-xs font-medium text-muted-foreground">
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
                        {hit.subtitle ? <span className="ml-2 text-xs text-muted-foreground">{hit.subtitle}</span> : null}
                        {hit.snippet ? (
                          <div className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
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
