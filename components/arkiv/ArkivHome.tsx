'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { HelpPopover } from '@/components/ui/help-popover'
import { PageHeader } from '@/components/ui/page-header'
import { Skeleton } from '@/components/ui/skeleton'
import type { ArkivGraph as GraphData } from '@/app/api/arkiv/graph/route'
import { ArkivGraph } from './ArkivGraph'
import { ArkivDocuments } from './ArkivDocuments'

/** Where a file is dropped: the Underlag inbox, which hands every document to Arkiv. */
const UPLOAD_HREF = '/e/general/invoice-inbox'

/** /arkiv (canvas artboard Arkiv): the header with search and upload, the graph, then the table. */
export function ArkivHome() {
  const t = useTranslations('arkiv')
  const [graph, setGraph] = useState<GraphData | null>(null)
  const [graphFailed, setGraphFailed] = useState(false)

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
            <Button asChild size="sm">
              <Link href={UPLOAD_HREF}>{t('action_upload')}</Link>
            </Button>
          </div>
        }
      />
      {graph ? <ArkivGraph graph={graph} /> : graphFailed ? null : <Skeleton className="h-64 w-full" />}
      <ArkivDocuments />
    </div>
  )
}
