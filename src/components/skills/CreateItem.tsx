'use client'

import { useEffect, useRef, useState, useSyncExternalStore, type ClipboardEvent } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { useTranslations } from 'next-intl'
import useSWR, { useSWRConfig } from 'swr'
import { ArrowLeft, Plus, X } from 'lucide-react'
import { useCompany } from '@/contexts/CompanyContext'
import { useCanWrite } from '@/lib/hooks/use-can-write'
import { useUnsavedChanges } from '@/lib/hooks/use-unsaved-changes'
import type { KnowledgeMeta } from '@/lib/agent-skills/agent-bundle'
import { OWN_AGENT_KNOWLEDGE } from '@/lib/agent-skills/agents'
import type { KnowledgeAction } from '@/lib/agent-skills/knowledge-choices'
import { editedFlowBody, ownItemText, ownSkillSteps } from '@/lib/agent-skills/own-skill-body'
import { PageHeader } from '@/components/ui/page-header'
import { Button } from '@/components/ui/button'
import { SegmentedControl } from '@/components/ui/segmented-control'
import { Field, KnowledgeChip, KnowledgePanel, Row } from './AgentDetail'
import { ItemSymbol } from './ItemSymbol'
import { StrataField } from './StrataField'
import { catalogHref, itemHue, seedOf, type ItemKind } from './hues'
import { fetchConnections, readOptions, simulatedClient, withKnowledgeFailed } from './data'
import { RoutineRow, RoutineRowElsewhere, sendRoutine, useRoutineTranslate } from './RoutinePanel'
import { useClaudeTarget } from './claude-target'
import { AI_CLIENTS, pickConnectedAiClient, type AiClient } from '@/lib/onboarding/ai-clients'
import { trackInstructions } from './track'
import { routinePrompt, routineQuery, type RoutineChoice, type RoutineSent, type RoutineTarget } from '@/lib/agent-skills/routine'
import styles from './skills.module.css'

const KIND_PARAM: Record<string, ItemKind> = { arbetsfloden: 'workflow', kunskap: 'rules', analyser: 'analysis' }
const KINDS: readonly ItemKind[] = ['workflow', 'rules', 'analysis']

/** "Redigera" on an own item: what was saved, and what the page does when the form closes. */
export type EditTarget = {
  installationId: string
  kind: ItemKind
  name: string
  description: string
  body: string
  onCancel: () => void
  onSaved: () => Promise<void>
}

/** What was typed on an unsaved Skriv själv, kept for the tab's session so a link or Back does not lose it. */
type Draft = { kind: ItemKind; name: string; description: string; steps: string[]; text: string; knowledge: string[]; removedDefaults: string[] }
const draftKey = (companyId: string) => `instructions-write-draft:${companyId}`
function readDraft(companyId: string): Draft | null {
  try {
    const raw = window.sessionStorage.getItem(draftKey(companyId))
    const saved = raw ? (JSON.parse(raw) as Record<string, unknown>) : null
    if (!saved || typeof saved !== 'object') return null
    const text = (v: unknown) => (typeof v === 'string' ? v : '')
    const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
    const steps = list(saved.steps)
    return {
      kind: KINDS.includes(saved.kind as ItemKind) ? (saved.kind as ItemKind) : 'workflow',
      name: text(saved.name), description: text(saved.description), steps: steps.length ? steps : [''], text: text(saved.text),
      knowledge: list(saved.knowledge), removedDefaults: list(saved.removedDefaults),
    }
  } catch {
    return null
  }
}
function writeDraft(companyId: string, draft: Draft | null) {
  try {
    if (draft) window.sessionStorage.setItem(draftKey(companyId), JSON.stringify(draft))
    else window.sessionStorage.removeItem(draftKey(companyId))
  } catch {
    // Storage blocked or full: the form still works, only without the kept copy.
  }
}

// Below this width the stage stacks above the form (.agrid2 in skills.module.css), so Save moves to a bar pinned at the bottom.
const STACKED = '(max-width: 960px)'
function subscribeStacked(onChange: () => void) {
  const query = window.matchMedia(STACKED)
  query.addEventListener('change', onChange)
  return () => query.removeEventListener('change', onChange)
}

/**
 * "Skriv själv" as the item's own page, empty: the same stage and panel as a
 * flow, with fields to fill in. A flow is its steps (typed or pasted, one per
 * line) and the knowledge it brings; knowledge and an analysis are free text.
 * Saved under Egna; the page then opens the new item. With `edit`, the same
 * form opens filled in from an own item and saves over it, so its id stays.
 */
export function CreateItem({ backHref, edit }: { backHref: string; edit?: EditTarget }) {
  const { company } = useCompany()
  return company ? <Create companyId={company.id} companyName={company.name} backHref={backHref} edit={edit} /> : null
}

function Create({ companyId, companyName, backHref, edit }: { companyId: string; companyName: string; backHref: string; edit?: EditTarget }) {
  const t = useTranslations('skills_registry')
  const router = useRouter()
  const { mutate } = useSWRConfig()
  const { canWrite } = useCanWrite()
  const stacked = useSyncExternalStore(subscribeStacked, () => window.matchMedia(STACKED).matches, () => false)
  const typ = useSearchParams().get('typ')
  const [kind, setKind] = useState<ItemKind>(edit?.kind ?? KIND_PARAM[typ ?? ''] ?? 'workflow')
  const [name, setName] = useState(edit?.name ?? '')
  const [description, setDescription] = useState(edit?.description ?? '')
  const [steps, setSteps] = useState<string[]>(() => {
    const saved = edit?.kind === 'workflow' ? ownSkillSteps(edit.body) : []
    return saved.length ? saved : ['']
  })
  // The step to put the cursor in once it exists (after Enter or "Lägg till steg").
  const focusStep = useRef<number | null>(null)
  const stepRefs = useRef<Array<HTMLInputElement | null>>([])
  useEffect(() => {
    if (focusStep.current === null) return
    stepRefs.current[focusStep.current]?.focus()
    focusStep.current = null
  }, [steps])
  const [text, setText] = useState(() => (edit && edit.kind !== 'workflow' ? ownItemText(edit.body, edit.description) : ''))
  // What the flow will carry: Accounted's default for own flows (minus any taken away) and what was added.
  const [knowledge, setKnowledge] = useState<string[]>([])
  const [removedDefaults, setRemovedDefaults] = useState<string[]>([])
  const [view, setView] = useState<'main' | 'knowledge'>('main')
  const [state, setState] = useState<'idle' | 'saving'>('idle')
  const [problem, setProblem] = useState<string | null>(null)
  // A routine is scheduled in Claude, so it is offered to Claude users only, for flows and analyses, and not while editing.
  const [routine, setRoutine] = useState<RoutineChoice | null>(null)
  // Where in Claude: the web unless this browser starts Claude in Desktop or Cowork.
  const [claudeTarget] = useClaudeTarget()
  const [chosenTarget, setChosenTarget] = useState<RoutineTarget | null>(null)
  const routineTarget: RoutineTarget = chosenTarget ?? (claudeTarget === 'web' ? 'web' : 'desktop')
  const [connected, setConnected] = useState<AiClient[] | null>(null)
  useEffect(() => {
    const simulated = simulatedClient()
    const controller = new AbortController()
    void (simulated ? Promise.resolve([simulated]) : fetchConnections(controller.signal)).then((list) => { if (list) setConnected(list) })
    return () => controller.abort()
  }, [])
  const aiClient = pickConnectedAiClient(connected ?? [])
  const routineOffered = !edit && kind !== 'rules' && aiClient === 'claude'
  // ChatGPT and Grok users see where routines are instead of a row that is not there.
  const routineElsewhere = !edit && kind !== 'rules' && !!aiClient && aiClient !== 'claude'
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

  // Typed and not saved: a new item with anything in it, or an edit that differs from what was saved.
  const dirty = edit
    ? name !== edit.name || description !== edit.description || body() !== initialBody()
    : !!(name.trim() || description.trim() || text.trim() || filled.length || knowledge.length || removedDefaults.length)
  useUnsavedChanges(dirty && state === 'idle' && canWrite)
  // A new item's draft follows the form while it is written, and goes once the item is saved. This effect
  // is declared before the one that restores the draft, so on arrival it waits for that one instead of
  // wiping the kept draft with the still-empty form.
  const restored = useRef(false)
  useEffect(() => {
    if (edit || !restored.current) return
    writeDraft(companyId, dirty ? { kind, name, description, steps, text, knowledge, removedDefaults } : null)
  }, [edit, companyId, dirty, kind, name, description, steps, text, knowledge, removedDefaults])
  // What was typed here earlier in this tab comes back; ?typ= still decides the kind when given.
  useEffect(() => {
    if (edit) return
    restored.current = true
    const draft = readDraft(companyId)
    if (!draft) return
    /* eslint-disable react-hooks/set-state-in-effect -- sessionStorage exists only in the browser, so the draft can only be read after hydration */
    setKind(KIND_PARAM[typ ?? ''] ?? draft.kind)
    setName(draft.name)
    setDescription(draft.description)
    setSteps(draft.steps)
    setText(draft.text)
    setKnowledge(draft.knowledge)
    setRemovedDefaults(draft.removedDefaults)
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [edit, companyId, typ])

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
    // An edited flow keeps what the form does not show (rules an AI wrote into it); only name, description and steps change.
    if (edit && kind === 'workflow') {
      return editedFlowBody(edit.body, { name: name.trim(), description: description.trim(), previousDescription: edit.description, steps: filled, stepsHeading: t('write_steps_heading') })
    }
    const head = `# ${name.trim()}\n\n${description.trim()}\n\n`
    return kind === 'workflow'
      ? `${head}## ${t('write_steps_heading')}\n\n${filled.map((s, i) => `${i + 1}. ${s}`).join('\n')}\n`
      : `${head}${text.trim()}\n`
  }
  // What saving untouched fields would write: an edit is dirty only when the body would change.
  function initialBody(): string {
    return edit?.kind === 'workflow'
      ? editedFlowBody(edit.body, { name: edit.name.trim(), description: edit.description.trim(), previousDescription: edit.description, steps: ownSkillSteps(edit.body), stepsHeading: t('write_steps_heading') })
      : `# ${edit?.name.trim()}\n\n${edit?.description.trim()}\n\n${edit ? ownItemText(edit.body, edit.description) : ''}\n`
  }

  const translate = useRoutineTranslate()
  const scheduling = !!routine && routineOffered

  /** Saves over the item being edited: the same row, so its id and every routine that names it stay. */
  async function saveEdit(target: EditTarget) {
    setState('saving')
    setProblem(null)
    try {
      const response = await fetch(`/api/skills/${target.installationId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'edit', name: name.trim(), description: description.trim(), body: body() }),
      })
      if (!response.ok) {
        const code = ((await response.json().catch(() => null)) as { error?: { code?: string } } | null)?.error?.code
        setProblem(t(code === 'VALIDATION_ERROR' ? 'write_invalid' : code === 'CONFLICT' ? 'edit_conflict' : 'write_failed'))
        setState('idle')
        return
      }
      await target.onSaved()
    } catch {
      setProblem(t('write_failed'))
      setState('idle')
    }
  }

  async function save() {
    if (edit) return saveEdit(edit)
    // Opening Claude needs a click, and the browser honours one for a few seconds: the routine
    // is sent from this same click when saving is quick. Either way the new page opens its
    // routine panel, which says what to do in Claude and can send it again.
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
      // Saved: the kept draft goes, so the next Skriv själv starts empty.
      writeDraft(companyId, null)
      // The chosen knowledge goes with the new flow, as it would when added on its page. Every
      // answer is checked: a flow that did not get all of it opens on its knowledge, saying so.
      let knowledgeSaved = true
      if (kind === 'workflow') {
        const changes = [...knowledge.map((id) => ['add', id] as const), ...removedDefaults.map((id) => ['remove', id] as const)]
        for (const [action, atomId] of changes) {
          const ok = await fetch('/api/agents/knowledge', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, agent_id: `own/${data.id}`, atom_id: atomId }) })
            .then((r) => r.ok, () => false)
          if (!ok) knowledgeSaved = false
        }
      }
      const land = (url: string) => (knowledgeSaved ? url : withKnowledgeFailed(url))
      // Drop the cached catalog rather than revalidate it: nothing on this page reads it, so a
      // revalidation would not run, and the new item's page would open on the old list.
      await mutate((key) => Array.isArray(key) && typeof key[0] === 'string' && (key[0] === '/api/skills' || key[0] === '/api/agents'), undefined, { revalidate: false })
      const page = kind === 'workflow' ? `${backHref}/own-${data.id}` : `${backHref}/egen.${data.id}`
      if (routine && routineOffered) {
        const stillClicked = (navigator.userActivation?.isActive ?? true) && performance.now() - clickedAt < 4000
        let sent: RoutineSent | null = null
        if (stillClicked) {
          const agent = `own/${data.id}`
          const run = kind === 'workflow'
            ? t('prompt', { say: t('own_say', { name: name.trim() }), agent, client: 'claude' })
            : t('skill_prompt', { name: name.trim(), slug: agent, client: 'claude' })
          trackInstructions('instructions_routine_opened', { item: 'own', kind, cadence: routine.cadence, target: routineTarget })
          const request = routinePrompt({ choice: routine, run, readOnly: kind === 'analysis', company: { id: companyId, name: companyName } }, translate)
          sent = await sendRoutine(routineTarget, request)
        }
        // Sent or not, the new page opens with the routine filled in: a Desktop that never opened loses nothing.
        router.push(land(`${page}?${routineQuery(routine, sent)}`))
        return
      }
      router.push(land(page))
    } catch {
      setProblem(t('write_failed'))
      setState('idle')
    }
  }

  const back = `${catalogHref(backHref, kind)}${kind === 'workflow' ? '?' : '&'}vy=egna`
  // One Save: on the stage beside the item, or, where the stage stacks above the form, pinned at the bottom.
  const actions = (
    <>
      <Button size="lg" className="gap-2" disabled={!ready || !canWrite} loading={state === 'saving'} onClick={() => void save()}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        {scheduling && <img src={AI_CLIENTS.find((c) => c.id === 'claude')!.logo} alt="" width={16} height={16} className={styles.btnLogo} />}
        {edit ? t('edit_save') : scheduling ? t('write_save_schedule') : t('write_save')}
      </Button>
      {problem && <span className={styles.stageStatus} role="alert">{problem}</span>}
    </>
  )
  return (
    <div className={styles.apage}>
      <PageHeader title={t('title')} />
      {edit
        ? <button type="button" className={styles.back} onClick={edit.onCancel}><ArrowLeft className="h-4 w-4" aria-hidden />{t('edit_back')}</button>
        : <Link href={back} className={styles.back}><ArrowLeft className="h-4 w-4" aria-hidden />{t('back_to_agents')}</Link>}
      {!canWrite && <p className={styles.viewerNote}>{t('viewer_note')}</p>}
      <div className={styles.agrid2}>
        <section className={styles.stage} aria-label={edit ? t('edit') : t('create_manual')}>
          {/* One grain for the page: switching kind changes the colour, not the pattern. An edited item keeps its own grain. */}
          <StrataField seed={seedOf(edit ? `own/${edit.installationId}` : 'ny')} ground={`hsl(${hue} 52% 88%)`} bar={`hsl(${hue} 40% 42%)`} strength={2.2} />
          <div className={styles.stageTile}>
            <span key={kind} className={`${styles.tileSymbol} ${styles.fadeIn}`}><ItemSymbol kind={kind} hue={hue} size={104} open /></span>
            <b className={name.trim() ? undefined : styles.placeholderName} data-ph-mask="">{name.trim() || t('create_untitled')}</b>
            <small>{t(`kind_one_${kind}`)} · {t('source_own_item')}</small>
          </div>
          {!stacked && <div className={styles.stageFoot}>{actions}</div>}
        </section>

        <section className={styles.apanel}>
          <div key={view} className={styles.viewIn}>
            {view === 'main' && (
              // A read-only member sees the form but cannot type into it: the note above says why.
              <fieldset className={styles.formSet} disabled={!canWrite}>
                {/* A fixed box: the folder is shorter than the other symbols, and the switch below must not move. */}
                <div className={`${styles.apAvatar} ${styles.apAvatarFixed}`}><span key={kind} className={styles.fadeIn}><ItemSymbol kind={kind} hue={hue} size={60} /></span></div>
                {/* What an item is stays what it was saved as. */}
                {!edit && (
                  <SegmentedControl<ItemKind>
                    aria-label={t('kinds_label')}
                    className={styles.kindSwitch}
                    value={kind}
                    onChange={setKind}
                    options={KINDS.map((k) => ({ value: k, label: t(`kind_one_${k}`) }))}
                  />
                )}
                <Field label={t('field_name')}>
                  {({ id }) => <input id={id} className={`${styles.fieldBox} ${styles.fieldInput}`} value={name} maxLength={120} onChange={(e) => setName(e.target.value)} placeholder={t(`write_name_${kind}`)} aria-required />}
                </Field>
                <Field label={t('write_description')}>
                  {({ id }) => <input id={id} className={`${styles.fieldBox} ${styles.fieldInput}`} value={description} maxLength={500} onChange={(e) => setDescription(e.target.value)} placeholder={t(`write_description_${kind}`)} aria-required />}
                </Field>
                <div key={kind} className={`${styles.kindFields} ${styles.fadeIn}`}>
                {kind === 'workflow' ? (
                  <Field label={t('section_instructions')} note={t('write_steps_hint')}>
                    {({ id, labelId, describedBy }) => (
                      <div className={styles.instrEdit} role="group" aria-labelledby={labelId} aria-describedby={describedBy}>
                        <ol>
                          {steps.map((step, i) => (
                            <li key={i}>
                              <input
                                id={i === 0 ? id : undefined}
                                value={step}
                                onChange={(e) => setStep(i, e.target.value)}
                                onPaste={(e) => pasteSteps(i, e)}
                                ref={(el) => { stepRefs.current[i] = el }}
                                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); setSteps((c) => [...c.slice(0, i + 1), '', ...c.slice(i + 1)]); focusStep.current = i + 1 } }}
                                placeholder={i === 0 ? t('create_step_first') : t('create_step_next')}
                                aria-label={t('create_step_label', { n: i + 1 })}
                              />
                              {/* The cursor goes to the step before, not back to the top of the page. */}
                              {steps.length > 1 && <button type="button" className={styles.chipX} aria-label={t('create_step_remove', { n: i + 1 })} onClick={() => { setSteps((c) => c.filter((_, j) => j !== i)); focusStep.current = Math.max(0, i - 1) }}><X className="h-3 w-3" aria-hidden /></button>}
                            </li>
                          ))}
                        </ol>
                        <button type="button" className={styles.addStep} onClick={() => { setSteps((c) => [...c, '']); focusStep.current = steps.length }}><Plus className="h-3.5 w-3.5" aria-hidden />{t('create_step_add')}</button>
                      </div>
                    )}
                  </Field>
                ) : (
                  <Field label={t('field_contents')} note={t('write_text_hint')}>
                    {({ id, describedBy }) => <textarea id={id} className={styles.textEdit} value={text} rows={10} onChange={(e) => setText(e.target.value)} placeholder={t(`write_text_${kind}`)} aria-describedby={describedBy} aria-required />}
                  </Field>
                )}
                {/* A saved flow's knowledge changes on its own page, at once, so editing leaves it out. */}
                {kind === 'workflow' && !edit && (
                  <div className={styles.rows}>
                    <Row label={t('section_knowledge')} onAdd={canWrite ? () => setView('knowledge') : undefined} addLabel={t('knowledge_add')}>
                      {/* Not links: leaving to read a pack would drop the form. The chip's tooltip says what it is. */}
                      {held.length === 0 ? <span className={styles.muted}>{t('create_knowledge_none')}</span> : held.map((k) => (
                        <KnowledgeChip key={k.id} knowledge={k} canEdit={canWrite} onRemove={() => changeKnowledge('remove', k.id)} />
                      ))}
                    </Row>
                  </div>
                )}
                {routineOffered && <RoutineRow value={routine} onChange={setRoutine} target={routineTarget} onTarget={setChosenTarget} />}
                {routineElsewhere && <RoutineRowElsewhere />}
                </div>
              </fieldset>
            )}
            {view === 'knowledge' && (
              <KnowledgePanel held={held} options={options.data ?? []} onBack={() => setView('main')} onChange={changeKnowledge} />
            )}
          </div>
        </section>
      </div>
      {stacked && <div className={styles.saveBar}>{actions}</div>}
    </div>
  )
}
