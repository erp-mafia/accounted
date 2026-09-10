'use client'

import { useEffect, useState } from 'react'
import { X } from 'lucide-react'
import { useTranslations } from 'next-intl'
import {
  dismissSystemNotice,
  isSystemNoticeDismissed,
} from '@/components/dashboard/system-notice'

/**
 * Operator-set system notice, shown once per browser until the deadline.
 * Same chrome treatment as SandboxBanner: environment notice on secondary,
 * never a warning fill (status colors are data, not chrome).
 *
 * Visibility is computed in an effect so server and client markup agree at
 * hydration, and a timer hides the banner at the deadline in tabs that stay
 * open past it.
 */
export function SystemNoticeBanner({ until }: { until: number }) {
  const t = useTranslations('system_notice')
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    if (isSystemNoticeDismissed(window.localStorage, until)) return
    const msLeft = until - Date.now()
    if (msLeft <= 0) return
    setVisible(true)
    const id = setTimeout(() => setVisible(false), msLeft)
    return () => clearTimeout(id)
  }, [until])

  if (!visible) return null

  function handleDismiss() {
    dismissSystemNotice(window.localStorage, until)
    setVisible(false)
  }

  return (
    <div
      role="status"
      className="relative z-50 flex flex-wrap items-center justify-center gap-x-3 gap-y-1 border-b border-border bg-secondary px-10 py-2 text-sm text-secondary-foreground sm:px-4"
    >
      <span className="text-center text-xs font-medium sm:text-sm">{t('high_load')}</span>
      <button
        type="button"
        onClick={handleDismiss}
        className="absolute right-2 top-1/2 -translate-y-1/2 rounded-sm p-1 transition-colors hover:bg-foreground/10"
        aria-label={t('dismiss')}
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  )
}
