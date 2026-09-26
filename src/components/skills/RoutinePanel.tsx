'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { Monitor, Repeat } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { AI_CLIENTS, type AiClient } from '@/lib/onboarding/ai-clients'
import {
  COWORK_WEB, coworkLink, routinePrompt, routineSummary, routineTime, ROUTINE_DAYS,
  type RoutineCadence, type RoutineChoice, type RoutineDay, type RoutineSent, type RoutineTarget, type RoutineTranslate,
} from '@/lib/agent-skills/routine'
import type { ItemKind } from './hues'
import { Field, SubView } from './AgentDetail'
import { CopyIcon } from './CopyIcon'
import { trackInstructions } from './track'
import { useClaudeTarget } from './claude-target'
import styles from './skills.module.css'

const CLAUDE_DOWNLOAD = 'https://claude.com/download'
const DEFAULT_CHOICE: RoutineChoice = { cadence: 'weekly', day: 'mon', time: '07:00' }
const CADENCE_OPTIONS = ['daily', 'weekdays', 'weekly'] as const

/** The page's translator in the shape routine.ts takes, so the request is written in one place. */
export function useRoutineTranslate(): RoutineTranslate {
  const t = useTranslations('skills_registry')
  return (key, values) => t(key, values)
}

/**
 * Sends the routine request to Claude from the user's click. On the web the
 * request is copied and claude.ai/cowork/new opened in a new tab (it drops a
 * ?q=, so the user pastes). Claude Desktop gets it filled in through
 * claude://cowork/new?q=; a link cannot tell whether the app opened, so the
 * status line says what to do if nothing did. Null when the new tab was blocked.
 */
export function sendRoutine(target: RoutineTarget, prompt: string): Promise<RoutineSent | null> {
  if (target === 'desktop') {
    window.location.href = coworkLink(prompt)
    return Promise.resolve('desktop')
  }
  // Both start inside the click: the clipboard and a new tab each need it.
  const copying = navigator.clipboard?.writeText(prompt) ?? Promise.reject(new Error('No clipboard'))
  const tab = window.open('about:blank', '_blank')
  if (tab) {
    tab.opener = null
    tab.location.replace(COWORK_WEB)
  }
  return copying.then(() => true, () => false).then((copied) => (!tab ? null : copied ? 'web' : 'web_uncopied'))
}

/**
 * "Gör till rutin" on an item's stage. Routines are scheduled in Claude, so
 * ChatGPT and Grok users get a short note instead. Nothing shows before an AI
 * is connected, nor to a viewer on a flow: a viewer's key cannot run a flow's
 * writes, while an analysis only reads.
 */
export function RoutineOffer({ client, disconnected, readOnly, canWrite, onOpen }: { client: AiClient; disconnected: boolean; readOnly: boolean; canWrite: boolean; onOpen: () => void }) {
  const t = useTranslations('skills_registry')
  if (disconnected || (!readOnly && !canWrite)) return null
  if (client !== 'claude') return <span className={styles.stageStatus}>{t('routine_other_client')}</span>
  return <Button size="lg" variant="outline" className="gap-2" onClick={onOpen}><Repeat className="h-4 w-4" aria-hidden />{t('routine_open')}</Button>
}

/**
 * "Gör till rutin": how often, then Claude on the web or Claude Desktop gets
 * a request to schedule this run. `run` is the page's own start prompt, so a
 * scheduled run is the same job a click starts, told that nobody is there to
 * answer, that it never approves its own proposals, and which company it is
 * for. The page shows the request in one plain sentence; the exact text is
 * one click away and can be copied.
 */
export function RoutinePanel({ run, name, item, kind, company, onBack, initial, sent }: {
  run: string
  /** The item's name, for the plain summary. */
  name: string
  item: string
  kind: ItemKind
  company: { id: string; name: string }
  onBack: () => void
  initial?: RoutineChoice | null
  /** Already sent while saving in Skriv själv: the panel opens with what to do next. */
  sent?: RoutineSent | null
}) {
  const t = useTranslations('skills_registry')
  const translate = useRoutineTranslate()
  const [choice, setChoice] = useState<RoutineChoice>(initial ?? DEFAULT_CHOICE)
  const [status, setStatus] = useState<RoutineSent | 'blocked' | null>(sent ?? null)
  const request = { choice, run, readOnly: kind === 'analysis', company }
  const prompt = routinePrompt(request, translate)
  const claude = AI_CLIENTS.find((c) => c.id === 'claude')!
  // A phone has no Claude Desktop (the same device check as Starta i Claude).
  const [, , targets] = useClaudeTarget()
  const desktop = targets.includes('desktop')

  function send(target: RoutineTarget) {
    trackInstructions('instructions_routine_opened', { item, kind, cadence: choice.cadence, target })
    void sendRoutine(target, prompt).then((result) => setStatus(result ?? 'blocked'))
  }

  return (
    <SubView title={t('routine_title')} onBack={onBack} backLabel={t('creator.back')}>
      <RoutineFields value={choice} onChange={(next) => { setChoice(next); setStatus(null) }} />
      <Field label={t('routine_preview')} copy={<CopyIcon text={prompt} label={t('routine_copy')} />}>
        <div className={`${styles.instrBox} ${styles.routinePreview}`}>
          <p data-ph-mask="">{routineSummary(request, name, translate)}</p>
          <details className="mt-2">
            <summary className="cursor-pointer text-xs text-muted-foreground">{t('routine_exact')}</summary>
            <p className="mt-2 text-xs text-muted-foreground" data-ph-mask="">{prompt}</p>
          </details>
        </div>
      </Field>
      <div className="flex flex-col items-start gap-2">
        <div className="flex flex-wrap gap-2">
          <Button className="gap-2" onClick={() => send('web')}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={claude.logo} alt="" width={16} height={16} className={styles.btnLogo} />
            {t('routine_go')}
          </Button>
          {desktop && (
            <Button variant="outline" className="gap-2" onClick={() => send('desktop')}>
              <Monitor className="h-4 w-4" aria-hidden />
              {t('routine_target_desktop')}
            </Button>
          )}
        </div>
        <p role="status" className={`${styles.muted} empty:hidden`}>
          {status && <>{t(`routine_sent_${status}`)} {status === 'blocked'
            ? <a className="underline underline-offset-4" href={COWORK_WEB} target="_blank" rel="noreferrer">{t('routine_open_claude')}</a>
            : t('routine_after')}</>}
        </p>
        <small className={styles.muted}>{t('routine_note')} · <a className="underline underline-offset-4" href={CLAUDE_DOWNLOAD} target="_blank" rel="noreferrer">{t('routine_download')}</a></small>
      </div>
    </SubView>
  )
}

/**
 * How often, which day and when: the controls of "Gör till rutin", as
 * selects side by side like Skriv själv's row. A segmented control's three
 * labels overflowed their pills on a phone, and a phone-only select beside it
 * would be a second control for the same choice. A cleared time keeps the
 * last valid one instead of turning into 07:00 unseen.
 */
export function RoutineFields({ value, onChange }: { value: RoutineChoice; onChange: (next: RoutineChoice) => void }) {
  const t = useTranslations('skills_registry')
  return (
    <div className={styles.routineRow}>
      <Field label={t('routine_how_often')}>
        <select className={`${styles.fieldBox} ${styles.fieldInput}`} value={value.cadence} onChange={(e) => onChange({ ...value, cadence: e.target.value as RoutineCadence })} aria-label={t('routine_how_often')}>
          {CADENCE_OPTIONS.map((c) => <option key={c} value={c}>{t(`routine_${c}`)}</option>)}
        </select>
      </Field>
      {value.cadence === 'weekly' && (
        <Field label={t('routine_day')}>
          <select className={`${styles.fieldBox} ${styles.fieldInput}`} value={value.day} onChange={(e) => onChange({ ...value, day: e.target.value as RoutineDay })} aria-label={t('routine_day')}>
            {ROUTINE_DAYS.map((d) => <option key={d} value={d}>{t(`routine_days.${d}`)}</option>)}
          </select>
        </Field>
      )}
      <Field label={t('routine_time')}>
        <input type="time" className={`${styles.fieldBox} ${styles.fieldInput}`} value={value.time} onChange={(e) => onChange({ ...value, time: routineTime(e.target.value, value.time) })} aria-label={t('routine_time')} />
      </Field>
    </div>
  )
}

/**
 * Skriv själv's routine: one row like the page's other rows, how often on the
 * right and, once chosen, the day, the time and where in Claude beside it.
 * Nothing unfolds below; saving schedules it (CreateItem.tsx).
 */
export function RoutineRow({ value, onChange, target, onTarget }: {
  value: RoutineChoice | null
  onChange: (next: RoutineChoice | null) => void
  target: RoutineTarget
  onTarget: (next: RoutineTarget) => void
}) {
  const t = useTranslations('skills_registry')
  const [, , targets] = useClaudeTarget()
  const desktop = targets.includes('desktop')
  const current = value ?? DEFAULT_CHOICE
  return (
    <div className={styles.routineInline}>
      <span className={styles.rowLabel}>{t('routine_create_label')}</span>
      <span className={styles.routineControls}>
        <select className={styles.routineSelect} value={value?.cadence ?? 'none'} aria-label={t('routine_how_often')}
          onChange={(e) => onChange(e.target.value === 'none' ? null : { ...current, cadence: e.target.value as RoutineCadence })}>
          <option value="none">{t('routine_none')}</option>
          {CADENCE_OPTIONS.map((c) => <option key={c} value={c}>{t(`routine_${c}`)}</option>)}
        </select>
        {value?.cadence === 'weekly' && (
          <select className={styles.routineSelect} value={value.day} aria-label={t('routine_day')} onChange={(e) => onChange({ ...value, day: e.target.value as RoutineDay })}>
            {ROUTINE_DAYS.map((d) => <option key={d} value={d}>{t(`routine_days.${d}`)}</option>)}
          </select>
        )}
        {value && <input type="time" className={styles.routineSelect} value={value.time} aria-label={t('routine_time')} onChange={(e) => onChange({ ...value, time: routineTime(e.target.value, value.time) })} />}
        {value && (
          <select className={styles.routineSelect} value={target} aria-label={t('routine_where')} onChange={(e) => onTarget(e.target.value as RoutineTarget)}>
            <option value="web">{t('routine_target_web')}</option>
            {desktop && <option value="desktop">{t('routine_target_desktop')}</option>}
          </select>
        )}
      </span>
      {value && (
        <small className={styles.routineInlineNote}>
          {t('routine_create_hint')}{target === 'desktop' && <> · <a className="underline underline-offset-4" href={CLAUDE_DOWNLOAD} target="_blank" rel="noreferrer">{t('routine_download')}</a></>}
        </small>
      )}
    </div>
  )
}

/** Skriv själv's Rutin row for a ChatGPT or Grok user: routines are in Claude for now. */
export function RoutineRowElsewhere() {
  const t = useTranslations('skills_registry')
  return (
    <div className={styles.routineInline}>
      <span className={styles.rowLabel}>{t('routine_create_label')}</span>
      <span className={`${styles.routineControls} ${styles.muted}`}>{t('routine_other_client')}</span>
    </div>
  )
}
