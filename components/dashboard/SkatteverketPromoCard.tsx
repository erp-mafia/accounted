'use client'

import { useCallback, useSyncExternalStore } from 'react'
import { useTranslations } from 'next-intl'
import { ENABLED_EXTENSION_IDS } from '@/lib/extensions/_generated/enabled-extensions'
import { useCapability, useCompanyOptional } from '@/contexts/CompanyContext'
import { CAPABILITY } from '@/lib/entitlements/keys'

const dismissKey = (companyId: string) => `erp_skv_promo_dismissed:${companyId}`
// storage events only fire in OTHER tabs; this custom event covers the
// same-tab dismissal so useSyncExternalStore re-reads localStorage.
const DISMISS_EVENT = 'erp-skv-promo-dismissed'

function subscribeToDismissal(onStoreChange: () => void) {
  window.addEventListener('storage', onStoreChange)
  window.addEventListener(DISMISS_EVENT, onStoreChange)
  return () => {
    window.removeEventListener('storage', onStoreChange)
    window.removeEventListener(DISMISS_EVENT, onStoreChange)
  }
}

interface SkatteverketPromoCardProps {
  companyId: string
  /** True when the active user already has a Skatteverket token. */
  connected: boolean
}

/**
 * Dismissible dashboard nudge for companies that have never connected
 * Skatteverket. New companies meet the connect step in NewUserChecklist;
 * this is the equivalent surface for existing companies, which otherwise
 * only discover the integration deep inside the VAT/AGI flows.
 * Shape: one quiet sentence with the connect link at the end and the same
 * "Dölj" text control the checklist uses, not a boxed card. It is an
 * optional offer, not an exception, so it stays muted rather than taking
 * the ochre .attn tone (convention 6/12: attention colour is for data and
 * real exceptions).
 * Capability-less users never see it: the paywall upsell lives where the
 * intent is (SkatteverketPanel, AGIPanel), not on the dashboard.
 * Sandbox companies never see it either: Skatteverket is one of the external
 * services the sandbox blocks outright, so the CTA would lead nowhere.
 */
export function SkatteverketPromoCard({ companyId, connected }: SkatteverketPromoCardProps) {
  const t = useTranslations('dashboard')
  const extensionEnabled = ENABLED_EXTENSION_IDS.has('skatteverket')
  const hasCapability = useCapability(CAPABILITY.skatteverket)
  const isSandbox = useCompanyOptional()?.isSandbox ?? false

  // Server snapshot says dismissed: the card appears only after hydration,
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

  if (!extensionEnabled || !hasCapability || isSandbox || connected || dismissed) return null

  return (
    <section className="flex items-start justify-between gap-4">
      <p className="text-[12.5px] leading-5 text-muted-foreground">
        {t('skv_promo_description')}{' '}
        {/* py-3/-my-3: a 44px tap target on a link that still sits inline in
            the sentence; the negative margin keeps the line box at 20px so
            nothing shifts. */}
        {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- /api route, not a Next page; the authorize endpoint 302s to Skatteverket, which the client router cannot follow */}
        <a
          href="/api/extensions/ext/skatteverket/authorize?return_to=/"
          className="inline-block -my-3 whitespace-nowrap py-3 text-foreground underline decoration-border underline-offset-4 transition-colors hover:decoration-foreground"
        >
          {t('skv_promo_cta')}
        </a>
      </p>
      <button
        type="button"
        onClick={dismiss}
        className="-my-3 shrink-0 py-3 text-xs text-muted-foreground underline decoration-border underline-offset-4 transition-colors hover:text-foreground"
      >
        {t('skv_promo_dismiss')}
      </button>
    </section>
  )
}
