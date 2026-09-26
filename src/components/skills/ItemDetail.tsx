'use client'

import { useEffect, useState } from 'react'
import dynamic from 'next/dynamic'
import Link from 'next/link'
import { useLocale, useTranslations } from 'next-intl'
import useSWR from 'swr'
import { useRouter, useSearchParams } from 'next/navigation'
import { ArrowLeft, ArrowUpRight, Check, ChevronDown, ChevronUp, Plus, Repeat } from 'lucide-react'
import { useCompany } from '@/contexts/CompanyContext'
import { useCanWrite } from '@/lib/hooks/use-can-write'
import { AGENTS, COMMUNITY_OPEN, OWN_AGENT_KNOWLEDGE } from '@/lib/agent-skills/agents'
import { SHOWN_FLOWS } from './catalog-setup'
import type { KnowledgeOption } from '@/lib/agent-skills/knowledge-choices'
import { formatDateLong } from '@/lib/utils'
import { ownSkillSteps } from '@/lib/agent-skills/own-skill-body'
import { AI_CLIENTS, pickConnectedAiClient, type AiClient } from '@/lib/onboarding/ai-clients'
import { copyPromptAndOpen, openInClaude, type ClaudeTarget } from './run'
import { ClaudeStart } from './ClaudeStart'
import { trackInstructions } from './track'
import { RoutinePanel } from './RoutinePanel'
import { parseRoutineQuery } from '@/lib/agent-skills/routine'
import { PageHeader } from '@/components/ui/page-header'
import { Button } from '@/components/ui/button'
import { DeleteOwn, Field, Row, ShareBox, SubView } from './AgentDetail'
import { FlowSymbol } from './FlowSymbol'
import { CopyIcon } from './CopyIcon'
import { ItemSymbol } from './ItemSymbol'
import { StrataField } from './StrataField'
import { catalogHref, itemHue, seedOf, type ItemKind } from './hues'
import { useAnalysisLabel, useKnowledgeDesc, useKnowledgeName } from './knowledge-labels'
import { analysisSegment, communityMeta, communitySegment, fetchConnections, kindOf, readAgents, readCatalog, readOptions, rulesSegment, simulatedClient, type CommunityMeta } from './data'
import styles from './skills.module.css'

// The Markdown parser loads with the first pack that is opened, not with the list.
const Markdown = dynamic(() => import('@/components/agent/MarkdownMessage'))

async function readBody(url: string): Promise<string> {
  const response = await fetch(url)
  if (!response.ok) throw new Error('Item body request failed')
  return ((await response.json()).data as { body: string }).body
}

type Item = {
  kind: ItemKind
  key: string
  name: string
  desc: string
  body: string
  /** A rule pack's registry id: such an item can be given to a flow. */
  atomId: string | null
  version: number | null
  reviewedAt: string | null
  level: string | null
  community: CommunityMeta | null
  /** Written by the company itself. */
  own?: boolean
}

/**
 * The page of a knowledge pack from Accounted, or of anything the community
 * shared. A shared flow looks like any flow: its steps, what it brings along
 * and a start button in the company's AI, plus who shared it and the upvote.
 * Knowledge shows its own text, as the AI reads it, and can be given to flows.
 */
export function ItemDetail({ segment, backHref }: { segment: string; backHref: string }) {
  const { company } = useCompany()
  return company ? <Detail key={`${company.id}:${segment}`} companyId={company.id} segment={segment} backHref={backHref} /> : null
}

function Detail({ companyId, segment, backHref }: { companyId: string; segment: string; backHref: string }) {
  const t = useTranslations('skills_registry')
  const locale = useLocale()
  const { canWrite } = useCanWrite()
  const router = useRouter()
  const knowledgeName = useKnowledgeName()
  const knowledgeDesc = useKnowledgeDesc()
  const analysisLabel = useAnalysisLabel()
  const isRules = segment.startsWith('kunskap.')
  const options = useSWR(['/api/agents/knowledge', companyId], ([url]) => readOptions(url))
  // Always read: a pack's page lists the company's own flows it can be given to.
  const catalog = useSWR(['/api/skills', companyId], ([url]) => readCatalog(url))
  const agents = useSWR(['/api/agents', companyId, 'claude'], ([url, , c]) => readAgents(`${url}?client=${c}`))
  // A routine chosen in Skriv själv arrives as ?rutin=… and opens its panel filled in.
  const handedRoutine = parseRoutineQuery(new URLSearchParams(useSearchParams().toString()))
  const [view, setView] = useState<'main' | 'give' | 'routine'>(handedRoutine ? 'routine' : 'main')
  const [connected, setConnected] = useState<AiClient[] | null>(null)
  const [ran, setRan] = useState(false)
  // A pack's own text is written for the AI (often in English): folded until asked for.
  const [showBody, setShowBody] = useState(false)
  useEffect(() => {
    const simulated = simulatedClient()
    const controller = new AbortController()
    void (simulated ? Promise.resolve([simulated]) : fetchConnections(controller.signal)).then((list) => { if (list) setConnected(list) })
    return () => controller.abort()
  }, [])
  const client = pickConnectedAiClient(connected ?? []) ?? 'claude'
  const ai = AI_CLIENTS.find((c) => c.id === client)!

  const pack: KnowledgeOption | undefined = options.data?.find((o) => rulesSegment(o.id) === segment)
  const shared = catalog.data?.find((s) => s.tier === 'community' && communitySegment(s.slug) === segment)
  const builtIn = segment.startsWith('analys.') ? catalog.data?.find((s) => s.source === 'accounted' && s.itemKind === 'analysis' && analysisSegment(s.slug) === segment) : undefined
  const mine = segment.startsWith('egen.') ? catalog.data?.find((s) => s.tier === 'own' && s.slug === `own/${segment.slice(5)}`) : undefined
  const builtInLabel = builtIn ? analysisLabel(builtIn.slug, { name: builtIn.name, summary: builtIn.summary }) : null
  const item: Item | null = builtIn && builtInLabel ? {
    kind: 'analysis', key: builtIn.slug, name: builtInLabel.name, desc: builtInLabel.summary, body: builtIn.summary,
    atomId: null, version: builtIn.version ?? null, reviewedAt: null, level: null, community: null,
  } : mine ? {
    kind: mine.itemKind ?? 'rules', key: mine.slug, name: mine.name, desc: mine.summary, body: mine.summary,
    // Own knowledge a person added can be given to flows, as a pack can (own/<id>).
    atomId: (mine.itemKind ?? 'rules') === 'rules' && !mine.draft ? mine.slug : null, version: null, reviewedAt: null, level: null, community: null, own: true,
  } : pack ? {
    kind: 'rules', key: pack.id, name: knowledgeName(pack.id, pack.title), desc: knowledgeDesc(pack.id, pack.summary), body: pack.summary,
    atomId: pack.id, version: pack.version, reviewedAt: pack.reviewed_at, level: pack.tier === 'community' ? null : pack.tier, community: null,
  } : shared ? {
    kind: kindOf(shared), key: shared.slug, name: shared.name, desc: shared.summary, body: shared.summary,
    atomId: kindOf(shared) === 'rules' && options.data?.some((o) => o.id === shared.slug) ? shared.slug : null,
    version: shared.version ?? null, reviewedAt: communityMeta(shared)?.reviewed_at ?? shared.reviewedAt ?? null, level: null, community: communityMeta(shared),
  } : null

  // What the AI actually reads: the pack's own text from the registry, fetched when the page opens.
  const bodySlug = pack?.id ?? shared?.slug ?? mine?.slug ?? builtIn?.slug ?? null
  const body = useSWR(bodySlug ? ['/api/skills', companyId, bodySlug] : null, ([url, , slug]) => readBody(`${url}?slug=${encodeURIComponent(slug)}`))
  // Gone only once a fresh list says so: a cached one can predate an item just saved.
  async function patchMine(payload: object): Promise<boolean> {
    const installation = mine?.installations[0]
    if (!installation) return false
    try {
      const response = await fetch(`/api/skills/${installation.installation_id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
      if (!response.ok) return false
      await catalog.mutate()
      return true
    } catch {
      return false
    }
  }
  async function addMine(): Promise<void> {
    const installation = mine?.installations[0]
    if (!installation) return
    trackInstructions('instructions_draft_added', { kind: mine?.itemKind ?? 'rules' })
    const response = await fetch(`/api/skills/${installation.installation_id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'add' }) })
    if (response.ok) await catalog.mutate()
  }
  async function deleteMine(): Promise<boolean> {
    const installation = mine?.installations[0]
    if (!installation) return false
    try {
      const response = await fetch(`/api/skills/${installation.installation_id}`, { method: 'DELETE' })
      if (!response.ok) return false
      await catalog.mutate()
      router.push(`${catalogHref(backHref, item?.kind ?? 'rules')}${item?.kind === 'workflow' ? '?' : '&'}vy=egna`)
      return true
    } catch {
      return false
    }
  }
  const loaded = isRules ? !!options.data : !!catalog.data && !catalog.isValidating
  if (!item) {
    return (
      <div className={styles.apage}>
        <PageHeader title={t('title')} />
        <Link href={backHref} className={styles.back}><ArrowLeft className="h-4 w-4" aria-hidden />{t('back_to_agents')}</Link>
        {loaded && <p className={styles.muted}>{t('not_found')}</p>}
      </div>
    )
  }

  const hue = itemHue(item.kind, item.own ? item.name : item.key)
  // Back to where the item lives: its industry or company form, or the general list.
  const home = item.atomId && (item.atomId.startsWith('vertical/') || item.atomId.startsWith('modifier/')) ? item.atomId : null
  const listHref = catalogHref(backHref, item.kind, home)
  // Own items live under Egna.
  const back = item.own ? `${listHref}${listHref.includes('?') ? '&' : '?'}vy=egna` : listHref
  const isFlow = item.kind === 'workflow' && !!item.community
  // Accounted's knowledge packs lead with what they cover in plain words; the text the AI reads is one click away.
  const isPack = !builtIn && !mine && !!pack && pack.tier !== 'community'
  // Flows and analyses run in the company's AI; knowledge is given to flows instead.
  // An AI-saved draft is not loadable until it is added, so it cannot run yet.
  const runnable = (isFlow || item.kind === 'analysis') && !mine?.draft
  const steps = isFlow && body.data ? ownSkillSteps(body.data) : []
  function runShared(target: ClaudeTarget = 'web') {
    trackInstructions('instructions_start_clicked', { item: item!.own ? 'own' : builtIn ? builtIn.slug : 'community', kind: item!.kind, client, surface: 'item', target: client === 'claude' ? target : 'web' })
    // A shared item's text carries what its author wrote, so the prompt is copied rather than typed into the chat.
    const prompt = t('skill_prompt', { name: item!.name, slug: item!.key, client })
    void (client === 'claude' ? openInClaude(target, prompt, false) : copyPromptAndOpen(prompt, client, false)).then(() => setRan(true))
  }
  // Every flow the company can give knowledge to: Accounted's, then its own.
  const ownFlows = (catalog.data ?? []).filter((s) => s.tier === 'own' && (s.itemKind ?? 'workflow') === 'workflow' && !s.draft && s.shareStatus !== 'withdrawn' && s.installations[0])
  const givable = [
    ...SHOWN_FLOWS.map((id) => ({ id: id as string, name: t(`skills.${id}.name`), task: t(`skills.${id}.short`), hue: itemHue('workflow', id, id), defaults: AGENTS[id].knowledge as readonly string[] })),
    ...ownFlows.map((s) => ({ id: s.slug, name: s.name, task: s.summary, hue: itemHue('workflow', s.name), defaults: OWN_AGENT_KNOWLEDGE as readonly string[] })),
  ]
  const knowledgeOf = (flowId: string) => flowId.startsWith('own/')
    ? agents.data?.own_knowledge[flowId] ?? agents.data?.own_default
    : agents.data?.agents.find((a) => a.id === flowId)?.knowledge
  const holders = item.atomId ? givable.filter((f) => knowledgeOf(f.id)?.some((k) => k.id === item.atomId)) : []
  const reviewed = item.reviewedAt ? formatDateLong(item.reviewedAt, locale) : null

  async function toggle(flow: string, has: boolean): Promise<void> {
    if (!item?.atomId) return
    const response = await fetch('/api/agents/knowledge', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: has ? 'remove' : 'add', agent_id: flow, atom_id: item.atomId }) })
    if (response.ok) await agents.mutate()
  }

  return (
    <div className={styles.apage}>
      <PageHeader title={t('title')} />
      <Link href={back} className={styles.back}><ArrowLeft className="h-4 w-4" aria-hidden />{t('back_to_agents')}</Link>
      <div className={styles.agrid2}>
        <section className={styles.stage} aria-label={item.name}>
          <StrataField seed={seedOf(item.key)} ground={`hsl(${hue} 52% 88%)`} bar={`hsl(${hue} 40% 42%)`} strength={2.2} />
          <div className={styles.stageTile}>
            <ItemSymbol kind={item.kind} hue={hue} seedKey={item.key} size={104} open />
            <b data-ph-mask={item.community ? '' : undefined}>{item.name}</b>
            <small>{t(`kind_one_${item.kind}`)}{item.community ? ` · @${item.community.author}` : ''}</small>
          </div>
          <div className={styles.stageFoot}>
            {runnable && client === 'claude' ? <ClaudeStart onStart={runShared} /> : runnable ? (
              <Button size="lg" className="gap-2 pl-4" onClick={() => runShared()}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={ai.logo} alt="" width={16} height={16} className={styles.btnLogo} />
                {t('run_agent', { client: ai.name })}
                <ArrowUpRight className="h-4 w-4" aria-hidden />
              </Button>
            ) : item.atomId
              ? <Button size="lg" className="gap-2" disabled={!canWrite} onClick={() => setView('give')}><Plus className="h-4 w-4" aria-hidden />{t('give_to_flow')}</Button>
              : <span />}
            {/* A routine is scheduled in Claude Desktop, so only for Claude. */}
            {runnable && client === 'claude' && (
              <Button size="lg" variant="outline" className="gap-2" onClick={() => setView('routine')}><Repeat className="h-4 w-4" aria-hidden />{t('routine_open')}</Button>
            )}
            {ran && <span className={styles.stageStatus} role="status">{t('copied_open', { client: ai.name })}</span>}
            {item.community && <Vote meta={item.community} slug={item.key} />}
          </div>
        </section>

        <section className={styles.apanel}>
          <div key={view} className={styles.viewIn}>
            {view === 'main' && (
              <>
                <div className={styles.apAvatar}><ItemSymbol kind={item.kind} hue={hue} seedKey={item.key} size={60} /></div>
                <Field label={t('field_name')}>
                  <div className={styles.fieldBox} data-ph-mask={item.community ? '' : undefined}>{item.name}</div>
                </Field>
                {isFlow && (
                  <Field label={t('section_instructions')} note={t('source_community')} copy={<CopyIcon text={body.data} label={t('copy_instructions')} />}>
                    <div className={styles.instrBox} data-ph-mask="">
                      {steps.length > 0 ? <ol>{steps.map((step, i) => <li key={i}>{step}</li>)}</ol> : body.data ? <Markdown text={body.data} /> : <span className={styles.muted}>{t('loading_short')}</span>}
                    </div>
                  </Field>
                )}
                <div className={styles.rows}>
                  {!item.community && <Row label={t('row_source')}><span className={styles.muted}>{[item.own ? t('source_own_item') : t('source_accounted'), item.version ? t('version_short', { version: item.version }) : null].filter(Boolean).join(' · ')}</span></Row>}
                  {isFlow && <Row label={t('section_knowledge')}><span className={styles.muted}>{t('shared_flow_knowledge')}</span></Row>}
                  {item.level && <Row label={t('row_level')}><span className={styles.muted}>{t(`level_${item.level}`)}</span></Row>}
                  {item.community && <Row label={t('row_shared_by')}><Link href={`${backHref}/av.${item.community.author}`} className={styles.authorLink}>@{item.community.author}{item.community.author_verified && ` · ${t('author_verified')}`} · {t('author_shared', { count: item.community.author_shared })}</Link></Row>}
                  {!item.own && <Row label={t('row_reviewed')}><span className={styles.muted}>{reviewed ?? t('reviewed_accounted')}</span></Row>}
                  {item.atomId && (
                    <Row label={t('row_used_by')} onAdd={canWrite ? () => setView('give') : undefined} addLabel={t('give_to_flow')}>
                      {holders.length === 0 ? <span className={styles.muted}>{t('used_by_none')}</span> : (
                        <>{holders.slice(0, 2).map((s) => <span key={s.id} className={styles.chip}>{s.name}</span>)}{holders.length > 2 && <span className={styles.chip}>+{holders.length - 2}</span>}</>
                      )}
                    </Row>
                  )}
                </div>
                {!isFlow && <Field label={t('field_contents')} note={isPack ? undefined : t('contents_note')} copy={<CopyIcon text={body.data} label={t('copy_contents')} />}>
                  {isPack && <p className={styles.packAbout}>{item.desc}</p>}
                  {isPack && (
                    <button type="button" className={`${styles.catLink} ${styles.packToggle}`} aria-expanded={showBody} aria-controls="item-body" onClick={() => setShowBody(!showBody)}>
                      {t(showBody ? 'hide_ai_text' : 'show_ai_text')}
                      {showBody ? <ChevronUp className="h-4 w-4" aria-hidden /> : <ChevronDown className="h-4 w-4" aria-hidden />}
                    </button>
                  )}
                  {(!isPack || showBody) && (
                    <div id="item-body" className={styles.mdBody} data-ph-mask={item.community ? '' : undefined}>
                      {body.data ? <Markdown text={body.data} /> : <span className={styles.muted}>{body.error ? t('body_failed_pack') : t('loading_short')}</span>}
                    </div>
                  )}
                </Field>}
                {mine?.draft && (
                  <div><Button disabled={!canWrite} onClick={() => void addMine()}><Plus className="h-4 w-4" aria-hidden />{t(`add_draft_${item.kind}`)}</Button></div>
                )}
                {COMMUNITY_OPEN && mine?.installations[0] && !mine.draft && (
                  <div className={styles.alist}><ShareBox preview={{ title: item.name, desc: item.desc, kind: item.kind, hue, symbolKey: item.key }} status={mine.shareStatus ?? 'private'} publishedUrl={mine.publishedUrl} reviewNote={mine.reviewNote} canWrite={canWrite} onShare={(share) => patchMine(share === 'withdraw' ? { action: 'withdraw' } : { action: 'submit', confirmed_no_customer_data: true, author_handle: share.author_handle })} /></div>
                )}
                {mine?.installations[0] && (mine.shareStatus ?? 'private') === 'private' && (
                  <div className={styles.alist}><DeleteOwn kind={item.kind} canWrite={canWrite} onDelete={deleteMine} /></div>
                )}
              </>
            )}
            {view === 'routine' && (
              <RoutinePanel run={t('skill_prompt', { name: item.name, slug: item.key, client: 'claude' })} item={item.own ? 'own' : builtIn ? builtIn.slug : 'community'} kind={item.kind} initial={handedRoutine} onBack={() => setView('main')} />
            )}
            {view === 'give' && item.atomId && (
              <SubView title={t('give_to_flow')} onBack={() => setView('main')}>
                <p className={styles.muted}>{t('give_hint')}</p>
                <ul className={styles.kgrid2}>
                  {givable.map((s) => {
                    const has = holders.some((h) => h.id === s.id)
                    const isDefault = s.defaults.includes(item.atomId!)
                    return (
                      <li key={s.id}>
                        <GiveCard name={s.name} task={s.task} hue={s.hue} has={has} note={isDefault ? t('knowledge_default') : undefined} disabled={!canWrite || !agents.data} onToggle={() => toggle(s.id, has)} />
                      </li>
                    )
                  })}
                </ul>
              </SubView>
            )}
          </div>
        </section>
      </div>
    </div>
  )
}

function GiveCard({ name, task, hue, has, note, disabled, onToggle }: { name: string; task: string; hue: number; has: boolean; note?: string; disabled: boolean; onToggle: () => Promise<void> }) {
  const t = useTranslations('skills_registry')
  const [busy, setBusy] = useState(false)
  return (
    <div className={styles.giveCard} data-held={has ? "" : undefined}>
      <FlowSymbol hue={hue} size={34} />
      <span className={styles.giveText}><b>{name}</b><span>{note ? `${task} · ${note}` : task}</span></span>
      <Button variant={has ? 'default' : 'outline'} size="icon" aria-pressed={has} aria-label={has ? t('knowledge_remove', { name }) : t('give_to_named', { name })} disabled={disabled} loading={busy}
        onClick={() => { setBusy(true); void onToggle().finally(() => setBusy(false)) }}>
        {has ? <Check className="h-4 w-4" aria-hidden /> : <Plus className="h-4 w-4" aria-hidden />}
      </Button>
    </div>
  )
}

async function sendFeedback(payload: { slug: string; vote: boolean }): Promise<boolean> {
  try {
    const response = await fetch('/api/agents/community/feedback', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
    return response.ok
  } catch {
    return false
  }
}

/** The upvote on the stage: one per company member, shown at once and undone if the save fails. */
function Vote({ meta, slug }: { meta: CommunityMeta; slug: string }) {
  const t = useTranslations('skills_registry')
  const [voted, setVoted] = useState(meta.voted)
  const votes = meta.votes - (meta.voted ? 1 : 0) + (voted ? 1 : 0)
  return (
    <Button variant="outline" size="lg" className={`gap-2 ${styles.voteBtn}`} aria-pressed={voted} onClick={() => {
      const next = !voted
      setVoted(next)
      void sendFeedback({ slug, vote: next }).then((ok) => { if (!ok) setVoted(!next) })
    }}>
      <ChevronUp className="h-4 w-4" aria-hidden />{t(voted ? 'voted' : 'vote')}<span className={styles.voteCount}>{votes}</span>
    </Button>
  )
}

