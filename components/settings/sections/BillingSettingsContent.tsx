'use client'

import { useEffect, useState } from 'react'
import { Check, Clock } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { formatDateLong } from '@/lib/utils'
import { BillingActions } from '@/components/settings/BillingActions'

// What the paid tier unlocks (mirrors lib/entitlements PAID_CAPABILITIES).
const INCLUDED = [
  'AI-assistent: chatt, kategorisering och dokumenttolkning',
  'Bankkoppling och automatisk synk (PSD2)',
  'Skatteverket: moms- och AGI-inlämning',
  'E-postutskick av fakturor, påminnelser och lönebesked',
]

const ALWAYS_FREE =
  'All bokföring, fakturering, rapporter, SIE-export, org.nr-uppslag och momsnummerkontroll ingår alltid utan kostnad.'

interface BillingView {
  isPaying: boolean
  configured: boolean
  trialEndsAt: string | null
  daysLeft: number | null
  isDemo: boolean
}

/**
 * Settings → Abonnemang. Rendered both as the full page (thin wrapper) and
 * inside the settings modal (via SETTINGS_SECTIONS), so it's a client component
 * that reads its state from GET /api/billing/status.
 */
export function BillingSettingsContent() {
  const [view, setView] = useState<BillingView | null>(null)

  useEffect(() => {
    let active = true
    fetch('/api/billing/status')
      .then((r) => r.json())
      .then((d: { isPaying: boolean; configured: boolean; trialEndsAt: string | null; isDemo?: boolean }) => {
        if (!active) return
        // Compute days-left here (effect), not during render, to keep render pure.
        const daysLeft = d.trialEndsAt
          ? Math.max(0, Math.ceil((new Date(d.trialEndsAt).getTime() - Date.now()) / 86_400_000))
          : null
        setView({ ...d, daysLeft, isDemo: d.isDemo ?? false })
      })
      .catch(() => {
        if (active) setView({ isPaying: false, configured: false, trialEndsAt: null, daysLeft: null, isDemo: false })
      })
    return () => { active = false }
  }, [])

  if (!view) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    )
  }

  // Demo / sandbox account → can't check out. Show the value prop but point
  // them to creating a real account instead of a pay button that would 403.
  if (view.isDemo) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Abonnemang</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Du provkör Accounted i en demo. Skapa ett riktigt konto för att aktivera
            abonnemang, AI-assistent, bankkoppling och inlämning till Skatteverket.
          </p>
          <ul className="space-y-2">
            {INCLUDED.map((item) => (
              <li key={item} className="flex items-start gap-2 text-sm">
                <Check className="h-4 w-4 mt-1 shrink-0 text-foreground" />
                <span>{item}</span>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    )
  }

  // Paying company → manage view.
  if (view.isPaying) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Abonnemang</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Ditt abonnemang är aktivt. Du kan hantera eller avsluta det när som helst.
          </p>
          <BillingActions isPaying configured={view.configured} />
        </CardContent>
      </Card>
    )
  }

  // Trialing / expired → sell view.
  const { trialEndsAt, daysLeft } = view

  return (
    <div className="space-y-6">
      {daysLeft !== null && (
        <div className="flex items-center gap-3 rounded-lg border border-border bg-secondary px-4 py-3 text-sm">
          <Clock className="h-4 w-4 shrink-0 text-foreground" />
          <span>
            {daysLeft > 0
              ? `Din provperiod löper ut om ${daysLeft} ${daysLeft === 1 ? 'dag' : 'dagar'}${
                  trialEndsAt ? ` (${formatDateLong(trialEndsAt)})` : ''
                }. Lägg till betalning nu så fortsätter allt utan avbrott.`
              : 'Din provperiod har löpt ut. Aktivera abonnemanget för att få tillbaka AI, bankkoppling och inlämning.'}
          </span>
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Allt du behöver för att sköta bokföringen själv</CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">
          <BillingActions isPaying={false} configured={view.configured} />
          <ul className="space-y-2">
            {INCLUDED.map((item) => (
              <li key={item} className="flex items-start gap-2 text-sm">
                <Check className="h-4 w-4 mt-1 shrink-0 text-foreground" />
                <span>{item}</span>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>

      <p className="text-sm text-muted-foreground leading-relaxed">
        {ALWAYS_FREE} Avsluta när du vill. Ingen bindningstid.
      </p>
    </div>
  )
}
