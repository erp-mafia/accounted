'use client'

import { useState, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { useToast } from '@/components/ui/use-toast'
import type { BillingPlan } from '@/lib/stripe/client'

const PRICE: Record<BillingPlan, { amount: string; suffix: string; sub: string; cta: string }> = {
  monthly: {
    amount: '199 kr',
    suffix: '/ mån',
    sub: 'Faktureras månadsvis.',
    cta: 'Aktivera abonnemang: 199 kr/mån',
  },
  yearly: {
    amount: '166 kr',
    suffix: '/ mån',
    sub: '1 999 kr/år: du betalar för 10 månader.',
    cta: 'Aktivera årsabonnemang: 1 999 kr/år',
  },
}

/**
 * Interactive billing CTA. Paying companies get the Stripe Customer Portal
 * (manage/cancel); everyone else gets a reactive plan picker + Checkout. Both
 * POST to a route that returns a hosted Stripe URL we redirect to.
 */
export function BillingActions({ isPaying, configured }: { isPaying: boolean; configured: boolean }) {
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
      const data = (await res.json().catch(() => ({}))) as { url?: string; error?: string }
      if (!res.ok || !data.url) throw new Error(data.error || 'Något gick fel')
      window.location.href = data.url
    } catch (e) {
      toast({
        title: 'Kunde inte öppna betalningen',
        description: e instanceof Error ? e.message : undefined,
        variant: 'destructive',
      })
      setLoading(false)
    }
  }

  if (isPaying) {
    return (
      <Button size="lg" onClick={() => go('/api/billing/portal')} disabled={loading} className="w-full sm:w-auto">
        Hantera abonnemang
      </Button>
    )
  }

  if (!configured) {
    return (
      <Button size="lg" disabled className="w-full">
        Uppgradering öppnar snart
      </Button>
    )
  }

  const segment = (p: BillingPlan, label: ReactNode) => (
    <button
      type="button"
      onClick={() => setPlan(p)}
      className={`flex items-center rounded-md px-3 py-2 transition-colors ${
        plan === p ? 'bg-secondary text-foreground' : 'text-muted-foreground hover:text-foreground'
      }`}
    >
      {label}
    </button>
  )

  return (
    <div className="space-y-4">
      <div>
        <div className="flex items-baseline gap-2">
          <span className="font-display text-3xl tracking-tight tabular-nums">{PRICE[plan].amount}</span>
          <span className="text-muted-foreground">{PRICE[plan].suffix}</span>
        </div>
        <p className="text-sm text-muted-foreground mt-1">{PRICE[plan].sub}</p>
      </div>

      <div className="inline-flex rounded-lg border border-border p-1 text-sm">
        {segment('monthly', 'Månadsvis')}
        {segment(
          'yearly',
          <>
            Årsvis
            <span className="ml-2 text-xs text-muted-foreground">Spara 2 mån</span>
          </>,
        )}
      </div>

      <Button size="lg" onClick={() => go('/api/billing/checkout', { plan })} disabled={loading} className="w-full">
        {loading ? 'Öppnar…' : PRICE[plan].cta}
      </Button>
      <p className="text-xs text-muted-foreground text-center">Säker betalning via Stripe · Avsluta när du vill</p>
    </div>
  )
}
