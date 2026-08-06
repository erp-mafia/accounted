'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Check } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useErrorToast } from '@/lib/hooks/use-error-toast'
import { ENABLED_EXTENSION_IDS } from '@/lib/extensions/_generated/enabled-extensions'
import { useCapability } from '@/contexts/CompanyContext'
import { CAPABILITY } from '@/lib/entitlements/keys'
import type { InitialSetupPath, InitialSetupState } from '@/types'

interface NewUserChecklistProps {
  initialState: InitialSetupState
  className?: string
  hasBookkeepingImported?: boolean
  hasBankConnected?: boolean
  hasSkatteverketConnected?: boolean
  hasAgentBuilt?: boolean
}

/**
 * First-run getting-started block on Hem, in the founder-picked stepped
 * shape: a numbered thread (get the books in, connect the bank, connect
 * Skatteverket, build the assistant) on a hairline spine.
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
  hasAgentBuilt = false,
}: NewUserChecklistProps) {
  const t = useTranslations('initial_setup')
  const router = useRouter()
  const showError = useErrorToast()
  const hasAi = useCapability(CAPABILITY.ai)
  const [state, setState] = useState(initialState)
  const [saving, setSaving] = useState<InitialSetupPath | 'dismiss' | 'complete' | null>(null)

  const hasMigration = ENABLED_EXTENSION_IDS.has('arcim-migration')
  const hasBanking = ENABLED_EXTENSION_IDS.has('enable-banking')
  const hasSkatteverket = ENABLED_EXTENSION_IDS.has('skatteverket')

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
  // Companies built without the skatteverket extension skip that step.
  const step3Done = !hasSkatteverket || hasSkatteverketConnected
  const step4Done = hasAgentBuilt

  useEffect(() => {
    // The block retires itself once every step is done; Dölj remains the
    // manual way out.
    if (!state.completedAt && step1Done && step2Done && step3Done && step4Done && saving === null) {
      void persist({ completed: true }, 'complete')
    }
  // persist intentionally stays out: its identity follows the toast hook and
  // would retrigger this completion sync after every render.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step1Done, step2Done, step3Done, step4Done, saving, state.completedAt])

  if (state.dismissedAt || state.completedAt) return null

  const goMigration = async () => {
    const updated = await persist({ path: 'migration' }, 'migration')
    if (updated) router.push(hasMigration ? '/import?mode=migration' : '/import?mode=sie')
  }
  const goFresh = () => void persist({ path: 'fresh' }, 'fresh')
  const goBank = async () => {
    const updated = await persist({ path: state.path ?? 'bank' }, 'bank')
    if (updated) router.push(hasBanking ? '/import?mode=psd2' : '/import?mode=bank')
  }

  const activeStep = !step1Done ? 1 : !step2Done ? 2 : !step3Done ? 3 : 4
  const stepCount = hasSkatteverket ? 4 : 3

  return (
    <section className={className} aria-label={t('title', { count: stepCount })}>
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-medium">{t('title', { count: stepCount })}</h2>
        <button
          type="button"
          disabled={saving !== null}
          onClick={() => void persist({ dismissed: true }, 'dismiss')}
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
        >
          {t('step_bank_description')}
        </Step>

        {hasSkatteverket && (
          <Step
            number={3}
            done={step3Done}
            active={activeStep === 3}
            title={t('step_skv_title')}
            action={(variant) => (
              <Button size="sm" variant={variant} asChild>
                {/* The authorize endpoint redirects off-site to Skatteverket. */}
                {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
                <a href="/api/extensions/ext/skatteverket/authorize?return_to=/">
                  {t('step_skv_action')}
                </a>
              </Button>
            )}
            marks={<LogoMark src="/logos/skatteverket_color.svg" name="Skatteverket" />}
          >
            {t('step_skv_description')}
          </Step>
        )}

        <Step
          number={hasSkatteverket ? 4 : 3}
          done={step4Done}
          active={activeStep === 4 || (!hasSkatteverket && activeStep === 3)}
          title={t('step_assistant_title')}
          badge={t('step_assistant_beta')}
          last
          action={(variant) => (
            <Button
              size="sm"
              variant={variant}
              onClick={() => router.push(hasAi ? '/onboarding/agent' : '/settings/billing')}
            >
              {t('step_assistant_action')}
            </Button>
          )}
        >
          {t('step_assistant_description')}
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
        'flex h-6 w-6 items-center justify-center overflow-hidden rounded-md border border-border',
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
