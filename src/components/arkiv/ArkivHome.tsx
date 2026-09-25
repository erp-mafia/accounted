'use client'

import { Suspense, useState } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { HelpPopover } from '@/components/ui/help-popover'
import { PageHeader } from '@/components/ui/page-header'
import { QUIET_LINK_CLASS } from '@/components/ui/dry-table'
import { ArkivSearch, SEARCH_MIN } from './ArkivSearch'
import { ArkivTree } from './ArkivTree'
import { UploadDrop } from './UploadDrop'

/**
 * /arkiv: the header with upload, the search field, then every document as
 * folders (ArkivTree). While a search is on, the hits stand where the tree
 * was; `?q=` opens the page searching, so a link can land here with a
 * question ready. The search field sits right under the top
 * bar, so the header carries no "Sök" button of its own, and the way to ask
 * through the person's own assistant lives behind the "?" (convention 7).
 */
function ArkivHomeInner() {
  const t = useTranslations('arkiv')
  const params = useSearchParams()
  const [uploading, setUploading] = useState(false)
  const [refreshKey, setRefreshKey] = useState(0)
  const [query, setQuery] = useState(params.get('q') ?? '')
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
      {!searching && <ArkivTree refreshKey={refreshKey} />}
    </div>
  )
}

export function ArkivHome() {
  // useSearchParams needs a Suspense boundary on a server-rendered page.
  return (
    <Suspense fallback={null}>
      <ArkivHomeInner />
    </Suspense>
  )
}
