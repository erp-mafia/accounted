'use client'

import { useState } from 'react'
import { usePathname, useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { persistUiState } from '@/lib/ui-state/client'
import { useFormat } from '@/lib/hooks/use-format'
import type { EntitlementState } from '@/lib/entitlements/has-capability'

/**
 * One-time on-entry notice that the trial (or a cancelled subscription) has
 * lapsed, with the path to Abonnemang. Shown once per user AND company:
 * the acknowledgement persists in user_preferences.ui_state
 * (trial_expired_ack[companyId]), read server-side by the dashboard layout so
 * an acked dialog never mounts (no flash). Both dismissing and clicking
 * through count as acknowledged; afterwards the persistent
 * SubscriptionTouchpoint in the chrome carries the CTA. The layout gates
 * sandbox/anonymous users (no billing); this component additionally skips
 * /settings/* so it never stacks on the routed settings modal.
 */
export function TrialExpiredDialog({
  state,
  trialExpiredAt,
  companyId,
  initialAcknowledged,
}: {
  state: EntitlementState
  trialExpiredAt: string | null
  companyId: string
  initialAcknowledged: boolean
}) {
  const t = useTranslations('trial_expired_dialog')
  const { formatDateLong } = useFormat()
  const router = useRouter()
  const pathname = usePathname()
  const [open, setOpen] = useState(true)

  const lapsed = state === 'trial_expired' || state === 'lapsed_subscription'
  if (!lapsed || initialAcknowledged || pathname.startsWith('/settings')) {
    return null
  }

  const acknowledge = () => {
    setOpen(false)
    persistUiState({
      trial_expired_ack: { [companyId]: new Date().toISOString() },
    })
  }

  const goToBilling = () => {
    acknowledge()
    router.push('/settings/billing')
  }

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) acknowledge() }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="font-display text-xl tracking-tight">
            {state === 'lapsed_subscription'
              ? t('title_lapsed')
              : trialExpiredAt
                ? t('title_dated', { date: formatDateLong(trialExpiredAt) })
                : t('title')}
          </DialogTitle>
          <DialogDescription className="sr-only">{t('body_paused')}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3 text-sm text-muted-foreground">
          <p>{t('body_paused')}</p>
          <p>{t('body_free')}</p>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={acknowledge}>
            {t('cta_secondary')}
          </Button>
          <Button onClick={goToBilling}>{t('cta_primary')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export default TrialExpiredDialog
