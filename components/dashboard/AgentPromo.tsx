'use client'

import { useCallback, useSyncExternalStore } from 'react'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { useCapability } from '@/contexts/CompanyContext'
import { CAPABILITY } from '@/lib/entitlements/keys'

const dismissKey = (companyId: string) => `erp_agent_promo_dismissed:${companyId}`
// storage events only fire in OTHER tabs; this custom event covers the
// same-tab dismissal so useSyncExternalStore re-reads localStorage.
const DISMISS_EVENT = 'erp-agent-promo-dismissed'

function subscribeToDismissal(onStoreChange: () => void) {
  window.addEventListener('storage', onStoreChange)
  window.addEventListener(DISMISS_EVENT, onStoreChange)
  return () => {
    window.removeEventListener('storage', onStoreChange)
    window.removeEventListener(DISMISS_EVENT, onStoreChange)
  }
}

interface AgentPromoProps {
  companyId: string
}

/**
 * Build-assistant nudge on Hem, shown until the company has a verified
 * agent_profile (the caller gates on that plus the first-run checklist
 * being dismissed or completed, since the checklist already carries the
 * assistant as its last step).
 * Shape: one quiet sentence with the action link at the end and the same
 * "Dölj" text control the Skatteverket promo uses, not a boxed card. It is
 * an optional offer, not an exception, so it stays muted (convention 6/12).
 * Non-payers keep seeing it (conversion surface) but it routes to billing
 * instead of a build flow that would 403.
 */
export function AgentPromo({ companyId }: AgentPromoProps) {
  const t = useTranslations('dashboard')
  const hasAi = useCapability(CAPABILITY.ai)

  // Server snapshot says dismissed: the promo appears only after hydration,
  // when localStorage is readable, so server and client never disagree.
  const dismissed = useSyncExternalStore(
    subscribeToDismissal,
    () => localStorage.getItem(dismissKey(companyId)) === 'true',
    () => true
  )

  const dismiss = useCallback(() => {
    localStorage.setItem(dismissKey(companyId), 'true')
    window.dispatchEvent(new Event(DISMISS_EVENT))
  }, [companyId])

  if (dismissed) return null

  return (
    <section className="flex items-start justify-between gap-4">
      <p className="text-[12.5px] leading-5 text-muted-foreground">
        {t(hasAi ? 'agent_promo_description' : 'agent_promo_description_upgrade')}{' '}
        {/* py-3/-my-3: a 44px tap target on a link that still sits inline in
            the sentence; the negative margin keeps the line box at 20px so
            nothing shifts. */}
        <Link
          href={hasAi ? '/onboarding/agent' : '/settings/billing'}
          className="inline-block -my-3 whitespace-nowrap py-3 text-foreground underline decoration-border underline-offset-4 transition-colors hover:decoration-foreground"
        >
          {t(hasAi ? 'agent_promo_cta' : 'agent_promo_cta_upgrade')}
        </Link>
      </p>
      <button
        type="button"
        onClick={dismiss}
        className="-my-3 shrink-0 py-3 text-xs text-muted-foreground underline decoration-border underline-offset-4 transition-colors hover:text-foreground"
      >
        {t('agent_promo_dismiss')}
      </button>
    </section>
  )
}
