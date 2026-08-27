'use client'

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Check } from 'lucide-react'
import posthog from 'posthog-js'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import JourneyOrb from '@/components/onboarding/journey/JourneyOrb'
import { cn } from '@/lib/utils'
import { useErrorToast } from '@/lib/hooks/use-error-toast'
import { useFormat } from '@/lib/hooks/use-format'
import { isAnalyticsEnabled } from '@/lib/analytics/enabled'
import { checklistNumbers, type VatDeadlineLine } from '@/lib/onboarding/checklist'
import { ENABLED_EXTENSION_IDS } from '@/lib/extensions/_generated/enabled-extensions'
import { useCapability } from '@/contexts/CompanyContext'
import { CAPABILITY } from '@/lib/entitlements/keys'
import type { InitialSetupPath, InitialSetupState } from '@/types'
import { useBranding } from '@/lib/branding/brand-context'

interface NewUserChecklistProps {
  initialState: InitialSetupState
  className?: string
  hasBookkeepingImported?: boolean
  hasBankConnected?: boolean
  hasSkatteverketConnected?: boolean
  hasInboxItems?: boolean
  hasAgentBuilt?: boolean
  /** Personalized VAT-deadline line for the Skatteverket step (null = say nothing). */
  vatLine?: VatDeadlineLine
  /** Latest SIE reconciliation-sweep outcome: surfaces "X matchade, Y att
   *  granska" on the bank step so a migrator sees what the sweep did with
   *  their history. Null = no sweep has run, say nothing. A sweep with
   *  errors > 0 was incomplete (a whole account may have been skipped), so it
   *  also says nothing rather than presenting partial numbers as the result. */
  sieSweep?: { auto_linked: number; suggested: number; unmatched: number; errors: number } | null
}

/**
 * Activation funnel events, mirroring the one existing product-event site
 * (lib/support/submit-feedback.ts): guarded, try/caught, no PII in
 * properties. Sandbox companies never render this block (their
 * initial_setup is seeded completed+dismissed), so no sandbox gate needed.
 */
function captureSetup(event: string, properties?: Record<string, unknown>) {
  if (!isAnalyticsEnabled()) return
  try {
    posthog.capture(event, properties)
  } catch {
    // Telemetry must never affect the checklist.
  }
}

/**
 * First-run getting-started block on Hem, in the founder-picked stepped
 * shape: a numbered thread (get the books in, connect the bank, connect
 * Skatteverket, get receipts flowing, build the assistant) on a hairline
 * spine.
 * Only the step you are on argues its case: it carries the description and
 * the partner marks next to a filled action. Steps you have not reached yet
 * drop the pitch but keep a quiet outline action, so any step stays one
 * click away (connect Skatteverket before the bank, if that is your order).
 * Done steps collapse to their title.
 * The persisted state machine is unchanged (path / completedAt /
 * dismissedAt via /api/onboarding/state); "Starta från början" records the
 * fresh path and simply checks off step one.
 */
export default function NewUserChecklist({
  initialState,
  className,
  hasBookkeepingImported = false,
  hasBankConnected = false,
  hasSkatteverketConnected = false,
  hasInboxItems = false,
  hasAgentBuilt = false,
  vatLine = null,
  sieSweep = null,
}: NewUserChecklistProps) {
  const t = useTranslations('initial_setup')
  const { appName } = useBranding()
  const router = useRouter()
  const showError = useErrorToast()
  const { formatDateLong } = useFormat()
  const hasAi = useCapability(CAPABILITY.ai)
  const [state, setState] = useState(initialState)
  const [saving, setSaving] = useState<InitialSetupPath | 'dismiss' | 'complete' | null>(null)
  // The completion signature: 'verdict' shows the orb check-morph and the
  // verdict line, 'closing' fades the block, 'done' keeps it retired for the
  // rest of the session. Plays only in the session that finishes the last
  // step (companies whose completedAt arrives from the server never see it).
  const [retiring, setRetiring] = useState<'verdict' | 'closing' | 'done' | null>(null)
  const retireStartedRef = useRef(false)

  const hasMigration = ENABLED_EXTENSION_IDS.has('arcim-migration')
  const hasBanking = ENABLED_EXTENSION_IDS.has('enable-banking')
  const hasSkatteverket = ENABLED_EXTENSION_IDS.has('skatteverket')
  const hasInbox = ENABLED_EXTENSION_IDS.has('invoice-inbox')
  const hasWhatsApp = ENABLED_EXTENSION_IDS.has('whatsapp-inbox')

  const persist = async (
    body: Record<string, unknown>,
    pending: InitialSetupPath | 'dismiss' | 'complete',
  ): Promise<InitialSetupState | null> => {
    setSaving(pending)
    try {
      const response = await fetch('/api/onboarding/state', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!response.ok) {
        await showError(response, { context: 'settings' })
        return null
      }
      const payload = await response.json() as { data: InitialSetupState }
      setState(payload.data)
      return payload.data
    } catch (error) {
      await showError(error, { context: 'settings' })
      return null
    } finally {
      setSaving(null)
    }
  }

  const step1Done = hasBookkeepingImported || state.path === 'fresh'
  const step2Done = hasBankConnected
  // Companies built without the skatteverket/inbox extensions skip those steps.
  const step3Done = !hasSkatteverket || hasSkatteverketConnected
  const step4Done = !hasInbox || hasInboxItems
  const step5Done = hasAgentBuilt

  useEffect(() => {
    // The block retires itself once every step is done; Dölj remains the
    // manual way out. The signature beat latches via retireStartedRef so a
    // failed persist can retry the PATCH without replaying the beat.
    if (
      !state.completedAt &&
      step1Done && step2Done && step3Done && step4Done && step5Done &&
      saving === null
    ) {
      if (!retireStartedRef.current) {
        retireStartedRef.current = true
        setRetiring('verdict')
      }
      void persist({ completed: true }, 'complete').then((updated) => {
        if (updated) captureSetup('onboarding_setup_completed', { path: updated.path })
      })
    }
  // persist intentionally stays out: its identity follows the toast hook and
  // would retrigger this completion sync after every render.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step1Done, step2Done, step3Done, step4Done, step5Done, saving, state.completedAt])

  // Beat timing: hold the verdict, then fade, then stay retired.
  useEffect(() => {
    if (retiring !== 'verdict') return
    const toClosing = window.setTimeout(() => setRetiring('closing'), 2600)
    const toGone = window.setTimeout(() => setRetiring('done'), 3200)
    return () => {
      window.clearTimeout(toClosing)
      window.clearTimeout(toGone)
    }
  }, [retiring])

  const numbers = checklistNumbers({ hasSkatteverket, hasInbox })
  const stepCount = numbers.count

  if (state.dismissedAt) return null
  // After the beat, stay retired even while the completion PATCH is still in
  // flight or retrying: falling through to the full checklist here would
  // flash it after the verdict already played. A failed PATCH keeps retrying
  // invisibly; the next visit renders from server truth either way.
  if (retiring === 'done') return null
  if (state.completedAt && !retiring) return null

  if (retiring) {
    return (
      <section className={className} aria-label={t('title', { count: stepCount })}>
        <div
          role="status"
          className={cn(
            'flex flex-col items-center py-4 text-center transition-opacity duration-500',
            retiring === 'closing' ? 'opacity-0' : 'opacity-100',
          )}
        >
          {/* The orb draws at the top quarter of its canvas (CY = height/4),
              so a 100px canvas clipped to 52px shows exactly the check. */}
          <div className="relative h-[52px] w-28 overflow-hidden" aria-hidden="true">
            <JourneyOrb state="check" targetX={0.5} height={100} />
          </div>
          <p className="mt-2 text-sm font-medium">{t('completed_verdict')}</p>
        </div>
      </section>
    )
  }

  const goMigration = async () => {
    const updated = await persist({ path: 'migration' }, 'migration')
    if (updated) {
      captureSetup('onboarding_setup_step_started', { step: 'books', path: 'migration' })
      router.push(hasMigration ? '/import?mode=migration' : '/import?mode=sie')
    }
  }
  const goFresh = () =>
    void persist({ path: 'fresh' }, 'fresh').then((updated) => {
      if (updated) captureSetup('onboarding_setup_step_started', { step: 'books', path: 'fresh' })
    })
  const goBank = async () => {
    const updated = await persist({ path: state.path ?? 'bank' }, 'bank')
    if (updated) {
      captureSetup('onboarding_setup_step_started', { step: 'bank' })
      router.push(hasBanking ? '/import?mode=psd2' : '/import?mode=bank')
    }
  }
  const goReceipts = () => {
    captureSetup('onboarding_setup_step_started', { step: 'receipts' })
    router.push(hasAi ? '/e/general/invoice-inbox' : '/settings/billing')
  }
  // Founder call 2026-08-27: the closing CTA is "Anslut till Claude", not the
  // in-app assistant calibration (still reachable from the assistant page).
  // A user who finishes the hosted onboarding lands in Claude with everything
  // already connected, where the MCP onboarding skill opens with findings and
  // the Att göra-list instead of setup. The connector URL is built from the
  // page origin so self-hosted and white-label domains link to themselves.
  const goClaude = () => {
    captureSetup('onboarding_setup_step_started', { step: 'claude' })
    const serverUrl = `${window.location.origin}/api/extensions/ext/mcp-server/mcp?tool_namespace=accounted`
    const link = `https://claude.ai/customize/connectors?modal=add-custom-connector&connectorName=${encodeURIComponent(appName)}&connectorUrl=${encodeURIComponent(serverUrl)}`
    window.open(link, '_blank', 'noopener')
  }
  const dismiss = () =>
    void persist({ dismissed: true }, 'dismiss').then((updated) => {
      if (updated) captureSetup('onboarding_setup_dismissed', {})
    })

  const activeStep = !step1Done ? 1 : !step2Done ? 2 : !step3Done ? 3 : !step4Done ? 4 : 5

  return (
    <section className={className} aria-label={t('title', { count: stepCount })}>
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm">{t('title', { count: stepCount })}</h2>
        <button
          type="button"
          disabled={saving !== null}
          onClick={dismiss}
          className="shrink-0 text-xs text-muted-foreground underline decoration-border underline-offset-4 transition-colors hover:text-foreground"
        >
          {t('dismiss')}
        </button>
      </div>

      <ol className="mt-3" role="list">
        <Step
          number={1}
          done={step1Done}
          active={activeStep === 1}
          title={t('step_books_title')}
          action={(variant) => (
            <Button
              size="sm"
              variant={variant}
              disabled={saving !== null}
              onClick={() => void goMigration()}
            >
              {t('step_books_action')}
            </Button>
          )}
          marks={
            <>
              <LogoMark src="/logos/fortnox.svg" name="Fortnox" />
              <LogoMark src="/logos/visma.jpeg" name="Visma" />
              <LogoMark src="/logos/bokio.png" name="Bokio" />
              <span className="text-[11px] text-muted-foreground">{t('step_books_sie')}</span>
            </>
          }
        >
          {t('step_books_description')}{' '}
          <button
            type="button"
            disabled={saving !== null}
            onClick={goFresh}
            className="underline decoration-border underline-offset-4 transition-colors hover:text-foreground"
          >
            {t('step_books_fresh_link')}
          </button>{' '}
          {t('step_books_fresh_suffix')}
        </Step>

        <Step
          number={2}
          done={step2Done}
          active={activeStep === 2}
          title={t('step_bank_title')}
          action={(variant) => (
            <Button
              size="sm"
              variant={variant}
              disabled={saving !== null}
              onClick={() => void goBank()}
            >
              {t('step_bank_action')}
            </Button>
          )}
          marks={
            hasBanking ? (
              <LogoMark src="/logos/enable-banking-icon.png" name="Enable Banking" mono />
            ) : undefined
          }
          doneNote={
            step2Done &&
            sieSweep &&
            sieSweep.errors === 0 &&
            (sieSweep.auto_linked > 0 || sieSweep.suggested > 0) ? (
              <Link
                href="/transactions"
                className="underline decoration-border underline-offset-4 transition-colors hover:text-foreground"
              >
                {t('step_bank_sweep_note', {
                  matched: sieSweep.auto_linked,
                  toReview: sieSweep.suggested,
                })}
              </Link>
            ) : undefined
          }
        >
          {t('step_bank_description')}
        </Step>

        {hasSkatteverket && (
          <Step
            number={numbers.skv}
            done={step3Done}
            active={activeStep === 3}
            title={t('step_skv_title')}
            action={(variant) => (
              <Button size="sm" variant={variant} asChild>
                {/* The authorize endpoint redirects off-site to Skatteverket. */}
                {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
                <a
                  href="/api/extensions/ext/skatteverket/authorize?return_to=/"
                  onClick={() => captureSetup('onboarding_setup_step_started', { step: 'skatteverket' })}
                >
                  {t('step_skv_action')}
                </a>
              </Button>
            )}
            marks={<LogoMark src="/logos/skatteverket_color.svg" name="Skatteverket" />}
          >
            {t('step_skv_description')}
            {vatLine?.kind === 'date' && (
              <>
                {' '}
                <span className="text-foreground">
                  {t('step_skv_next_vat', { date: formatDateLong(vatLine.dueDate) })}
                </span>
              </>
            )}
            {vatLine?.kind === 'missing_period' && (
              <>
                {' '}
                <Link
                  href="/settings/tax"
                  className="underline decoration-border underline-offset-4 transition-colors hover:text-foreground"
                >
                  {t('step_skv_choose_period')}
                </Link>
              </>
            )}
          </Step>
        )}

        {hasInbox && (
          <Step
            number={numbers.receipts}
            done={step4Done}
            active={activeStep === 4}
            title={t('step_receipts_title')}
            action={(variant) => (
              <Button size="sm" variant={variant} onClick={goReceipts}>
                {t('step_receipts_action')}
              </Button>
            )}
            marks={
              <span className="text-[11px] text-muted-foreground">
                {hasWhatsApp ? t('step_receipts_channels') : t('step_receipts_channels_no_wa')}
              </span>
            }
          >
            {t('step_receipts_description')}
          </Step>
        )}

        <Step
          number={numbers.assistant}
          done={step5Done}
          active={activeStep === 5}
          title={t('step_claude_title')}
          last
          action={(variant) => (
            <Button size="sm" variant={variant} onClick={goClaude}>
              {t('step_claude_action')}
            </Button>
          )}
        >
          {t('step_claude_description')}
        </Step>
      </ol>
    </section>
  )
}

/**
 * One numbered step on the thread: dot + hairline down to the next step.
 * `children` (the pitch) and `marks` (partner logos) render only while this
 * is the step the user is on. `action` renders on every step that is not
 * done: filled on the active step, outline on the ones further down, so no
 * step is ever unreachable just because it is not next in line.
 * The title row is a constant 36px so it matches the h-9 action button and
 * the dot (mt-1) centres in it; the spine then runs dot-bottom to dot-top
 * (top-8 to -bottom-1) without visible breaks.
 */
function Step({
  number,
  done,
  active,
  title,
  badge,
  action,
  marks,
  doneNote,
  last = false,
  children,
}: {
  number: number
  done: boolean
  active: boolean
  title: string
  badge?: string
  action?: (variant: 'default' | 'outline') => React.ReactNode
  marks?: React.ReactNode
  /** Small note rendered next to the title once the step is DONE: the one
   *  exception to "done steps collapse to their title" (e.g. the bank step's
   *  sweep outcome, which is the payoff the migrator is waiting for). */
  doneNote?: React.ReactNode
  last?: boolean
  children: React.ReactNode
}) {
  const open = active && !done

  return (
    <li
      className="relative flex gap-3 pb-3 last:pb-0"
      aria-current={open ? 'step' : undefined}
    >
      {!last && (
        <span
          className="absolute -bottom-1 left-[13px] top-8 w-px bg-border"
          aria-hidden="true"
        />
      )}
      <span
        className={cn(
          'relative z-10 mt-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-full border text-xs tabular-nums',
          done
            ? 'border-success/40 text-success'
            : open
              ? 'border-foreground bg-foreground text-background'
              : 'border-border text-muted-foreground',
        )}
      >
        {done ? <Check className="h-3.5 w-3.5" aria-hidden="true" /> : number}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex min-h-9 flex-wrap items-center gap-x-3 gap-y-2">
          <div
            className={cn(
              'flex items-center gap-2 text-sm',
              open ? 'font-medium' : 'text-muted-foreground',
            )}
          >
            <span>{title}</span>
            {badge && (
              <Badge
                variant="secondary"
                className={cn('shrink-0 uppercase tracking-wider', !open && 'font-normal')}
              >
                {badge}
              </Badge>
            )}
          </div>
          {!done && action?.(open ? 'default' : 'outline')}
          {done && doneNote && (
            <span className="text-xs tabular-nums text-muted-foreground">{doneNote}</span>
          )}
        </div>
        {open && (
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-2">
            <p className="text-xs leading-5 text-muted-foreground">{children}</p>
            {marks && <span className="flex items-center gap-2">{marks}</span>}
          </div>
        )}
      </div>
    </li>
  )
}

/** Tiny partner mark: real logo on a white chip; `mono` darkens a white
 *  source logo in light mode and lifts it in dark (Enable Banking). */
function LogoMark({ src, name, mono = false }: { src: string; name: string; mono?: boolean }) {
  return (
    <span
      className={cn(
        'flex h-6 w-6 items-center justify-center overflow-hidden rounded-sm border border-border',
        !mono && 'bg-white',
      )}
      title={name}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt={name}
        className={cn(
          'h-4 w-4 object-contain',
          mono &&
            'opacity-90 [filter:grayscale(100%)_brightness(0.18)] dark:[filter:grayscale(100%)_brightness(1.5)]',
        )}
      />
    </span>
  )
}
