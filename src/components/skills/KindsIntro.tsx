'use client'

import { useCallback, useSyncExternalStore } from 'react'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { FlowSymbol } from './FlowSymbol'
import { Folder } from './Folder'
import { AnalysisSymbol } from './AnalysisSymbol'
import styles from './skills.module.css'

const seenKey = (companyId: string) => `erp_agentinstruktioner_intro_seen:${companyId}`
const SEEN_EVENT = 'erp-agentinstruktioner-intro-seen'

function readSeen(companyId: string): boolean {
  try {
    return localStorage.getItem(seenKey(companyId)) === 'true'
  } catch {
    return false
  }
}

/**
 * The first visit's explanation: what a flow is, what knowledge is (a flow
 * carries it), and what an analysis is. Shown until the user closes it; the help popover
 * in the top bar says the same afterwards. Remembered per browser only,
 * because it is a convenience, not a setting.
 */
export function KindsIntro({ companyId }: { companyId: string }) {
  const t = useTranslations('skills_registry')
  // Server snapshot says seen: the card appears only after hydration, so server and client agree.
  const seen = useSyncExternalStore(
    (notify) => { window.addEventListener(SEEN_EVENT, notify); return () => window.removeEventListener(SEEN_EVENT, notify) },
    () => readSeen(companyId),
    () => true,
  )
  const close = useCallback(() => {
    try { localStorage.setItem(seenKey(companyId), 'true') } catch { /* private window: it simply shows again next time */ }
    window.dispatchEvent(new Event(SEEN_EVENT))
  }, [companyId])
  if (seen) return null
  return (
    <section className={`${styles.kindsIntro} ${styles.fadeIn}`} aria-label={t('intro_label')}>
      <div className={styles.kindsIntroPart}>
        <span className={styles.kindsIntroPic}><FlowSymbol hue={210} size={44} /></span>
        <div><b>{t('kind_one_workflow')}</b><p>{t('intro_workflow')}</p></div>
      </div>
      <span className={styles.kindsIntroPlus} aria-hidden>+</span>
      <div className={styles.kindsIntroPart}>
        <span className={styles.kindsIntroPic}><Folder hue={34} size={44} /></span>
        <div><b>{t('kind_one_rules')}</b><p>{t('intro_knowledge')}</p></div>
      </div>
      <div className={`${styles.kindsIntroPart} ${styles.kindsIntroApart}`}>
        <span className={styles.kindsIntroPic}><AnalysisSymbol hue={152} size={44} /></span>
        <div><b>{t('kind_one_analysis')}</b><p>{t('intro_analysis')}</p></div>
      </div>
      <div className={styles.kindsIntroEnd}>
        <p>{t('intro_together')}</p>
        <Button size="sm" variant="outline" onClick={close}>{t('intro_close')}</Button>
      </div>
    </section>
  )
}
