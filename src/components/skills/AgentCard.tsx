'use client'

import Link from 'next/link'
import type { ReactNode } from 'react'
import { useTranslations } from 'next-intl'
import type { ItemKind, Presence } from './hues'
import { ItemSymbol } from './ItemSymbol'
import styles from './skills.module.css'

/**
 * One agent instruction in the list: a tinted panel with the name, what it
 * does and what it uses, its picture on a white tile (a flow's orb, or a folder that opens on hover), and
 * a foot with a status or, for community items, who shared it and how it is
 * rated. Without `href` the card is not a link (a connection that lives in
 * the user's AI has no page).
 */
export function AgentCard({ href, title, desc, kind, symbolKey, hue, status, marks, badge, foot, masked }: {
  href?: string
  title: string
  desc: string
  kind: ItemKind
  /** Seeds the orb's grain, so each flow turns its own way. */
  symbolKey: string
  hue: number
  status?: { presence: Presence; text: string }
  marks?: ReactNode
  badge?: ReactNode
  /** Replaces the status line, e.g. a community item's author and rating. */
  foot?: ReactNode
  /** Company-written text: masked in session replay. */
  masked?: boolean
}) {
  const t = useTranslations('skills_registry')
  const inner = (
    <>
      <span className={styles.acPanel}>
        <span className={styles.acText}>
          <span className={styles.acTitle} data-ph-mask={masked ? '' : undefined}>{title}{badge}</span>
          <span className={styles.acDesc} data-ph-mask={masked ? '' : undefined}>{desc}</span>
          {marks && <span className={styles.acMarks}>{marks}</span>}
        </span>
        <span className={styles.acTile}><ItemSymbol kind={kind} hue={hue} seedKey={symbolKey} size={66} /></span>
      </span>
      <span className={styles.acFoot}>
        <span className={styles.statusSlot}>{foot ?? (status && <span className={`${styles.status} ${styles.fadeIn}`} data-presence={status.presence}>{status.text}</span>)}</span>
        {href && <span className={styles.open} aria-hidden>{t('open_hint')}</span>}
      </span>
    </>
  )
  return href ? <Link href={href} className={styles.acard}>{inner}</Link> : <div className={`${styles.acard} ${styles.acardStatic}`}>{inner}</div>
}
