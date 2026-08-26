'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { ChevronRight, Clock, Lock } from 'lucide-react'
import { useCompany } from '@/contexts/CompanyContext'

/**
 * The chrome-level subscription touchpoint: the paywall is a lifecycle flow,
 * not a settings page, so trial state stays quietly visible in the chrome
 * instead of only inside Inställningar -> Abonnemang.
 *
 *   trial               -> the countdown pill ("Provperiod: N dagar kvar").
 *   trial_expired /
 *   lapsed_subscription -> a muted pill linking to /settings/billing. This is
 *                          the navigation affordance a lapsed user could not
 *                          find (2026-08-18 report), so it is NOT dismissable
 *                          and, unlike the countdown, stays visible when the
 *                          sidebar is collapsed (icon-only with aria-label).
 *
 * Hidden for sandbox/demo (no checkout; sandbox companies carry trial grants
 * too) and for paying companies. Muted chrome tone throughout: status colors
 * are data, never chrome.
 */
export function SubscriptionTouchpoint({
  variant,
  collapsed = false,
  onNavigate,
}: {
  variant: 'sidebar' | 'mobile'
  collapsed?: boolean
  onNavigate?: () => void
}) {
  const { entitlementState, trialEndsAt, isSandbox } = useCompany()
  const tNav = useTranslations('nav')

  // Trial countdown. Computed in an effect (not during render) so server and
  // client markup agree at hydration; an hourly tick keeps a long-lived tab
  // from showing yesterday's count.
  const [trialDaysLeft, setTrialDaysLeft] = useState<number | null>(null)
  useEffect(() => {
    if (!trialEndsAt) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setTrialDaysLeft(null)
      return
    }
    const update = () => {
      const msLeft = new Date(trialEndsAt).getTime() - Date.now()
      setTrialDaysLeft(msLeft > 0 ? Math.ceil(msLeft / 86_400_000) : null)
    }
    update()
    const id = setInterval(update, 3_600_000)
    return () => clearInterval(id)
  }, [trialEndsAt])

  if (isSandbox) return null

  const lapsed =
    entitlementState === 'trial_expired' || entitlementState === 'lapsed_subscription'
  const showCountdown =
    entitlementState === 'trial' && trialDaysLeft !== null
  if (!lapsed && !showCountdown) return null

  const label = lapsed
    ? tNav(
        entitlementState === 'lapsed_subscription'
          ? 'subscription_lapsed_cta'
          : 'trial_expired_cta',
      )
    : tNav('trial_days_left', { days: trialDaysLeft ?? 0 })
  const Icon = lapsed ? Lock : Clock

  if (variant === 'mobile') {
    return (
      <Link
        href="/settings/billing"
        onClick={onNavigate}
        className="flex items-center gap-3 px-3 min-h-[44px] rounded-lg text-foreground transition-colors active:bg-muted/60"
      >
        <Icon className="h-[18px] w-[18px] flex-shrink-0 text-muted-foreground" />
        <span className="text-sm flex-1">{label}</span>
        <ChevronRight className="h-4 w-4 flex-shrink-0 text-muted-foreground/50" />
      </Link>
    )
  }

  // Sidebar. The countdown keeps its pre-existing behavior of hiding when the
  // rail is collapsed; the lapsed CTA must not vanish, so it collapses to an
  // icon-only link instead.
  if (collapsed) {
    if (!lapsed) return null
    return (
      <div className="flex flex-shrink-0 justify-center pb-2">
        <Link
          href="/settings/billing"
          title={label}
          aria-label={label}
          className="flex h-9 w-9 items-center justify-center rounded-lg text-muted-foreground hover:bg-secondary/60 hover:text-foreground transition-colors duration-150"
        >
          <Icon className="h-[17px] w-[17px]" />
        </Link>
      </div>
    )
  }

  return (
    <div className="flex-shrink-0 px-3 pb-2">
      <Link
        href="/settings/billing"
        className="flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-xs text-muted-foreground hover:bg-secondary/60 hover:text-foreground transition-colors duration-150"
      >
        <Icon className="h-3.5 w-3.5 shrink-0" />
        <span className="flex-1 truncate">{label}</span>
        <ChevronRight className="h-3.5 w-3.5 shrink-0 opacity-50" />
      </Link>
    </div>
  )
}

export default SubscriptionTouchpoint
