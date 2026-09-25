'use client'

import { useTranslations } from 'next-intl'
import { ChevronUp } from 'lucide-react'
import type { CommunityMeta } from './data'
import styles from './skills.module.css'

/** Who shared it and what others think, on the card's foot. */
export function CommunityFoot({ meta }: { meta: CommunityMeta | null }) {
  const t = useTranslations('skills_registry')
  if (!meta) return null
  return (
    <span className={styles.metaLine}>
      <span>@{meta.author}{meta.author_verified && <span className={styles.verified} title={t('author_verified')}>✓</span>}</span>
      <span className={styles.voteMini} aria-label={t('votes_label', { count: meta.votes })}><ChevronUp className="h-3.5 w-3.5" aria-hidden />{meta.votes}</span>
      {meta.used_by !== null && meta.used_by > 0 && <span>{t('used_by_companies', { count: meta.used_by })}</span>}
    </span>
  )
}
