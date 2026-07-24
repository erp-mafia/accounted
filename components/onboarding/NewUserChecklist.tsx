'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Check } from 'lucide-react'
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
 * shape: a numbered three-step thread (get the books in, connect the bank,
 * build the assistant) with the partner marks on the steps that have them.
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

  return (
    <section className={className} aria-label={t('title', { count: hasSkatteverket ? 4 : 3 })}>
      <div className="mb-1 flex items-center justify-between gap-3">
        <h2 className="text-sm font-medium">{t('title', { count: hasSkatteverket ? 4 : 3 })}</h2>
        <button
          type="button"
          disabled={saving !== null}
          onClick={() => void persist({ dismissed: true }, 'dismiss')}
          className="shrink-0 text-xs text-muted-foreground underline decoration-border underline-offset-4 transition-colors hover:text-foreground"
        >
          {t('dismiss')}
        </button>
      </div>

      <div className="mt-4">
        <Step
          number={1}
          done={step1Done}
          active={activeStep === 1}
          title={t('step_books_title')}
        >
          <p className="text-xs leading-5 text-muted-foreground">
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
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-3">
              <Button
                size="sm"
                disabled={saving !== null}
                onClick={() => void goMigration()}
              >
                {t('step_books_action')}
              </Button>
              <span className="flex items-center gap-1.5">
                <LogoMark src="/logos/fortnox.svg" name="Fortnox" />
                <LogoMark src="/logos/visma.jpeg" name="Visma" />
                <LogoMark src="/logos/bokio.png" name="Bokio" />
                <span className="ml-1 text-[11px] text-muted-foreground">{t('step_books_sie')}</span>
              </span>
            </div>
        </Step>

        <Step
          number={2}
          done={step2Done}
          active={activeStep === 2}
          title={t('step_bank_title')}
        >
          <p className="text-xs leading-5 text-muted-foreground">{t('step_bank_description')}</p>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <Button
              size="sm"
              variant={activeStep === 2 ? 'default' : 'outline'}
              disabled={saving !== null}
              onClick={() => void goBank()}
            >
              {t('step_bank_action')}
            </Button>
            {hasBanking && (
              <LogoMark
                src="/logos/enable-banking-icon.png"
                name="Enable Banking"
                mono
              />
            )}
          </div>
        </Step>

        {hasSkatteverket && (
          <Step
            number={3}
            done={step3Done}
            active={activeStep === 3}
            title={t('step_skv_title')}
          >
            <p className="text-xs leading-5 text-muted-foreground">{t('step_skv_description')}</p>
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <Button
                size="sm"
                variant={activeStep === 3 ? 'default' : 'outline'}
                asChild
              >
                {/* The authorize endpoint redirects off-site to Skatteverket. */}
                {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
                <a href="/api/extensions/ext/skatteverket/authorize?return_to=/">
                  {t('step_skv_action')}
                </a>
              </Button>
              <LogoMark src="/logos/skatteverket_color.svg" name="Skatteverket" />
            </div>
          </Step>
        )}

        <Step
          number={hasSkatteverket ? 4 : 3}
          done={step4Done}
          active={activeStep === 4 || (!hasSkatteverket && activeStep === 3)}
          title={t('step_assistant_title')}
          badge={t('step_assistant_beta')}
          last
        >
          <p className="text-xs leading-5 text-muted-foreground">{t('step_assistant_description')}</p>
          <div className="mt-3">
            <Button
              size="sm"
              variant={activeStep >= 3 ? 'default' : 'outline'}
              onClick={() => router.push(hasAi ? '/onboarding/agent' : '/settings/billing')}
            >
              {t('step_assistant_action')}
            </Button>
          </div>
        </Step>
      </div>
    </section>
  )
}

/** One numbered step on the thread: dot + hairline down to the next step. */
function Step({
  number,
  done,
  active,
  title,
  badge,
  last = false,
  children,
}: {
  number: number
  done: boolean
  active: boolean
  title: string
  badge?: string
  last?: boolean
  children: React.ReactNode
}) {
  return (
    <div className="relative flex gap-4 pb-6 last:pb-0">
      {!last && (
        <span
          className="absolute bottom-0 left-[13px] top-8 w-px bg-border"
          aria-hidden="true"
        />
      )}
      <span
        className={cn(
          'relative z-10 flex h-7 w-7 shrink-0 items-center justify-center rounded-full border text-xs tabular-nums',
          done
            ? 'border-success/40 text-success'
            : active
              ? 'border-foreground bg-foreground text-background'
              : 'border-border text-muted-foreground',
        )}
      >
        {done ? <Check className="h-3.5 w-3.5" aria-hidden="true" /> : number}
      </span>
      <div className="min-w-0 flex-1 pt-1">
        <p className={cn('flex items-center gap-2 text-sm', active && !done && 'font-medium', done && 'text-muted-foreground')}>
          {title}
          {badge && (
            <span className="rounded-full border border-border px-2 py-0.5 text-[10px] leading-none text-muted-foreground">
              {badge}
            </span>
          )}
        </p>
        {/* A ticked step needs no pitch: the description and actions only
            render while the step is still open. */}
        {!done && <div className="mt-1">{children}</div>}
      </div>
    </div>
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
