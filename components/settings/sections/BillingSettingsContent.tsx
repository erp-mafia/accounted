'use client'

import { useEffect, useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { Check } from 'lucide-react'
import { AttnLine } from '@/components/ui/attn-line'
import { Skeleton } from '@/components/ui/skeleton'
import { getErrorMessage, type ErrorLocale } from '@/lib/errors/get-error-message'
import {
  SettingsGroup,
  SettingsRow,
  SettingsRowEnd,
  SettingsRowNote,
  SettingsSectionHeader,
  SettingsSeg,
} from '@/components/settings/SettingsRows'
import { formatCurrency } from '@/lib/utils'
import { useFormat } from '@/lib/hooks/use-format'
import { BillingActions } from '@/components/settings/BillingActions'
import { PLAN_PRICES } from '@/components/settings/billing-plans'
import type { BillingPlan } from '@/lib/stripe/client'

// What the paid tier unlocks, phrased as what happens for the user rather
// than as a feature inventory. One line per PAID capability in
// lib/entitlements/keys.ts (ai, bank_sync, skatteverket, email_send).
const UNLOCK_KEYS = ['unlock_ai', 'unlock_bank', 'unlock_skv', 'unlock_email'] as const

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

function UnlockList() {
  const t = useTranslations('settings_billing')
  return (
    <ul className="space-y-2 px-1 pt-3">
      {UNLOCK_KEYS.map((key) => (
        <li key={key} className="flex items-start gap-2 text-sm">
          <Check aria-hidden="true" className="mt-1 h-3.5 w-3.5 shrink-0 text-foreground" />
          <span>{t(key)}</span>
        </li>
      ))}
    </ul>
  )
}

/**
 * Settings → Abonnemang. Rendered both as the full page (thin wrapper) and
 * inside the settings modal (via SETTINGS_SECTIONS), so it's a client component
 * that reads its state from GET /api/billing/status.
 *
 * The sell view is deliberately an order summary in the Fönster row grammar:
 * what you unlock, then price / first charge / how to cancel as flat rows,
 * then one CTA. The money terms are stated once each, where the decision is
 * made, instead of repeated as reassurance copy around the page.
 */
export function BillingSettingsContent() {
  const tNav = useTranslations('settings_nav')
  const tIntro = useTranslations('settings_intro')
  const t = useTranslations('settings_billing')
  const errorLocale = useLocale() as ErrorLocale
  const { formatDateLong } = useFormat()
  // null = the billing state is not known: still loading, or the read failed
  // (loadError). A failed GET must never render a fabricated non-paying,
  // unconfigured panel to a paying customer.
  const [view, setView] = useState<BillingView | null>(null)
  // detail === null: transient, so the line carries a retry. A detail sentence
  // means the user has to act (an expired session) and a retry cannot help.
  const [loadError, setLoadError] = useState<{ detail: string | null } | null>(null)
  const [reloadKey, setReloadKey] = useState(0)
  const [plan, setPlan] = useState<BillingPlan>('yearly')

  useEffect(() => {
    let active = true

    async function load() {
      setLoadError(null)
      try {
        const res = await fetch('/api/billing/status')
        if (!res.ok) {
          // Not-JSON bodies (an HTML error page, an empty 502) leave null, and
          // getErrorMessage falls back to the status map.
          const body = await res.json().catch(() => null)
          if (!active) return
          const sessionGone = res.status === 401 || res.status === 403
          setView(null)
          setLoadError({
            detail: sessionGone
              ? getErrorMessage(body, { statusCode: res.status, locale: errorLocale })
              : null,
          })
          return
        }
        // A 200 whose body will not parse throws into the catch below; a 200
        // without the expected booleans is a failed read too. Neither may
        // become a fabricated view.
        const d = (await res.json()) as {
          isPaying?: unknown
          configured?: unknown
          trialEndsAt?: unknown
          isDemo?: unknown
        }
        if (!active) return
        if (typeof d?.isPaying !== 'boolean' || typeof d?.configured !== 'boolean') {
          setView(null)
          setLoadError({ detail: null })
          return
        }
        const trialEndsAt = typeof d.trialEndsAt === 'string' ? d.trialEndsAt : null
        // Compute time-derived state here (effect), not during render, to keep render pure.
        const msLeft = trialEndsAt ? new Date(trialEndsAt).getTime() - Date.now() : null
        const daysLeft = msLeft !== null ? Math.max(0, Math.ceil(msLeft / 86_400_000)) : null
        const chargeDeferred = msLeft !== null && msLeft > DEFER_THRESHOLD_MS
        // Set by the checkout success redirect. Provisioning happens via the
        // Stripe webhook, so isPaying can lag the redirect by a few seconds.
        const paidJustNow = new URLSearchParams(window.location.search).get('success') === '1'
        setView({
          isPaying: d.isPaying,
          configured: d.configured,
          trialEndsAt,
          daysLeft,
          chargeDeferred,
          paidJustNow,
          isDemo: d.isDemo === true,
        })
      } catch {
        if (active) {
          setView(null)
          setLoadError({ detail: null })
        }
      }
    }

    void load()
    return () => { active = false }
  }, [reloadKey, errorLocale])

  const header = <SettingsSectionHeader title={tNav('billing')} intro={tIntro('billing')} />

  if (!view) {
    return (
      <div>
        {header}
        {/* Live region always mounted so the failure is announced when it
            appears, not merely inserted. */}
        <div role="status" aria-live="polite" className="mt-3">
          {loadError && (
            <AttnLine
              action={
                loadError.detail
                  ? undefined
                  : { label: t('load_retry'), onClick: () => setReloadKey((k) => k + 1) }
              }
            >
              {loadError.detail ? `${t('load_failed')} ${loadError.detail}` : t('load_failed')}
            </AttnLine>
          )}
        </div>
        {!loadError && (
          <div className="mt-6 space-y-4">
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-64 w-full" />
          </div>
        )}
      </div>
    )
  }

  // Demo / sandbox account → can't check out. Show the value prop but point
  // them to creating a real account instead of a pay button that would 403.
  if (view.isDemo) {
    return (
      <div>
        {header}
        <SettingsGroup label={t('group_yours')}>
          <SettingsRow label={t('row_status')} borderless>
            <span>{t('status_demo')}</span>
            <SettingsRowNote>{t('status_demo_note')}</SettingsRowNote>
          </SettingsRow>
        </SettingsGroup>
        <SettingsGroup label={t('group_included')}>
          <UnlockList />
        </SettingsGroup>
      </div>
    )
  }

  // Paying company → manage view.
  if (view.isPaying) {
    return (
      <div>
        {header}
        <SettingsGroup label={t('group_yours')}>
          <SettingsRow label={t('row_status')}>
            <span className="font-medium">{t('status_active')}</span>
            <SettingsRowNote>{t('status_active_note')}</SettingsRowNote>
          </SettingsRow>
          <SettingsRow label={t('row_manage')} borderless>
            <SettingsRowNote>{t('manage_note')}</SettingsRowNote>
            <SettingsRowEnd>
              <BillingActions isPaying configured={view.configured} />
            </SettingsRowEnd>
          </SettingsRow>
        </SettingsGroup>
        <SettingsGroup label={t('group_included')}>
          <UnlockList />
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
        <SettingsGroup label={t('group_yours')}>
          <SettingsRow label={t('row_status')} borderless>
            <span className="flex items-start gap-2">
              <Check aria-hidden="true" className="mt-1 h-3.5 w-3.5 shrink-0 text-foreground" />
              <span>{t('paid_just_now')}</span>
            </span>
            <SettingsRowNote>{t('paid_just_now_note')}</SettingsRowNote>
          </SettingsRow>
        </SettingsGroup>
      </div>
    )
  }

  // Trialing / expired → sell view.
  const { trialEndsAt, daysLeft, chargeDeferred } = view
  const price = PLAN_PRICES[plan]

  return (
    <div>
      {header}

      {/* Consequential trial countdown: one attn-tone sentence, not a banner. */}
      {daysLeft !== null && (
        <AttnLine className="mt-3">
          {daysLeft > 0
            ? t('trial_ends_in', { days: daysLeft, date: trialEndsAt ? formatDateLong(trialEndsAt) : '' })
            : t('trial_ended')}
        </AttnLine>
      )}

      <SettingsGroup label={t('group_included')} help={t('unlock_help')}>
        <UnlockList />
        {/* Freeze-and-retain, said once and up front: nothing is taken away. */}
        <p className="px-1 pt-4 text-xs text-muted-foreground">{t('without_note')}</p>
      </SettingsGroup>

      <SettingsGroup label={t('group_terms')}>
        {/* The interval toggle lives in the price row: it is the price selector,
            and the amount changing right beside it makes the trade-off legible. */}
        <SettingsRow label={t('row_price')}>
          <SettingsSeg
            value={plan}
            onChange={setPlan}
            aria-label={t('row_interval')}
            options={[
              { value: 'monthly', label: t('interval_monthly') },
              {
                value: 'yearly',
                label: (
                  <>
                    {t('interval_yearly')}
                    <span className="ml-2 text-muted-foreground">{t('interval_yearly_save')}</span>
                  </>
                ),
              },
            ]}
          />
          <span className="tabular-nums">
            {formatCurrency(price.exVat)} / {t(`period_${plan}`)}
          </span>
          <SettingsRowNote className="basis-full tabular-nums">
            {plan === 'yearly'
              ? t('price_note_yearly', { inc: formatCurrency(price.incVat), perMonth: formatCurrency(price.perMonthEquivalent) })
              : t('price_note_monthly', { inc: formatCurrency(price.incVat) })}
          </SettingsRowNote>
        </SettingsRow>
        <SettingsRow label={t('row_first_charge')} align="baseline">
          {chargeDeferred && trialEndsAt ? (
            <>
              <span className="tabular-nums">{formatDateLong(trialEndsAt)}</span>
              <SettingsRowNote>{t('first_charge_deferred_note')}</SettingsRowNote>
            </>
          ) : (
            <span>{t('first_charge_today')}</span>
          )}
        </SettingsRow>
        <SettingsRow label={t('row_cancel')} align="baseline" borderless>
          <span>{t('cancel_value')}</span>
        </SettingsRow>
        <div className="px-1 pt-4">
          <BillingActions isPaying={false} configured={view.configured} plan={plan} firstChargeDeferred={chargeDeferred} />
          <p className="pt-3 text-xs text-muted-foreground">{t('stripe_note')}</p>
        </div>
      </SettingsGroup>
    </div>
  )
}
