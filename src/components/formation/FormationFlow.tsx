'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { StandaloneHeading } from '@/components/standalone/StandalonePage'
import { StatusGlyph } from '@/components/ui/status-glyph'
import { ChevronLeftIcon } from '@/components/icons'
import { cn } from '@/lib/utils'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import type { FormationAnswers } from '@/lib/formation/answers'
import { STEPS, type FormationStep, checkAnswers, issuesForStep } from '@/lib/formation/rules'
import type { FormationView } from '@/lib/formation/store'
import { FORMATION_BOOKING_URL } from '@/lib/formation/constants'
import { BoardStep, CompanyStep, DetailsStep, OwnersStep } from './FormationSteps'
import { FormationReview } from './FormationReview'
import { FormationPackage } from './FormationPackage'

type View = FormationStep | 'review' | 'package'
const ORDER: Array<Exclude<View, 'package'>> = [...STEPS, 'review']

export async function formationFetch<T>(url: string, init: RequestInit, _locale?: string): Promise<T> {
  const res = await fetch(url, { ...init, headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) } })
  const body = (await res.json().catch(() => ({}))) as { data?: T; error?: { code?: string; message?: string; message_en?: string } }
  if (!res.ok) {
    // The canonical envelope's inner error, which getErrorMessage translates by its code.
    throw Object.assign(new Error(body.error?.message || res.statusText), {
      code: body.error?.code ?? `HTTP_${res.status}`,
      message_en: body.error?.message_en,
    })
  }
  return body.data as T
}

export function FormationFlow({
  initial,
  ticEnabled,
  shareholderAgreement,
}: {
  initial: FormationView | null
  ticEnabled: boolean
  shareholderAgreement: boolean
}) {
  const t = useTranslations('formation')
  const locale = useLocale()
  const [formation, setFormation] = useState<FormationView | null>(initial)
  const [answers, setAnswers] = useState<FormationAnswers | null>(initial?.answers ?? null)
  // A complete formation opens on its package, also one the founder's own AI saved.
  const [view, setView] = useState<View>(() => (initial?.ready ? 'package' : 'company'))
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const [starting, setStarting] = useState(false)
  const [startError, setStartError] = useState<string | null>(null)
  const [showErrors, setShowErrors] = useState(false)
  const pending = useRef<FormationAnswers | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const issues = useMemo(() => (answers ? checkAnswers(answers) : []), [answers])

  // --- autosave ---------------------------------------------------------------
  const flush = useCallback(async () => {
    if (!formation || !pending.current) return
    const toSave = pending.current
    pending.current = null
    setSaveState('saving')
    try {
      const saved = await formationFetch<FormationView>(`/api/formation/${formation.id}`, { method: 'PUT', body: JSON.stringify({ answers: toSave }) }, locale)
      setFormation(saved)
      // Keep what was typed (a personnummer is never sent back), but take the
      // sealed markers the server set.
      setAnswers((current) => {
        if (!current) return saved.answers
        const last4 = new Map(saved.answers.parties.map((p) => [p.id, p.type === 'person' ? p.personnummerLast4 : undefined]))
        return { ...current, parties: current.parties.map((p) => (p.type === 'person' ? { ...p, personnummerLast4: last4.get(p.id) ?? p.personnummerLast4 } : p)) }
      })
      setSaveState('saved')
    } catch {
      setSaveState('error')
    }
  }, [formation, locale])

  const update = useCallback(
    (next: FormationAnswers) => {
      setAnswers(next)
      pending.current = next
      if (timer.current) clearTimeout(timer.current)
      timer.current = setTimeout(() => void flush(), 700)
    },
    [flush],
  )

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    [],
  )

  const start = async () => {
    setStarting(true)
    setStartError(null)
    try {
      const created = await formationFetch<FormationView>('/api/formation', { method: 'POST', body: JSON.stringify({}) }, locale)
      setFormation(created)
      setAnswers(created.answers)
      setView('company')
    } catch (err) {
      setStartError(getErrorMessage(err, { locale: locale === 'en' ? 'en' : 'sv' }))
    } finally {
      setStarting(false)
    }
  }

  // --- the intro, before a formation exists -------------------------------------------
  if (!formation || !answers) {
    return (
      <div>
        <StandaloneHeading title={t('intro.title')} sub={t('intro.sub')} />
        <ol className="mt-6 space-y-3">
          {(['decide', 'documents', 'file', 'setup'] as const).map((k, i) => (
            <li key={k} className="flex gap-3">
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-secondary text-xs font-medium tabular-nums text-strong">{i + 1}</span>
              <span className="min-w-0">
                <span className="block text-sm font-medium text-strong">{t(`intro.${k}_title`)}</span>
                <span className="block text-sm text-muted-foreground">{t(`intro.${k}_text`)}</span>
              </span>
            </li>
          ))}
        </ol>
        <div className="mt-6 border-t-hairline pt-4 text-sm text-muted-foreground">{t('intro.price')}</div>
        <div className="mt-5 flex flex-wrap items-center gap-2">
          <Button onClick={start} loading={starting}>
            {t('intro.start')}
          </Button>
          <Button asChild variant="ghost">
            <a href={FORMATION_BOOKING_URL} target="_blank" rel="noreferrer">
              {t('book_call')}
            </a>
          </Button>
        </div>
        {startError && <p className="mt-3 text-xs text-destructive">{startError}</p>}
        <p className="mt-6 text-xs text-muted-foreground">{t('intro.scope')}</p>
      </div>
    )
  }

  // --- complete: the package, then the setup -------------------------------------------------
  if (view === 'package' && formation.ready) {
    return (
      <FormationPackage
        formation={formation}
        answers={answers}
        ticEnabled={ticEnabled}
        shareholderAgreement={shareholderAgreement}
        onChange={setFormation}
        onEdit={(step) => setView(step)}
        onStartNew={() => void start()}
      />
    )
  }

  // A package view whose answers are no longer complete shows the review, which names what is missing.
  const step: Exclude<View, 'package'> = view === 'package' ? 'review' : view
  const index = ORDER.indexOf(step)
  const stepIssues = step === 'review' ? issues : issuesForStep(issues, step)
  const shownIssues = showErrors ? stepIssues : stepIssues.filter((i) => i.severity === 'warning' || isTouched(answers, i))
  const go = (next: View) => {
    void flush()
    setShowErrors(false)
    setView(next)
    if (typeof window !== 'undefined') window.scrollTo({ top: 0 })
  }
  const next = () => {
    if (step !== 'review' && stepIssues.some((i) => i.severity === 'error')) {
      setShowErrors(true)
      return
    }
    go(ORDER[index + 1])
  }

  return (
    <div>
      <nav aria-label={t('steps_label')} className="-mx-1 mb-5 flex flex-wrap gap-1">
        {ORDER.map((v, i) => {
          const errors = v === 'review' ? 0 : issuesForStep(issues, v).filter((x) => x.severity === 'error').length
          const current = v === step
          return (
            <button
              key={v}
              type="button"
              onClick={() => go(v)}
              aria-current={current ? 'step' : undefined}
              className={cn(
                'flex h-7 items-center gap-1.5 rounded-md px-2 text-xs font-medium transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70 pointer-coarse:min-h-10',
                current ? 'bg-secondary text-strong' : 'text-foreground/80 hover:bg-secondary/60',
              )}
            >
              <span className="tabular-nums text-muted-foreground">{i + 1}</span>
              {/* On a phone only the current step keeps its name, so the bar stays one row. */}
              <span className={current ? undefined : 'sr-only sm:not-sr-only'}>{t(`step.${v}`)}</span>
              {errors > 0 && i < index && <StatusGlyph tone="warning" />}
            </button>
          )
        })}
      </nav>

      <StandaloneHeading title={t(`step_title.${step}`)} sub={t(`step_sub.${step}`)} className="mb-6" />

      {step === 'company' && <CompanyStep answers={answers} update={update} issues={shownIssues} />}
      {step === 'owners' && <OwnersStep answers={answers} update={update} issues={shownIssues} />}
      {step === 'board' && <BoardStep answers={answers} update={update} issues={shownIssues} />}
      {step === 'details' && <DetailsStep answers={answers} update={update} issues={shownIssues} />}
      {step === 'review' && (
        <FormationReview
          answers={answers}
          issues={issues}
          onEdit={(step) => go(step)}
          onShowPackage={async () => {
            await flush()
            go('package')
          }}
        />
      )}

      {step !== 'review' && (
        <div className="mt-8 flex items-center gap-2 border-t-hairline pt-4">
          {index > 0 ? (
            <Button variant="ghost" onClick={() => go(ORDER[index - 1])}>
              <ChevronLeftIcon className="h-4 w-4" />
              {t('back')}
            </Button>
          ) : (
            <span />
          )}
          <span className="ml-auto text-xs text-muted-foreground" aria-live="polite">
            {saveState === 'saving' ? t('saving') : saveState === 'saved' ? t('saved') : saveState === 'error' ? t('save_failed') : ''}
          </span>
          <Button onClick={next}>{t('next')}</Button>
        </div>
      )}
    </div>
  )
}

/** Show an error before "Fortsätt" only once the founder has typed something there. */
function isTouched(a: FormationAnswers, issue: { field: string }): boolean {
  const f = issue.field
  if (f.startsWith('names.')) return (a.names[Number(f.split('.')[1])] ?? '').trim().length > 0
  if (f === 'description') return a.description.trim().length > 0
  if (f.startsWith('parties.')) {
    const [, id, key] = f.split('.')
    const p = a.parties.find((x) => x.id === id)
    if (!p) return false
    const value = (p as Record<string, unknown>)[key]
    return typeof value === 'string' ? value.trim().length > 0 : false
  }
  if (f === 'address.postalCode') return a.address.postalCode.trim().length > 0
  if (f === 'contact.email') return a.contact.email.trim().length > 0
  if (f === 'contact.phone') return a.contact.phone.trim().length > 0
  if (f === 'capital.amount') return true
  return false
}
