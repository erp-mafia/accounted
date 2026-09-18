'use client'

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { HelpPopover } from '@/components/ui/help-popover'
import { PageHeader } from '@/components/ui/page-header'
import { Skeleton } from '@/components/ui/skeleton'
import type { ArkivGraph as GraphData } from '@/app/api/arkiv/graph/route'
import { ArkivGraph } from './ArkivGraph'
import { ArkivDocuments } from './ArkivDocuments'
import { ArkivSearch, SEARCH_MIN } from './ArkivSearch'
import { UploadDrop } from './UploadDrop'

/**
 * /arkiv (canvas artboard Arkiv): the header with search and upload, the
 * search field, the graph, then the table. While a search is on, the hits
 * stand where the graph and the table were.
 */
export function ArkivHome() {
  const t = useTranslations('arkiv')
  const [graph, setGraph] = useState<GraphData | null>(null)
  const [graphFailed, setGraphFailed] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [refreshKey, setRefreshKey] = useState(0)
  const [query, setQuery] = useState('')
  const searching = query.trim().length >= SEARCH_MIN

  useEffect(() => {
    let cancelled = false
    fetch('/api/arkiv/graph')
      .then(async (res) => {
        if (!res.ok) throw new Error(String(res.status))
        const { data } = (await res.json()) as { data: GraphData }
        if (!cancelled) setGraph(data)
      })
      .catch(() => {
        if (!cancelled) setGraphFailed(true)
      })
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <div className="space-y-6">
      <PageHeader
        title={t('home_title')}
        help={<HelpPopover>{t('home_help')}</HelpPopover>}
        action={
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => document.getElementById('arkiv-search')?.focus()}>
              {t('action_search')}
            </Button>
            <Button size="sm" onClick={() => setUploading((v) => !v)} aria-expanded={uploading}>
              {t('action_upload')}
            </Button>
          </div>
        }
      />
      <ArkivSearch query={query} onQueryChange={setQuery} />
      {uploading && <UploadDrop onLanded={() => setRefreshKey((k) => k + 1)} />}
      {!searching && (graph ? <ArkivGraph graph={graph} /> : graphFailed ? null : <Skeleton className="h-64 w-full" />)}
      {!searching && <ArkivDocuments refreshKey={refreshKey} searchable={false} />}
    </div>
  )
}
