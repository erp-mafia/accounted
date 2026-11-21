'use client'

import { useTranslations } from 'next-intl'
import useSWR from 'swr'
import { CheckBadgeIcon } from '@/components/icons'
import { useCompany } from '@/contexts/CompanyContext'
import { PageHeader } from '@/components/ui/page-header'
import { LoadError, NotFoundState } from '@/components/ui/empty-state'
import { AgentCard } from './AgentCard'
import { CommunityFoot } from './KindViews'
import { itemHue, seedOf } from './hues'
import { communityMeta, communitySegment, kindOf, readCatalog } from './data'
import styles from './skills.module.css'

/**
 * A community author's page: who they are, what they shared and how it is
 * received. An accounting firm is marked as one; for a firm this page is
 * how companies find them.
 */
export function CreatorProfile({ handle, backHref }: { handle: string; backHref: string }) {
  const { company } = useCompany()
  const t = useTranslations('skills_registry')
  // The top bar carries the menu row's name (Agenter › Arbetssätt).
  const tNav = useTranslations('nav')
  const catalog = useSWR(company ? ['/api/skills', company.id] : null, ([url]) => readCatalog(url))
  const items = (catalog.data ?? []).filter((s) => s.tier === 'community' && communityMeta(s)?.author === handle)
    .sort((a, b) => (communityMeta(b)?.votes ?? 0) - (communityMeta(a)?.votes ?? 0))
  const metas = items.map((s) => communityMeta(s)!)
  const votes = metas.reduce((sum, m) => sum + m.votes, 0)
  const usedBy = metas.reduce((sum, m) => sum + (m.used_by ?? 0), 0)
  const verified = metas.some((m) => m.author_verified)
  const hue = seedOf(handle) % 360

  return (
    <div className={styles.apage}>
      <PageHeader title={`@${handle}`} parent={{ label: tNav('v3_skills'), href: backHref }} />
      {catalog.error && !catalog.data ? (
        <LoadError title={t('load_failed')} onRetry={() => void catalog.mutate()} />
      ) : catalog.data && items.length === 0 ? (
        <NotFoundState
          title={t('creator_not_found')}
          description={t('creator_not_found_hint')}
          backHref={backHref}
          backLabel={t('back_to_catalog', { name: tNav('v3_skills') })}
        />
      ) : (
        <>
          <section className={styles.creator}>
            <span className={styles.creatorAvatar} style={{ background: `hsl(${hue} 55% 88%)`, color: `hsl(${hue} 50% 30%)` }} aria-hidden>{handle.charAt(0).toUpperCase()}</span>
            <div className={styles.creatorText}>
              <h2>@{handle}{verified && <span className={styles.creatorBadge}><CheckBadgeIcon className="h-4 w-4" aria-hidden />{t('author_verified')}</span>}</h2>
              <dl className={styles.creatorStats}>
                <div><dt>{t('creator_shared')}</dt><dd>{items.length}</dd></div>
                <div><dt>{t('creator_votes')}</dt><dd>{votes}</dd></div>
                {usedBy > 0 && <div><dt>{t('creator_used_by')}</dt><dd>{usedBy}</dd></div>}
              </dl>
            </div>
          </section>
          <ul className={styles.agrid}>
            {items.map((skill) => (
              <li key={skill.slug}>
                <AgentCard href={`${backHref}/${communitySegment(skill.slug)}`} title={skill.name} desc={skill.summary} kind={kindOf(skill)} symbolKey={skill.slug} hue={itemHue(kindOf(skill), skill.slug)} foot={<CommunityFoot meta={communityMeta(skill)} />} />
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  )
}
