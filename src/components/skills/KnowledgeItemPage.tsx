'use client'

import useSWR from 'swr'
import { useTranslations } from 'next-intl'
import { useCompany } from '@/contexts/CompanyContext'
import { LoadError, NotFoundState } from '@/components/ui/empty-state'
import { PageHeader } from '@/components/ui/page-header'
import { readOptions, rulesSegment } from './data'
import { KnowledgeItemView } from './KnowledgeItemView'
import { useKnowledgeName } from './knowledge-labels'

/** Where the page leads back to: the picture, under its menu name. */
const PICTURE_HREF = '/wiki'

/**
 * A knowledge item's own page (/skills/kunskap.<item>) for a company with
 * the agent picture on: the same plain content as the picture's Kunskap
 * panel shows when a folder is opened (KnowledgeItemView), under a trail
 * that reads Kontext, then the item's name, and leads back to the picture.
 * No flows to hand the item to, and nothing of the catalogue around it.
 */
export function KnowledgeItemPage({ segment }: { segment: string }) {
  const { company } = useCompany()
  return company ? <ItemPage key={`${company.id}:${segment}`} companyId={company.id} segment={decodeURIComponent(segment)} /> : null
}

function ItemPage({ companyId, segment }: { companyId: string; segment: string }) {
  const t = useTranslations('skills_registry')
  const tNav = useTranslations('nav')
  const knowledgeName = useKnowledgeName()
  // The catalogue's own key: the page and the picture's panel share the read.
  const options = useSWR(['/api/agents/knowledge', companyId], ([url]) => readOptions(url))
  const option = options.data?.find((o) => rulesSegment(o.id) === segment)
  const picture = tNav('v3_context')

  if (!option) {
    // A list that could not be read is not a missing item: it says so, with a retry.
    return (
      <div className="space-y-6">
        <PageHeader title={picture} />
        {options.error && !options.data ? (
          <LoadError title={t('load_failed')} onRetry={() => void options.mutate()} />
        ) : options.data ? (
          <NotFoundState title={t('not_found')} backHref={PICTURE_HREF} backLabel={t('back_to_catalog', { name: picture })} />
        ) : null}
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <PageHeader title={knowledgeName(option.id, option.title)} parent={{ label: picture, href: PICTURE_HREF }} />
      <div className="max-w-[720px]">
        <KnowledgeItemView option={option} companyId={companyId} />
      </div>
    </div>
  )
}
