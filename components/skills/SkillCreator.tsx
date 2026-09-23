'use client'

import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { ArrowUp, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { AI_CLIENTS, type AiClient } from '@/lib/onboarding/ai-clients'
import { buildOwnSkill } from '@/lib/agent-skills/own-skill-body'
import type { CreatorQuestion, CreatorStep, CreatorSummary, CreatorTurn } from '@/lib/agent-skills/creator-chat'
import { prefersReducedMotion, wait } from './spark'
import styles from './skills.module.css'

export type CreatorMode =
  | { kind: 'gate' }
  | { kind: 'create' }
  | { kind: 'edit'; installationId: string }

/** Where the finished key sits on screen as the creator closes, so the page can fly it into the list. */
export type KeyRect = { left: number; top: number; width: number; height: number; name: string }

/**
 * "Resan": the creator is a ride along a blue line over Stockholm, one
 * station per step: describe the task, up to three follow-up questions from
 * the assistant, then the summary. It opens through "Dörrarna" (the page
 * splits and slides apart) and ends in a 3D exploded view: one plate per
 * answer falls into place, they press together, the camera turns top-down
 * and the top plate becomes the key. While no AI is connected it opens as
 * "Koppla din AI först" instead.
 */
export function SkillCreator({ mode, client, pageRef, onClose, onConnect, onSave, onSaved }: {
  mode: CreatorMode | null
  client: AiClient
  /** The page behind, split open by the doors. */
  pageRef: RefObject<HTMLElement | null>
  onClose: () => void
  onConnect: (client: AiClient) => void
  /** Saves the skill; resolves to the new installation id, or null on failure. */
  onSave: (skill: { name: string; description: string; body: string }, mode: CreatorMode) => Promise<string | null>
  onSaved: (installationId: string, key: KeyRect | null) => void
}) {
  const journey = mode && mode.kind !== 'gate'
  return (
    <DialogPrimitive.Root open={mode !== null} onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Content className={styles.full} data-journey={journey ? '' : undefined} aria-describedby={undefined}>
          {mode?.kind === 'gate' ? <Gate onClose={onClose} onConnect={onConnect} /> : mode ? <Journey key={mode.kind} mode={mode} client={client} pageRef={pageRef} onClose={onClose} onSave={onSave} onSaved={onSaved} /> : null}
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
        {AI_CLIENTS.map((c) => (
          <button key={c.id} type="button" className={styles.kbtn} onClick={() => onConnect(c.id)}>{t('connect_client', { client: c.name })}</button>
        ))}
      </div>
      <div className={styles.cfoot}><Button variant="outline" onClick={onClose}>{t('cancel')}</Button></div>
    </div>
  )
}

type Phase = 'describe' | 'question' | 'summary' | 'build'
type Stage = { orbit: boolean; fallen: number; collapse: boolean; flat: boolean; burn: boolean }
const STAGE_START: Stage = { orbit: false, fallen: 0, collapse: false, flat: false, burn: false }

async function draft(body: object): Promise<CreatorStep> {
  const response = await fetch('/api/skills/draft', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  if (!response.ok) throw new Error(`draft ${response.status}`)
  return (await response.json()).data as CreatorStep
}

/** The build, in ms from pressing Bygg: orbit, four plates fall, press together, turn top-down, burn. */
const BUILD_AT = { orbit: 100, fall: [300, 1000, 1700, 2400], collapse: 3600, flat: 4500, burn: 5300, home: 6800 }

function Journey({ mode, client, pageRef, onClose, onSave, onSaved }: {
  mode: Exclude<CreatorMode, { kind: 'gate' }>
  client: AiClient
  pageRef: RefObject<HTMLElement | null>
  onClose: () => void
  onSave: (skill: { name: string; description: string; body: string }, mode: CreatorMode) => Promise<string | null>
  onSaved: (installationId: string, key: KeyRect | null) => void
}) {
  const t = useTranslations('skills_registry')
  const locale = useLocale() === 'en' ? 'en' : 'sv'
  const clientName = AI_CLIENTS.find((c) => c.id === client)?.name ?? 'Claude'
  const [phase, setPhase] = useState<Phase>('describe')
  const [description, setDescription] = useState('')
  const [turns, setTurns] = useState<CreatorTurn[]>([])
  const [topics, setTopics] = useState<string[]>([])
  const [question, setQuestion] = useState<CreatorQuestion | null>(null)
  const [summary, setSummary] = useState<CreatorSummary | null>(null)
  const [extra, setExtra] = useState<string[]>([])
  const [adding, setAdding] = useState(false)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState<null | 'draft' | 'save'>(null)
  const [text, setText] = useState('')
  const [stage, setStage] = useState<Stage>(STAGE_START)
  const retry = useRef<(() => void) | null>(null)
  const topRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const alive = useRef(true)
  useEffect(() => () => { alive.current = false }, [])

  const station = phase === 'describe' ? 0 : phase === 'question' ? turns.length + 1 : 4
  const names = [t('creator.station_describe'), ...[0, 1, 2].map((i) => topics[i] ?? t('creator.station_question', { n: i + 1 })), t('creator.station_end')]

  useEffect(() => { if (!busy) inputRef.current?.focus({ preventScroll: true }) }, [busy, phase, turns.length, adding])

  async function step(body: { description: string; turns: CreatorTurn[]; extra: string[]; summarize?: boolean }) {
    setBusy(true)
    setFailed(null)
    try {
      const next = await draft({ client: clientName, locale, ...body })
      if (!alive.current) return
      if (next.kind === 'question') {
        setQuestion(next)
        setTopics((prev) => [...prev.slice(0, body.turns.length), next.topic])
        setPhase('question')
      } else {
        setSummary(next)
        setPhase('summary')
      }
      setText('')
    } catch {
      if (!alive.current) return
      retry.current = () => void step(body)
      setFailed('draft')
    } finally {
      if (alive.current) setBusy(false)
    }
  }

  function send(value = text) {
    const answer = value.trim()
    if (!answer || busy) return
    if (phase === 'describe') {
      setDescription(answer)
      void step({ description: answer, turns: [], extra: [] })
    } else if (phase === 'question' && question) {
      const next = [...turns, { question: question.question, answer }]
      setTurns(next)
      void step({ description, turns: next, extra })
    } else if (phase === 'summary' && adding) {
      const next = [...extra, answer]
      setExtra(next)
      setAdding(false)
      void step({ description, turns, extra: next, summarize: true })
    }
  }

  async function build() {
    if (!summary) return
    const skill = buildOwnSkill(summary, { description, turns, extra }, {
      intro: t('creator.body_intro'),
      taskHeading: t('creator.body_task_heading'),
      stepsHeading: t('creator.body_steps_heading'),
      rulesHeading: t('creator.body_rules_heading'),
      approvalLine: t('creator.body_approval'),
      lockedLine: t('creator.body_locked'),
      toldHeading: t('creator.body_told_heading'),
      addedLabel: t('creator.body_added'),
    })
    setFailed(null)
    setPhase('build')
    setStage(STAGE_START)
    const reduced = prefersReducedMotion()
    const show = async () => {
      if (reduced) return
      const at = (ms: number, change: Partial<Stage>) => wait(ms).then(() => { if (alive.current) setStage((prev) => ({ ...prev, ...change })) })
      await Promise.all([
        at(BUILD_AT.orbit, { orbit: true }),
        ...BUILD_AT.fall.map((ms, i) => at(ms, { fallen: i + 1 })),
        at(BUILD_AT.collapse, { collapse: true }),
        at(BUILD_AT.flat, { flat: true }),
        at(BUILD_AT.burn, { burn: true }),
        wait(BUILD_AT.home),
      ])
    }
    const [id] = await Promise.all([onSave(skill, mode), show()])
    if (!alive.current) return
    if (!id) {
      retry.current = () => void build()
      setFailed('save')
      return
    }
    const r = topRef.current?.getBoundingClientRect()
    onSaved(id, r && !reduced ? { left: r.left, top: r.top, width: r.width, height: r.height, name: skill.name } : null)
  }

  const sign = phase === 'summary'
    ? <><small>{t('creator.end_label')}</small>{t('creator.end_title')}</>
    : <small>{t('creator.station_label', { n: station + 1 })}</small>
  const asked = phase === 'describe' ? t('creator.describe_q', { client: clientName }) : phase === 'question' ? question?.question ?? '' : t('creator.add_q')

  return (
    <div className={styles.journey} data-building={phase === 'build' ? '' : undefined} style={{ '--skpan': station / 4 } as CSSProperties}>
      <div className={styles.jbg} aria-hidden><div className={styles.jpan} /><div className={styles.jshade} /><div className={styles.jgrid} /></div>
      <DialogPrimitive.Title className="sr-only">{t('creator.title')}</DialogPrimitive.Title>
      <Doors pageRef={pageRef} />
      <button type="button" className={styles.jx} onClick={onClose} aria-label={t('creator.close')}><X className="h-4 w-4" aria-hidden /></button>
      <ol className={styles.jline} aria-label={t('creator.stations')}>
        <i className={styles.jrun} aria-hidden /><i className={styles.jtrain} aria-hidden />
        {names.map((name, i) => <li key={i} data-on={i <= station ? '' : undefined} aria-current={i === station ? 'step' : undefined}>{name}</li>)}
      </ol>
      <div className={styles.jsign} key={`s${station}`}>{sign}</div>

      <div className={styles.jcard} key={`c${station}-${adding}`}>
        {failed === 'draft' ? (
          <div className={styles.jmid}>
            <p className={styles.jq} role="alert">{t('creator.draft_failed')}</p>
            <button type="button" className={styles.jpill} onClick={() => retry.current?.()}>{t('retry')}</button>
          </div>
        ) : busy ? (
          <div className={styles.jmid}><span className={styles.jthink} role="status" aria-label={t('creator.thinking')}><i /><i /><i /></span></div>
        ) : phase === 'summary' && summary && !adding ? (
          <Summary summary={summary} extra={extra} client={clientName} onBuild={() => void build()} onAdd={() => { setAdding(true); setText('') }} />
        ) : phase !== 'build' ? (
          <div className={styles.jmid}>
            <h2 className={styles.jq}>{asked}</h2>
            <form className={styles.jcomp} onSubmit={(e) => { e.preventDefault(); send() }}>
              <textarea
                ref={inputRef}
                rows={1}
                value={text}
                maxLength={phase === 'describe' ? 2000 : 1000}
                placeholder={phase === 'describe' ? t('creator.describe_ph') : phase === 'question' ? t('creator.answer_ph') : t('creator.add_ph')}
                aria-label={asked}
                onChange={(e) => { setText(e.target.value); e.target.style.height = 'auto'; e.target.style.height = `${Math.min(140, e.target.scrollHeight)}px` }}
                onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } }}
              />
              <button type="submit" className={styles.jsend} disabled={!text.trim()} aria-label={t('creator.send')}><ArrowUp className="h-4 w-4" aria-hidden /></button>
            </form>
            {phase === 'question' && question && question.suggestions.length > 0 && (
              <div className={styles.jchips}>
                {question.suggestions.map((s, i) => <button key={s} type="button" style={{ '--n': i } as CSSProperties} onClick={() => send(s)}>{s}</button>)}
              </div>
            )}
            {adding && <button type="button" className={styles.jlink} onClick={() => setAdding(false)}>{t('creator.back')}</button>}
          </div>
        ) : null}
      </div>

      {phase === 'build' && summary && <Build summary={summary} turns={turns} stage={stage} topRef={topRef} />}
      {phase === 'build' && failed === 'save' && (
        <div className={styles.jdone} role="alert">
          <p>{t('save_failed')}</p>
          <div className={styles.jacts}>
            <button type="button" className={styles.jpill} onClick={() => retry.current?.()}>{t('retry')}</button>
            <button type="button" className={`${styles.jpill} ${styles.jghost}`} onClick={() => { setFailed(null); setPhase('summary') }}>{t('creator.back')}</button>
          </div>
        </div>
      )}
    </div>
  )
}

function Summary({ summary, extra, client, onBuild, onAdd }: { summary: CreatorSummary; extra: string[]; client: string; onBuild: () => void; onAdd: () => void }) {
  const t = useTranslations('skills_registry')
  return (
    <div className={styles.jsum}>
      <h3 data-ph-mask>{summary.name}</h3>
      <p data-ph-mask>{summary.lede}</p>
      <ol>{summary.steps.map((s, i) => <li key={i} style={{ '--n': i } as CSSProperties} data-ph-mask>{s}</li>)}</ol>
      {extra.length > 0 && <p className={styles.jextra} data-ph-mask><b>{t('creator.added')}</b> {extra.join(' · ')}</p>}
      {summary.facts.length > 0 && <div className={styles.jfacts}>{summary.facts.map((f) => <span key={f}>{f}</span>)}</div>}
      <div className={styles.jacts}>
        <button type="button" className={styles.jpill} onClick={onBuild}>{t('creator.build', { client })}</button>
        <button type="button" className={`${styles.jpill} ${styles.jghost}`} onClick={onAdd}>{t('creator.add')}</button>
      </div>
    </div>
  )
}

/** The exploded view: four plates, one per answer; the top one becomes the key. */
function Build({ summary, turns, stage, topRef }: { summary: CreatorSummary; turns: CreatorTurn[]; stage: Stage; topRef: RefObject<HTMLDivElement | null> }) {
  const t = useTranslations('skills_registry')
  const layers = [
    { k: t('creator.layer_base'), cap: turns[0] ? t('creator.cap_answer', { answer: turns[0].answer }) : t('creator.cap_steps'), items: summary.facts },
    { k: t('creator.layer_rules'), cap: turns.length > 1 ? t('creator.cap_answer', { answer: turns.slice(1).map((turn) => turn.answer).join(' · ') }) : t('creator.cap_steps'), items: summary.rules.length ? summary.rules.slice(0, 3) : [t('creator.rule_default')] },
  ]
  return (
    <div className={styles.scene} aria-hidden data-orbit={stage.orbit ? '' : undefined} data-collapse={stage.collapse ? '' : undefined} data-flat={stage.flat ? '' : undefined} data-burn={stage.burn ? '' : undefined}>
      <div className={styles.rig}>
        {layers.map((l, i) => (
          <div key={l.k} className={styles.plate} style={{ '--i': i } as CSSProperties} data-in={stage.fallen > i ? '' : undefined}>
            <div className={styles.pface}><b>{l.k}</b><div className={styles.ptags}>{l.items.map((item) => <span key={item} data-ph-mask>{item}</span>)}</div></div>
            <div className={styles.plbl}><i /><span><b>{l.k}</b><span data-ph-mask>{l.cap}</span></span></div>
          </div>
        ))}
        <div className={styles.plate} style={{ '--i': 2 } as CSSProperties} data-in={stage.fallen > 2 ? '' : undefined}>
          <div className={styles.pface}><b>{t('creator.layer_steps')}</b><ol className={styles.psteps}>{summary.steps.slice(0, 6).map((s, i) => <li key={i} data-ph-mask>{s}</li>)}</ol></div>
          <div className={styles.plbl}><i /><span><b>{t('creator.layer_steps')}</b>{t('creator.cap_steps')}</span></div>
        </div>
        <div ref={topRef} className={`${styles.plate} ${styles.ptop}`} style={{ '--i': 3 } as CSSProperties} data-in={stage.fallen > 3 ? '' : undefined}>
          <div className={styles.pface}>
            <h4 data-ph-mask>{summary.name}</h4>
            <p data-ph-mask>{summary.facts.join(' · ')}</p>
            <div className={styles.pleds}><i /><i /><i /></div>
          </div>
          <div className={styles.plbl}><i /><span><b>{t('creator.layer_name')}</b>{t('creator.cap_name')}</span></div>
        </div>
      </div>
    </div>
  )
}

/**
 * "Dörrarna": two copies of the page, each clipped to one half, slide apart
 * as the journey opens behind them. Purely visual: the copies are inert.
 */
function Doors({ pageRef }: { pageRef: RefObject<HTMLElement | null> }) {
  const layer = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [gone, setGone] = useState(false)
  useLayoutEffect(() => {
    const page = pageRef.current
    const host = layer.current
    if (!page || !host || prefersReducedMotion()) return
    const box = host.getBoundingClientRect()
    const r = page.getBoundingClientRect()
    const doors = (['l', 'r'] as const).map((side) => {
      const door = document.createElement('div')
      door.className = styles.door
      door.dataset.side = side
      const copy = page.cloneNode(true) as HTMLElement
      copy.removeAttribute('id')
      copy.querySelectorAll('[id]').forEach((el) => el.removeAttribute('id'))
      Object.assign(copy.style, { position: 'absolute', left: `${r.left - box.left}px`, top: `${r.top - box.top}px`, width: `${r.width}px`, margin: '0' })
      door.appendChild(copy)
      return host.appendChild(door)
    })
    const frame = requestAnimationFrame(() => requestAnimationFrame(() => setOpen(true)))
    const done = setTimeout(() => setGone(true), 1100)
    return () => { cancelAnimationFrame(frame); clearTimeout(done); doors.forEach((door) => door.remove()) }
  }, [pageRef])
  if (gone) return null
  return <div ref={layer} className={styles.doors} data-open={open ? '' : undefined} aria-hidden inert />
}
