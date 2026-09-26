'use client'

import { useEffect, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { useLocale, useTranslations } from 'next-intl'
import useSWR from 'swr'
import { ArrowLeft, ArrowUpRight, Check, ChevronLeft, ChevronRight, Plus, Repeat, Search, X } from 'lucide-react'
import { useCompany } from '@/contexts/CompanyContext'
import { useCanWrite } from '@/lib/hooks/use-can-write'
import { useBranding } from '@/lib/branding/brand-context'
import { AGENTS, COMMUNITY_OPEN, OWN_AGENT_KNOWLEDGE, isAgentId } from '@/lib/agent-skills/agents'
import type { AgentConnectionState, AgentsOverview, KnowledgeMeta } from '@/lib/agent-skills/agent-bundle'
import type { KnowledgeAction, KnowledgeOption } from '@/lib/agent-skills/knowledge-choices'
import { registrySkillSlug, skillsToDoNow, type RegistrySkillId } from '@/lib/agent-skills/registry'
import { ownSkillSteps } from '@/lib/agent-skills/own-skill-body'
import { AI_CLIENTS, aiConnectAction, openAiConnector, pickConnectedAiClient, type AiClient } from '@/lib/onboarding/ai-clients'
import { formatDateLong } from '@/lib/utils'
import { PageHeader } from '@/components/ui/page-header'
import { Button } from '@/components/ui/button'
import { DestructiveConfirmDialog } from '@/components/ui/destructive-confirm-dialog'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { AgentCard } from './AgentCard'
import { FlowSymbol } from './FlowSymbol'
import { CopyIcon } from './CopyIcon'
import { itemHue, seedOf, type ItemKind } from './hues'
import { StrataField } from './StrataField'
import { ConnectionMark } from './ConnectionMark'
import { SegmentedControl } from '@/components/ui/segmented-control'
import { useKnowledgeDesc, useKnowledgeName } from './knowledge-labels'
import { handoffRoute, pinCompany, startInAi, type ClaudeTarget, type StartOutcome } from './run'
import { ClaudeStart } from './ClaudeStart'
import { useClaudeTarget } from './claude-target'
import { StartNote } from './StartNote'
import { trackInstructions } from './track'
import { RoutinePanel } from './RoutinePanel'
import { parseRoutineQuery } from '@/lib/agent-skills/routine'
import { agentIdFromSegment, agentStatus, fetchConnections, readAgents, readCatalog, readOptions, readUsage, readWorklist, knowledgeHref, simulatedClient, type SkillSummary } from './data'
import styles from './skills.module.css'


type View = 'main' | 'knowledge' | 'company' | 'advanced' | 'routine'
type Own = SkillSummary & { installations: [{ installation_id: string }] }

async function readBody(url: string): Promise<string> {
  const response = await fetch(url)
  if (!response.ok) throw new Error('Skill body request failed')
  return ((await response.json()).data as { body: string }).body
}

/**
 * One agent's page, as in Oasis: its orb on a stage with the run button to
 * the left, and to the right what it is made of: instructions, connections,
 * knowledge and what it knows about the company. Adding knowledge or a
 * connection turns the right panel into a searchable grid instead of a menu.
 */
export function AgentDetail({ segment, backHref = '/skills' }: { segment: string; backHref?: string }) {
  const { company } = useCompany()
  return company ? <Detail key={`${company.id}:${segment}`} companyId={company.id} companyName={company.name} agentId={agentIdFromSegment(segment)} backHref={backHref} /> : null
}

function Detail({ companyId, companyName, agentId, backHref }: { companyId: string; companyName: string; agentId: string; backHref: string }) {
  const t = useTranslations('skills_registry')
  const locale = useLocale()
  const router = useRouter()
  const { canWrite } = useCanWrite()
  const { appName } = useBranding()
  const curated = isAgentId(agentId) ? agentId as RegistrySkillId : null

  // ── the AI connection, read once and whenever the user comes back ──
  const [connected, setConnected] = useState<AiClient[] | null>(null)
  useEffect(() => {
    const simulated = simulatedClient()
    const controller = new AbortController()
    const check = () => { if (document.visibilityState !== 'hidden') void (simulated ? Promise.resolve([simulated]) : fetchConnections(controller.signal)).then((list) => { if (list) setConnected(list) }) }
    check()
    window.addEventListener('focus', check)
    return () => { controller.abort(); window.removeEventListener('focus', check) }
  }, [])
  const client = pickConnectedAiClient(connected ?? []) ?? 'claude'
  const clientName = AI_CLIENTS.find((c) => c.id === client)!.name
  const [claudeTarget] = useClaudeTarget()
  const target: ClaudeTarget = client === 'claude' ? claudeTarget : 'web'

  const catalog = useSWR(['/api/skills', companyId], ([url]) => readCatalog(url))
  const agents = useSWR(['/api/agents', companyId, client], ([url, , c]) => readAgents(`${url}?client=${c}`))
  const options = useSWR(['/api/agents/knowledge', companyId], ([url]) => readOptions(url))
  const worklist = useSWR(['/api/worklist/counts', companyId], ([url]) => readWorklist(url))
  const usage = useSWR(['/api/skills/usage', companyId], ([url]) => readUsage(url))
  const own = curated ? null : (catalog.data ?? []).find((s): s is Own => s.slug === agentId && !!s.installations[0]) ?? null
  const overview = curated ? agents.data?.agents.find((a) => a.id === curated) : undefined
  const bodySlug = curated ? registrySkillSlug(curated, client) : agentId
  const body = useSWR(curated || own ? ['/api/skills', companyId, bodySlug] : null, ([url, , s]) => readBody(`${url}?slug=${encodeURIComponent(s)}`))
  // A routine chosen in Skriv själv arrives as ?rutin=… and opens its panel filled in.
  const handedRoutine = parseRoutineQuery(new URLSearchParams(useSearchParams().toString()))
  const [view, setView] = useState<View>(handedRoutine ? 'routine' : 'main')
  const [outcome, setOutcome] = useState<StartOutcome | null>(null)

  // Gone only once a fresh catalog says so: a cached list can predate the item.
  if (!curated && catalog.data && !catalog.isValidating && !own) {
    return (
      <div className={styles.apage}>
        <PageHeader title={t('title')} />
        <Link href={backHref} className={styles.back}><ArrowLeft className="h-4 w-4" aria-hidden />{t('back_to_agents')}</Link>
        <p className={styles.muted}>{t('not_found')}</p>
      </div>
    )
  }

  const name = curated ? t(`skills.${curated}.name`) : own?.name ?? ''
  const task = t('kind_one_workflow')
  // An own flow takes its colour from its name, as it did while it was being written.
  const hue = itemHue('workflow', curated ? agentId : name, curated)
  const steps = curated ? (t.raw(`skills.${curated}.steps`) as string[]) : body.data ? ownSkillSteps(body.data) : []
  const knowledge: KnowledgeMeta[] = curated ? overview?.knowledge ?? [] : agents.data ? agents.data.own_knowledge[agentId] ?? agents.data.own_default : []
  const connections: AgentConnectionState[] = overview?.connections ?? []
  const changed = knowledge.some((k) => k.source === 'added') || (overview?.removed.length ?? 0) > 0
  const status = curated ? agentStatus({
    id: curated,
    aiKnown: connected === null ? null : connected.length > 0,
    overview: agents.data,
    waiting: skillsToDoNow(worklist.data ?? {}).get(curated),
    lastAt: usage.data?.[curated]?.last_at,
    t: (key, values) => t(key, values),
    formatDate: (iso) => formatDateLong(iso, locale),
  }) : undefined
  const canEdit = canWrite && !own?.draft

  /**
   * The change shows at once (optimistic), then the server's answer replaces it;
   * a failed save rolls back. No flicker of the old list while the request runs.
   */
  async function changeKnowledge(action: KnowledgeAction, atomId?: string): Promise<boolean> {
    const current = agents.data
    const optimistic = current ? withKnowledgeChange(current, agentId, curated ? AGENTS[curated].knowledge : OWN_AGENT_KNOWLEDGE, options.data ?? [], action, atomId) : undefined
    try {
      await agents.mutate(async () => {
        const response = await fetch('/api/agents/knowledge', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(atomId ? { action, agent_id: agentId, atom_id: atomId } : { action, agent_id: agentId }) })
        if (!response.ok) throw new Error('Knowledge change failed')
        return current
      }, { optimisticData: optimistic, rollbackOnError: true, populateCache: false, revalidate: true })
      return true
    } catch {
      return false
    }
  }
  async function patchOwn(payload: object): Promise<boolean> {
    if (!own) return false
    try {
      const response = await fetch(`/api/skills/${own.installations[0].installation_id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
      if (!response.ok) return false
      await catalog.mutate()
      return true
    } catch {
      return false
    }
  }
  async function deleteOwn(): Promise<boolean> {
    if (!own) return false
    try {
      const response = await fetch(`/api/skills/${own.installations[0].installation_id}`, { method: 'DELETE' })
      if (!response.ok) return false
      await catalog.mutate()
      router.push(backHref)
      return true
    } catch {
      return false
    }
  }

  const say = curated ? t(`skills.${curated}.say`) : t('own_say', { name })
  const disconnected = connected !== null && connected.length === 0
  // Curated flows are fixed text, so on the web they open filled in; an own flow's prompt carries the name the user wrote, so it is copied.
  const prompt = pinCompany(t('prompt', { say, agent: agentId, client }), t('prompt_company_pin', { company: companyName, companyId }))
  function run(start: ClaudeTarget = 'web'): Promise<StartOutcome> | undefined {
    if (disconnected) {
      trackInstructions('instructions_connect_clicked', { client: 'claude', surface: 'flow' })
      openAiConnector(aiConnectAction('claude', { origin: window.location.origin, appName }).open)
      return undefined
    }
    trackInstructions('instructions_start_clicked', { item: curated ?? 'own', kind: 'workflow', client, surface: 'flow', target: client === 'claude' ? start : 'web' })
    setOutcome(null)
    const starting = startInAi(client, start, prompt, !!curated)
    void starting.then(setOutcome)
    return starting
  }

  return (
    <div className={styles.apage}>
      <PageHeader title={t('title')} />
      <Link href={backHref} className={styles.back}><ArrowLeft className="h-4 w-4" aria-hidden />{t('back_to_agents')}</Link>
      <div className={styles.agrid2}>
        <section className={styles.stage} aria-label={name}>
          <StrataField seed={seedOf(agentId)} ground={`hsl(${hue} 52% 88%)`} bar={`hsl(${hue} 40% 42%)`} strength={2.2} />
          <div className={styles.stageTile}>
            <FlowSymbol hue={hue} size={96} />
            <b data-ph-mask={own ? '' : undefined}>{name}</b>
            {task && <small>{task}</small>}
          </div>
          <div className={styles.stageFoot}>
            {/* A draft saved by an AI is not loadable until it is added, so it cannot be started yet. */}
            {own?.draft ? <span className={styles.stageStatus}>{t('draft_run_hint')}</span> : !disconnected && client === 'claude' ? <ClaudeStart onStart={run} /> : (
              <Button size="lg" className="gap-2 pl-4" onClick={() => void run()}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={AI_CLIENTS.find((c) => c.id === (disconnected ? 'claude' : client))!.logo} alt="" width={16} height={16} className={styles.btnLogo} />
                {disconnected ? t('connect_client', { client: 'Claude' }) : t('run_agent', { client: clientName })}
                <ArrowUpRight className="h-4 w-4" aria-hidden />
              </Button>
            )}
            {/* A routine is scheduled in Claude Desktop, so only for Claude, and never for a draft. */}
            {!own?.draft && !disconnected && client === 'claude' && (
              <Button size="lg" variant="outline" className="gap-2" onClick={() => setView('routine')}><Repeat className="h-4 w-4" aria-hidden />{t('routine_open')}</Button>
            )}
            {/* only a status worth reading: work waiting, a missing connection, no AI yet */}
            {status && status.presence !== 'ready' && <span className={styles.stageStatus}><span className={styles.chipDot} data-presence={status.presence} aria-hidden />{status.text}</span>}
            {!own?.draft && !disconnected && (
              <StartNote route={handoffRoute(client, target, !!curated)} outcome={outcome} client={client} target={target} prompt={prompt.pinned} onWeb={() => void run('web')} />
            )}
          </div>
        </section>

        <section className={styles.apanel}>
          <div key={view} className={styles.viewIn}>
          {view === 'main' && (
            <>
              <div className={styles.apAvatar}><FlowSymbol hue={hue} size={56} /></div>

              <Field label={t('field_name')}>
                <div className={styles.fieldBox} data-ph-mask={own ? '' : undefined}>{name}</div>
              </Field>

              <Field label={t('section_instructions')} copy={<CopyIcon text={body.data} label={t('copy_instructions')} />} note={own ? t('instructions_own') : [t('instructions_source'), overview?.workflow.version ? t('instructions_version', { version: overview.workflow.version }) : null].filter(Boolean).join(' · ')}>
                <div className={styles.instrBox}><ol data-ph-mask={own ? '' : undefined}>{steps.map((step, i) => <li key={i}>{step}</li>)}</ol></div>
              </Field>

              {own?.draft && (
                <div><Button disabled={!canWrite} onClick={() => { trackInstructions('instructions_draft_added', { kind: 'workflow' }); void patchOwn({ action: 'add' }) }}><Plus className="h-4 w-4" aria-hidden />{t('add_draft_workflow')}</Button></div>
              )}

              <div className={styles.rows}>
                {curated && (
                  <Row label={t('section_connections')}>
                    {connections.length === 0 ? <span className={styles.muted}>{t('connections_none')}</span> : <Capped items={connections.map((c) => <ConnectionChip key={c.kind} connection={c} />)} />}
                  </Row>
                )}
                <Row label={t('section_knowledge')} onAdd={canEdit ? () => setView('knowledge') : undefined} addLabel={t('knowledge_add')}>
                  {knowledge.length === 0 ? <span className={styles.muted}>{t(own ? 'knowledge_own' : 'knowledge_none')}</span> : <Capped items={knowledge.map((k) => (
                    <KnowledgeChip key={k.id} knowledge={k} href={knowledgeHref(backHref, k.id)} canEdit={canEdit} onRemove={() => changeKnowledge('remove', k.id)} />
                  ))} />}
                </Row>
                {/* The company's own industry sections for this flow's area, sent in full when the flow starts. */}
                {(overview?.industry_sections.length ?? 0) > 0 && (
                  <Row label={t('section_industry')}>
                    <Capped items={overview!.industry_sections.map((s) => <span key={s.id} className={`${styles.chip} ${styles.chipCompany}`} title={s.title}>{s.title}</span>)} />
                  </Row>
                )}
                <Row label={t('section_company')} onOpen={() => setView('company')}>
                  <span className={styles.muted}>{[
                    overview && overview.facts_known > 0 ? t('company_facts_known', { known: overview.facts_known, total: AGENTS[curated!].facts.length }) : null,
                    (agents.data?.documents ?? 0) > 0 ? t('company_documents', { count: agents.data!.documents }) : null,
                  ].filter(Boolean).join(' · ') || t('company_none')}</span>
                </Row>
                <Row label={t('section_advanced')} onOpen={() => setView('advanced')} />
              </div>
            </>
          )}
          {view === 'company' && (
            <SubView title={t('section_company')} onBack={() => setView('main')}>
              <div className={styles.chips}>
                {(agents.data?.agents[0]?.company ?? []).map((c) => <span key={c.id} className={`${styles.chip} ${styles.chipCompany}`}>{c.title}</span>)}
                {overview && overview.facts_known > 0 && <span className={`${styles.chip} ${styles.chipCompany}`}>{t('company_facts_known', { known: overview.facts_known, total: AGENTS[curated!].facts.length })}</span>}
                {(agents.data?.remembered ?? 0) > 0 && <span className={`${styles.chip} ${styles.chipCompany}`}>{t('company_remembered', { count: agents.data!.remembered })}</span>}
                {(agents.data?.documents ?? 0) > 0 && <span className={`${styles.chip} ${styles.chipCompany}`}>{t('company_documents', { count: agents.data!.documents })}</span>}
              </div>
              <p className={styles.muted}>{t('company_given')}</p>
            </SubView>
          )}
          {view === 'routine' && (
            <RoutinePanel run={t('prompt', { say, agent: agentId, client: 'claude' })} item={curated ?? 'own'} kind="workflow" initial={handedRoutine} onBack={() => setView('main')} />
          )}
          {view === 'advanced' && (
            <SubView title={t('section_advanced')} onBack={() => setView('main')}>
              <div className={styles.alist}>
              <CopyInstruction body={body.data} />
              {canEdit && changed && (
                <ActionRow title={t('adv_reset_title')} desc={t('adv_reset_desc')}>
                  <Button variant="outline" size="sm" onClick={() => void changeKnowledge('reset')}>{t('adv_reset')}</Button>
                </ActionRow>
              )}
              {COMMUNITY_OPEN && own && !own.draft && <ShareBox preview={{ title: name, desc: own.summary ?? '', kind: 'workflow', hue, symbolKey: agentId }} status={own.shareStatus ?? 'private'} publishedUrl={own.publishedUrl} reviewNote={own.reviewNote} canWrite={canWrite} onShare={(share) => patchOwn(share === 'withdraw' ? { action: 'withdraw' } : { action: 'submit', confirmed_no_customer_data: true, author_handle: share.author_handle })} />}
              </div>
              {own && (own.shareStatus ?? 'private') === 'private' && <div className={styles.alist}><DeleteOwn canWrite={canWrite} onDelete={deleteOwn} /></div>}
            </SubView>
          )}
          {view === 'knowledge' && (
            <KnowledgePanel held={knowledge} options={options.data ?? []} onBack={() => setView('main')} onChange={changeKnowledge} />
          )}
          </div>
        </section>
      </div>
    </div>
  )
}

/** One settings row as in Oasis: label left, one line of content, one square button in a fixed column. */
export function Row({ label, children, onAdd, addLabel, onOpen }: { label: string; children?: ReactNode; onAdd?: () => void; addLabel?: string; onOpen?: () => void }) {
  const inner = (
    <>
      <span className={styles.rowLabel}>{label}</span>
      <div className={styles.rowContent}>{children}</div>
      <span className={styles.rowAction}>
        {onAdd && <Button variant="outline" size="icon" aria-label={addLabel} onClick={onAdd}><Plus className="h-4 w-4" aria-hidden /></Button>}
        {onOpen && <ChevronRight className="h-4 w-4 text-muted-foreground" aria-hidden />}
      </span>
    </>
  )
  return onOpen
    ? <button type="button" className={`${styles.srow} ${styles.srowLink}`} onClick={onOpen}>{inner}</button>
    : <div className={styles.srow}>{inner}</div>
}

/** A labelled field, label above its box. */
export function Field({ label, note, copy, children }: { label: string; note?: string; copy?: ReactNode; children: ReactNode }) {
  return (
    <div className={styles.field}>
      <div className={styles.fieldHead}><span className={styles.rowLabel}>{label}</span><span className={styles.fieldTools}>{note && <span className={styles.partNote}>{note}</span>}{copy}</span></div>
      {children}
    </div>
  )
}

/** A panel sub-view: back to the agent, a title, its content. */
export function SubView({ title, onBack, children }: { title: string; onBack: () => void; children: ReactNode }) {
  const t = useTranslations('skills_registry')
  return (
    <div className="flex flex-col gap-4">
      <button type="button" className={styles.back} onClick={onBack}><ChevronLeft className="h-4 w-4" aria-hidden />{t('knowledge_picker_done')}</button>
      <h2 className={styles.subTitle}>{title}</h2>
      {children}
    </div>
  )
}

/** At most two chips on the line and a count for the rest, so a row never wraps. */
function Capped({ items }: { items: ReactNode[] }) {
  return <>{items.slice(0, 2)}{items.length > 2 && <span className={styles.chip}>+{items.length - 2}</span>}</>
}

/** One advanced setting: what it is on the left, a single action on the right, the same edges on every row. */
function ActionRow({ title, desc, alert, children, below }: { title: string; desc: string; alert?: string; children?: ReactNode; below?: ReactNode }) {
  return (
    <div className={styles.arow}>
      <div className={styles.arowMain}>
        <div className={styles.arowText}>
          <span className={styles.arowTitle}>{title}</span>
          <span className={styles.arowDesc}>{desc}</span>
          {alert && <span role="alert" className={styles.arowAlert}>{alert}</span>}
        </div>
        {children && <div className={styles.arowAction}>{children}</div>}
      </div>
      {below}
    </div>
  )
}

function CopyInstruction({ body }: { body: string | undefined }) {
  const t = useTranslations('skills_registry')
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle')
  return (
    <ActionRow title={t('adv_copy_title')} desc={t('adv_copy_desc')} alert={state === 'failed' ? t('copy_failed') : undefined}>
      <Button variant="outline" size="sm" disabled={!body} onClick={() => {
        const copying = body && navigator.clipboard ? navigator.clipboard.writeText(body) : Promise.reject(new Error('Nothing to copy'))
        void copying.then(() => setState('copied'), () => setState('failed'))
      }}>{t(state === 'copied' ? 'copied_full' : 'copy')}</Button>
    </ActionRow>
  )
}

export function KnowledgeChip({ knowledge, href, canEdit, onRemove }: { knowledge: KnowledgeMeta; href: string; canEdit: boolean; onRemove: () => Promise<boolean> }) {
  const t = useTranslations('skills_registry')
  const name = useKnowledgeName()
  const describe = useKnowledgeDesc()
  const [busy, setBusy] = useState(false)
  const label = name(knowledge.id, knowledge.title)
  return (
    <span className={`${styles.chip} ${styles.chipKnow} ${knowledge.source === 'added' ? styles.chipAdded : ''}`} title={describe(knowledge.id, knowledge.summary)}>
      <Link href={href} className={styles.chipLink}>{label}</Link>
      {knowledge.source === 'added' && <small>{t('knowledge_added_tag')}</small>}
      {canEdit && (
        <button type="button" className={styles.chipX} aria-label={t('knowledge_remove', { name: label })} disabled={busy} onClick={() => { setBusy(true); void onRemove().finally(() => setBusy(false)) }}>
          <X className="h-3 w-3" aria-hidden />
        </button>
      )}
    </span>
  )
}

function ConnectionChip({ connection }: { connection: AgentConnectionState }) {
  const t = useTranslations('skills_registry')
  const inner = <><span className={styles.appchip}><ConnectionMark kind={connection.kind} /></span>{t(`conn_${connection.kind}`)}<small>{t(`conn_${connection.status}`)}</small></>
  return connection.status === 'missing' && connection.settings_href
    ? <Link href={connection.settings_href} className={styles.chip} data-status={connection.status}>{inner}</Link>
    : <span className={styles.chip} data-status={connection.status}>{inner}</span>
}

const GROUPS = ['horizontal', 'vertical', 'modifier'] as const

/** Kunskap, as in Oasis's skill picker: Accounted or community, a search, and cards to add or take away. */
export function KnowledgePanel({ held, options, onBack, onChange }: {
  held: KnowledgeMeta[]
  options: KnowledgeOption[]
  onBack: () => void
  onChange: (action: KnowledgeAction, atomId?: string) => Promise<boolean>
}) {
  const t = useTranslations('skills_registry')
  const name = useKnowledgeName()
  const describe = useKnowledgeDesc()
  const [source, setSource] = useState<'accounted' | 'own' | 'community'>('accounted')
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  const holds = new Set(held.map((k) => k.id))
  const q = query.trim().toLowerCase()
  const shown = options
    .filter((o) => source === 'community' ? o.tier === 'community' : source === 'own' ? o.tier === 'own' : o.tier !== 'community' && o.tier !== 'own')
    .filter((o) => !q || `${name(o.id, o.title)} ${describe(o.id, o.summary)}`.toLowerCase().includes(q))
    .sort((a, b) => GROUPS.indexOf(a.tier as typeof GROUPS[number]) - GROUPS.indexOf(b.tier as typeof GROUPS[number]))
  async function toggle(id: string) {
    setBusy(id)
    setFailed(!(await onChange(holds.has(id) ? 'remove' : 'add', id)))
    setBusy(null)
  }
  return (
    <div className="flex flex-col gap-4">
      <button type="button" className={styles.back} onClick={onBack}><ChevronLeft className="h-4 w-4" aria-hidden />{t('knowledge_picker_done')}</button>
      <SegmentedControl aria-label={t('sources_label')} className={styles.sourceSwitch} value={source} onChange={setSource} options={[
        { value: 'accounted' as const, label: t('tab_accounted') },
        { value: 'own' as const, label: t('tab_own') },
        ...(COMMUNITY_OPEN ? [{ value: 'community' as const, label: t('tab_community') }] : []),
      ]} />
      <label className={styles.search}>
        <Search className="h-4 w-4 text-muted-foreground" aria-hidden />
        <input id="agent-knowledge-search" type="search" value={query} placeholder={t('knowledge_search')} onChange={(e) => setQuery(e.target.value)} />
      </label>
      {failed && <p role="alert" className={styles.muted}>{t('knowledge_save_failed')}</p>}
      {shown.length === 0 ? <p className={styles.muted}>{t(q ? 'knowledge_no_match' : source === 'community' ? 'knowledge_community_empty' : source === 'own' ? 'knowledge_own_empty' : 'knowledge_all_added')}</p> : (
        <div className={styles.kgrid2}>
          {shown.map((o) => {
            const has = holds.has(o.id)
            return (
              <div key={o.id} className={styles.kcard} data-held={has ? '' : undefined}>
                <div className={styles.kcardTop}>
                  <b>{name(o.id, o.title)}</b>
                  <Button variant={has ? 'default' : 'outline'} size="icon-sm" loading={busy === o.id} disabled={busy !== null && busy !== o.id} aria-label={has ? t('knowledge_remove', { name: name(o.id, o.title) }) : t('knowledge_add')} onClick={() => void toggle(o.id)}>
                    {has ? <Check className="h-4 w-4" aria-hidden /> : <Plus className="h-4 w-4" aria-hidden />}
                  </Button>
                </div>
                <p>{describe(o.id, o.summary)}</p>
                <small>{o.tier === 'community' ? t('knowledge_by_community') : o.tier === 'own' ? t('knowledge_by_own') : `${t(`knowledge_group_${o.tier}`)} · ${t('knowledge_by')}`}</small>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

const HANDLE = /^[a-z0-9][a-z0-9-]{0,38}$/

/** Share an own agent with the community: it waits for Accounted's review before anyone else sees it. */
/** Share an own item: Accounted reviews it, and a published one is open to everyone under MIT on accounted.se. */
export function ShareBox({ status, canWrite, onShare, publishedUrl, reviewNote, preview }: {
  status: NonNullable<SkillSummary['shareStatus']>
  canWrite: boolean
  onShare: (share: { author_handle: string } | 'withdraw') => Promise<boolean>
  publishedUrl?: string | null
  reviewNote?: string | null
  /** The item as its card will look to others, so the name being chosen is seen where it will stand. */
  preview: { title: string; desc: string; kind: ItemKind; hue: number; symbolKey: string }
}) {
  const t = useTranslations('skills_registry')
  const [open, setOpen] = useState(false)
  const [handle, setHandle] = useState('')
  const [confirmed, setConfirmed] = useState(false)
  const [state, setState] = useState<'idle' | 'sending' | 'failed'>('idle')
  async function send(share: { author_handle: string } | 'withdraw') {
    setState('sending')
    const ok = await onShare(share)
    setState(ok ? 'idle' : 'failed')
    if (ok) setOpen(false)
  }
  const failed = state === 'failed' ? t('share_failed') : undefined
  const handleOk = HANDLE.test(handle)
  if (status === 'submitted' || status === 'published') {
    return (
      <ActionRow title={t('adv_share_title')} desc={t(`share_status_${status}`)} alert={failed} below={status === 'published' && publishedUrl ? <a className={styles.catLink} href={publishedUrl} target="_blank" rel="noreferrer">{t('share_published_link')}</a> : undefined}>
        <Button variant="outline" size="sm" disabled={!canWrite} loading={state === 'sending'} onClick={() => void send('withdraw')}>{t('share_withdraw')}</Button>
      </ActionRow>
    )
  }
  if (status === 'withdrawn') return <ActionRow title={t('adv_share_title')} desc={t('share_status_withdrawn')} />
  return (
    <ActionRow title={t('adv_share_title')} desc={reviewNote ? t('share_returned', { note: reviewNote }) : t('adv_share_desc')}>
      <Button variant="outline" size="sm" disabled={!canWrite} onClick={() => { setState('idle'); setOpen(true) }}>{t('adv_share')}</Button>
      <Dialog open={open} onOpenChange={(next) => state !== 'sending' && setOpen(next)}>
        <DialogContent className="sm:max-w-[480px]">
          <DialogHeader>
            <DialogTitle className="font-display text-lg tracking-tight">{t('share_title')}</DialogTitle>
            <DialogDescription className="text-[13px] leading-relaxed">{t('share_body')}</DialogDescription>
          </DialogHeader>
          <form id="share-form" className={styles.shareForm} onSubmit={(e) => { e.preventDefault(); if (handleOk && confirmed) void send({ author_handle: handle }) }}>
            <div className={styles.sharePreview} aria-hidden>
              <AgentCard title={preview.title} desc={preview.desc} kind={preview.kind} hue={preview.hue} symbolKey={preview.symbolKey} masked
                foot={<span className={styles.shareBy}>{t('share_by', { handle: handle || t('share_handle_placeholder') })}</span>} />
            </div>
            <label className={styles.shareField} htmlFor="share-handle">
              {t('share_handle')}
              <span className={styles.shareInput} data-invalid={handle && !handleOk ? '' : undefined}>
                <span aria-hidden>@</span>
                <input id="share-handle" type="text" value={handle} placeholder={t('share_handle_placeholder')} autoComplete="off" spellCheck={false} maxLength={39}
                  onChange={(e) => setHandle(e.target.value.toLowerCase())} aria-invalid={handle !== '' && !handleOk} aria-describedby={handle && !handleOk ? 'share-handle-hint' : undefined} />
              </span>
              {handle && !handleOk && <small id="share-handle-hint" className={styles.shareHint}>{t('share_handle_hint')}</small>}
            </label>
            <label className={styles.shareCheck} htmlFor="share-confirm">
              <input id="share-confirm" type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
              {t('share_confirm')}
            </label>
            <small className={styles.muted}>{t('share_license')}</small>
            {failed && <p role="alert" className={styles.shareHint}>{failed}</p>}
          </form>
          <DialogFooter className="gap-2 sm:gap-2">
            <Button variant="outline" size="sm" onClick={() => setOpen(false)}>{t('cancel')}</Button>
            <Button type="submit" form="share-form" size="sm" disabled={!canWrite || !confirmed || !handleOk} loading={state === 'sending'}>{t('share_submit')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </ActionRow>
  )
}

/** Delete an own item: a flow here, knowledge or an analysis on its item page. */
export function DeleteOwn({ canWrite, onDelete, kind = 'workflow' }: { canWrite: boolean; onDelete: () => Promise<boolean>; kind?: ItemKind }) {
  const t = useTranslations('skills_registry')
  const [confirm, setConfirm] = useState(false)
  const [failed, setFailed] = useState(false)
  return (
    <ActionRow title={t(`delete_title_${kind}`)} desc={t(`delete_desc_${kind}`)} alert={failed ? t('save_failed') : undefined}>
      <Button variant="outline" size="sm" className={styles.dangerBtn} disabled={!canWrite} onClick={() => setConfirm(true)}>{t('delete')}</Button>
      <DestructiveConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title={t('delete')}
        description={t(`delete_confirm_${kind}`)}
        confirmLabel={t('delete')}
        cancelLabel={t('cancel')}
        onConfirm={async () => { setFailed(!(await onDelete())) }}
      />
    </ActionRow>
  )
}

/** The overview as it will be after a knowledge change, for the optimistic update. */
function withKnowledgeChange(
  overview: AgentsOverview,
  agentId: string,
  defaults: readonly string[],
  options: KnowledgeOption[],
  action: KnowledgeAction,
  atomId?: string,
) {
  const apply = (list: KnowledgeMeta[]): KnowledgeMeta[] => {
    if (action === 'reset') {
      return defaults.flatMap((id) => {
        const o = options.find((x) => x.id === id)
        return o ? [{ id, tier: o.tier, source: 'default' as const, title: o.title, summary: o.summary, version: o.version, reviewed_at: o.reviewed_at }] : []
      })
    }
    if (action === 'remove') return list.filter((k) => k.id !== atomId)
    const o = options.find((x) => x.id === atomId)
    if (!o || list.some((k) => k.id === atomId)) return list
    return [...list, { id: o.id, tier: o.tier, source: defaults.includes(o.id) ? 'default' as const : 'added' as const, title: o.title, summary: o.summary, version: o.version, reviewed_at: o.reviewed_at }]
  }
  if (agentId.startsWith('own/')) return { ...overview, own_knowledge: { ...overview.own_knowledge, [agentId]: apply(overview.own_knowledge[agentId] ?? overview.own_default) } }
  return { ...overview, agents: overview.agents.map((a) => a.id === agentId ? { ...a, knowledge: apply(a.knowledge), removed: action === 'reset' ? [] : action === 'remove' && defaults.includes(atomId!) ? [...a.removed, atomId!] : a.removed.filter((r) => r !== atomId) } : a) }
}
