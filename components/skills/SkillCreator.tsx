'use client'

import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { useTranslations } from 'next-intl'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { Check } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { AI_CLIENTS, type AiClient } from '@/lib/onboarding/ai-clients'
import { buildOwnSkill } from '@/lib/agent-skills/own-skill-body'
import { prefersReducedMotion, wait } from './spark'
import styles from './skills.module.css'

export type CreatorMode =
  | { kind: 'gate' }
  | { kind: 'create' }
  | { kind: 'edit'; installationId: string }

type Answers = { area: number; context: Set<number>; askFirst: Set<number> }

const initialAnswers = (): Answers => ({ area: 0, context: new Set([0, 1]), askFirst: new Set([0]) })

/**
 * "Helskärm": the creator covers the page, one question at a time, a spark
 * on a progress line. It ends in "Smedja": the answers fly into a key, its
 * three LEDs light, it catches fire and drops into the list. While no AI is
 * connected it opens as "Koppla din AI först" instead.
 */
export function SkillCreator({ mode, onClose, onConnect, onSave, onSaved }: {
  mode: CreatorMode | null
  onClose: () => void
  onConnect: (client: AiClient) => void
  /** Saves the skill; resolves to the new installation id, or null on failure. */
  onSave: (skill: { name: string; description: string; body: string }, mode: CreatorMode) => Promise<string | null>
  onSaved: (installationId: string) => void
}) {
  return (
    <DialogPrimitive.Root open={mode !== null} onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Content className={styles.full} aria-describedby={undefined}>
          {mode?.kind === 'gate' ? <Gate onClose={onClose} onConnect={onConnect} /> : mode ? <Questions key={mode.kind} mode={mode} onClose={onClose} onSave={onSave} onSaved={onSaved} /> : null}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}

function Gate({ onClose, onConnect }: { onClose: () => void; onConnect: (client: AiClient) => void }) {
  const t = useTranslations('skills_registry')
  return (
    <div className={styles.cstep}>
      <span className={styles.kick}>{t('creator.gate_kick')}</span>
      <DialogPrimitive.Title asChild><h2 className={styles.cq}>{t('creator.gate_title')}</h2></DialogPrimitive.Title>
      <p className={styles.cbody}>{t('creator.gate_body')}</p>
      <div className={styles.kgrid} style={{ maxWidth: 640 }}>
        {AI_CLIENTS.map((client) => (
          <button key={client.id} type="button" className={styles.kbtn} onClick={() => onConnect(client.id)}>{t('connect_client', { client: client.name })}</button>
        ))}
      </div>
      <div className={styles.cfoot}><Button variant="outline" onClick={onClose}>{t('cancel')}</Button></div>
    </div>
  )
}

function Questions({ mode, onClose, onSave, onSaved }: {
  mode: CreatorMode
  onClose: () => void
  onSave: (skill: { name: string; description: string; body: string }, mode: CreatorMode) => Promise<string | null>
  onSaved: (installationId: string) => void
}) {
  const t = useTranslations('skills_registry')
  const [step, setStep] = useState(0)
  const [answers, setAnswers] = useState<Answers>(initialAnswers)
  const [forging, setForging] = useState<'no' | 'running' | 'failed'>('no')
  const [drop, setDrop] = useState(false)
  const alive = useRef(true)
  useEffect(() => () => { alive.current = false }, [])

  const options = [t.raw('creator.q1_options') as string[], t.raw('creator.q2_options') as string[], t.raw('creator.q3_options') as string[]]
  const questions = [t('creator.q1'), t('creator.q2'), t('creator.q3')]
  const area = options[0][answers.area]
  const context = options[1].filter((_, i) => answers.context.has(i))
  const askFirst = options[2].filter((_, i) => answers.askFirst.has(i))
  const skill = buildOwnSkill({ area, context, askFirst }, {
    name: (a) => t('creator.name', { area: a }),
    intro: t('creator.body_intro'),
    scopeHeading: t('creator.body_scope_heading'),
    scope: (a) => t('creator.body_scope', { area: a }),
    contextHeading: t('creator.body_context_heading'),
    askHeading: t('creator.body_ask_heading'),
    askLine: (item) => t('creator.body_ask', { item }),
    lockedLine: t('creator.body_locked'),
    rulesHeading: t('creator.body_rules_heading'),
    rules: t('creator.body_rules'),
    noContext: t('creator.body_no_context'),
  })

  function toggle(q: number, i: number) {
    setAnswers((prev) => {
      if (q === 0) return { ...prev, area: i }
      const key = q === 1 ? 'context' : 'askFirst'
      const next = new Set(prev[key])
      if (next.has(i)) next.delete(i)
      else next.add(i)
      return { ...prev, [key]: next }
    })
  }

  async function forge() {
    setForging('running')
    setDrop(false)
    const reduced = prefersReducedMotion()
    const [id] = await Promise.all([onSave(skill, mode), wait(reduced ? 0 : 2700)])
    if (!alive.current) return
    if (!id) { setForging('failed'); return }
    if (!reduced) {
      setDrop(true)
      await wait(450)
      if (!alive.current) return
    }
    onSaved(id)
  }

  if (forging !== 'no') {
    const flying = [area, context[0], askFirst[0]].filter(Boolean) as string[]
    const at: [string, string][] = [['-270px', '-30px'], ['0px', '-130px'], ['270px', '-30px']]
    return (
      <>
        <div className={styles.end}>
          <DialogPrimitive.Title asChild><span className={styles.kick}>{t('creator.forge_kick')}</span></DialogPrimitive.Title>
          {forging === 'running' ? (
            <>
              <div className={styles.forgestage} aria-hidden>
                {flying.map((label, i) => (
                  <span key={label} className={styles.fly} style={{ '--fx': at[i][0], '--fy': at[i][1], '--fd': `${0.25 + i * 0.3}s` } as CSSProperties}>{label}</span>
                ))}
                <div className={styles.forgekey} data-drop={drop ? '' : undefined}>
                  <div className={styles.leds}>{[0, 1, 2].map((n) => <i key={n} style={{ '--n': n } as CSSProperties} />)}</div>
                  <h4 data-ph-mask>{skill.name}</h4>
                </div>
              </div>
              <div className={styles.ticks}>
                {['tick_1', 'tick_2', 'tick_3'].map((key, n) => (
                  <div key={key} style={{ '--n': n } as CSSProperties}><Check className="h-3.5 w-3.5" aria-hidden /><span>{t(`creator.${key}`)}</span></div>
                ))}
              </div>
            </>
          ) : (
            <>
              <p role="alert" className={styles.cbody}>{t('save_failed')}</p>
              <div className={styles.cfoot}>
                <Button variant="outline" onClick={() => { setForging('no'); setStep(2) }}>{t('creator.back')}</Button>
                <Button onClick={() => void forge()}>{t('retry')}</Button>
              </div>
            </>
          )}
        </div>
        <div className={styles.prog} aria-hidden><i style={{ '--p': '100%' } as CSSProperties} /></div>
      </>
    )
  }

  return (
    <>
      <span className={styles.bign} aria-hidden>{step + 1}</span>
      <div className={styles.cstep} key={step}>
        <span className={styles.kick}>{t('creator.question_of', { n: step + 1 })}</span>
        <DialogPrimitive.Title asChild><h2 className={styles.cq}>{questions[step]}</h2></DialogPrimitive.Title>
        <div className={styles.kgrid} role="group" aria-label={questions[step]}>
          {options[step].map((label, i) => {
            const pressed = step === 0 ? answers.area === i : (step === 1 ? answers.context : answers.askFirst).has(i)
            return <button key={label} type="button" className={styles.kbtn} aria-pressed={pressed} onClick={() => toggle(step, i)}>{label}</button>
          })}
          {step === 2 && <button type="button" className={styles.kbtn} aria-pressed="true" aria-disabled="true">{t('creator.q3_fixed')}</button>}
        </div>
      </div>
      <div className={styles.cfoot}>
        {step > 0 ? <Button variant="outline" onClick={() => setStep(step - 1)}>{t('creator.back')}</Button> : <Button variant="outline" onClick={onClose}>{t('cancel')}</Button>}
        {step < 2 ? <Button onClick={() => setStep(step + 1)}>{t('creator.next')}</Button> : <Button onClick={() => void forge()}>{t('creator.forge')}</Button>}
      </div>
      <div className={styles.prog} aria-hidden><i style={{ '--p': `${[8, 50, 92][step]}%` } as CSSProperties} /></div>
    </>
  )
}
