'use client'

import { useCallback, useSyncExternalStore } from 'react'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
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
 * The first visit's explanation, as a dialog: what a flow is, what knowledge
 * is (a flow carries it), and what an analysis is. It opens once, the first
 * time the page is entered, and never again once closed (Jag förstår, the X
 * or Esc all count: a card left on the page was easy to miss and then sat
 * there). The help popover in the top bar says the same afterwards.
 * Remembered per browser only, because it is a convenience, not a setting.
 */
export function KindsIntro({ companyId }: { companyId: string }) {
  const t = useTranslations('skills_registry')
  // Server snapshot says seen: the dialog opens only after hydration, so server and client agree.
  const seen = useSyncExternalStore(
    (notify) => { window.addEventListener(SEEN_EVENT, notify); return () => window.removeEventListener(SEEN_EVENT, notify) },
    () => readSeen(companyId),
    () => true,
  )
  const close = useCallback(() => {
    try { localStorage.setItem(seenKey(companyId), 'true') } catch { /* private window: it simply shows again next time */ }
    window.dispatchEvent(new Event(SEEN_EVENT))
  }, [companyId])
  return (
    <Dialog open={!seen} onOpenChange={(open) => { if (!open) close() }}>
      <DialogContent className={`sm:max-w-[520px] ${styles.kindsIntro}`}>
        <DialogHeader>
          <DialogTitle className="font-display text-xl tracking-tight">{t('intro_label')}</DialogTitle>
          <DialogDescription className="text-[13px] leading-relaxed">{t('intro_together')}</DialogDescription>
        </DialogHeader>
        <ul className={styles.introRows}>
          <li>
            <span className={styles.kindsIntroPic}><FlowSymbol hue={210} size={44} /></span>
            <div><b>{t('kind_one_workflow')}</b><p>{t('intro_workflow')}</p></div>
          </li>
          <li>
            <span className={styles.kindsIntroPic}><Folder hue={34} size={44} /></span>
            <div><b>{t('kind_one_rules')}</b><p>{t('intro_knowledge')}</p></div>
          </li>
          <li>
            <span className={styles.kindsIntroPic}><AnalysisSymbol hue={152} size={44} /></span>
            <div><b>{t('kind_one_analysis')}</b><p>{t('intro_analysis')}</p></div>
          </li>
        </ul>
        <DialogFooter>
          <Button onClick={close}>{t('intro_close')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
