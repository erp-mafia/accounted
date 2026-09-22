'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { ChevronRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useToast } from '@/components/ui/use-toast'
import type { BillingPlan } from '@/lib/stripe/client'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'
import { formatCurrency } from '@/lib/utils'
import { PLAN_PRICES } from '@/components/settings/billing-plans'

/**
 * The billing call to action. Paying companies get the Stripe Customer
 * Portal (manage/cancel) as a quiet row action; everyone else gets the
 * Checkout button for the plan chosen in the offer rows above it. Both POST
 * to a route that returns a hosted Stripe URL we redirect to.
 *
 * `firstChargeDeferred`: the checkout route will defer the first charge to
 * the trial's end (see billing/checkout), so the CTA can truthfully say
 * "0 kr idag" instead of quoting a price.
 */
export function BillingActions({
  isPaying,
  configured,
  plan = 'yearly',
  firstChargeDeferred = false,
}: {
  isPaying: boolean
  configured: boolean
  plan?: BillingPlan
  firstChargeDeferred?: boolean
}) {
  const t = useTranslations('settings_billing')
  const { toast } = useToast()
  const [loading, setLoading] = useState(false)

  async function go(endpoint: string, payload?: Record<string, unknown>) {
    setLoading(true)
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload ?? {}),
      })
      const data = (await res.json().catch(() => ({}))) as {
        url?: string
        error?: string | { message?: string }
      }
      const errorMessage = typeof data.error === 'string' ? data.error : data.error?.message
      if (!res.ok || !data.url) throw new Error(errorMessage || t('checkout_failed'))
      window.location.href = data.url
    } catch (e) {
      toast({
        title: t('checkout_failed'),
        description: e instanceof Error ? getUserErrorMessage(e) : undefined,
        variant: 'destructive',
      })
      setLoading(false)
    }
  }

  if (isPaying) {
    return (
      <Button variant="outline" size="sm" onClick={() => go('/api/billing/portal')} disabled={loading}>
        {t('manage_cta')}
      </Button>
    )
  }

  if (!configured) {
    return (
      <Button size="lg" disabled className="w-full sm:w-auto">
        {t('cta_coming_soon')}
      </Button>
    )
  }

  const label = loading
    ? t('cta_opening')
    : firstChargeDeferred
      ? t('cta_start_deferred')
      : t('cta_start_now', { price: formatCurrency(PLAN_PRICES[plan].exVat), period: t(`period_${plan}`) })

  return (
    <Button
      size="lg"
      onClick={() => go('/api/billing/checkout', { plan })}
      disabled={loading}
      className="w-full sm:w-auto"
    >
      {label}
      {!loading && <ChevronRight className="h-4 w-4" />}
    </Button>
  )
}
