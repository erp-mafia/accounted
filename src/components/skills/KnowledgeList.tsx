'use client'

import { useState } from 'react'
import useSWR from 'swr'
import { useTranslations } from 'next-intl'
import { useCompany } from '@/contexts/CompanyContext'
import { LoadError } from '@/components/ui/empty-state'
import { Skeleton } from '@/components/ui/skeleton'
import { ToolbarSearch } from '@/components/ui/toolbar-search'
import { industryFirst, SEARCH_FROM_ROWS } from '@/lib/agent-skills/knowledge-list'
import { CatalogList, NoHits, knowledgeRows } from './Catalog'
import { readOptions } from './data'
import { useKnowledgeDesc, useKnowledgeName } from './knowledge-labels'

/**
 * The catalogue's knowledge list as one list, for a narrow place (the agent
 * picture's Kunskap drawer): the same items, names and one-liners as the
 * Kunskap kind of the catalogue, read by the same loader and drawn with the
 * same rows. The company's own industry item comes first, marked "För din
 * bransch"; every row opens the item's own page. No kinds, no Egna |
 * Upptäck; a search field only when the list is long.
 */
export function KnowledgeList({ industry, hrefBase = '/skills' }: { industry: string | null; hrefBase?: string }) {
  const t = useTranslations('skills_registry')
  const { company } = useCompany()
  const knowledgeName = useKnowledgeName()
  const knowledgeDesc = useKnowledgeDesc()
  // The catalogue page's own key, so the two share one read.
  const options = useSWR(company ? ['/api/agents/knowledge', company.id] : null, ([url]) => readOptions(url))
  const [q, setQ] = useState('')

  if (options.error && !options.data) return <LoadError title={t('load_failed')} onRetry={() => void options.mutate()} />
  if (!options.data) {
    return (
      <div aria-busy>
        {[0, 1, 2, 3, 4].map((i) => (
          <div key={i} className="flex h-11 items-center border-b-hairline">
            <Skeleton className="h-3.5 w-2/3" />
          </div>
        ))}
      </div>
    )
  }

  const rows = industryFirst(knowledgeRows(options.data, hrefBase, { name: knowledgeName, desc: knowledgeDesc }), industry).map((row) =>
    row.key === industry ? { ...row, tag: t('featured_industry') } : row,
  )
  const query = q.trim().toLocaleLowerCase('sv')
  const shown = query ? rows.filter((row) => `${row.title} ${row.desc}`.toLocaleLowerCase('sv').includes(query)) : rows

  return (
    <div className="space-y-3">
      {rows.length > SEARCH_FROM_ROWS && (
        <ToolbarSearch aria-label={t('search_label')} placeholder={t('search_rules')} value={q} onChange={(e) => setQ(e.target.value)} />
      )}
      {shown.length > 0 ? (
        <CatalogList kind="rules" items={shown} compact />
      ) : query ? (
        <NoHits onClear={() => setQ('')} />
      ) : (
        <div className="text-[13px] text-muted-foreground">{t('place_empty')}</div>
      )}
    </div>
  )
}
