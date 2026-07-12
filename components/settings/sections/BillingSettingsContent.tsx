'use client'

import { useEffect, useState } from 'react'
import { Check, Clock, Minus } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { formatDateLong } from '@/lib/utils'
import { BillingActions } from '@/components/settings/BillingActions'

// What the paid tier unlocks (mirrors lib/entitlements PAID_CAPABILITIES).
const INCLUDED = [
  'AI-assistent: chatt, kategorisering och dokumenttolkning',
  'Bankkoppling och automatisk synk (PSD2)',
  'Skatteverket: moms- och AGI-inlämning',
  'E-postutskick av fakturor, påminnelser och lönebesked',
]

// Free vs paid, shown as a comparison table: what the paid tier adds reads
// strongest next to what stays free forever (freeze-and-retain, nothing is
// taken away). Free rows mirror the old ALWAYS_FREE copy.
const FEATURE_MATRIX: { label: string; free: boolean }[] = [
  { label: 'Bokföring och rapporter', free: true },
  { label: 'Fakturering', free: true },
  { label: 'SIE-export', free: true },
  { label: 'Org.nr-uppslag och momsnummerkontroll', free: true },
  ...INCLUDED.map((label) => ({ label, free: false })),
]

// Mirrors the checkout route's deferred-first-charge condition (Stripe's 48h
// trial_end floor plus clock margin). Above this, checkout collects the card
// but the first charge lands when the trial ends.
const DEFER_THRESHOLD_MS = 49 * 3600 * 1000

interface BillingView {
  isPaying: boolean
  configured: boolean
  trialEndsAt: string | null
  daysLeft: number | null
  chargeDeferred: boolean
  paidJustNow: boolean
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
        // Compute time-derived state here (effect), not during render, to keep render pure.
        const msLeft = d.trialEndsAt ? new Date(d.trialEndsAt).getTime() - Date.now() : null
        const daysLeft = msLeft !== null ? Math.max(0, Math.ceil(msLeft / 86_400_000)) : null
        const chargeDeferred = msLeft !== null && msLeft > DEFER_THRESHOLD_MS
        // Set by the checkout success redirect. Provisioning happens via the
        // Stripe webhook, so isPaying can lag the redirect by a few seconds.
        const paidJustNow = new URLSearchParams(window.location.search).get('success') === '1'
        setView({ ...d, daysLeft, chargeDeferred, paidJustNow, isDemo: d.isDemo ?? false })
      })
      .catch(() => {
        if (active)
          setView({
            isPaying: false,
            configured: false,
            trialEndsAt: null,
            daysLeft: null,
            chargeDeferred: false,
            paidJustNow: false,
            isDemo: false,
          })
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

  // Just returned from checkout but the webhook hasn't flipped isPaying yet →
  // confirm instead of re-showing the sell pitch to someone who already paid.
  if (view.paidJustNow) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Abonnemang</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <p className="flex items-start gap-2 text-sm">
            <Check className="h-4 w-4 mt-0.5 shrink-0 text-foreground" />
            <span>Klart! Ditt abonnemang är aktiverat och alla funktioner låses upp inom någon minut.</span>
          </p>
          <p className="text-sm text-muted-foreground">Ladda om sidan om du inte ser ändringen.</p>
        </CardContent>
      </Card>
    )
  }

  // Trialing / expired → sell view.
  const { trialEndsAt, daysLeft } = view
  const deferredTo = view.chargeDeferred ? trialEndsAt : null

  return (
    <div className="space-y-6">
      {daysLeft !== null && (
        <div className="flex items-center gap-3 rounded-lg border border-border bg-secondary px-4 py-3 text-sm">
          <Clock className="h-4 w-4 shrink-0 text-foreground" />
          <span>
            {daysLeft > 0
              ? `Din provperiod löper ut om ${daysLeft} ${daysLeft === 1 ? 'dag' : 'dagar'}${
                  trialEndsAt ? ` (${formatDateLong(trialEndsAt)})` : ''
                }. ${
                  deferredTo
                    ? 'Lägg till ditt kort nu: inget dras förrän provperioden är slut.'
                    : 'Lägg till betalning nu så fortsätter allt utan avbrott.'
                }`
              : 'Din provperiod har löpt ut. Aktivera abonnemanget för att få tillbaka AI, bankkoppling och inlämning.'}
          </span>
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Allt du behöver för att sköta bokföringen själv</CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">
          <BillingActions isPaying={false} configured={view.configured} firstChargeAt={deferredTo} />

          {deferredTo && (
            <div className="space-y-3">
              <h3 className="text-sm font-medium uppercase tracking-wider text-muted-foreground">Så funkar det</h3>
              <ol className="space-y-2 text-sm">
                <li className="flex gap-3">
                  <span className="w-28 shrink-0 text-muted-foreground">Idag</span>
                  <span>Du lägger till ditt kort. Inget dras nu.</span>
                </li>
                <li className="flex gap-3">
                  <span className="w-28 shrink-0 text-muted-foreground tabular-nums">{formatDateLong(deferredTo)}</span>
                  <span>Provperioden slutar och den första debiteringen sker.</span>
                </li>
                <li className="flex gap-3">
                  <span className="w-28 shrink-0 text-muted-foreground">När som helst</span>
                  <span>Avsluta direkt via Stripe. Före {formatDateLong(deferredTo)} kostar det ingenting.</span>
                </li>
              </ol>
            </div>
          )}

          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-full">Funktion</TableHead>
                <TableHead className="text-center">Gratis</TableHead>
                <TableHead className="text-center">Abonnemang</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {FEATURE_MATRIX.map((f) => (
                <TableRow key={f.label}>
                  <TableCell className="text-sm">{f.label}</TableCell>
                  <TableCell className="text-center">
                    {f.free ? (
                      <Check role="img" aria-label="Ingår" className="h-4 w-4 mx-auto text-foreground" />
                    ) : (
                      <Minus role="img" aria-label="Ingår inte" className="h-4 w-4 mx-auto text-muted-foreground/50" />
                    )}
                  </TableCell>
                  <TableCell className="text-center">
                    <Check role="img" aria-label="Ingår" className="h-4 w-4 mx-auto text-foreground" />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <p className="text-sm text-muted-foreground leading-relaxed">
        Utan abonnemang behåller du bokföringen, fakturorna, rapporterna och all din data utan kostnad. Ingenting
        raderas: räkenskapsinformation bevaras i sju år enligt bokföringslagen, oavsett abonnemang.
      </p>
    </div>
  )
}
