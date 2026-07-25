'use client'

import { useState } from 'react'
import { ChevronRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useToast } from '@/components/ui/use-toast'
import { SettingsSeg } from '@/components/settings/SettingsRows'
import { formatDateLong } from '@/lib/utils'
import type { BillingPlan } from '@/lib/stripe/client'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'

const PRICE: Record<BillingPlan, { amount: string; suffix: string; sub: string; cta: string }> = {
  monthly: {
    amount: '199 kr',
    suffix: '/ mån exkl. moms',
    sub: '248,75 kr/mån inkl. moms. Faktureras månadsvis.',
    cta: 'Aktivera abonnemang: 199 kr/mån',
  },
  yearly: {
    amount: '166 kr',
    suffix: '/ mån exkl. moms',
    sub: '1 999 kr/år exkl. moms (2 498,75 kr inkl.). Du betalar för 10 månader.',
    cta: 'Aktivera årsabonnemang: 1 999 kr/år',
  },
}

/**
 * Interactive billing CTA. Paying companies get the Stripe Customer Portal
 * (manage/cancel) as a quiet row action; everyone else gets a plan picker
 * (SettingsSeg) + Checkout. Both POST to a route that returns a hosted Stripe
 * URL we redirect to.
 *
 * `firstChargeAt`: when the checkout route will defer the first charge to the
 * trial's end (see billing/checkout), the date it lands. Shifts the CTA from
 * "pay now" to "0 kr idag": the strongest risk-reversal we can make truthfully.
 */
export function BillingActions({
  isPaying,
  configured,
  firstChargeAt = null,
}: {
  isPaying: boolean
  configured: boolean
  firstChargeAt?: string | null
}) {
  const { toast } = useToast()
  const [loading, setLoading] = useState(false)
  const [plan, setPlan] = useState<BillingPlan>('yearly')

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
      if (!res.ok || !data.url) throw new Error(errorMessage || 'Något gick fel')
      window.location.href = data.url
    } catch (e) {
      toast({
        title: 'Kunde inte öppna betalningen',
        description: e instanceof Error ? getUserErrorMessage(e) : undefined,
        variant: 'destructive',
      })
      setLoading(false)
    }
  }

  if (isPaying) {
    return (
      <Button variant="outline" size="sm" onClick={() => go('/api/billing/portal')} disabled={loading}>
        Hantera abonnemang
      </Button>
    )
  }

  if (!configured) {
    return (
      <Button size="lg" disabled className="w-full sm:w-auto">
        Uppgradering öppnar snart
      </Button>
    )
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <SettingsSeg
          value={plan}
          onChange={setPlan}
          aria-label="Betalningsintervall"
          options={[
            { value: 'monthly', label: 'Månadsvis' },
            {
              value: 'yearly',
              label: (
                <>
                  Årsvis
                  <span className="ml-2 text-muted-foreground">Spara 2 mån</span>
                </>
              ),
            },
          ]}
        />
        <p className="text-sm text-muted-foreground">
          <span className="tabular-nums text-foreground">{PRICE[plan].amount}</span> {PRICE[plan].suffix}
        </p>
      </div>
      <p className="text-xs text-muted-foreground tabular-nums">{PRICE[plan].sub}</p>

      <Button
        size="lg"
        onClick={() => go('/api/billing/checkout', { plan })}
        disabled={loading}
        className="w-full sm:w-auto"
      >
        {loading ? 'Öppnar…' : firstChargeAt ? 'Starta abonnemanget: 0 kr idag' : PRICE[plan].cta}
        {!loading && <ChevronRight className="h-4 w-4" />}
      </Button>
      {firstChargeAt && (
        // The one deferred-charge line that stays visible (the rest of the
        // legal/marketing copy lives behind the group-level "?").
        <p className="text-xs text-muted-foreground">
          Första debiteringen sker {formatDateLong(firstChargeAt)}, när provperioden slutar. Avslutar du innan dess
          kostar det ingenting.
        </p>
      )}
    </div>
  )
}
