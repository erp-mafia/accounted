'use client'

import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode, type Ref } from 'react'
import Link from 'next/link'
import { useLocale, useTranslations } from 'next-intl'
import { ChevronRightIcon } from '@/components/icons'
import { LoadError } from '@/components/ui/empty-state'
import { LateReveal, Skeleton } from '@/components/ui/skeleton'
import { getErrorMessage, type ErrorLocale } from '@/lib/errors/get-error-message'
import { useFormat } from '@/lib/hooks/use-format'
import { AI_CLIENTS } from '@/lib/onboarding/ai-clients'
import { cn } from '@/lib/utils'
import { flowLayout, isReadingNow, type FlowCard, type FlowLayout } from '@/lib/agent-context/agent-picture-lines'
import type {
  AgentPicture as AgentPictureData,
  PictureActivity,
  PictureAgent,
  PictureCompany,
  PictureLinkState,
  PictureSource,
} from '@/lib/agent-context/agent-picture'
import type { ConnectionKind } from '@/lib/settings/mcp-connections'
import { PictureDrawer, type PictureTab } from './PictureDrawer'
import { AgentMark, SourceMark } from './picture-marks'

type LoadState = { state: 'loading' } | { state: 'ok'; data: AgentPictureData } | { state: 'failed'; description: string } | { state: 'off' }

/** How often the agents' activity is asked for again while the tab is visible. */
const ACTIVITY_INTERVAL_MS = 30_000

/** Where a connection is made and managed. */
const CONNECT_AGENT_HREF = '/settings/api'

/** The clients offered, faded, while the company has no connection of that kind. */
const OFFERED_CLIENTS = ['claude', 'chatgpt'] as const

/** A connected line, in the chart pair's blue (the colour the wiki's own bar uses). */
const LINE_COLOR = 'hsl(var(--chart-1))'

const REDUCED_MOTION = '(prefers-reduced-motion: reduce)'
function subscribeReducedMotion(onChange: () => void): () => void {
  const query = window.matchMedia(REDUCED_MOTION)
  query.addEventListener('change', onChange)
  return () => query.removeEventListener('change', onChange)
}
const reducedMotionNow = () => window.matchMedia(REDUCED_MOTION).matches
const reducedMotionOnServer = () => false

/**
 * One picture of what a connected agent gets: what is connected on the left,
 * the company in the middle, the agents on the right, and a line from every
 * card to the company's card (GET /api/wiki/picture). Every card leads to
 * where its connection is managed; a row of the company's card opens the
 * drawer on that part. While the tab is visible the agents' activity is
 * asked for again every 30 seconds (GET /api/wiki/picture/activity), and a
 * connection that just made a call says so and gets a moving line.
 *
 * `contextTab` is the drawer's Kontext part: the briefing's sections, which
 * the page that hosts the picture already loads.
 */
export function AgentPicture({ contextTab }: { contextTab: ReactNode }) {
  const t = useTranslations('wiki')
  const locale = useLocale() as ErrorLocale
  const [load, setLoad] = useState<LoadState>({ state: 'loading' })
  const [activity, setActivity] = useState<PictureActivity | null>(null)
  const [tab, setTab] = useState<PictureTab | null>(null)

  // One read per attempt. Every state change happens in the answer's callback.
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let cancelled = false
    fetch('/api/wiki/picture')
      .then(async (res) => {
        const body = (await res.json().catch(() => null)) as { data?: AgentPictureData } | null
        if (cancelled) return
        if (res.ok && body?.data) {
          setActivity(body.data.agents?.activity ?? null)
          setLoad({ state: 'ok', data: body.data })
        } else if (res.status === 404) {
          setLoad({ state: 'off' })
        } else {
          setLoad({ state: 'failed', description: getErrorMessage(body, { locale, statusCode: res.status }) })
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) setLoad({ state: 'failed', description: getErrorMessage(err, { locale }) })
      })
    return () => {
      cancelled = true
    }
  }, [attempt, locale])
  const retry = () => {
    setLoad({ state: 'loading' })
    setAttempt((n) => n + 1)
  }

  // The agents' activity, again every 30 seconds while the tab is visible and
  // at once when it becomes visible. A failed read keeps the last answer.
  const loaded = load.state === 'ok'
  useEffect(() => {
    if (!loaded) return
    let cancelled = false
    const read = async () => {
      if (document.visibilityState !== 'visible') return
      try {
        const res = await fetch('/api/wiki/picture/activity')
        if (!res.ok) return
        const body = (await res.json().catch(() => null)) as { data?: PictureActivity } | null
        if (!cancelled && body?.data) setActivity(body.data)
      } catch {
        // The picture keeps what it last knew.
      }
    }
    const timer = setInterval(() => void read(), ACTIVITY_INTERVAL_MS)
    const onVisible = () => void read()
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      cancelled = true
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [loaded])

  if (load.state === 'off') return null
  if (load.state === 'loading') return <PictureSkeleton />
  if (load.state === 'failed') {
    return <LoadError title={t('picture.load_failed_title')} description={load.description} onRetry={retry} />
  }
  return <PictureFigure picture={load.data} activity={activity} tab={tab} onTab={setTab} contextTab={contextTab} />
}

function PictureSkeleton() {
  return (
    <LateReveal>
      <div className="@container" aria-busy>
        <div className="grid items-center gap-10 py-6 @3xl:grid-cols-3 @3xl:gap-x-16">
          <div className="space-y-3">
            {[1, 2, 3, 4].map((i) => (
              <Skeleton key={i} className="h-13 w-full rounded-lg" />
            ))}
          </div>
          <Skeleton className="h-64 w-full rounded-lg" />
          <div className="space-y-3">
            {[1, 2].map((i) => (
              <Skeleton key={i} className="h-13 w-full rounded-lg" />
            ))}
          </div>
        </div>
      </div>
    </LateReveal>
  )
}

interface AgentCard {
  id: string
  kind: ConnectionKind
  name: string
  detail: string
  state: PictureLinkState
  active: boolean
  /** A hand-made key's name is the company's own text. */
  maskName: boolean
}

function PictureFigure({
  picture,
  activity,
  tab,
  onTab,
  contextTab,
}: {
  picture: AgentPictureData
  activity: PictureActivity | null
  tab: PictureTab | null
  onTab: (tab: PictureTab | null) => void
  contextTab: ReactNode
}) {
  const t = useTranslations('wiki')
  const tKeys = useTranslations('settings_api_keys')
  const { locale, formatDateLong } = useFormat()
  const reducedMotion = useSyncExternalStore(subscribeReducedMotion, reducedMotionNow, reducedMotionOnServer)

  const timeOf = (instant: string) => new Intl.DateTimeFormat(locale === 'en' ? 'en-GB' : 'sv-SE', { hour: '2-digit', minute: '2-digit' }).format(new Date(instant))
  /** An instant in words: today with its time, another day by its date. */
  const when = (instant: string): string => {
    const date = new Date(instant)
    if (Number.isNaN(date.getTime())) return ''
    return date.toDateString() === new Date().toDateString() ? t('picture.today_at', { time: timeOf(instant) }) : formatDateLong(date)
  }

  const sourceName = (source: PictureSource) => source.name ?? t(`picture.sources.${source.key}`)
  const sourceDetail = (source: PictureSource): string => {
    if (source.state === 'not_connected') return t('picture.not_connected')
    if (source.state === 'unknown') return t('picture.state_unknown')
    if (source.state === 'needs_attention') return t('picture.needs_attention')
    const delivered = source.last_delivered_at ? when(source.last_delivered_at) : null
    const parts: Array<string | null> = (() => {
      switch (source.key) {
        case 'bank':
          return [[source.detail, source.tail ? `••${source.tail}` : null].filter(Boolean).join(' ') || null, delivered]
        case 'skatteverket':
          return delivered ? [t('picture.detail_skattekonto'), delivered] : [t('picture.connected')]
        case 'bolagsverket':
          return [t('picture.detail_register'), delivered]
        case 'inbox':
          return [source.count === null ? source.detail : t('picture.inbox_count', { count: source.count })]
        case 'whatsapp':
        case 'pos':
          return [source.detail ?? t('picture.connected')]
        default:
          return [t('picture.connected'), delivered]
      }
    })()
    return parts.filter(Boolean).join(' · ')
  }

  const agentName = (agent: Pick<PictureAgent, 'kind' | 'name'>): string => {
    switch (agent.kind) {
      case 'key':
        return agent.name ?? t('picture.groups.keys')
      case 'partner':
        return agent.name ?? tKeys('kind_partner')
      case 'claude':
      case 'chatgpt':
      case 'grok':
        return AI_CLIENTS.find((client) => client.id === agent.kind)?.name ?? agent.kind
      case 'gemini':
      case 'copilot':
        return tKeys(`target_${agent.kind}`)
      default:
        return tKeys(`kind_${agent.kind}`)
    }
  }

  const agentCards: AgentCard[] = (picture.agents?.list ?? []).map((agent) => {
    // The newest answer of the log wins over the one the picture came with.
    const seen = activity ? activity.actors[agent.id] : undefined
    const calls = activity ? (seen?.calls_today ?? 0) : agent.calls_today
    const lastCall = activity ? (seen?.last_call_at ?? null) : agent.last_call_at
    const active = activity ? isReadingNow(lastCall, activity.now) : false
    const last = lastCall ?? agent.last_used_at
    const detail = active
      ? t('picture.reading_now')
      : activity && calls > 0 && lastCall
        ? activity.capped
          ? t('picture.calls_today_capped', { count: calls, time: timeOf(lastCall) })
          : t('picture.calls_today', { count: calls, time: timeOf(lastCall) })
        : last
          ? t('picture.last_used', { when: when(last) })
          : t('picture.never_used')
    return { id: agent.id, kind: agent.kind, name: agentName(agent), detail, state: 'connected', active, maskName: agent.kind === 'key' }
  })
  const offered: AgentCard[] = picture.agents
    ? OFFERED_CLIENTS.filter((kind) => !agentCards.some((card) => card.kind === kind)).map((kind) => ({
        id: `offer:${kind}`,
        kind,
        name: agentName({ kind, name: null }),
        detail: t('picture.not_connected'),
        state: 'not_connected',
        active: false,
        maskName: false,
      }))
    : []
  const clients = [...agentCards.filter((card) => card.kind !== 'key'), ...offered]
  const keys = agentCards.filter((card) => card.kind === 'key')
  const more = picture.agents?.more ?? 0

  // The lines, measured from where the cards ended up, again on every resize
  // and whenever a card appears, changes state or starts or stops working.
  const mapRef = useRef<HTMLDivElement>(null)
  const coreRef = useRef<HTMLDivElement>(null)
  const inRef = useRef<HTMLDivElement>(null)
  const outRef = useRef<HTMLDivElement>(null)
  const [layout, setLayout] = useState<FlowLayout | null>(null)
  const signature = [
    ...picture.sources.flatMap((group) => group.items.map((item) => `${item.id}:${item.state}`)),
    ...[...clients, ...keys].map((card) => `${card.id}:${card.state}:${card.active}`),
    picture.agents ? more : 'unknown',
  ].join('|')
  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    let frame = 0
    const measure = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        const core = coreRef.current
        if (!core) return
        const cards: FlowCard[] = Array.from(map.querySelectorAll<HTMLElement>('[data-flow-id]')).map((el) => ({
          id: el.dataset.flowId ?? '',
          side: el.dataset.flowSide === 'out' ? 'out' : 'in',
          rect: el.getBoundingClientRect(),
          connected: el.dataset.flowConnected === 'true',
          active: el.dataset.flowActive === 'true',
        }))
        setLayout(
          flowLayout({
            map: map.getBoundingClientRect(),
            core: core.getBoundingClientRect(),
            cards,
            inColumn: inRef.current?.getBoundingClientRect() ?? null,
            outColumn: outRef.current?.getBoundingClientRect() ?? null,
          }),
        )
      })
    }
    measure()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    observer?.observe(map)
    window.addEventListener('resize', measure)
    return () => {
      cancelAnimationFrame(frame)
      observer?.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [signature])

  return (
    <section aria-label={t('picture.label')} className="@container">
      <div
        ref={mapRef}
        className="relative grid items-center gap-10 py-6 @3xl:grid-cols-[minmax(0,1fr)_minmax(0,1.08fr)_minmax(0,1fr)] @3xl:gap-x-16 @5xl:gap-x-24"
      >
        {layout && (
          <svg
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 h-full w-full overflow-visible"
            viewBox={`0 0 ${layout.width} ${layout.height}`}
          >
            {layout.lines.map((line) => (
              <g key={line.id} fill="none">
                {!line.dashed && <path d={line.d} strokeWidth={6} opacity={0.1} style={{ stroke: LINE_COLOR }} />}
                <path
                  d={line.d}
                  strokeWidth={line.active ? 2 : 1.25}
                  strokeDasharray={line.dashed ? '3 4' : line.active ? '10 14' : undefined}
                  className={line.dashed ? 'stroke-line-strong' : undefined}
                  style={line.dashed ? undefined : { stroke: LINE_COLOR }}
                >
                  {/* The dashes travel only where motion is welcome; the heavier dashed line and the card's own words say the same without it. */}
                  {line.active && !reducedMotion && <animate attributeName="stroke-dashoffset" from="24" to="0" dur="0.9s" repeatCount="indefinite" />}
                </path>
              </g>
            ))}
            {layout.sockets.map((socket, i) => (
              <circle key={i} cx={socket.x} cy={socket.y} r={3} strokeWidth={1} className="fill-background stroke-line-strong" />
            ))}
          </svg>
        )}

        <div ref={inRef} className="relative z-10 flex min-w-0 flex-col gap-4">
          {picture.sources.map((group) => (
            <CardGroup key={group.id} label={t(`picture.groups.${group.id}`)}>
              {group.items.map((source) => (
                <PictureCard
                  key={source.id}
                  flowId={source.id}
                  side="in"
                  href={source.href}
                  state={source.state}
                  active={false}
                  mark={<SourceMark sourceKey={source.key} logo={source.logo} />}
                  name={sourceName(source)}
                  detail={sourceDetail(source)}
                  // A bank's own name, an account's and an address are the company's data.
                  maskName={source.name !== null}
                />
              ))}
            </CardGroup>
          ))}
        </div>

        <CompanyCard ref={coreRef} company={picture.company} onOpen={onTab} />

        <div ref={outRef} className="relative z-10 flex min-w-0 flex-col gap-4">
          <CardGroup label={t('picture.groups.agents')}>
            {picture.agents === null && (
              <PictureCard
                flowId="agents"
                side="out"
                href={CONNECT_AGENT_HREF}
                state="unknown"
                active={false}
                mark={<AgentMark kind="mcp" />}
                name={t('picture.agents_unknown')}
                detail={t('picture.state_unknown')}
                maskName={false}
              />
            )}
            {clients.map((card) => (
              <AgentPictureCard key={card.id} card={card} />
            ))}
          </CardGroup>
          {keys.length > 0 && (
            <CardGroup label={t('picture.groups.keys')}>
              {keys.map((card) => (
                <AgentPictureCard key={card.id} card={card} />
              ))}
            </CardGroup>
          )}
          {more > 0 && (
            <Link href={CONNECT_AGENT_HREF} className="px-2.5 text-xs font-medium text-foreground/80 underline-offset-2 hover:underline">
              {t('picture.agents_more', { count: more })}
            </Link>
          )}
        </div>
      </div>

      <PictureDrawer
        tab={tab}
        onTabChange={onTab}
        onClose={() => onTab(null)}
        companyName={picture.company.name}
        contextTab={contextTab}
        checks={picture.company.checks}
        knowledge={picture.company.knowledge}
        when={when}
      />
    </section>
  )
}

function AgentPictureCard({ card }: { card: AgentCard }) {
  return (
    <PictureCard
      flowId={card.id}
      side="out"
      href={CONNECT_AGENT_HREF}
      state={card.state}
      active={card.active}
      mark={<AgentMark kind={card.kind} />}
      name={card.name}
      detail={card.detail}
      maskName={card.maskName}
    />
  )
}

function CardGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div role="group" aria-label={label} className="flex min-w-0 flex-col gap-1.5">
      <div className="px-2.5 text-xs font-medium text-foreground/80">{label}</div>
      {children}
    </div>
  )
}

/**
 * One card: a source or an agent. The whole card is the link to where it is
 * managed. A card that is not connected is flat and outlined, its mark
 * greyed, and says Koppla. The data attributes are what the lines are
 * measured from.
 */
function PictureCard({
  flowId,
  side,
  href,
  state,
  active,
  mark,
  name,
  detail,
  maskName,
}: {
  flowId: string
  side: 'in' | 'out'
  href: string
  state: PictureLinkState
  active: boolean
  mark: ReactNode
  name: string
  detail: string
  maskName: boolean
}) {
  const t = useTranslations('wiki')
  const off = state === 'not_connected'
  return (
    <Link
      href={href}
      data-flow-id={flowId}
      data-flow-side={side}
      data-flow-connected={state === 'connected' ? 'true' : 'false'}
      data-flow-active={active ? 'true' : 'false'}
      className={cn(
        'flex min-h-13 items-center gap-2.5 rounded-lg px-2.5 py-2 outline-none focus-visible:ring-2 focus-visible:ring-ring/70',
        off
          ? 'border border-border transition-colors duration-150 hover:bg-secondary/60'
          : 'bg-control shadow-raised transition-shadow duration-150 hover:shadow-raised-hover',
      )}
    >
      <span className={cn('grid h-8 w-8 shrink-0 place-items-center overflow-hidden rounded-md bg-secondary', off && 'opacity-60 grayscale')}>
        {mark}
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className={cn('truncate text-[13px] font-medium', off ? 'text-foreground/80' : 'text-strong')} {...(maskName ? { 'data-ph-mask': '' } : {})}>
          {name}
        </span>
        <span className={cn('break-words text-xs tabular-nums', state === 'needs_attention' ? 'text-attn' : 'text-muted-foreground')} data-ph-mask="">
          {detail}
        </span>
      </span>
      {off && <span className="shrink-0 text-xs font-medium text-strong">{t('picture.connect')}</span>}
    </Link>
  )
}

function initialsOf(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0]?.toLocaleUpperCase() ?? '')
    .join('')
}

/**
 * The company's card: its name and four rows, each a button that opens the
 * drawer on that part. The sentences are built from the numbers and the
 * check results as they were read; a part that could not be read says so.
 */
function CompanyCard({
  ref,
  company,
  onOpen,
}: {
  ref: Ref<HTMLDivElement>
  company: PictureCompany
  onOpen: (tab: PictureTab) => void
}) {
  const t = useTranslations('wiki')
  const name = company.name ?? t('picture.company')

  const counts = company.counts
  const countParts = [
    counts.vouchers === null ? null : t('picture.count_vouchers', { count: counts.vouchers }),
    counts.bank_rows === null ? null : t('picture.count_bank_rows', { count: counts.bank_rows }),
    counts.documents === null ? null : t('picture.count_documents', { count: counts.documents }),
    counts.customers === null ? null : t('picture.count_customers', { count: counts.customers }),
    counts.suppliers === null ? null : t('picture.count_suppliers', { count: counts.suppliers }),
  ].filter((part): part is string => part !== null)

  const checks = company.checks
  const checkParts = checks
    ? [
        checks.counts.agrees > 0 ? t('picture.checks_agrees', { count: checks.counts.agrees }) : null,
        checks.counts.attention > 0 ? t('picture.checks_attention', { count: checks.counts.attention }) : null,
        checks.counts.unknown > 0 ? t('picture.checks_unknown_part', { count: checks.counts.unknown }) : null,
      ].filter((part): part is string => part !== null)
    : []

  const knowledge = company.knowledge
  const rows: Array<{ tab: PictureTab; line: string }> = [
    { tab: 'context', line: countParts.length > 0 ? countParts.join(', ') : t('picture.counts_unknown') },
    {
      tab: 'checks',
      line: !checks ? t('picture.checks_unreadable') : checkParts.length > 0 ? `${checkParts.join(', ')}.` : t('picture.checks_none'),
    },
    { tab: 'memory', line: company.memory_facts === null ? t('picture.counts_unknown') : t('picture.memory_line', { count: company.memory_facts }) },
    {
      tab: 'knowledge',
      line:
        knowledge.rule_areas === null
          ? t('picture.knowledge_line_workflows', { workflows: knowledge.workflows.length })
          : t('picture.knowledge_line', { areas: knowledge.rule_areas, workflows: knowledge.workflows.length }),
    },
  ]

  return (
    <div ref={ref} className="relative z-10 min-w-0 rounded-lg bg-control p-3.5 shadow-raised">
      <div className="flex items-center gap-2 pb-2">
        <span aria-hidden="true" className="grid h-6 w-6 shrink-0 place-items-center rounded-md bg-secondary text-xs font-semibold text-strong">
          {initialsOf(name)}
        </span>
        <span className="truncate text-[13px] font-medium text-strong" data-ph-mask="">
          {name}
        </span>
      </div>
      {rows.map((row) => (
        <button
          key={row.tab}
          type="button"
          onClick={() => onOpen(row.tab)}
          className="relative -mx-2 flex w-[calc(100%+1rem)] flex-col gap-0.5 rounded-md py-2 pl-2 pr-8 text-left outline-none transition-colors duration-150 hover:bg-secondary/60 focus-visible:ring-2 focus-visible:ring-ring/70"
        >
          <span className="text-[13px] font-medium text-strong">{t(`picture.row_${row.tab}`)}</span>
          <span className="text-xs tabular-nums text-foreground/80">{row.line}</span>
          <ChevronRightIcon className="absolute right-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
        </button>
      ))}
    </div>
  )
}
