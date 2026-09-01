'use client'

import { useEffect, useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { Check } from 'lucide-react'
import { AttnLine } from '@/components/ui/attn-line'
import { HelpPopover } from '@/components/ui/help-popover'
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
import { cn, formatCurrency } from '@/lib/utils'
import { useFormat } from '@/lib/hooks/use-format'
import { BillingActions } from '@/components/settings/BillingActions'
import { PLAN_PRICES } from '@/components/settings/billing-plans'
import type { BillingPlan } from '@/lib/stripe/client'
import { useBranding } from '@/lib/branding/brand-context'

// What the paid tier unlocks: the external connections. One item per PAID
// capability in lib/entitlements/keys.ts (ai, bank_sync, skatteverket,
// email_send, stripe_payments, woocommerce_sync + shopify_sync as one
// "webshop" item). Keep in step with PAID_CAPABILITIES when a key is added.
const UNLOCK_KEYS = ['unlock_ai', 'unlock_bank', 'unlock_skv', 'unlock_email', 'unlock_payments', 'unlock_webshop', 'unlock_users'] as const

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
  /**
   * WL-10: present when the company is covered by its byrå team's agreement
   * (active team-scoped manual grant). Replaces the upgrade pitch with a
   * read-only "Ingår i <teamName>s avtal" state.
   */
  teamAgreement: { teamName: string } | null
}

function UnlockList({ className }: { className?: string }) {
  const t = useTranslations('settings_billing')
  return (
    <ul className={cn('grid gap-x-6 gap-y-3 px-1 sm:grid-cols-2', className)}>
      {UNLOCK_KEYS.map((key) => (
        <li key={key} className="text-sm">
          <span className="font-medium">{t(key)}</span>
          <span className="block text-xs text-muted-foreground">{t(`${key}_gloss`)}</span>
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
  const { appName } = useBranding()
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
          teamAgreement?: unknown
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
        // Only a well-formed teamAgreement (non-empty team name) activates the
        // read-only agreement state: anything else falls back to the normal view.
        const rawAgreement = d.teamAgreement as { teamName?: unknown } | null | undefined
        const teamAgreement =
          rawAgreement && typeof rawAgreement.teamName === 'string' && rawAgreement.teamName.length > 0
            ? { teamName: rawAgreement.teamName }
            : null
        setView({
          isPaying: d.isPaying,
          configured: d.configured,
          trialEndsAt,
          daysLeft,
          chargeDeferred,
          paidJustNow,
          isDemo: d.isDemo === true,
          teamAgreement,
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
            <SettingsRowNote>{t('status_demo_note', { appName })}</SettingsRowNote>
          </SettingsRow>
        </SettingsGroup>
        <SettingsGroup label={t('group_included')}>
          <UnlockList className="pt-3" />
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
          <UnlockList className="pt-3" />
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

  // Covered by the byrå team's agreement (WL-10) → read-only state instead
  // of the upgrade pitch and Stripe checkout. The page stays visible for
  // transparency; billing is the byrå's, so there is nothing to manage here.
  if (view.teamAgreement) {
    return (
      <div>
        {header}
        <SettingsGroup label={t('group_yours')}>
          <SettingsRow label={t('row_status')} borderless>
            <span className="font-medium">
              {t('team_agreement_status', { teamName: view.teamAgreement.teamName })}
            </span>
            <SettingsRowNote>{t('team_agreement_note')}</SettingsRowNote>
          </SettingsRow>
        </SettingsGroup>
        <SettingsGroup label={t('group_included')}>
          <UnlockList className="pt-3" />
        </SettingsGroup>
      </div>
    )
  }

  // Trialing / expired → sell view: one number, four short lines, one
  // button, two quiet sentences. Everything else lives behind the "?".
  const { trialEndsAt, daysLeft, chargeDeferred } = view
  const price = PLAN_PRICES[plan]
  const priceNote =
    plan === 'yearly'
      ? t('price_note_yearly', { inc: formatCurrency(price.incVat), perMonth: formatCurrency(price.perMonthEquivalent) })
      : t('price_note_monthly', { inc: formatCurrency(price.incVat) })
  const termsLine =
    chargeDeferred && trialEndsAt
      ? t('terms_deferred', { date: formatDateLong(trialEndsAt) })
      : t('terms_now')

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

      <div className="mt-8 flex flex-wrap items-start justify-between gap-x-6 gap-y-3 px-1">
        <div>
          <p className="font-display text-xl tabular-nums leading-8">
            {formatCurrency(price.exVat)}
            <span className="text-muted-foreground"> / {t(`period_${plan}`)}</span>
          </p>
          <p className="text-xs tabular-nums text-muted-foreground">{priceNote}</p>
        </div>
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
      </div>

      <UnlockList className="mt-6 border-t border-border pt-6" />

      <div className="mt-8 border-t border-border px-1 pt-6">
        <BillingActions isPaying={false} configured={view.configured} plan={plan} firstChargeDeferred={chargeDeferred} />
        <p className="pt-3 text-xs text-muted-foreground">{termsLine}</p>
        <p className="pt-1 text-xs text-muted-foreground">
          {t('without_note')}{' '}
          <HelpPopover className="ml-1 align-middle">{t('unlock_help')}</HelpPopover>
        </p>
      </div>
    </div>
  )
}
