'use client'

import dynamic from 'next/dynamic'
import { useLocale, useTranslations } from 'next-intl'
import useSWR from 'swr'
import type { KnowledgeOption } from '@/lib/agent-skills/knowledge-choices'
import { formatDateLong } from '@/lib/utils'
import { CopyIcon } from './CopyIcon'
import { readBody } from './data'
import { Folder } from './Folder'
import { itemHue } from './hues'
import { useKnowledgeDesc, useKnowledgeName } from './knowledge-labels'
import styles from './skills.module.css'

// The Markdown parser loads with the first item that is opened, not with the folders.
const Markdown = dynamic(() => import('@/components/agent/MarkdownMessage'))

/**
 * One knowledge item, plainly: its folder, its name and one line, who keeps
 * it, and the text the AI reads, shown directly with a copy control. The
 * text is read as the item's page reads it (GET /api/skills?slug=, the same
 * key, so the two share one read).
 *
 * Nothing about flows: an item is read here, not handed out.
 */
export function KnowledgeItemView({ option, companyId }: { option: KnowledgeOption; companyId: string }) {
  const t = useTranslations('skills_registry')
  const locale = useLocale()
  const name = useKnowledgeName()(option.id, option.title)
  const desc = useKnowledgeDesc()(option.id, option.summary)
  const body = useSWR(['/api/skills', companyId, option.id], ([url, , slug]) => readBody(`${url}?slug=${encodeURIComponent(slug)}`))
  // As the item's page words it: the day it was reviewed when the registry carries one, otherwise who reviews it.
  const reviewed = option.reviewed_at ? t('reviewed_on', { date: formatDateLong(option.reviewed_at, locale) }) : t('reviewed_accounted')

  return (
    <div className="space-y-5">
      <div className="flex items-start gap-4">
        <Folder hue={itemHue('rules', option.id)} size={72} open />
        <div className="min-w-0 space-y-1">
          <h3 className="break-words text-[15px] font-medium text-strong">{name}</h3>
          <div className="break-words text-[13px] text-foreground/80">{desc}</div>
          <div className="text-xs text-muted-foreground">{reviewed}</div>
        </div>
      </div>
      <section aria-labelledby="knowledge-item-text" className="space-y-2">
        <div className="flex items-center justify-between gap-3">
          <h4 id="knowledge-item-text" className="text-xs font-medium text-foreground/80">
            {t('ai_text_title')}
          </h4>
          <CopyIcon text={body.data} label={t('copy_contents')} />
        </div>
        <div className={styles.mdBody}>
          {body.data ? <Markdown text={body.data} /> : <span className={styles.muted}>{body.error ? t('body_failed_pack') : t('loading_short')}</span>}
        </div>
      </section>
    </div>
  )
}
