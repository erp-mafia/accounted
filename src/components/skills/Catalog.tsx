'use client'

import { useState, type ReactNode } from 'react'
import Link from 'next/link'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { ArrowLeft, ArrowRight, ArrowUpDown, PenLine, Briefcase, Check, Building2, ChevronDown, ChevronUp, Cloud, HardHat, Laptop, Megaphone, Plus, Shuffle, SlidersHorizontal, ShoppingCart, Stethoscope, UserRound, UtensilsCrossed, Store, Truck, Home, Tractor, Palette, GraduationCap, HeartHandshake, User, type LucideIcon } from 'lucide-react'
import type { AgentConnectionState, AgentsOverview } from '@/lib/agent-skills/agent-bundle'
import type { RegistrySkillId } from '@/lib/agent-skills/registry'
import { AI_CLIENTS, type AiClient } from '@/lib/onboarding/ai-clients'
import type { KnowledgeOption } from '@/lib/agent-skills/knowledge-choices'
import type { SkillUsage } from '@/lib/agent-skills/usage'
import { Button } from '@/components/ui/button'
import { SegmentedControl } from '@/components/ui/segmented-control'
import { ToolbarSearch } from '@/components/ui/toolbar-search'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { ItemSymbol } from './ItemSymbol'
import { CATEGORY_IDS, SHOWN_FLOWS } from './catalog-setup'
import { AgentCard } from './AgentCard'
import { CommunityFoot } from './KindViews'
import { ConnectionMark, SourceMarks } from './ConnectionMark'
import { useCompany } from '@/contexts/CompanyContext'
import { handoffRoute, pinCompany, startInAi, type ClaudeTarget, type StartOutcome } from './run'
import { ClaudeStart } from './ClaudeStart'
import { useClaudeTarget } from './claude-target'
import { StartNote } from './StartNote'
import { trackInstructions } from './track'
import type { Presence } from './hues'
import { AGENTS, COMMUNITY_OPEN, type AgentConnection } from '@/lib/agent-skills/agents'
import { itemHue, seedOf, type ItemKind } from './hues'
import { StrataField } from './StrataField'
import { useAnalysisLabel, useKnowledgeDesc, useKnowledgeName } from './knowledge-labels'
import { agentSegment, agentStatus, analysisSegment, communityMeta, communitySegment, kindOf, rulesSegment, type CommunityMeta, type SkillSummary } from './data'
import styles from './skills.module.css'

const KINDS: ItemKind[] = ['workflow', 'rules', 'analysis']
const KIND_PARAM: Record<ItemKind, string> = { workflow: 'arbetsfloden', rules: 'kunskap', analysis: 'analyser' }
const TOP = 6
const CATEGORIES_SHOWN = 8

/** A category's picture, by the industry or company-form pack it stands for. */
const CATEGORY_ICONS: Record<string, LucideIcon> = {
  'bygg-hantverk': HardHat,
  'e-handel': ShoppingCart,
  'konsult-it': Laptop,
  'reklambyra-marknadsforing': Megaphone,
  'restaurang-cafe': UtensilsCrossed,
  'vard-halsa': Stethoscope,
  'software-saas-ai': Cloud,
  'holding-ab': Building2,
  'mixed-verksamhet': Shuffle,
  'single-shareholder-ab-fmb': UserRound,
  'handel-butik': Store,
  'transport-logistik': Truck,
  fastighet: Home,
  'jordbruk-skog': Tractor,
  'kreativa-yrken': Palette,
  utbildning: GraduationCap,
  'ideell-forening': HeartHandshake,
  'enskild-firma': User,
}

type Source = 'accounted' | 'community' | 'own'
interface Item {
  key: string
  kind: ItemKind
  title: string
  desc: string
  href: string
  source: Source
  meta: CommunityMeta | null
  /** The industry and company-form packs it belongs to; none means it fits everyone. */
  categories: string[]
  popularity: number
  usedByFlows?: number
  /** A longer description for the featured slot. */
  lede?: string
  /** Set only when a connection the flow needs is missing. */
  status?: { presence: Presence; text: string }
  /** What a flow works with, as the small marks on its card. */
  connections?: readonly AgentConnection[]
}

/**
 * Agentinstruktioner as a catalogue, laid out like Claude's Customize page:
 * the three kinds as tabs, Egna | Upptäck, search, a category filter and sort
 * in one toolbar. Upptäck opens on a featured item, the most used and the
 * categories (industries and company forms) with counts; a category or a
 * search shows the full list. Egna is what the company made or uses.
 */
export function Catalog({ hrefBase, catalog, options, overview, usage, own, companyIndustry, client, aiReady, canWrite, onCreate, gate, pending }: {
  hrefBase: string
  catalog: SkillSummary[]
  options: KnowledgeOption[]
  overview: AgentsOverview | null | undefined
  usage: SkillUsage | undefined
  own: SkillSummary[]
  companyIndustry: string | null
  /** The AI the company works in; `aiReady` is true once it is connected. */
  client: AiClient
  aiReady: boolean
  canWrite: boolean
  /** Create with the company's AI. */
  /** Create with the company's AI: the prompt says which kind of item to make. */
  onCreate: (kind: ItemKind) => void
  /** Shown in the featured slot while no AI is connected. */
  gate: ReactNode
  /**
   * A connection being made, with its address and steps. The overview shows
   * it in the featured slot (as `gate`); every other view and list shows it
   * on top, so a connect started from Egna or a search keeps the address.
   */
  pending?: ReactNode
}) {
  const t = useTranslations('skills_registry')
  const clientName = AI_CLIENTS.find((c) => c.id === client)!.name
  const knowledgeName = useKnowledgeName()
  const knowledgeDesc = useKnowledgeDesc()
  const analysisLabel = useAnalysisLabel()
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const kind = KINDS.find((k) => KIND_PARAM[k] === params.get('typ')) ?? 'workflow'
  const view: 'discover' | 'own' = params.get('vy') === 'egna' ? 'own' : 'discover'
  const category = params.get('kategori')?.replace('.', '/') ?? null
  const [q, setQ] = useState('')
  const [sort, setSort] = useState<'popular' | 'name'>('popular')
  const [showAll, setShowAll] = useState(false)
  const [allCategories, setAllCategories] = useState(false)
  // "Skriv själv" opens the new item's own page, empty, on the kind in view.
  const write = () => { trackInstructions('instructions_create_clicked', { mode: 'manual', kind }); router.push(`${hrefBase}/ny?typ=${KIND_PARAM[kind]}`) }

  function go(next: { typ?: ItemKind; vy?: 'discover' | 'own'; kategori?: string | null }) {
    const sp = new URLSearchParams(params.toString())
    const typ = next.typ ?? kind
    if (typ === 'workflow') sp.delete('typ'); else sp.set('typ', KIND_PARAM[typ])
    const vy = next.vy ?? view
    if (vy === 'own') sp.set('vy', 'egna'); else sp.delete('vy')
    const kat = next.kategori === undefined ? category : next.kategori
    if (kat) sp.set('kategori', kat.replace('/', '.')); else sp.delete('kategori')
    setShowAll(false)
    router.replace(sp.size ? `${pathname}?${sp}` : pathname, { scroll: false })
  }

  // ── every item of every kind, one shape ──
  // What each flow the company sees carries: Accounted's shown flows, then its own (an unadjusted own flow carries the default).
  const flowKnowledge: string[][] = overview ? [
    ...overview.agents.filter((a) => (SHOWN_FLOWS as readonly string[]).includes(a.id)).map((a) => a.knowledge.map((k) => k.id)),
    ...own.filter((s) => (s.itemKind ?? 'workflow') === 'workflow' && !s.draft)
      .map((s) => (overview.own_knowledge[s.slug] ?? overview.own_default).map((k) => k.id)),
  ] : []
  const usedByFlows = (atomId: string) => flowKnowledge.filter((ids) => ids.includes(atomId)).length
  const shared: Item[] = catalog.filter((s) => COMMUNITY_OPEN && s.tier === 'community').map((s) => {
    const meta = communityMeta(s)
    return { key: s.slug, kind: kindOf(s), title: s.name, desc: s.summary, href: `${hrefBase}/${communitySegment(s.slug)}`, source: 'community', meta, categories: (meta?.industries ?? []).map((i) => `vertical/${i}`), popularity: meta?.used_by ?? meta?.votes ?? 0 }
  })
  const flows: Item[] = SHOWN_FLOWS.map((id) => ({ id })).map((s) => ({
    key: s.id, kind: 'workflow', title: t(`skills.${s.id}.name`), desc: t(`skills.${s.id}.short`), href: `${hrefBase}/${agentSegment(s.id)}`,
    source: 'accounted', meta: null, categories: [], popularity: usage?.[s.id]?.count ?? 0, connections: AGENTS[s.id].connections, lede: t(`skills.${s.id}.desc`),
    status: agentStatus({ id: s.id, aiKnown: true, overview, waiting: undefined, lastAt: undefined, t: (key, values) => t(key, values), formatDate: (iso) => iso }),
  }))
  // Accounted's packs only: the company's own knowledge is listed under Egna from the catalog.
  const packs: Item[] = options.filter((o) => o.tier !== 'community' && o.tier !== 'own').map((o) => ({
    key: o.id, kind: 'rules', title: knowledgeName(o.id, o.title), desc: knowledgeDesc(o.id, o.summary), href: `${hrefBase}/${rulesSegment(o.id)}`,
    source: 'accounted', meta: null, categories: o.tier === 'vertical' || o.tier === 'modifier' ? [o.id] : [], popularity: usedByFlows(o.id), usedByFlows: usedByFlows(o.id),
  }))
  // Own items: a flow opens the flow page; own knowledge and analyses open the item page (egen.<id>).
  const ownItems: Item[] = own.map((s) => {
    const k = s.itemKind ?? 'workflow'
    // A draft your AI saved waits for you: say so on the card, not only on its page.
    return { key: s.slug, kind: k, title: s.name, desc: s.summary, href: k === 'workflow' ? `${hrefBase}/${agentSegment(s.slug)}` : `${hrefBase}/egen.${s.slug.slice(4)}`, source: 'own', meta: null, categories: [], popularity: s.draft ? 1 : 0,
      ...(s.draft ? { status: { presence: 'busy' as const, text: t('draft_tag') } } : {}) }
  })
  // Accounted's own analyses: examples of what an analysis is, next to the community's.
  const analyses: Item[] = catalog.filter((s) => s.source === 'accounted' && s.itemKind === 'analysis').map((s) => {
    const label = analysisLabel(s.slug, { name: s.name, summary: s.summary })
    return {
      key: s.slug, kind: 'analysis', title: label.name, desc: label.summary, href: `${hrefBase}/${analysisSegment(s.slug)}`,
      source: 'accounted', meta: null, categories: [], popularity: usage?.[s.slug]?.count ?? 0,
    }
  })
  const all = [...flows, ...packs, ...analyses, ...shared]
  const ofKind = all.filter((i) => i.kind === kind)

  // Egna: for flows, what the company made; for knowledge, what the company's flows carry (its own flows too).
  const carried = new Set(flowKnowledge.flat())
  const mine = ownItems.filter((i) => i.kind === kind)
  const carriedPacks = kind === 'rules' ? packs.filter((p) => carried.has(p.key)) : []

  // Every industry and company form with something in it, and the company's own industry even when empty, so it sees where it stands.
  const categories = CATEGORY_IDS
    .map((id) => ({ id: id as string, name: t(`category_names.${id.split('/')[1]}`), count: ofKind.filter((i) => i.categories.includes(id)).length }))
    .filter((c) => c.count > 0 || c.id === companyIndustry)
    .sort((a, b) => Number(b.id === companyIndustry) - Number(a.id === companyIndustry) || b.count - a.count)
  const categoryName = categories.find((c) => c.id === category)?.name ?? (category ? knowledgeName(category, category) : null)

  const query = q.trim().toLocaleLowerCase('sv')
  const sorted = (items: Item[]) => [...items].sort((a, b) => sort === 'name' ? a.title.localeCompare(b.title, 'sv') : b.popularity - a.popularity)
  const listing = view === 'discover' && (showAll || !!category || !!query)
  const pool = view === 'own' ? mine : ofKind
  const listed = sorted(pool.filter((i) => (!category || i.categories.includes(category)) && (!query || `${i.title} ${i.desc}`.toLocaleLowerCase('sv').includes(query))))

  // The featured slot: Kvittojakten for flows, the company's own industry pack for knowledge, otherwise the most used.
  const featured = (kind === 'workflow' ? flows.find((f) => f.key === 'kvittojakten') : undefined)
    ?? (kind === 'rules' && companyIndustry ? packs.find((p) => p.key === companyIndustry) : undefined) ?? sorted(ofKind)[0]
  // "Mest använda" leaves out what the banner already shows; while the connect gate stands in the slot, nothing is left out.
  const rest = gate || !featured ? ofKind : ofKind.filter((i) => i.key !== featured.key)
  const top = sorted(rest).slice(0, TOP)

  return (
    <div className={styles.catalog}>
      <div className={styles.catBar}>
        <SegmentedControl<ItemKind>
          aria-label={t('kinds_label')}
          value={kind}
          onChange={(k) => go({ typ: k, kategori: null })}
          options={KINDS.map((k) => ({ value: k, label: t(`kind_${k}`) }))}
        />
        <span className={styles.catDivider} aria-hidden />
        <SegmentedControl<'own' | 'discover'>
          aria-label={t('view_label')}
          value={view}
          onChange={(vy) => go({ vy, kategori: null })}
          options={[{ value: 'own', label: t('view_own') }, { value: 'discover', label: t('view_discover') }]}
        />
        <div className={styles.catTools}>
          <ToolbarSearch containerClassName={styles.catSearch} aria-label={t('search_label')} placeholder={t(`search_${kind}`)} value={q} onChange={(e) => setQ(e.target.value)} />
          {view === 'discover' && categories.length > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="icon-sm" aria-label={t('category_label')}><SlidersHorizontal className="h-4 w-4" aria-hidden /></Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuLabel>{t('category_label')}</DropdownMenuLabel>
                <DropdownMenuRadioGroup value={category ?? 'all'} onValueChange={(v) => go({ kategori: v === 'all' ? null : v })}>
                  <DropdownMenuRadioItem value="all">{t('category_all')}</DropdownMenuRadioItem>
                  {categories.map((c) => <DropdownMenuRadioItem key={c.id} value={c.id}>{c.name}</DropdownMenuRadioItem>)}
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="icon-sm" aria-label={t('sort_label')}><ArrowUpDown className="h-4 w-4" aria-hidden /></Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuLabel>{t('sort_label')}</DropdownMenuLabel>
              <DropdownMenuRadioGroup value={sort} onValueChange={(v) => setSort(v as 'popular' | 'name')}>
                <DropdownMenuRadioItem value="popular">{t('sort_popular')}</DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="name">{t('sort_name')}</DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" className="gap-1.5" disabled={!canWrite}><Plus className="h-4 w-4" aria-hidden />{t('create_button')}<ChevronDown className="h-3.5 w-3.5" aria-hidden /></Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem className="gap-2" onSelect={() => onCreate(kind)}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={AI_CLIENTS.find((c) => c.id === client)!.logo} alt="" width={16} height={16} className={styles.btnLogo} />
                {t('create_with', { client: clientName })}
              </DropdownMenuItem>
              <DropdownMenuItem className="gap-2" onSelect={write}><PenLine className="h-4 w-4" aria-hidden />{t('create_manual')}</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {(view === 'own' || listing) && pending}
      {view === 'own' && (
        <section className={styles.catSection}>
          <div className={styles.catHead}><h2>{t(`own_${kind}_title`)}</h2></div>
          {listed.length === 0
            ? <div className={`${styles.placeEmpty} ${styles.shareInvite}`}><span>{t(`own_${kind}_empty`, { client: clientName })}</span><CreateButtons client={client} canWrite={canWrite} onCreate={() => onCreate(kind)} onWrite={write} /></div>
            : <ul className={styles.agrid}>{listed.map((i) => <CatalogCard key={i.key} item={i} />)}</ul>}
        </section>
      )}
      {view === 'own' && carriedPacks.length > 0 && (
        <section className={styles.catSection}>
          <div className={styles.catHead}><h2>{t('own_rules_carried')}</h2></div>
          <ul className={styles.agrid}>{sorted(carriedPacks).map((i) => <CatalogCard key={i.key} item={i} />)}</ul>
        </section>
      )}

      {view === 'discover' && listing && (
        <section className={styles.catSection}>
          <div className={styles.catHead}>
            <h2>{categoryName ?? (query ? t('search_results') : t(`all_${kind}`))}<span className={styles.catCount}>{listed.length}</span></h2>
            <button type="button" className={styles.catLink} onClick={() => { setQ(''); go({ kategori: null }) }}><ArrowLeft className="h-4 w-4" aria-hidden />{t('back_overview')}</button>
          </div>
          {listed.length === 0
            ? <div className={`${styles.placeEmpty} ${styles.shareInvite}`}>
                <span>{category && COMMUNITY_OPEN ? t('place_share_first', { place: categoryName ?? '' }) : t('place_empty')}</span>
                {category && COMMUNITY_OPEN && <CreateButtons client={client} canWrite={canWrite} onCreate={() => onCreate(kind)} onWrite={write} />}
              </div>
            : <ul className={styles.agrid}>{listed.map((i) => <CatalogCard key={i.key} item={i} />)}</ul>}
        </section>
      )}

      {view === 'discover' && !listing && (
        <>
          {gate ?? (featured && <Featured item={featured} industry={featured.categories.includes(companyIndustry ?? '')} client={client} aiReady={aiReady} overview={overview} />)}

          {/* Nothing of the kind at all says so; when the banner already shows the only one, the section is simply left out. */}
          {(top.length > 0 || ofKind.length === 0) && (
            <section className={styles.catSection}>
              <div className={styles.catHead}>
                <h2>{t(`most_used_${kind}`)}</h2>
                {rest.length > TOP && <button type="button" className={styles.catLink} onClick={() => setShowAll(true)}>{t('show_all')}<ArrowRight className="h-4 w-4" aria-hidden /></button>}
              </div>
              {top.length === 0 ? (COMMUNITY_OPEN
                ? <div className={styles.placeEmpty}>{t(`community_empty_${kind}`)}</div>
                : <div className={`${styles.placeEmpty} ${styles.shareInvite}`}><span>{t(`accounted_empty_${kind}`)}</span><CreateButtons client={client} canWrite={canWrite} onCreate={() => onCreate(kind)} onWrite={write} /></div>) : <ul className={styles.agrid}>{top.map((i) => <CatalogCard key={i.key} item={i} />)}</ul>}
            </section>
          )}

          {categories.length > 0 && (
            <section className={styles.catSection}>
              <div className={styles.catHead}>
                <h2>{t('categories')}</h2>
                {categories.length > CATEGORIES_SHOWN && (
                  <button type="button" className={styles.catLink} onClick={() => setAllCategories(!allCategories)}>
                    {t(allCategories ? 'show_fewer' : 'show_all_count', { count: categories.length })}
                    {allCategories ? <ChevronUp className="h-4 w-4" aria-hidden /> : <ChevronDown className="h-4 w-4" aria-hidden />}
                  </button>
                )}
              </div>
              <ul className={styles.categoryGrid}>
                {(allCategories ? categories : categories.slice(0, CATEGORIES_SHOWN)).map((c) => {
                  const Icon = CATEGORY_ICONS[c.id.split('/')[1] ?? ''] ?? Briefcase
                  return (
                    <li key={c.id}>
                      <button type="button" className={styles.categoryCard} onClick={() => go({ kategori: c.id })}>
                        <span className={styles.categoryIcon}><Icon className="h-6 w-6" strokeWidth={1.5} aria-hidden /></span>
                        <span className={styles.categoryName}>{c.name}{c.id === companyIndustry && <small>{t('industry_yours')}</small>}</span>
                        <span className={styles.catCount}>{c.count}</span>
                      </button>
                    </li>
                  )
                })}
              </ul>
            </section>
          )}
        </>
      )}
    </div>
  )
}

/** The two ways to make something: with the company's AI, or by hand. */
function CreateButtons({ client, canWrite, onCreate, onWrite }: { client: AiClient; canWrite: boolean; onCreate: () => void; onWrite: () => void }) {
  const t = useTranslations('skills_registry')
  const ai = AI_CLIENTS.find((c) => c.id === client)!
  return (
    <span className={styles.createPair}>
      <Button size="sm" className="gap-2" disabled={!canWrite} onClick={onCreate}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={ai.logo} alt="" width={14} height={14} className={styles.btnLogo} />
        {t('create_with', { client: ai.name })}
      </Button>
      <Button size="sm" variant="outline" className="gap-1.5" disabled={!canWrite} onClick={onWrite}><PenLine className="h-4 w-4" aria-hidden />{t('create_manual')}</Button>
    </span>
  )
}

/** One item in the catalogue, in the page's own card: tinted panel, its picture on a tile, and a foot. */
function CatalogCard({ item }: { item: Item }) {
  const t = useTranslations('skills_registry')
  const hue = itemHue(item.kind, item.source === 'own' ? item.title : item.key, item.source === 'accounted' && item.kind === 'workflow' ? item.key as never : null)
  const foot = item.meta ? <CommunityFoot meta={item.meta} />
    : item.usedByFlows ? <span className={styles.metaLine}>{t('used_by', { count: item.usedByFlows })}</span>
    : undefined
  return (
    <li>
      <AgentCard
        href={item.href}
        title={item.title}
        desc={item.desc}
        kind={item.kind}
        symbolKey={item.key}
        hue={hue}
        masked={item.source === 'own'}
        marks={item.connections && item.connections.length > 0 ? <SourceMarks connections={item.connections} /> : undefined}
        status={item.status}
        foot={foot}
      />
    </li>
  )
}

/** The featured slot at the top of Upptäck, as Claude's "From Anthropic" banner. A flow starts right here in the company's AI. */
function Featured({ item, industry, client, aiReady, overview }: { item: Item; industry: boolean; client: AiClient; aiReady: boolean; overview: AgentsOverview | null | undefined }) {
  const t = useTranslations('skills_registry')
  const { company } = useCompany()
  const [claudeTarget] = useClaudeTarget()
  const target: ClaudeTarget = client === 'claude' ? claudeTarget : 'web'
  const [outcome, setOutcome] = useState<StartOutcome | null>(null)
  const hue = itemHue(item.kind, item.source === 'own' ? item.title : item.key, item.source === 'accounted' && item.kind === 'workflow' ? item.key as never : null)
  const ai = AI_CLIENTS.find((c) => c.id === client)!
  // Accounted's flows and analyses start from the banner; community items open their page first.
  const runnable = (item.kind === 'workflow' || item.kind === 'analysis') && item.source === 'accounted' && aiReady
  const states = overview?.agents.find((a) => a.id === item.key)?.connections ?? []
  const id = item.key as RegistrySkillId
  // Accounted's own text: filled in on the web, with the company pinned only where no URL carries it.
  const prompt = pinCompany(
    item.kind === 'analysis' ? t('skill_prompt', { name: item.title, slug: item.key, client }) : t('prompt', { say: t(`skills.${id}.say`), agent: id, client }),
    t('prompt_company_pin', { company: company?.name ?? '', companyId: company?.id ?? '' }),
  )
  function run(start: ClaudeTarget = 'web'): Promise<StartOutcome> {
    trackInstructions('instructions_start_clicked', { item: id, kind: item.kind, client, surface: 'banner', target: client === 'claude' ? start : 'web' })
    setOutcome(null)
    const starting = startInAi(client, start, prompt, true)
    void starting.then(setOutcome)
    return starting
  }
  return (
    <section className={styles.featured} style={{ background: `hsl(${hue} 32% 90%)` }}>
      {/* A faint strata ground, the stage's in the item's colour, kept quiet behind the text. */}
      <StrataField seed={seedOf(item.key)} ground={`hsl(${hue} 32% 90%)`} bar={`hsl(${hue} 35% 45%)`} strength={1.2} />
      {/* The whole banner opens the item; the start button and connection logos sit above this link. */}
      <Link href={item.href} className={styles.featuredLink} aria-label={item.title} />
      <div className={styles.featuredText}>
        {(industry || item.source === 'community') && <span>{industry ? t('featured_industry') : t('featured_community', { who: `@${item.meta?.author ?? ''}` })}</span>}
        <h2>{item.title}</h2>
        <p>{item.lede ?? item.desc}</p>
        <div className={styles.featuredActions}>
          {runnable && (client === 'claude' ? <ClaudeStart size="sm" onStart={run} /> : (
            <Button size="sm" className="gap-2 pl-3" onClick={() => void run()}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={ai.logo} alt="" width={14} height={14} className={styles.btnLogo} />
              {t('run_agent', { client: ai.name })}
            </Button>
          ))}
          {/* Knowledge does not start: it is read and given to flows on its own page, so say where to go. */}
          {item.kind === 'rules' && (
            <Button asChild size="sm" variant="outline" className="gap-1.5"><Link href={item.href}>{t('featured_open_rules')}<ArrowRight className="h-4 w-4" aria-hidden /></Link></Button>
          )}
          {item.connections && item.connections.length > 0 && (
            <span className={styles.featuredUses}>
              {item.connections.map((c) => <ConnectionBadge key={c} kind={c} state={states.find((s) => s.kind === c)} clientName={ai.name} />)}
            </span>
          )}
          {runnable && <StartNote banner route={handoffRoute(client, target, true)} outcome={outcome} client={client} target={target} prompt={prompt.pinned} onWeb={() => void run('web')} />}
        </div>
      </div>
      <span className={styles.featuredArt}><ItemSymbol kind={item.kind} hue={hue} seedKey={item.key} size={120} open /></span>
    </section>
  )
}

/**
 * One connection as its logo, saying where it stands: an Accounted connection
 * is connected or links to where it is set up; mail and browser live in the
 * company's AI, which Accounted cannot see.
 */
function ConnectionBadge({ kind, state, clientName }: { kind: AgentConnection; state: AgentConnectionState | undefined; clientName: string }) {
  const t = useTranslations('skills_registry')
  const status = state?.status ?? 'in_ai'
  const label = status === 'in_ai' ? t('badge_in_ai', { conn: t(`conn_${kind}`), client: clientName })
    : status === 'connected' ? t('badge_connected', { conn: t(`conn_${kind}`) })
    : status === 'missing' ? t('badge_missing', { conn: t(`conn_${kind}`) }) : t(`conn_${kind}`)
  const inner = <><span className={styles.appchip}><ConnectionMark kind={kind} /></span>{status === 'missing' && <small>{t('conn_missing')}</small>}{status === 'connected' && <Check className="h-3 w-3" aria-hidden />}</>
  return status === 'missing' && state?.settings_href
    ? <Link href={state.settings_href} className={styles.connBadge} data-status={status} title={label} aria-label={label}>{inner}</Link>
    : <span className={styles.connBadge} data-status={status} title={label} aria-label={label} role="img">{inner}</span>
}
