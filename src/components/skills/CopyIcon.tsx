'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { Check, Copy } from 'lucide-react'
import styles from './skills.module.css'

/**
 * A quiet inline copy button for any instruction or knowledge text: the icon
 * turns into a tick for a moment once the text is on the clipboard. Disabled
 * until there is text to copy.
 */
export function CopyIcon({ text, label }: { text: string | undefined; label: string }) {
  const t = useTranslations('skills_registry')
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle')
  function copy() {
    if (!text) return
    const copying = navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject(new Error('No clipboard'))
    void copying.then(() => setState('copied'), () => setState('failed')).then(() => window.setTimeout(() => setState('idle'), 1600))
  }
  const said = state === 'copied' ? t('copied') : state === 'failed' ? t('copy_failed') : label
  return (
    <button type="button" className={styles.copyIcon} onClick={copy} disabled={!text} aria-label={said} title={said} data-state={state}>
      {state === 'copied' ? <Check className="h-3.5 w-3.5" aria-hidden /> : <Copy className="h-3.5 w-3.5" aria-hidden />}
    </button>
  )
}
