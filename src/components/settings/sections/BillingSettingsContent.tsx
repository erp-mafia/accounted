'use client'

import { useEffect, useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { CheckIcon, ChevronDownIcon } from '@/components/icons'
import { AttnLine } from '@/components/ui/attn-line'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { TD_CLASS, TH_CLASS } from '@/components/ui/dry-table'
import { HelpPopover } from '@/components/ui/help-popover'
import { SegmentedControl } from '@/components/ui/segmented-control'
import { Skeleton } from '@/components/ui/skeleton'
import { getErrorMessage, type ErrorLocale } from '@/lib/errors/get-error-message'
import {
  SettingsRow,
  SettingsRowEnd,
  SettingsRowNote,
  SettingsSectionHeader,
  SettingsSeg,
} from '@/components/settings/SettingsRows'
import { cn, formatCurrency, formatDate } from '@/lib/utils'
import { useFormat } from '@/lib/hooks/use-format'
import { BillingActions } from '@/components/settings/BillingActions'
import { ConnectorSettingsSection } from '@/components/settings/ConnectorSettingsSection'
import { PLAN_PRICES, planPrice } from '@/components/settings/billing-plans'
import type { BillingPlan } from '@/lib/stripe/client'
import { useBranding } from '@/lib/branding/brand-context'
import { useSigningAvailability } from '@/components/signing/use-signing-availability'

// What the paid tier unlocks: the external connections. One item per PAID
// capability in lib/entitlements/keys.ts (bank_sync, skatteverket,
// email_send, and stripe_payments + woocommerce_sync + shopify_sync +
// zettle_sync as one "payments and webshop" item). Keep in step with
// PAID_CAPABILITIES when a key is added. collections and signing have their
// own items (UNLOCK_COLLECTIONS_KEY, UNLOCK_SIGNING_KEY), listed only where
// the feature is switched on for the viewing company, so merging them shows
// nothing to anyone.
//
// ai is deliberately not listed (owner, 2026-10-22): the assistant is meant
// to be sold as an add-on later, so the page does not promise it as part of
// the subscription. The capability itself is still granted with it.
const UNLOCK_KEYS = ['unlock_bank', 'unlock_skv', 'unlock_email', 'unlock_payments_webshop'] as const
const UNLOCK_COLLECTIONS_KEY = 'unlock_collections'
const UNLOCK_SIGNING_KEY = 'unlock_signing'

// What stays without a subscription (the free plan card). Retention is the
// last item and carries its own gloss.
const FREE_KEYS = ['free_bookkeeping', 'free_invoices', 'free_reports'] as const

// Mirrors the checkout route's deferred-first-charge condition (Stripe's 48h
// trial_end floor plus clock margin). Above this, checkout collects the card
// but the first charge lands when the trial ends.
const DEFER_THRESHOLD_MS = 49 * 3600 * 1000

type BillingTab = 'plan' | 'receipts'

interface BillingView {
  isPaying: boolean
  configured: boolean
  trialEndsAt: string | null
  daysLeft: number | null
  chargeDeferred: boolean
  /**
   * Paying card: the first charge of a subscription started during the trial
   * (Stripe 'trialing'). The sell view promised this date before checkout;
   * null once the first charge is behind.
   */
  firstChargeAt: string | null
  /** Paying card: the next renewal of an active subscription; null when a
   *  cancellation is pending or Stripe could not confirm it. */
  renewsAt: string | null
  paidJustNow: boolean
  isDemo: boolean
  /**
   * WL-10: present when the company is covered by its byrå team's agreement
   * (active team-scoped manual grant). Replaces the upgrade pitch with a
   * read-only "Hanteras av <teamName>" state.
   */
  teamAgreement: { teamName: string } | null
  /**
   * Covered without a Stripe subscription or a named byrå agreement: an
   * invoice or comp grant (coverage 'agreement'), or a team grant whose team
   * has no name to show. `until` is null for an open-ended grant. Anyone in
   * this state has paid, so the sell view is never rendered for them.
   */
  agreement: { until: string | null } | null
  /**
   * Paying card: what the company's own subscription costs per interval, SEK
   * exkl. moms. A subscription started before the 2026-10-22 price change
   * keeps its old Stripe price, so the card shows this and never the list
   * price. null when unknown: the card then shows no amount at all.
   */
  subscriptionAmountExVat: number | null
}

/** Mirrors GET /api/billing/invoices. */
interface BillingReceipt {
  id: string
  number: string | null
  created: string
  amountPaid: number
  currency: string
  status: 'paid' | 'open' | 'uncollectible'
  description: string | null
  pdfUrl: string | null
  hostedUrl: string | null
}

/**
 * Settings → Abonnemang: a client component that reads its state from
 * GET /api/billing/status.
 *
 * Two tabs: Plan (the free plan and the subscription side by side, the
 * subscription card carrying the one CTA or the manage action) and Kvitton
 * (the Stripe invoices). The money terms are stated once each, in the card
 * footer where the decision is made.
 */
export function BillingSettingsContent() {
  return (
    <>
      <BillingCoreContent />
      {/* Self-host only (renders null on hosted): connector status + manual
          entitlement sync. Sits below the billing states, which is why the
          core content is split out: it has an early return. */}
      <ConnectorSettingsSection />
    </>
  )
}

function CheckItem({ label, gloss }: { label: string; gloss?: string }) {
  return (
    <li className="flex items-start gap-2 text-[13px]">
      <CheckIcon aria-hidden="true" className="mt-1 h-3.5 w-3.5 shrink-0 text-foreground" />
      <span>
        <span>{label}</span>
        {gloss && <span className="block text-xs text-muted-foreground">{gloss}</span>}
      </span>
    </li>
  )
}

function PlanCard({
  title,
  headerEnd,
  price,
  period,
  note,
  items,
  footer,
  current = false,
}: {
  title: string
  headerEnd?: React.ReactNode
  /** Left out when the amount is not known: no price line at all. */
  price?: number
  period?: string
  note?: string
  items: React.ReactNode
  footer?: React.ReactNode
  current?: boolean
}) {
  return (
    <section
      className={cn(
        'flex flex-col rounded-lg border p-6',
        current ? 'border-foreground' : 'border-border',
      )}
    >
      <div className="flex min-h-8 flex-wrap items-center justify-between gap-2">
        <h3 className="text-[13px] font-medium">{title}</h3>
        {headerEnd}
      </div>
      {price !== undefined && (
        <>
          <p className="mt-4 font-display text-3xl tabular-nums">
            {formatCurrency(price)}
            <span className="text-[15px] text-muted-foreground"> / {period}</span>
          </p>
          <p className="mt-1 text-xs tabular-nums text-muted-foreground">{note}</p>
        </>
      )}
      <div className="my-6 border-t border-border" />
      <ul className="space-y-3">{items}</ul>
      {footer && <div className="mt-auto pt-8">{footer}</div>}
    </section>
  )
}

function BillingCoreContent() {
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
  const [tab, setTab] = useState<BillingTab>('plan')
  // The receipts panel mounts on first open and then stays mounted, so
  // switching back and forth does not refetch.
  const [receiptsOpened, setReceiptsOpened] = useState(false)
  // A paying company sees its plan as one row; the two sales cards open
  // behind "Jämför planer".
  const [comparing, setComparing] = useState(false)
  // Whether collections is switched on for this company (kill switch and
  // pilot list): only then does the paid list name it. A failed read keeps it
  // off, which is the merge-time state anyway.
  const [collectionsOffered, setCollectionsOffered] = useState(false)
  // Whether BankID signing is switched on for this company (its rollout and
  // a wired provider), whatever its plan: the paid list names it only then.
  const signingOffered = useSigningAvailability().offered

  useEffect(() => {
    let active = true
    fetch('/api/collections/availability')
      .then((res) => (res.ok ? res.json() : null))
      .then((body: { data?: { enabled?: unknown; pilot?: unknown } } | null) => {
        if (active) setCollectionsOffered(body?.data?.enabled === true && body.data.pilot === true)
      })
      .catch(() => {})
    return () => {
      active = false
    }
  }, [])

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
          firstChargeAt?: unknown
          renewsAt?: unknown
          isDemo?: unknown
          teamAgreement?: unknown
          coverage?: unknown
          subscriptionPlan?: unknown
          subscriptionAmountExVat?: unknown
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
        const firstChargeAt = typeof d.firstChargeAt === 'string' ? d.firstChargeAt : null
        const renewsAt = typeof d.renewsAt === 'string' ? d.renewsAt : null
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
        const rawCoverage = d.coverage as { kind?: unknown; coveredUntil?: unknown } | null | undefined
        const agreement =
          rawCoverage && (rawCoverage.kind === 'agreement' || rawCoverage.kind === 'team')
            ? { until: typeof rawCoverage.coveredUntil === 'string' ? rawCoverage.coveredUntil : null }
            : null
        // A paying company's card shows the interval it actually pays.
        if (d.subscriptionPlan === 'monthly' || d.subscriptionPlan === 'yearly') {
          setPlan(d.subscriptionPlan)
        }
        setView({
          isPaying: d.isPaying,
          configured: d.configured,
          trialEndsAt,
          daysLeft,
          chargeDeferred,
          firstChargeAt,
          renewsAt,
          paidJustNow,
          isDemo: d.isDemo === true,
          teamAgreement,
          agreement,
          subscriptionAmountExVat:
            typeof d.subscriptionAmountExVat === 'number' &&
            Number.isFinite(d.subscriptionAmountExVat) &&
            d.subscriptionAmountExVat > 0
              ? d.subscriptionAmountExVat
              : null,
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
          <div className="mt-6 space-y-6">
            <Skeleton className="h-8 w-40" />
            <div className="grid gap-4 sm:grid-cols-2">
              <Skeleton className="h-80 w-full" />
              <Skeleton className="h-80 w-full" />
            </div>
          </div>
        )}
      </div>
    )
  }

  // Which state the subscription card is in. Precedence mirrors the old
  // early returns: demo, paying, just paid (webhook lag), byrå agreement,
  // own agreement, and otherwise the sell view (trialing or expired).
  const covered =
    !view.isDemo &&
    (view.isPaying || view.paidJustNow || view.teamAgreement !== null || view.agreement !== null)
  const selling = !view.isDemo && !covered
  const { trialEndsAt, daysLeft, chargeDeferred } = view
  // Two prices, never mixed. A company that is not paying sees the list
  // price, written like the website's price page: the monthly figure large
  // and how it is billed underneath. A paying company sees what its own
  // subscription costs, which for anyone who subscribed before 2026-10-22 is
  // the old price. When that amount is unknown no amount is shown.
  const listPrice = PLAN_PRICES[plan]
  const listNote =
    plan === 'yearly'
      ? t('price_note_yearly_billed', { ex: formatCurrency(listPrice.exVat), inc: formatCurrency(listPrice.incVat) })
      : t('price_note_monthly_billed', { inc: formatCurrency(listPrice.incVat) })
  const paidPrice =
    view.subscriptionAmountExVat !== null ? planPrice(plan, view.subscriptionAmountExVat) : null
  const paidNote = paidPrice
    ? plan === 'yearly'
      ? t('price_note_yearly', { inc: formatCurrency(paidPrice.incVat), perMonth: formatCurrency(paidPrice.perMonthEquivalent) })
      : t('price_note_monthly', { inc: formatCurrency(paidPrice.incVat) })
    : null

  // An active paid plan: one row with the plan, its price, the next charge
  // when one is known, and the manage action. The cards are a comparison.
  const planRow = view.isPaying && !view.isDemo

  let paidFooter: React.ReactNode = null
  if (view.isDemo) {
    // Demo accounts cannot check out: both cards, no CTA.
    paidFooter = null
  } else if (view.isPaying) {
    // The plan row above the comparison carries the manage action, the
    // first charge and the manage line.
    paidFooter = null
  } else if (view.paidJustNow) {
    // Just returned from checkout but the webhook hasn't flipped isPaying
    // yet: confirm instead of re-showing the sell pitch to someone who paid.
    paidFooter = (
      <div className="space-y-1">
        <div className="flex items-start gap-2 text-[13px]">
          <CheckIcon aria-hidden="true" className="mt-1 h-3.5 w-3.5 shrink-0 text-foreground" />
          <span>{t('paid_just_now')}</span>
        </div>
        <p className="text-xs text-muted-foreground">{t('paid_just_now_note')}</p>
      </div>
    )
  } else if (view.teamAgreement) {
    // Billing is the byrå's (WL-10): nothing to manage or buy here.
    paidFooter = (
      <p className="text-center text-xs text-muted-foreground">
        {t('team_managed_by', { teamName: view.teamAgreement.teamName })}
      </p>
    )
  } else if (view.agreement) {
    // Invoice or comp grant: no Stripe customer behind this cover.
    paidFooter = (
      <p className="text-center text-xs text-muted-foreground">
        {view.agreement.until
          ? t('agreement_note_until', { date: formatDateLong(view.agreement.until) })
          : t('agreement_note_open')}
      </p>
    )
  } else {
    paidFooter = (
      <div className="space-y-3">
        <BillingActions
          isPaying={false}
          configured={view.configured}
          plan={plan}
          firstChargeDeferred={chargeDeferred}
          className="sm:w-full"
        />
        <p className="text-center text-xs text-muted-foreground">
          {chargeDeferred && trialEndsAt
            ? t('first_charge_on', { date: formatDateLong(trialEndsAt) })
            : t('terms_now')}
        </p>
      </div>
    )
  }

  const comparison = (
    <div>
      <div className="grid gap-4 sm:grid-cols-2">
        <PlanCard
          title={t('free_title')}
          price={0}
          period={t('period_monthly')}
          note={t('free_lead')}
          items={
            <>
              {FREE_KEYS.map((key) => (
                <CheckItem key={key} label={t(key)} />
              ))}
              <CheckItem label={t('free_retention')} gloss={t('free_retention_gloss')} />
            </>
          }
          footer={
            selling ? <p className="text-center text-xs text-muted-foreground">{t('free_footer')}</p> : undefined
          }
        />
        <PlanCard
          title={t('paid_title')}
          current={covered}
          headerEnd={
            selling ? (
              <SettingsSeg
                value={plan}
                onChange={setPlan}
                aria-label={t('row_interval')}
                options={[
                  { value: 'monthly', label: t('seg_monthly') },
                  { value: 'yearly', label: t('seg_yearly') },
                ]}
              />
            ) : covered ? (
              <Badge variant="outline">{t('your_plan')}</Badge>
            ) : undefined
          }
          {...(covered
            ? paidPrice && paidNote
              ? { price: paidPrice.exVat, period: t(`period_${plan}`), note: paidNote }
              : {}
            : { price: listPrice.perMonthEquivalent, period: t('period_monthly'), note: listNote })}
          items={
            <>
              <CheckItem label={t('includes_free')} />
              {UNLOCK_KEYS.map((key) => (
                <CheckItem key={key} label={t(key)} gloss={t(`${key}_gloss`)} />
              ))}
              {collectionsOffered && (
                <CheckItem label={t(UNLOCK_COLLECTIONS_KEY)} gloss={t(`${UNLOCK_COLLECTIONS_KEY}_gloss`)} />
              )}
              {signingOffered && <CheckItem label={t(UNLOCK_SIGNING_KEY)} gloss={t(`${UNLOCK_SIGNING_KEY}_gloss`)} />}
            </>
          }
          footer={paidFooter}
        />
      </div>

      {view.isDemo && (
        <p className="mt-4 text-xs text-muted-foreground">{t('status_demo_note', { appName })}</p>
      )}
      <p className="mt-4 text-xs text-muted-foreground">
        {t('without_note')}{' '}
        <HelpPopover className="ml-1 align-middle">{t('unlock_help')}</HelpPopover>
      </p>
    </div>
  )

  const planTab = planRow ? (
    <div>
      <SettingsRow label={t('paid_title')} help={t('manage_line')}>
        <span className="tabular-nums">
          {paidPrice ? `${formatCurrency(paidPrice.exVat)} / ${t(`period_${plan}`)}` : t(`interval_${plan}`)}
        </span>
        <SettingsRowEnd>
          <BillingActions isPaying configured={view.configured} />
        </SettingsRowEnd>
        {paidNote && <SettingsRowNote className="basis-full tabular-nums">{paidNote}</SettingsRowNote>}
        {/* Subscribed during the trial: the card is committed but not yet
            charged, so say when, in the words the sell view used. */}
        {view.firstChargeAt && (
          <SettingsRowNote className="basis-full">
            {t('first_charge_on', { date: formatDateLong(view.firstChargeAt) })}
          </SettingsRowNote>
        )}
        {view.renewsAt && (
          <SettingsRowNote className="basis-full">
            {t('next_charge_on', { date: formatDateLong(view.renewsAt) })}
          </SettingsRowNote>
        )}
      </SettingsRow>
      <button
        type="button"
        onClick={() => setComparing((v) => !v)}
        aria-expanded={comparing}
        className="mt-4 inline-flex items-center gap-1 text-[12.5px] text-muted-foreground transition-colors duration-150 hover:text-foreground pointer-coarse:min-h-10"
      >
        {t('compare_plans')}
        <ChevronDownIcon
          className={cn('h-3.5 w-3.5 transition-transform duration-150', comparing && 'rotate-180')}
          aria-hidden="true"
        />
      </button>
      {comparing && <div className="mt-6 animate-fade-in">{comparison}</div>}
    </div>
  ) : (
    comparison
  )

  function selectTab(next: BillingTab) {
    setTab(next)
    if (next === 'receipts') setReceiptsOpened(true)
  }

  return (
    <div>
      {header}

      {/* An expired trial is consequential: one attn-tone sentence. The
          running countdown lives in the subscription card's footer. */}
      {selling && daysLeft === 0 && <AttnLine className="mt-3">{t('trial_ended')}</AttnLine>}
      {/* A running trial: say plainly what happens when it ends (crm#1502).
          The trial is a capability grant, not a Stripe subscription, so
          nothing renews: only a checkout the owner starts creates one. */}
      {selling && daysLeft !== null && daysLeft > 0 && (
        <p className="mt-3 text-[13px] text-muted-foreground">{t('trial_end_free_note')}</p>
      )}

      <SegmentedControl<BillingTab>
        className="mt-6"
        value={tab}
        onChange={selectTab}
        aria-label={t('tabs_label')}
        options={[
          { value: 'plan', label: t('tab_plan') },
          { value: 'receipts', label: t('tab_receipts') },
        ]}
      />

      <div role="tabpanel" className="mt-6" hidden={tab !== 'plan'}>
        {planTab}
      </div>
      {receiptsOpened && (
        <div role="tabpanel" className="mt-6" hidden={tab !== 'receipts'}>
          <ReceiptsPanel isPaying={view.isPaying} configured={view.configured} />
        </div>
      )}
    </div>
  )
}

const RECEIPT_STATUS_KEY = {
  paid: 'receipt_status_paid',
  open: 'receipt_status_open',
  uncollectible: 'receipt_status_uncollectible',
} as const satisfies Record<BillingReceipt['status'], string>

function ReceiptsPanel({ isPaying, configured }: { isPaying: boolean; configured: boolean }) {
  const t = useTranslations('settings_billing')
  const [receipts, setReceipts] = useState<BillingReceipt[] | null>(null)
  const [failed, setFailed] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)

  useEffect(() => {
    let active = true

    async function load() {
      setFailed(false)
      setReceipts(null)
      try {
        const res = await fetch('/api/billing/invoices')
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const body = (await res.json()) as { invoices?: unknown }
        if (!active) return
        if (!Array.isArray(body.invoices)) throw new Error('Malformed response')
        setReceipts(body.invoices as BillingReceipt[])
      } catch {
        if (active) setFailed(true)
      }
    }

    void load()
    return () => { active = false }
  }, [reloadKey])

  let content: React.ReactNode
  if (failed) {
    content = (
      <AttnLine action={{ label: t('load_retry'), onClick: () => setReloadKey((k) => k + 1) }}>
        {t('receipts_load_failed')}
      </AttnLine>
    )
  } else if (receipts === null) {
    content = (
      <div className="space-y-2">
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-8 w-full" />
      </div>
    )
  } else if (receipts.length === 0) {
    content = <p className="text-[13px] text-muted-foreground">{t('receipts_empty')}</p>
  } else {
    content = (
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-[13px]">
          <thead>
            <tr>
              <th className={TH_CLASS}>{t('receipts_col_date')}</th>
              <th className={TH_CLASS}>{t('receipts_col_description')}</th>
              <th className={cn(TH_CLASS, 'text-right')}>{t('receipts_col_amount')}</th>
              <th className={TH_CLASS}>{t('receipts_col_status')}</th>
              <th className={TH_CLASS}>
                <span className="sr-only">{t('receipts_col_file')}</span>
              </th>
            </tr>
          </thead>
          <tbody className="stagger-enter">
            {receipts.map((r) => (
              <tr key={r.id} className="transition-colors duration-150 hover:bg-secondary/35">
                <td className={cn(TD_CLASS, 'whitespace-nowrap tabular-nums')}>{formatDate(r.created)}</td>
                <td className={TD_CLASS}>{r.description ?? r.number ?? t('paid_title')}</td>
                <td className={cn(TD_CLASS, 'whitespace-nowrap text-right tabular-nums')}>
                  {formatCurrency(r.amountPaid, r.currency.toUpperCase())}
                </td>
                <td className={cn(TD_CLASS, 'whitespace-nowrap text-muted-foreground')}>
                  {t(RECEIPT_STATUS_KEY[r.status] ?? 'receipt_status_open')}
                </td>
                <td className={cn(TD_CLASS, 'py-1 text-right')}>
                  {r.pdfUrl && (
                    <Button variant="ghost" size="sm" asChild>
                      <a
                        href={r.pdfUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        aria-label={t('receipt_pdf_aria', { date: formatDate(r.created) })}
                      >
                        {t('receipt_pdf')}
                      </a>
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    )
  }

  return (
    <div>
      <div role="status" aria-live="polite">{content}</div>
      {isPaying && (
        <div className="mt-6 flex flex-wrap items-center justify-between gap-4 border-t border-border pt-4">
          <span className="text-[13px]">{t('receipts_manage')}</span>
          <BillingActions isPaying configured={configured} />
        </div>
      )}
    </div>
  )
}
