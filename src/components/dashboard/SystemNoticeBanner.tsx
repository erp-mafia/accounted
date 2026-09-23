'use client'

import { useEffect, useState } from 'react'
import { X } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import {
  dismissSystemNotice,
  isSystemNoticeDismissed,
} from '@/components/dashboard/system-notice'

/**
 * setTimeout clamps anything above 2^31-1 ms to ~1 ms, so a deadline more
 * than 24.8 days out would hide the banner instantly. Wait in bounded steps
 * and re-check the clock at each step instead.
 */
const MAX_TIMER_MS = 2_147_483_647

/**
 * localStorage is a throwing property access when a browser blocks site
 * data, not just a null; read it behind a try so the dashboard never
 * crashes over a notice.
 */
function safeStorage(): Storage | null {
  try {
    return window.localStorage
  } catch {
    return null
  }
}

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
    let timer: ReturnType<typeof setTimeout> | undefined
    const tick = () => {
      if (isSystemNoticeDismissed(safeStorage(), until)) {
        setVisible(false)
        return
      }
      const msLeft = until - Date.now()
      if (msLeft <= 0) {
        setVisible(false)
        return
      }
      setVisible(true)
      timer = setTimeout(tick, Math.min(msLeft, MAX_TIMER_MS))
    }
    tick()
    return () => {
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [until])

  if (!visible) return null

  function handleDismiss() {
    dismissSystemNotice(safeStorage(), until)
    setVisible(false)
  }

  return (
    <div
      role="status"
      className="relative z-50 flex flex-wrap items-center justify-center gap-x-3 gap-y-1 border-b border-border bg-secondary py-2 pl-4 pr-12 text-sm text-secondary-foreground"
    >
      <span className="text-center text-xs font-medium sm:text-sm">{t('high_load')}</span>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        onClick={handleDismiss}
        className="absolute right-1 top-1/2 -translate-y-1/2"
        aria-label={t('dismiss')}
      >
        <X className="h-4 w-4" />
      </Button>
    </div>
  )
}
