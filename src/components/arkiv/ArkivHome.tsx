'use client'

import { useState } from 'react'
import dynamic from 'next/dynamic'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { HelpPopover } from '@/components/ui/help-popover'
import { PageHeader } from '@/components/ui/page-header'
import { Skeleton } from '@/components/ui/skeleton'
import { QUIET_LINK_CLASS } from '@/components/ui/dry-table'
import { ArkivDocuments } from './ArkivDocuments'
import { ArkivSearch, SEARCH_MIN } from './ArkivSearch'
import { UploadDrop } from './UploadDrop'

// Företagshjärnan needs WebGL and three.js: loaded only here, only in the browser.
const Brain = dynamic(() => import('./Brain'), { ssr: false, loading: () => <Skeleton className="h-[520px] w-full" /> })

/**
 * /arkiv (canvas artboard Arkiv): the header with upload, the search field,
 * Företagshjärnan, then the table. While a search is on, the hits stand where
 * the brain and the table were. The search field sits right under the top
 * bar, so the header carries no "Sök" button of its own, and the way to ask
 * through the person's own assistant lives behind the "?" (convention 7).
 */
export function ArkivHome() {
  const t = useTranslations('arkiv')
  const [uploading, setUploading] = useState(false)
  const [refreshKey, setRefreshKey] = useState(0)
  const [query, setQuery] = useState('')
  const searching = query.trim().length >= SEARCH_MIN

  return (
    <div className="space-y-6">
      <PageHeader
        title={t('home_title')}
        help={
          <HelpPopover>
            <p>{t('home_help')}</p>
            <p className="mt-2">
              {t('search_ask_lead')}{' '}
              <Link href="/settings/api" className={`${QUIET_LINK_CLASS} text-foreground`}>
                {t('search_ask_link')}
              </Link>
              {t('search_ask_tail')}
            </p>
          </HelpPopover>
        }
        action={
          <Button size="sm" onClick={() => setUploading((v) => !v)} aria-expanded={uploading}>
            {t('action_upload')}
          </Button>
        }
      />
      <ArkivSearch query={query} onQueryChange={setQuery} />
      {uploading && <UploadDrop onLanded={() => setRefreshKey((k) => k + 1)} />}
      {!searching && <Brain />}
      {!searching && <ArkivDocuments refreshKey={refreshKey} searchable={false} />}
    </div>
  )
}
