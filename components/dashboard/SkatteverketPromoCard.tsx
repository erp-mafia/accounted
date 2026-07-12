'use client'

import { useCallback, useSyncExternalStore } from 'react'
import { useTranslations } from 'next-intl'
import { ArrowRight, FileCheck, X } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { ENABLED_EXTENSION_IDS } from '@/lib/extensions/_generated/enabled-extensions'
import { useCapability } from '@/contexts/CompanyContext'
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
 * this card is the equivalent surface for existing companies, which
 * otherwise only discover the integration deep inside the VAT/AGI flows.
 * Capability-less users never see it: the paywall upsell lives where the
 * intent is (SkatteverketPanel, AGIPanel), not on the dashboard.
 */
export function SkatteverketPromoCard({ companyId, connected }: SkatteverketPromoCardProps) {
  const t = useTranslations('dashboard')
  const extensionEnabled = ENABLED_EXTENSION_IDS.has('skatteverket')
  const hasCapability = useCapability(CAPABILITY.skatteverket)

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

  if (!extensionEnabled || !hasCapability || connected || dismissed) return null

  return (
    <section>
      <Card>
        <CardContent className="p-6 flex items-center gap-4">
          <div className="flex-shrink-0 h-10 w-10 rounded-lg flex items-center justify-center bg-secondary">
            <FileCheck className="h-5 w-5" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="font-display text-xl leading-tight">{t('skv_promo_title')}</p>
            <p className="text-sm text-muted-foreground mt-1">{t('skv_promo_description')}</p>
          </div>
          <Button variant="outline" asChild className="flex-shrink-0">
            {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- /api route, not a Next page; the authorize endpoint 302s to Skatteverket, which the client router cannot follow */}
            <a href="/api/extensions/ext/skatteverket/authorize?return_to=/">
              {t('skv_promo_cta')}
              <ArrowRight className="ml-1.5 h-4 w-4" />
            </a>
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="flex-shrink-0"
            aria-label={t('skv_promo_dismiss')}
            onClick={dismiss}
          >
            <X className="h-4 w-4" />
          </Button>
        </CardContent>
      </Card>
    </section>
  )
}
