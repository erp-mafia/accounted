'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useTranslations } from 'next-intl'

/**
 * Multi-user grace countdown: shown to EVERYONE in a company whose
 * multi_user entitlement has lapsed but is still inside its 20-day grace
 * window, and only when the company actually has affected people (at least
 * one non-owner member). The affected member reads their own version; the
 * owner (and everyone else) reads which accounts pause and when.
 *
 * Server-gated: the dashboard layout renders this only in the grace state
 * with a non-empty affected list, so the component itself only formats.
 * Same chrome treatment as SandboxBanner: environment notice on secondary,
 * never a warning fill (status colors are data, not chrome).
 */
export function MultiUserGraceBanner({
  graceEndsAt,
  affectedEmails,
  isAffectedUser,
  companyName,
}: {
  graceEndsAt: string
  affectedEmails: string[]
  /** True when the signed-in user is one of the accounts that will pause. */
  isAffectedUser: boolean
  companyName: string
}) {
  const t = useTranslations('multi_user')

  // Computed in an effect so server and client markup agree at hydration;
  // an hourly tick keeps a long-lived tab honest (same pattern as
  // SubscriptionTouchpoint).
  const [daysLeft, setDaysLeft] = useState<number | null>(null)
  useEffect(() => {
    const update = () => {
      const msLeft = new Date(graceEndsAt).getTime() - Date.now()
      setDaysLeft(Math.max(0, Math.ceil(msLeft / 86_400_000)))
    }
    update()
    const id = setInterval(update, 3_600_000)
    return () => clearInterval(id)
  }, [graceEndsAt])

  if (daysLeft === null) return null

  const message = isAffectedUser
    ? t('banner_affected', { companyName, days: daysLeft })
    : t('banner_owner', { emails: affectedEmails.join(', '), days: daysLeft })

  return (
    <div className="relative z-50 flex flex-wrap items-center justify-center gap-x-3 gap-y-1 border-b border-border bg-secondary px-4 py-2 text-sm text-secondary-foreground">
      <span className="text-center text-xs font-medium sm:text-sm">{message}</span>
      <Link
        href="/settings/billing"
        className="shrink-0 rounded-full bg-foreground/10 px-3 py-0.5 text-xs font-semibold transition-colors hover:bg-foreground/15"
      >
        {t('banner_cta')}
      </Link>
    </div>
  )
}

export default MultiUserGraceBanner
