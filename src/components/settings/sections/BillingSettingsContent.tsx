'use client'

import { useEffect, useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { Check } from 'lucide-react'
import { AttnLine } from '@/components/ui/attn-line'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { TD_CLASS, TH_CLASS } from '@/components/ui/dry-table'
import { HelpPopover } from '@/components/ui/help-popover'
import { SegmentedControl } from '@/components/ui/segmented-control'
import { Skeleton } from '@/components/ui/skeleton'
import { getErrorMessage, type ErrorLocale } from '@/lib/errors/get-error-message'
import { SettingsSectionHeader, SettingsSeg } from '@/components/settings/SettingsRows'
import { cn, formatCurrency, formatDate } from '@/lib/utils'
import { useFormat } from '@/lib/hooks/use-format'
import { BillingActions } from '@/components/settings/BillingActions'
import { ConnectorSettingsSection } from '@/components/settings/ConnectorSettingsSection'
import { PLAN_PRICES } from '@/components/settings/billing-plans'
import type { BillingPlan } from '@/lib/stripe/client'
import { useBranding } from '@/lib/branding/brand-context'

// What the paid tier unlocks: the external connections. One item per PAID
// capability in lib/entitlements/keys.ts (ai, bank_sync, skatteverket,
// email_send, and stripe_payments + woocommerce_sync + shopify_sync as one
// "payments and webshop" item). Keep in step with PAID_CAPABILITIES when a
// key is added.
const UNLOCK_KEYS = ['unlock_ai', 'unlock_bank', 'unlock_skv', 'unlock_email', 'unlock_payments_webshop'] as const

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
      <Check aria-hidden="true" className="mt-1 h-3.5 w-3.5 shrink-0 text-foreground" />
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
  price: number
  period: string
  note: string
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
      <p className="mt-4 font-display text-3xl tabular-nums">
        {formatCurrency(price)}
        <span className="text-[15px] text-muted-foreground"> / {period}</span>
      </p>
      <p className="mt-1 text-xs tabular-nums text-muted-foreground">{note}</p>
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
          coverage?: unknown
          subscriptionPlan?: unknown
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
          paidJustNow,
          isDemo: d.isDemo === true,
          teamAgreement,
          agreement,
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
  const price = PLAN_PRICES[plan]
  const priceNote =
    plan === 'yearly'
      ? t('price_note_yearly', { inc: formatCurrency(price.incVat), perMonth: formatCurrency(price.perMonthEquivalent) })
      : t('price_note_monthly', { inc: formatCurrency(price.incVat) })

  let paidFooter: React.ReactNode = null
  if (view.isDemo) {
    // Demo accounts cannot check out: both cards, no CTA.
    paidFooter = null
  } else if (view.isPaying) {
    paidFooter = (
      <div className="flex flex-col items-center gap-3">
        <BillingActions isPaying configured={view.configured} />
        <p className="text-center text-xs text-muted-foreground">{t('manage_line')}</p>
      </div>
    )
  } else if (view.paidJustNow) {
    // Just returned from checkout but the webhook hasn't flipped isPaying
    // yet: confirm instead of re-showing the sell pitch to someone who paid.
    paidFooter = (
      <div className="space-y-1">
        <p className="flex items-start gap-2 text-[13px]">
          <Check aria-hidden="true" className="mt-1 h-3.5 w-3.5 shrink-0 text-foreground" />
          <span>{t('paid_just_now')}</span>
        </p>
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

  const planTab = (
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
          price={price.exVat}
          period={t(`period_${plan}`)}
          note={priceNote}
          items={
            <>
              <CheckItem label={t('includes_free')} />
              {UNLOCK_KEYS.map((key) => (
                <CheckItem key={key} label={t(key)} gloss={t(`${key}_gloss`)} />
              ))}
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
