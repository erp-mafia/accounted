'use client'

import { useEffect, useRef, useState, type ClipboardEvent } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { useTranslations } from 'next-intl'
import useSWR, { useSWRConfig } from 'swr'
import { ArrowLeft, Plus, X } from 'lucide-react'
import { useCompany } from '@/contexts/CompanyContext'
import { useCanWrite } from '@/lib/hooks/use-can-write'
import type { KnowledgeMeta } from '@/lib/agent-skills/agent-bundle'
import { OWN_AGENT_KNOWLEDGE } from '@/lib/agent-skills/agents'
import type { KnowledgeAction } from '@/lib/agent-skills/knowledge-choices'
import { PageHeader } from '@/components/ui/page-header'
import { Button } from '@/components/ui/button'
import { SegmentedControl } from '@/components/ui/segmented-control'
import { Field, KnowledgeChip, KnowledgePanel, Row } from './AgentDetail'
import { ItemSymbol } from './ItemSymbol'
import { StrataField } from './StrataField'
import { catalogHref, itemHue, seedOf, type ItemKind } from './hues'
import { fetchConnections, knowledgeHref, readOptions, simulatedClient } from './data'
import { RoutineRow, useRoutinePrompt } from './RoutinePanel'
import { AI_CLIENTS, pickConnectedAiClient, type AiClient } from '@/lib/onboarding/ai-clients'
import { trackInstructions } from './track'
import { coworkLink, routineQuery, type RoutineChoice } from '@/lib/agent-skills/routine'
import styles from './skills.module.css'

const KIND_PARAM: Record<string, ItemKind> = { arbetsfloden: 'workflow', kunskap: 'rules', analyser: 'analysis' }

/**
 * "Skriv själv" as the item's own page, empty: the same stage and panel as a
 * flow, with fields to fill in. A flow is its steps (typed or pasted, one per
 * line) and the knowledge it brings; knowledge and an analysis are free text.
 * Saved under Egna; the page then opens the new item.
 */
export function CreateItem({ backHref }: { backHref: string }) {
  const { company } = useCompany()
  return company ? <Create companyId={company.id} backHref={backHref} /> : null
}

function Create({ companyId, backHref }: { companyId: string; backHref: string }) {
  const t = useTranslations('skills_registry')
  const router = useRouter()
  const { mutate } = useSWRConfig()
  const { canWrite } = useCanWrite()
  const [kind, setKind] = useState<ItemKind>(KIND_PARAM[useSearchParams().get('typ') ?? ''] ?? 'workflow')
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [steps, setSteps] = useState<string[]>([''])
  // The step to put the cursor in once it exists (after Enter or "Lägg till steg").
  const focusStep = useRef<number | null>(null)
  const stepRefs = useRef<Array<HTMLInputElement | null>>([])
  useEffect(() => {
    if (focusStep.current === null) return
    stepRefs.current[focusStep.current]?.focus()
    focusStep.current = null
  }, [steps])
  const [text, setText] = useState('')
  // What the flow will carry: Accounted's default for own flows (minus any taken away) and what was added.
  const [knowledge, setKnowledge] = useState<string[]>([])
  const [removedDefaults, setRemovedDefaults] = useState<string[]>([])
  const [view, setView] = useState<'main' | 'knowledge'>('main')
  const [state, setState] = useState<'idle' | 'saving'>('idle')
  const [problem, setProblem] = useState<string | null>(null)
  // A routine is scheduled in Claude Desktop, so it is offered to Claude users only, for flows and analyses.
  const [routine, setRoutine] = useState<RoutineChoice | null>(null)
  const [connected, setConnected] = useState<AiClient[] | null>(null)
  useEffect(() => {
    const simulated = simulatedClient()
    const controller = new AbortController()
    void (simulated ? Promise.resolve([simulated]) : fetchConnections(controller.signal)).then((list) => { if (list) setConnected(list) })
    return () => controller.abort()
  }, [])
  const routineOffered = kind !== 'rules' && pickConnectedAiClient(connected ?? []) === 'claude'
  const options = useSWR(['/api/agents/knowledge', companyId], ([url]) => readOptions(url))

  // Coloured by its name, as the saved item will be.
  const hue = itemHue(kind, name.trim() || 'ny')
  const filled = steps.map((s) => s.trim()).filter(Boolean)
  const ready = !!name.trim() && !!description.trim() && (kind === 'workflow' ? filled.length > 0 : !!text.trim())
  const carried = [
    ...OWN_AGENT_KNOWLEDGE.filter((id) => !removedDefaults.includes(id)).map((id) => ({ id, source: 'default' as const })),
    ...knowledge.map((id) => ({ id, source: 'added' as const })),
  ]
  const held: KnowledgeMeta[] = carried.flatMap(({ id, source }) => {
    const o = options.data?.find((x) => x.id === id)
    return o ? [{ id: o.id, tier: o.tier, source, title: o.title, summary: o.summary, version: o.version, reviewed_at: o.reviewed_at }] : []
  })

  function setStep(i: number, value: string) {
    setSteps((current) => current.map((s, j) => (j === i ? value : s)))
  }
  // Pasting several lines into a step turns them into steps, numbers and bullets stripped.
  function pasteSteps(i: number, e: ClipboardEvent<HTMLInputElement>) {
    const lines = e.clipboardData.getData('text').split('\n').map((l) => l.replace(/^\s*(\d+[.)]|[-*])\s*/, '').trim()).filter(Boolean)
    if (lines.length < 2) return
    e.preventDefault()
    setSteps((current) => [...current.slice(0, i), ...lines, ...current.slice(i + 1)].filter((s, j, all) => s.trim() || j === all.length - 1))
  }
  async function changeKnowledge(action: KnowledgeAction, atomId?: string): Promise<boolean> {
    if (!atomId) return true
    if (OWN_AGENT_KNOWLEDGE.includes(atomId)) {
      setRemovedDefaults((current) => action === 'remove' ? [...new Set([...current, atomId])] : current.filter((k) => k !== atomId))
    } else {
      setKnowledge((current) => action === 'add' ? [...new Set([...current, atomId])] : current.filter((k) => k !== atomId))
    }
    return true
  }

  function body(): string {
    const head = `# ${name.trim()}\n\n${description.trim()}\n\n`
    return kind === 'workflow'
      ? `${head}## ${t('write_steps_heading')}\n\n${filled.map((s, i) => `${i + 1}. ${s}`).join('\n')}\n`
      : `${head}${text.trim()}\n`
  }

  const routinePrompt = useRoutinePrompt()
  const scheduling = !!routine && routineOffered

  async function save() {
    // Opening Claude Desktop needs a click, and the browser honours one for a few seconds:
    // the routine is sent from this same click when saving is quick, else handed to the new page.
    const clickedAt = performance.now()
    setState('saving')
    setProblem(null)
    try {
      const response = await fetch('/api/skills', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: 'own', item_kind: kind, name: name.trim(), description: description.trim(), body: body() }),
      })
      if (!response.ok) {
        const json = await response.json().catch(() => null) as { error?: { code?: string } } | null
        setProblem(json?.error?.code === 'VALIDATION_ERROR' ? t('write_invalid') : t('write_failed'))
        setState('idle')
        return
      }
      const { data } = await response.json() as { data: { id: string } }
      // The chosen knowledge goes with the new flow, as it would when added on its page.
      if (kind === 'workflow') {
        const changes = [...knowledge.map((id) => ['add', id] as const), ...removedDefaults.map((id) => ['remove', id] as const)]
        for (const [action, atomId] of changes) {
          await fetch('/api/agents/knowledge', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, agent_id: `own/${data.id}`, atom_id: atomId }) })
        }
      }
      // Drop the cached catalog rather than revalidate it: nothing on this page reads it, so a
      // revalidation would not run, and the new item's page would open on the old list.
      await mutate((key) => Array.isArray(key) && typeof key[0] === 'string' && (key[0] === '/api/skills' || key[0] === '/api/agents'), undefined, { revalidate: false })
      const page = kind === 'workflow' ? `${backHref}/own-${data.id}` : `${backHref}/egen.${data.id}`
      if (routine && routineOffered) {
        const stillClicked = (navigator.userActivation?.isActive ?? true) && performance.now() - clickedAt < 4000
        if (stillClicked) {
          const agent = `own/${data.id}`
          const run = kind === 'workflow'
            ? t('prompt', { say: t('own_say', { name: name.trim() }), agent, client: 'claude' })
            : t('skill_prompt', { name: name.trim(), slug: agent, client: 'claude' })
          trackInstructions('instructions_routine_opened', { item: 'own', kind, cadence: routine.cadence })
          window.location.href = coworkLink(routinePrompt(routine, run))
          router.push(page)
          return
        }
        // Too slow for the browser to allow it: the new page opens with the routine filled in, one click away.
        router.push(`${page}?${routineQuery(routine)}`)
        return
      }
      router.push(page)
    } catch {
      setProblem(t('write_failed'))
      setState('idle')
    }
  }

  const back = `${catalogHref(backHref, kind)}${kind === 'workflow' ? '?' : '&'}vy=egna`
  return (
    <div className={styles.apage}>
      <PageHeader title={t('title')} />
      <Link href={back} className={styles.back}><ArrowLeft className="h-4 w-4" aria-hidden />{t('back_to_agents')}</Link>
      <div className={styles.agrid2}>
        <section className={styles.stage} aria-label={t('create_manual')}>
          {/* One grain for the page: switching kind changes the colour, not the pattern. */}
          <StrataField seed={seedOf('ny')} ground={`hsl(${hue} 52% 88%)`} bar={`hsl(${hue} 40% 42%)`} strength={2.2} />
          <div className={styles.stageTile}>
            <span key={kind} className={`${styles.tileSymbol} ${styles.fadeIn}`}><ItemSymbol kind={kind} hue={hue} size={104} open /></span>
            <b className={name.trim() ? undefined : styles.placeholderName}>{name.trim() || t('create_untitled')}</b>
            <small>{t(`kind_one_${kind}`)} · {t('source_own_item')}</small>
          </div>
          <div className={styles.stageFoot}>
            <Button size="lg" className="gap-2" disabled={!ready || !canWrite} loading={state === 'saving'} onClick={() => void save()}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              {scheduling && <img src={AI_CLIENTS.find((c) => c.id === 'claude')!.logo} alt="" width={16} height={16} className={styles.btnLogo} />}
              {scheduling ? t('write_save_schedule') : t('write_save')}
            </Button>
            {problem && <span className={styles.stageStatus} role="alert">{problem}</span>}
          </div>
        </section>

        <section className={styles.apanel}>
          <div key={view} className={styles.viewIn}>
            {view === 'main' && (
              <>
                {/* A fixed box: the folder is shorter than the other symbols, and the switch below must not move. */}
                <div className={`${styles.apAvatar} ${styles.apAvatarFixed}`}><span key={kind} className={styles.fadeIn}><ItemSymbol kind={kind} hue={hue} size={60} /></span></div>
                <SegmentedControl<ItemKind>
                  aria-label={t('kinds_label')}
                  className={styles.kindSwitch}
                  value={kind}
                  onChange={setKind}
                  options={(['workflow', 'rules', 'analysis'] as const).map((k) => ({ value: k, label: t(`kind_one_${k}`) }))}
                />
                <Field label={t('field_name')}>
                  <input className={`${styles.fieldBox} ${styles.fieldInput}`} value={name} maxLength={120} onChange={(e) => setName(e.target.value)} placeholder={t(`write_name_${kind}`)} aria-label={t('field_name')} />
                </Field>
                <Field label={t('write_description')}>
                  <input className={`${styles.fieldBox} ${styles.fieldInput}`} value={description} maxLength={500} onChange={(e) => setDescription(e.target.value)} placeholder={t(`write_description_${kind}`)} aria-label={t('write_description')} />
                </Field>
                <div key={kind} className={`${styles.kindFields} ${styles.fadeIn}`}>
                {kind === 'workflow' ? (
                  <Field label={t('section_instructions')} note={t('write_steps_hint')}>
                    <div className={styles.instrEdit}>
                      <ol>
                        {steps.map((step, i) => (
                          <li key={i}>
                            <input
                              value={step}
                              onChange={(e) => setStep(i, e.target.value)}
                              onPaste={(e) => pasteSteps(i, e)}
                              ref={(el) => { stepRefs.current[i] = el }}
                              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); setSteps((c) => [...c.slice(0, i + 1), '', ...c.slice(i + 1)]); focusStep.current = i + 1 } }}
                              placeholder={i === 0 ? t('create_step_first') : t('create_step_next')}
                              aria-label={t('create_step_label', { n: i + 1 })}
                            />
                            {steps.length > 1 && <button type="button" className={styles.chipX} aria-label={t('create_step_remove', { n: i + 1 })} onClick={() => setSteps((c) => c.filter((_, j) => j !== i))}><X className="h-3 w-3" aria-hidden /></button>}
                          </li>
                        ))}
                      </ol>
                      <button type="button" className={styles.addStep} onClick={() => { setSteps((c) => [...c, '']); focusStep.current = steps.length }}><Plus className="h-3.5 w-3.5" aria-hidden />{t('create_step_add')}</button>
                    </div>
                  </Field>
                ) : (
                  <Field label={t('field_contents')} note={t('write_text_hint')}>
                    <textarea className={styles.textEdit} value={text} rows={10} onChange={(e) => setText(e.target.value)} placeholder={t(`write_text_${kind}`)} aria-label={t('field_contents')} />
                  </Field>
                )}
                {kind === 'workflow' && (
                  <div className={styles.rows}>
                    <Row label={t('section_knowledge')} onAdd={() => setView('knowledge')} addLabel={t('knowledge_add')}>
                      {held.length === 0 ? <span className={styles.muted}>{t('create_knowledge_none')}</span> : held.map((k) => (
                        <KnowledgeChip key={k.id} knowledge={k} href={knowledgeHref(backHref, k.id)} canEdit onRemove={() => changeKnowledge('remove', k.id)} />
                      ))}
                    </Row>
                  </div>
                )}
                {routineOffered && <RoutineRow value={routine} onChange={setRoutine} />}
                </div>
              </>
            )}
            {view === 'knowledge' && (
              <KnowledgePanel held={held} options={options.data ?? []} onBack={() => setView('main')} onChange={changeKnowledge} />
            )}
          </div>
        </section>
      </div>
    </div>
  )
}
