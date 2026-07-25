'use client'

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Check } from 'lucide-react'
import { AttnLine } from '@/components/ui/attn-line'
import { Skeleton } from '@/components/ui/skeleton'
import {
  SettingsGroup,
  SettingsRow,
  SettingsRowEnd,
  SettingsRowNote,
  SettingsSectionHeader,
} from '@/components/settings/SettingsRows'
import { formatDateLong } from '@/lib/utils'
import { BillingActions } from '@/components/settings/BillingActions'

// What the paid tier unlocks (mirrors lib/entitlements PAID_CAPABILITIES).
const INCLUDED = [
  'AI-assistent: chatt, kategorisering och dokumenttolkning',
  'Bankkoppling och automatisk synk (PSD2)',
  'Skatteverket: moms- och AGI-inlämning',
  'E-postutskick av fakturor, påminnelser och lönebesked',
]

// What stays free forever (freeze-and-retain, nothing is taken away). Shown
// as the second column of the flat feature list so the paid tier reads
// strongest right next to it. Mirrors the old ALWAYS_FREE copy.
const ALWAYS_FREE = [
  'Bokföring och rapporter',
  'Fakturering',
  'SIE-export',
  'Org.nr-uppslag och momsnummerkontroll',
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

function FeatureList({ heading, items }: { heading: string; items: string[] }) {
  return (
    <div>
      <p className="text-xs font-medium text-muted-foreground">{heading}</p>
      <ul className="mt-2 space-y-2">
        {items.map((item) => (
          <li key={item} className="flex items-start gap-2 text-sm">
            <Check aria-hidden="true" className="mt-1 h-3.5 w-3.5 shrink-0 text-foreground" />
            <span>{item}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

/**
 * Settings → Abonnemang. Rendered both as the full page (thin wrapper) and
 * inside the settings modal (via SETTINGS_SECTIONS), so it's a client component
 * that reads its state from GET /api/billing/status.
 */
export function BillingSettingsContent() {
  const tNav = useTranslations('settings_nav')
  const tIntro = useTranslations('settings_intro')
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

  const header = <SettingsSectionHeader title={tNav('billing')} intro={tIntro('billing')} />

  if (!view) {
    return (
      <div>
        {header}
        <div className="mt-6 space-y-4">
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-64 w-full" />
        </div>
      </div>
    )
  }

  // Demo / sandbox account → can't check out. Show the value prop but point
  // them to creating a real account instead of a pay button that would 403.
  if (view.isDemo) {
    return (
      <div>
        {header}
        <SettingsGroup label="Ditt abonnemang">
          <SettingsRow label="Status" borderless>
            <span>Demo</span>
            <SettingsRowNote>
              Du provkör Accounted i en demo. Skapa ett riktigt konto för att aktivera
              abonnemang, AI-assistent, bankkoppling och inlämning till Skatteverket.
            </SettingsRowNote>
          </SettingsRow>
        </SettingsGroup>
        <SettingsGroup label="I abonnemanget">
          <ul className="space-y-2 px-1 pt-3">
            {INCLUDED.map((item) => (
              <li key={item} className="flex items-start gap-2 text-sm">
                <Check aria-hidden="true" className="mt-1 h-3.5 w-3.5 shrink-0 text-foreground" />
                <span>{item}</span>
              </li>
            ))}
          </ul>
        </SettingsGroup>
      </div>
    )
  }

  // Paying company → manage view.
  if (view.isPaying) {
    return (
      <div>
        {header}
        <SettingsGroup label="Ditt abonnemang">
          <SettingsRow label="Status" borderless>
            <span>Aktivt</span>
            <SettingsRowNote>Du kan hantera eller avsluta det när som helst.</SettingsRowNote>
            <SettingsRowEnd>
              <BillingActions isPaying configured={view.configured} />
            </SettingsRowEnd>
          </SettingsRow>
        </SettingsGroup>
      </div>
    )
  }

  // Just returned from checkout but the webhook hasn't flipped isPaying yet →
  // confirm instead of re-showing the sell pitch to someone who already paid.
  if (view.paidJustNow) {
    return (
      <div>
        {header}
        <SettingsGroup label="Ditt abonnemang">
          <SettingsRow label="Status" borderless>
            <span className="flex items-start gap-2">
              <Check aria-hidden="true" className="mt-1 h-3.5 w-3.5 shrink-0 text-foreground" />
              <span>Klart! Ditt abonnemang är aktiverat och alla funktioner låses upp inom någon minut.</span>
            </span>
            <SettingsRowNote>Ladda om sidan om du inte ser ändringen.</SettingsRowNote>
          </SettingsRow>
        </SettingsGroup>
      </div>
    )
  }

  // Trialing / expired → sell view.
  const { trialEndsAt, daysLeft } = view
  const deferredTo = view.chargeDeferred ? trialEndsAt : null

  return (
    <div>
      {header}

      {/* Consequential trial countdown: one attn-tone sentence, not a banner. */}
      {daysLeft !== null && (
        <AttnLine className="mt-3">
          {daysLeft > 0
            ? `Din provperiod löper ut om ${daysLeft} ${daysLeft === 1 ? 'dag' : 'dagar'}${
                trialEndsAt ? ` (${formatDateLong(trialEndsAt)})` : ''
              }. ${
                deferredTo
                  ? 'Lägg till ditt kort nu: inget dras förrän provperioden är slut.'
                  : 'Lägg till betalning nu så fortsätter allt utan avbrott.'
              }`
            : 'Din provperiod har löpt ut. Aktivera abonnemanget för att få tillbaka AI, bankkoppling och inlämning.'}
        </AttnLine>
      )}

      <SettingsGroup
        label="Allt du behöver för att sköta bokföringen själv"
        help="Ingen bindningstid · Avsluta när du vill · Säker betalning via Stripe"
      >
        <div className="px-1 pt-3">
          <BillingActions isPaying={false} configured={view.configured} firstChargeAt={deferredTo} />
        </div>
      </SettingsGroup>

      {deferredTo && (
        <SettingsGroup label="Så funkar det">
          <SettingsRow label="Idag">
            <span>Du lägger till ditt kort. Inget dras nu.</span>
          </SettingsRow>
          <SettingsRow label={<span className="tabular-nums">{formatDateLong(deferredTo)}</span>}>
            <span>Provperioden slutar och den första debiteringen sker.</span>
          </SettingsRow>
          <SettingsRow label="När som helst" borderless>
            <span>
              Avsluta direkt via Stripe. Före {formatDateLong(deferredTo)} kostar det ingenting.
            </span>
          </SettingsRow>
        </SettingsGroup>
      )}

      <SettingsGroup
        label="Funktioner"
        // The 7-year retention reassurance moved behind the "?": long legal
        // copy stays out of the page flow.
        help="Utan abonnemang behåller du bokföringen, fakturorna, rapporterna och all din data utan kostnad. Ingenting raderas: räkenskapsinformation bevaras i sju år enligt bokföringslagen, oavsett abonnemang."
      >
        <div className="grid gap-6 px-1 pt-3 sm:grid-cols-2">
          <FeatureList heading="I abonnemanget" items={INCLUDED} />
          <FeatureList heading="Alltid gratis" items={ALWAYS_FREE} />
        </div>
      </SettingsGroup>
    </div>
  )
}
