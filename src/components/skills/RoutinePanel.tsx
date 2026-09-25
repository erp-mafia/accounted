'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { SegmentedControl } from '@/components/ui/segmented-control'
import { AI_CLIENTS } from '@/lib/onboarding/ai-clients'
import { coworkLink, routinePrompt, routineTime, ROUTINE_DAYS, type RoutineCadence, type RoutineChoice, type RoutineDay } from '@/lib/agent-skills/routine'
import type { ItemKind } from './hues'
import { Field, SubView } from './AgentDetail'
import { trackInstructions } from './track'
import styles from './skills.module.css'

const CLAUDE_DOWNLOAD = 'https://claude.com/download'

/**
 * "Gör till rutin": how often, then Claude Desktop opens a new Cowork task
 * asking Claude to schedule this run. `run` is the page's own start prompt,
 * so a scheduled run is the same job a click starts, told that nobody is
 * there to answer questions while it runs.
 */
export function RoutinePanel({ run, item, kind, onBack, initial }: { run: string; item: string; kind: ItemKind; onBack: () => void; initial?: RoutineChoice | null }) {
  const t = useTranslations('skills_registry')
  const [choice, setChoice] = useState<RoutineChoice>(initial ?? { cadence: 'weekly', day: 'mon', time: '07:00' })
  const { cadence, day, time } = choice
  const at = routineTime(time)
  const when = cadence === 'weekly'
    ? t('routine_when_weekly', { day: t(`routine_days.${day}`), time: at })
    : t(`routine_when_${cadence}`, { time: at })
  const prompt = routinePrompt({ when, run, wrap: (w, r) => t('routine_prompt', { when: w, run: r }) })
  const claude = AI_CLIENTS.find((c) => c.id === 'claude')!

  function open() {
    trackInstructions('instructions_routine_opened', { item, kind, cadence })
    window.location.href = coworkLink(prompt)
  }

  return (
    <SubView title={t('routine_title')} onBack={onBack}>
      <RoutineFields value={choice} onChange={(next) => { if (next) setChoice(next) }} />
      <Field label={t('routine_preview')}>
        <div className={`${styles.instrBox} ${styles.routinePreview}`}>{prompt}</div>
      </Field>
      <div className="flex flex-col items-start gap-2">
        <Button className="gap-2" onClick={open}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={claude.logo} alt="" width={16} height={16} className={styles.btnLogo} />
          {t('routine_go')}
        </Button>
        <small className={styles.muted}>{t('routine_note')} · <a className="underline underline-offset-4" href={CLAUDE_DOWNLOAD} target="_blank" rel="noreferrer">{t('routine_download')}</a></small>
      </div>
    </SubView>
  )
}

/** How often, which day and when: the controls "Gör till rutin" and Skriv själv share. `none` offers "Ingen" first. */
export function RoutineFields({ value, onChange, none = false }: { value: RoutineChoice | null; onChange: (next: RoutineChoice | null) => void; none?: boolean }) {
  const t = useTranslations('skills_registry')
  const current = value ?? { cadence: 'weekly' as const, day: 'mon' as const, time: '07:00' }
  const options = [
    ...(none ? [{ value: 'none' as const, label: t('routine_none') }] : []),
    ...(['daily', 'weekdays', 'weekly'] as const).map((c) => ({ value: c, label: t(`routine_${c}`) })),
  ]
  return (
    <>
      <Field label={t('routine_how_often')}>
        <SegmentedControl<RoutineCadence | 'none'>
          aria-label={t('routine_how_often')}
          className={styles.routineSwitch}
          value={value?.cadence ?? 'none'}
          onChange={(c) => onChange(c === 'none' ? null : { ...current, cadence: c })}
          options={options}
        />
      </Field>
      {value && (
        <div className={styles.routineRow}>
          {value.cadence === 'weekly' && (
            <Field label={t('routine_day')}>
              <select className={`${styles.fieldBox} ${styles.fieldInput}`} value={value.day} onChange={(e) => onChange({ ...value, day: e.target.value as RoutineDay })} aria-label={t('routine_day')}>
                {ROUTINE_DAYS.map((d) => <option key={d} value={d}>{t(`routine_days.${d}`)}</option>)}
              </select>
            </Field>
          )}
          <Field label={t('routine_time')}>
            <input type="time" className={`${styles.fieldBox} ${styles.fieldInput}`} value={value.time} onChange={(e) => onChange({ ...value, time: e.target.value })} aria-label={t('routine_time')} />
          </Field>
        </div>
      )}
    </>
  )
}
