'use client'

import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode, type Ref } from 'react'
import Link from 'next/link'
import { useLocale, useTranslations } from 'next-intl'
import { ChevronRightIcon } from '@/components/icons'
import { LoadError } from '@/components/ui/empty-state'
import { LateReveal, Skeleton } from '@/components/ui/skeleton'
import { useBranding } from '@/lib/branding/brand-context'
import { getErrorMessage, type ErrorLocale } from '@/lib/errors/get-error-message'
import { useFormat } from '@/lib/hooks/use-format'
import { cn } from '@/lib/utils'
import { agentCardState } from '@/lib/agent-context/agent-cards'
import { flowLayout, hitTest, type FlowCard, type FlowLayout } from '@/lib/agent-context/agent-picture-lines'
import {
  agentName,
  countParts,
  groupAgents,
  instantWords,
  isFresh,
  latestDelivery,
  memoryDots,
  offersClients,
  otherConnections,
  summarizeChecks,
  DOTS_PER_ROW,
  type AgentGroupId,
  type ChecksSummary,
} from '@/lib/agent-context/agent-picture-view'
import type {
  AgentPicture as AgentPictureData,
  PictureActivity,
  PictureAgentCard,
  PictureCompany,
  PictureLinkState,
  PictureSource,
} from '@/lib/agent-context/agent-picture'
import type { ConnectionKind } from '@/lib/settings/mcp-connections'
import { withoutPictureRow } from '@/lib/agent-context/wiki-views'
import { PictureViews, isPictureView, type PictureAgentView, type PictureContext, type PictureView } from './PictureViews'
import { WaitingLine } from './WaitingLine'
import { agentCardDetail, shortDay, type CardWords } from './agent-card-text'
import { AgentMark, LogoTile, SourceMark } from './picture-marks'

export type { PictureContext } from './PictureViews'

type LoadState = { state: 'loading' } | { state: 'ok'; data: AgentPictureData } | { state: 'failed'; description: string } | { state: 'off' }

/** How often the agents' activity is asked for again while the tab is visible. */
const ACTIVITY_INTERVAL_MS = 30_000

/** How long a closed view can still cover the page: its closing animation, with room to spare. */
const CLOSING_MS = 400
/** A press that reopens a view is also heard by the view that is leaving, which then asks to close: within this long, that is not a close. */
const REOPEN_GRACE_MS = 150

/** Where a connection is made and managed. */
const CONNECT_AGENT_HREF = '/settings/api'

/** The clients offered, faded, while the company has no connection of that kind. */
const OFFERED_CLIENTS = ['claude', 'chatgpt'] as const

/** The chart pair: blue for what flows and what is live, ochre for what just arrived. */
const BLUE = 'hsl(var(--chart-1))'
const OCHRE = 'hsl(var(--chart-2))'
const LIVE_RING: CSSProperties = { boxShadow: `0 0 0 1.5px ${BLUE}` }
const FRESH_RING: CSSProperties = { boxShadow: `0 0 0 1.5px ${OCHRE}` }

/** The picture's ground: a faint dot every 14px, in the strong line's ink. */
const DOTTED_GROUND: CSSProperties = {
  backgroundImage: 'radial-gradient(hsl(var(--line-strong)) 0.6px, transparent 0.7px)',
  backgroundSize: '14px 14px',
  backgroundPosition: '7px 7px',
}

/** The checks the sentences name in a word or two (wiki.picture.check_short). */
const SHORT_NAMES = new Set([
  'bank_balance_vs_bank',
  'skattekonto_vs_skatteverket',
  'receivables_vs_ledger',
  'payables_vs_ledger',
  'vat_declared_not_settled',
  'unbooked_bank_lines_overdue',
  'bank_feed',
])

/** A container and its label: a group of cards, or the shell round the company's card. */
const BOX_CLASS = 'flex min-w-0 flex-col gap-1 rounded-xl bg-background p-1 shadow-panel'
const BOX_LABEL_CLASS = 'flex items-center gap-1.5 px-2.5 pb-0.5 pt-1.5 text-xs font-medium text-foreground/80'

const REDUCED_MOTION = '(prefers-reduced-motion: reduce)'
function subscribeReducedMotion(onChange: () => void): () => void {
  const query = window.matchMedia(REDUCED_MOTION)
  query.addEventListener('change', onChange)
  return () => query.removeEventListener('change', onChange)
}
const reducedMotionNow = () => window.matchMedia(REDUCED_MOTION).matches
const reducedMotionOnServer = () => false

/**
 * Takes the row the address names, and its item, out of the address (with
 * `keepRow`, the item alone), so a reload does not open it again. Through
 * the History API, which Next keeps in step with useSearchParams: the page
 * is not loaded again.
 */
function forgetInAddress(options?: { keepRow?: boolean }): void {
  const here = `${window.location.pathname}${window.location.search}${window.location.hash}`
  const next = withoutPictureRow(here, options)
  if (next !== here) window.history.replaceState(null, '', next)
}

/**
 * One picture of what a connected agent gets: what is connected on the left,
 * the company in the middle, the agents on the right, and a line from every
 * card to the company's card (GET /api/wiki/picture). A source's card leads
 * to where its connection is managed; every row of the company's card opens
 * its own view, and an agent's card opens what the agent did for the company
 * in the same side panel (AgentPanel). The agents are one card per product:
 * the connections the screen names by the same kind share a card
 * (lib/agent-context/agent-cards.ts). The connections the person may not
 * list (other people's) are one card that says how many they are and
 * nothing else, and opens nothing; while there are any, or while it is not
 * known whether there are, no client is offered as not connected.
 * While the tab is visible the agents' activity and the memory's count are
 * asked for again every 30 seconds (GET /api/wiki/picture/activity): a card
 * whose connection just made a call says so, gets a ring and a moving line,
 * a card says what it did for the company today, and a newly remembered
 * thing gets its dot.
 *
 * `context` is the briefing as the page that hosts the picture loads it: the
 * Kontext row draws the context graph from it.
 *
 * `row` is the row the address names (lib/agent-context/wiki-views.ts): the
 * picture opens with that row's view open, and opens it when the address
 * comes to name it while the picture is shown. `item` is the knowledge item
 * the address names, whose folder the Kunskap view opens on. `agent` is the
 * agent card the address names, by its id: its panel opens once the picture
 * has that card. Closing takes all three out of the address; a row or a card
 * opened by a press is not written to it.
 */
export function AgentPicture({
  context,
  row = null,
  item = null,
  agent = null,
}: {
  context: PictureContext
  row?: PictureView | null
  item?: string | null
  agent?: string | null
}) {
  const t = useTranslations('wiki')
  const locale = useLocale() as ErrorLocale
  const [load, setLoad] = useState<LoadState>({ state: 'loading' })
  const [activity, setActivity] = useState<PictureActivity | null>(null)
  const [view, setView] = useState<PictureView | null>(row)
  // The row the address named at the last render: a change to another row opens that one.
  const [namedRow, setNamedRow] = useState(row)
  if (row !== namedRow) {
    setNamedRow(row)
    if (row) setView(row)
  }
  // The agent card whose panel is open, by its id: the one the address names, and one it comes to name.
  const [agentCard, setAgentCard] = useState<string | null>(agent)
  const [namedAgent, setNamedAgent] = useState(agent)
  if (agent !== namedAgent) {
    setNamedAgent(agent)
    if (agent) setAgentCard(agent)
  }

  // A view that is closing still covers the page for the length of its
  // animation and takes every press, so a press on another row would be
  // lost. While one is closing, a press is placed by where it landed: on a
  // row of the company's card it opens that row's view, on an agent's card
  // that card's panel.
  const closingUntil = useRef(0)
  const reopenedAt = useRef(0)
  const closeView = useCallback(() => {
    if (performance.now() - reopenedAt.current < REOPEN_GRACE_MS) return
    closingUntil.current = performance.now() + CLOSING_MS
    setAgentCard(null)
    setView(null)
    forgetInAddress()
  }, [])
  useEffect(() => {
    const onPress = (event: PointerEvent) => {
      if (performance.now() > closingUntil.current) return
      // A press on the view that is leaving is not a press on what is under it.
      if (event.target instanceof Element && event.target.closest('[role="dialog"]')) return
      const rows = Array.from(document.querySelectorAll<HTMLElement>('[data-picture-row]')).map((el) => ({
        id: el.dataset.pictureRow ?? '',
        rect: el.getBoundingClientRect(),
      }))
      const row = hitTest(rows, event.clientX, event.clientY)
      const cards = Array.from(document.querySelectorAll<HTMLElement>('[data-picture-agent]')).map((el) => ({
        id: el.dataset.pictureAgent ?? '',
        rect: el.getBoundingClientRect(),
      }))
      const card = isPictureView(row) ? null : hitTest(cards, event.clientX, event.clientY)
      if (!isPictureView(row) && !card) return
      closingUntil.current = 0
      reopenedAt.current = performance.now()
      if (isPictureView(row)) setView(row)
      else setAgentCard(card)
    }
    window.addEventListener('pointerdown', onPress, true)
    return () => window.removeEventListener('pointerdown', onPress, true)
  }, [])

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
  return (
    <PictureFigure
      picture={load.data}
      activity={activity}
      view={view}
      item={item}
      agentCard={agentCard}
      onOpen={setView}
      onOpenAgent={setAgentCard}
      onClose={closeView}
      context={context}
    />
  )
}

/** The canvas: between two hairlines, on the dotted ground, as wide as the page. */
function Canvas({ label, busy, children }: { label?: string; busy?: boolean; children: ReactNode }) {
  return (
    <section aria-label={label} aria-busy={busy} className="-mx-4 border-b-hairline border-t-hairline md:-mx-6" style={DOTTED_GROUND}>
      <div className="@container mx-auto max-w-[1120px] px-4 md:px-6">{children}</div>
    </section>
  )
}

const MAP_CLASS = 'relative grid items-center gap-x-4 gap-y-10 py-7 @3xl:grid-cols-[minmax(0,1fr)_minmax(0,1.08fr)_minmax(0,1fr)] @3xl:gap-x-16 @4xl:gap-x-26'

function PictureSkeleton() {
  return (
    <LateReveal>
      <Canvas busy>
        <div className={MAP_CLASS}>
          <div className="space-y-3">
            {[1, 2, 3, 4].map((i) => (
              <Skeleton key={i} className="h-13 w-full rounded-lg" />
            ))}
          </div>
          <Skeleton className="h-72 w-full rounded-xl" />
          <div className="space-y-3">
            {[1, 2].map((i) => (
              <Skeleton key={i} className="h-13 w-full rounded-lg" />
            ))}
          </div>
        </div>
      </Canvas>
    </LateReveal>
  )
}

/**
 * A card's detail line, always one line: `lead` gives way with an ellipsis
 * when the card is narrow; `tail` (a masked number, a time) is kept whole
 * for as long as there is room for it, and is never broken over two lines.
 * `under` is a second line of its own (how many connections an agent's card
 * stands for).
 */
interface CardDetail {
  lead: string
  tail?: string
  under?: string
}

interface AgentCard {
  id: string
  kind: ConnectionKind
  group: AgentGroupId
  name: string
  detail: CardDetail
  state: PictureLinkState
  /** A call in the last minute. */
  active: boolean
  /** A hand-made key's name and a service account's are the company's own text. */
  maskName: boolean
}

function PictureFigure({
  picture,
  activity,
  view,
  item,
  agentCard,
  onOpen,
  onOpenAgent,
  onClose,
  context,
}: {
  picture: AgentPictureData
  activity: PictureActivity | null
  view: PictureView | null
  /** The knowledge item the address names. */
  item: string | null
  /** The agent card whose panel is open, by its id. */
  agentCard: string | null
  onOpen: (view: PictureView) => void
  onOpenAgent: (card: string) => void
  onClose: () => void
  context: PictureContext
}) {
  const t = useTranslations('wiki')
  const tKeys = useTranslations('settings_api_keys')
  const { locale, formatDateLong } = useFormat()
  const { appName, logoUrl, logoPath } = useBranding()
  const brandMark = logoUrl ?? logoPath
  const reducedMotion = useSyncExternalStore(subscribeReducedMotion, reducedMotionNow, reducedMotionOnServer)

  /** The server's clock as last heard: what "just now" is measured from. */
  const clock = activity?.now ?? picture.generated_at

  // Swedish time, like the day an instant is counted to (instantWords).
  const timeOf = (date: Date) =>
    new Intl.DateTimeFormat(locale === 'en' ? 'en-GB' : 'sv-SE', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Stockholm' }).format(date)
  /** An instant or a date in words: today (with its time when it has one), another day by its long date. */
  const when = (instant: string): string => {
    const words = instantWords(instant, new Date())
    if (!words) return ''
    if (!words.today) return formatDateLong(words.date)
    return words.hasTime ? t('picture.today_at', { time: timeOf(words.date) }) : t('picture.today')
  }

  const sourceName = (source: PictureSource) => source.name ?? t(`picture.sources.${source.key}`)
  const sourceDetail = (source: PictureSource): CardDetail => {
    if (source.state === 'not_connected') return { lead: t('picture.not_connected') }
    if (source.state === 'unknown') return { lead: t('picture.state_unknown') }
    if (source.state === 'needs_attention') return { lead: t('picture.needs_attention') }
    const delivered = source.last_delivered_at ? when(source.last_delivered_at) : null
    const after = (text: string | null) => (text ? ` · ${text}` : undefined)
    switch (source.key) {
      case 'bank': {
        // The account's name gives way first; its masked number and the time stay whole.
        const rest = [source.tail ? `••${source.tail}` : null, delivered].filter(Boolean).join(' · ')
        if (!source.detail) return { lead: rest || t('picture.connected') }
        return { lead: source.detail, tail: rest ? ` ${rest}` : undefined }
      }
      case 'skatteverket':
        return delivered ? { lead: t('picture.detail_skattekonto'), tail: after(delivered) } : { lead: t('picture.connected') }
      case 'bolagsverket':
        return { lead: t('picture.detail_register'), tail: after(delivered) }
      case 'inbox':
        return { lead: (source.count === null ? source.detail : t('picture.inbox_count', { count: source.count })) ?? t('picture.connected') }
      case 'whatsapp':
      case 'pos':
        return { lead: source.detail ?? t('picture.connected') }
      default:
        return { lead: t('picture.connected'), tail: after(delivered) }
    }
  }

  /** A card's name, as the API settings page names a connection's row. */
  const nameOf = (agent: Pick<PictureAgentCard, 'kind' | 'name' | 'service_account'>): string => {
    const name = agentName(agent)
    return 'text' in name ? name.text : tKeys(name.message)
  }

  const words: CardWords = {
    time: (instant) => timeOf(new Date(instant)),
    when,
    day: (instant) => shortDay(instant, new Date(), locale, t('picture.today')),
  }
  const agentCards: AgentCard[] = (picture.agents?.list ?? []).map((agent) => {
    // The newest answer of the log wins over the one the picture came with (agentCardState).
    const state = agentCardState(agent, activity)
    return {
      id: agent.id,
      kind: agent.kind,
      group: 'clients',
      name: nameOf(agent),
      detail: agentCardDetail(state, t, words),
      state: 'connected',
      active: state.active,
      maskName: agent.kind === 'key' || agent.service_account !== null,
    }
  })
  // The groups of the column: who signed in, the host's own service accounts, the company's other ones, hand-made keys.
  const grouped = groupAgents(
    (picture.agents?.list ?? []).map((agent, i) => ({ ...agent, card: agentCards[i] })),
    appName,
  )
  const cardsOf = (id: AgentGroupId) => grouped.find((group) => group.id === id)?.agents.map((agent) => ({ ...agent.card, group: id })) ?? []
  // The connections the person may not list: how many, or that it is not known.
  const others = otherConnections(picture.agents)
  const offered: AgentCard[] = offersClients(picture.agents)
    ? OFFERED_CLIENTS.filter((kind) => !agentCards.some((card) => card.kind === kind)).map((kind) => ({
        id: `offer:${kind}`,
        kind,
        group: 'clients',
        name: nameOf({ kind, name: null, service_account: null }),
        detail: { lead: t('picture.not_connected') },
        state: 'not_connected',
        active: false,
        maskName: false,
      }))
    : []
  const agentGroups: Array<{ id: AgentGroupId; label: string; cards: AgentCard[] }> = [
    { id: 'clients' as const, label: t('picture.groups.agents'), cards: [...cardsOf('clients'), ...offered] },
    { id: 'brand' as const, label: appName, cards: cardsOf('brand') },
    { id: 'service_accounts' as const, label: tKeys('group_service_accounts'), cards: cardsOf('service_accounts') },
    { id: 'keys' as const, label: t('picture.groups.keys'), cards: cardsOf('keys') },
  ].filter((group) => group.cards.length > 0)
  const more = picture.agents?.more ?? 0

  // What the open card's panel is given. A card the picture does not list (an id the address made up) opens nothing.
  const openCard = agentCard ? (picture.agents?.list.find((card) => card.id === agentCard) ?? null) : null
  const openState = openCard ? agentCardState(openCard, activity) : null
  const agentView: PictureAgentView | null =
    openCard && openState
      ? {
          card: openCard,
          name: nameOf(openCard),
          maskName: openCard.kind === 'key' || openCard.service_account !== null,
          calls:
            activity && openState.calls > 0 && openState.last_call_at
              ? { count: openState.calls, last_call_at: openState.last_call_at, capped: openState.capped }
              : null,
          activity,
        }
      : null

  const memoryFacts = activity ? (activity.memory_facts ?? picture.company.memory_facts) : picture.company.memory_facts
  const updated = latestDelivery(picture.sources)

  // The lines, measured from where the cards ended up, again on every resize
  // and whenever a card appears, changes state or starts or stops working.
  const mapRef = useRef<HTMLDivElement>(null)
  const coreRef = useRef<HTMLDivElement>(null)
  const inRef = useRef<HTMLDivElement>(null)
  const outRef = useRef<HTMLDivElement>(null)
  const [layout, setLayout] = useState<FlowLayout | null>(null)
  const signature = [
    ...picture.sources.flatMap((group) => group.items.map((item) => `${item.id}:${item.state}`)),
    ...agentGroups.flatMap((group) => group.cards.map((card) => `${card.id}:${card.state}:${card.active}`)),
    picture.agents ? more : 'unknown',
    others.kind === 'count' ? `others:${others.count}` : `others:${others.kind}`,
    memoryFacts ?? 'unknown',
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

  const solid = layout?.lines.filter((line) => !line.dashed) ?? []
  const dashed = layout?.lines.filter((line) => line.dashed) ?? []

  return (
    <>
      <Canvas label={t('picture.label')}>
        <div ref={mapRef} className={MAP_CLASS}>
          {layout && (
            <svg aria-hidden="true" className="pointer-events-none absolute inset-0 h-full w-full overflow-visible" viewBox={`0 0 ${layout.width} ${layout.height}`} fill="none">
              {/* A soft wide halo under every connected line, then the lines themselves, so no halo dulls a line. */}
              {solid.map((line) => (
                <path key={`halo:${line.id}`} d={line.d} stroke={BLUE} strokeOpacity={0.1} strokeWidth={6} strokeLinecap="round" />
              ))}
              {dashed.map((line) => (
                <path key={line.id} d={line.d} strokeWidth={1.25} strokeDasharray="3 4" className="stroke-line-strong" />
              ))}
              {solid.map((line) => (
                <path key={line.id} d={line.d} stroke={BLUE} strokeWidth={line.active ? 2 : 1.25} strokeLinecap="round" strokeDasharray={line.active ? '10 14' : undefined}>
                  {/* The dashes travel only where motion is welcome; the card's ring and its own words say the same without it. */}
                  {line.active && !reducedMotion && <animate attributeName="stroke-dashoffset" from="24" to="0" dur="0.9s" repeatCount="indefinite" />}
                </path>
              ))}
              {layout.sockets.map((socket, i) => (
                <circle key={i} cx={socket.x} cy={socket.y} r={3} strokeWidth={1} className="fill-background stroke-line-strong" />
              ))}
            </svg>
          )}

          <div ref={inRef} className="relative z-10 flex min-w-0 flex-col gap-3">
            {picture.sources.map((group) => (
              <CardGroup key={group.id} label={t(`picture.groups.${group.id}`)}>
                {group.items.map((source) => (
                  <PictureCard
                    key={source.id}
                    flowId={source.id}
                    side="in"
                    href={source.href}
                    state={source.state}
                    ring={source.state === 'connected' && isFresh(source.last_delivered_at, clock) ? 'fresh' : null}
                    mark={<SourceMark sourceKey={source.key} logo={source.logo} off={source.state === 'not_connected'} />}
                    name={sourceName(source)}
                    detail={sourceDetail(source)}
                    // A bank's own name, an account's and an address are the company's data.
                    maskName={source.name !== null}
                  />
                ))}
              </CardGroup>
            ))}
          </div>

          <CompanyCard
            ref={coreRef}
            company={picture.company}
            brand={{ name: appName, mark: brandMark }}
            memoryFacts={memoryFacts}
            updated={updated ? when(updated) : null}
            when={when}
            onOpen={onOpen}
          />

          <div ref={outRef} className="relative z-10 flex min-w-0 flex-col gap-3">
            {picture.agents === null && (
              <CardGroup label={t('picture.groups.agents')}>
                <PictureCard
                  flowId="agents"
                  side="out"
                  href={CONNECT_AGENT_HREF}
                  state="unknown"
                  ring={null}
                  mark={<AgentMark kind="mcp" />}
                  name={t('picture.agents_unknown')}
                  detail={{ lead: t('picture.state_unknown') }}
                  maskName={false}
                />
              </CardGroup>
            )}
            {agentGroups.map((group) => (
              <CardGroup key={group.id} label={group.label}>
                {group.cards.map((card) => (
                  <PictureCard
                    key={card.id}
                    flowId={card.id}
                    side="out"
                    href={CONNECT_AGENT_HREF}
                    // A connected agent's card opens its panel; one that is offered leads to where it is connected.
                    onPress={card.state === 'connected' ? () => onOpenAgent(card.id) : undefined}
                    state={card.state}
                    active={card.active}
                    ring={card.active ? 'live' : null}
                    // The host's own service account carries the host's mark.
                    mark={group.id === 'brand' ? <LogoTile src={brandMark} /> : <AgentMark kind={card.kind} off={card.state === 'not_connected'} />}
                    name={card.name}
                    detail={card.detail}
                    maskName={card.maskName}
                  />
                ))}
              </CardGroup>
            ))}
            {others.kind !== 'none' && (
              // Other people's connections: a number and no way in. No name, no key, no link.
              <div className={BOX_CLASS}>
                <PictureCard
                  flowId="others"
                  side="out"
                  state={others.kind === 'count' ? 'connected' : 'unknown'}
                  ring={null}
                  mark={<AgentMark kind="mcp" />}
                  name={others.kind === 'count' ? t('picture.agents_others', { count: others.count }) : t('picture.agents_unknown')}
                  detail={{ lead: others.kind === 'count' ? t('picture.agents_others_by', { count: others.count }) : t('picture.state_unknown') }}
                  wrapDetail
                  maskName={false}
                />
              </div>
            )}
            {more > 0 && (
              <Link href={CONNECT_AGENT_HREF} className="px-3.5 text-xs font-medium text-foreground/80 underline-offset-2 hover:underline">
                {t('picture.agents_more', { count: more })}
              </Link>
            )}
          </div>
        </div>
      </Canvas>

      <PictureViews
        view={view}
        agent={agentView}
        onClose={onClose}
        companyName={picture.company.name}
        context={context}
        checks={picture.company.checks}
        activeKnowledge={picture.company.knowledge.active}
        knowledgeItem={item}
        onKnowledgeItemClose={() => forgetInAddress({ keepRow: true })}
        when={when}
        time={words.time}
      />
    </>
  )
}

/** A group of cards in its box: the label inside at the top, the cards stacked under it. */
function CardGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div role="group" aria-label={label} className={BOX_CLASS}>
      <div className={BOX_LABEL_CLASS}>{label}</div>
      {children}
    </div>
  )
}

/**
 * One card: a source or an agent. The whole card is the link to where it is
 * managed (`href`); with `onPress` it is instead a button that opens what is
 * behind it in place, and with neither it is not a control at all. A card
 * that is not connected is flat with a hairline,
 * faded, its mark greyed, and says Koppla. A ring says something is
 * happening: blue for a connection that just made a call, ochre for a source
 * that just delivered. The data attributes are what the lines are measured
 * from, and what a press is placed by while a view is closing.
 */
function PictureCard({
  flowId,
  side,
  href,
  onPress,
  state,
  active = false,
  ring,
  mark,
  name,
  detail,
  wrapDetail = false,
  maskName,
}: {
  flowId: string
  side: 'in' | 'out'
  href?: string
  onPress?: () => void
  state: PictureLinkState
  active?: boolean
  ring: 'live' | 'fresh' | null
  mark: ReactNode
  name: string
  detail: CardDetail
  /** The detail is a sentence that goes onto a second line when the card is narrow, instead of being cut. */
  wrapDetail?: boolean
  maskName: boolean
}) {
  const t = useTranslations('wiki')
  const off = state === 'not_connected'
  const control = onPress !== undefined || href !== undefined
  const flow = {
    'data-flow-id': flowId,
    'data-flow-side': side,
    'data-flow-connected': state === 'connected' ? 'true' : 'false',
    'data-flow-active': active ? 'true' : 'false',
    style: ring === 'live' ? LIVE_RING : ring === 'fresh' ? FRESH_RING : undefined,
    className: cn(
      'flex min-h-13 items-center gap-2.5 rounded-lg px-2.5 py-2',
      off ? 'border border-border' : 'bg-control shadow-raised',
      // Only a card that leads somewhere answers the pointer and takes focus.
      control && 'outline-none focus-visible:ring-2 focus-visible:ring-ring/70',
      control && (off ? 'transition-colors duration-150 hover:bg-secondary/60' : 'transition-shadow duration-150 hover:shadow-raised-hover'),
      onPress && 'w-full text-left',
    ),
  }
  const body = (
    <>
      {mark}
      <span className={cn('flex min-w-0 flex-1 flex-col', off && 'opacity-60')}>
        <span className="truncate text-[13px] font-medium text-strong" {...(maskName ? { 'data-ph-mask': '' } : {})}>
          {name}
        </span>
        <span className={cn('flex min-w-0 text-xs tabular-nums', state === 'needs_attention' ? 'text-attn' : 'text-muted-foreground')} data-ph-mask="">
          {/* Both may shrink, the lead far more readily: it gives way to an ellipsis before the tail loses a character. */}
          <span className={cn('min-w-0', !wrapDetail && 'flex-[0_9999_auto] truncate')}>{detail.lead}</span>
          {detail.tail && <span className="min-w-0 flex-[0_1_auto] overflow-hidden text-ellipsis whitespace-pre">{detail.tail}</span>}
        </span>
        {detail.under && (
          <span className="truncate text-xs tabular-nums text-muted-foreground" data-ph-mask="">
            {detail.under}
          </span>
        )}
      </span>
      {off && <span className="shrink-0 text-xs font-medium text-strong">{t('picture.connect')}</span>}
    </>
  )
  if (onPress) {
    return (
      <button type="button" data-picture-agent={flowId} onClick={onPress} {...flow}>
        {body}
      </button>
    )
  }
  if (href !== undefined) {
    return (
      <Link href={href} {...flow}>
        {body}
      </Link>
    )
  }
  return <div {...flow}>{body}</div>
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
 * The company's card in its shell. The shell's label row carries the host's
 * brand; the card inside has the company's initials and name, what waits on
 * the company's people (WaitingLine), when it was last updated, and four
 * rows that are buttons, each opening its own view.
 * The sentences are built from the numbers and the check results as they
 * were read; a part that could not be read says so.
 */
function CompanyCard({
  ref,
  company,
  brand,
  memoryFacts,
  updated,
  when,
  onOpen,
}: {
  ref: Ref<HTMLDivElement>
  company: PictureCompany
  brand: { name: string; mark: string }
  memoryFacts: number | null
  /** When the newest connected source delivered, in words; null when no time is known. */
  updated: string | null
  when: (instant: string) => string
  onOpen: (view: PictureView) => void
}) {
  const t = useTranslations('wiki')
  const name = company.name ?? t('picture.company')

  const counted = countParts(company.counts)
  const countLine = counted.unknown
    ? t('picture.counts_unknown')
    : counted.parts.length === 0
      ? t('picture.counts_empty')
      : counted.parts.map((part) => t(`picture.count_${part.kind}`, { count: part.count })).join(', ')

  const shortName = (id: string) => (SHORT_NAMES.has(id) ? t(`picture.check_short.${id}`) : id)
  const checksLine = (summary: ChecksSummary): string => {
    switch (summary.kind) {
      case 'unreadable':
        return t('picture.checks_unreadable')
      case 'none':
        return t('picture.checks_none')
      case 'unknown':
        return t('picture.checks_unknown_sentence', { count: summary.count })
      case 'attention': {
        const names = summary.names.map(shortName).join(', ') + (summary.more > 0 ? ` +${summary.more}` : '')
        const agrees = summary.agrees > 0 ? t('picture.checks_agree_count', { count: summary.agrees }) : null
        return [t('picture.checks_attention_named', { count: summary.count, names }), agrees].filter(Boolean).join(' ')
      }
      case 'agrees': {
        const named = summary.named.map((entry) => {
          const what = t(`picture.check_agrees_what.${entry.check_id}`)
          const at = entry.as_of ? when(entry.as_of) : ''
          return at ? t('picture.checks_agrees_with_at', { what, when: at }) : t('picture.checks_agrees_with', { what })
        })
        const rest =
          summary.named.length === 0
            ? t('picture.checks_agree_count', { count: summary.agrees })
            : summary.more > 0
              ? t('picture.checks_more_agree', { count: summary.more })
              : null
        const unknown = summary.unknown > 0 ? t('picture.checks_unknown_sentence', { count: summary.unknown }) : null
        return [...named, rest, unknown].filter(Boolean).join(' ')
      }
    }
  }

  const rows: Array<{ view: PictureView; line: string; under?: ReactNode }> = [
    { view: 'context', line: countLine },
    { view: 'checks', line: checksLine(summarizeChecks(company.checks)) },
    {
      view: 'memory',
      line: memoryFacts === null ? t('picture.counts_unknown') : t('picture.memory_line', { count: memoryFacts }),
      under: memoryFacts === null ? undefined : <MemoryDots count={memoryFacts} />,
    },
    {
      view: 'knowledge',
      line: company.knowledge.items === null ? t('picture.counts_unknown') : t('picture.knowledge_line', { count: company.knowledge.items }),
    },
  ]

  return (
    <div ref={ref} className={cn(BOX_CLASS, 'relative z-10')}>
      <div className={BOX_LABEL_CLASS}>
        {/* The host's own mark, from the branding it already carries. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={brand.mark} alt="" width={16} height={16} className="h-4 w-4 rounded-sm object-contain" />
        {brand.name}
      </div>
      <div className="flex flex-col gap-1.5 rounded-lg bg-control p-3.5 shadow-raised">
        <div className="flex items-center gap-2 pb-1.5">
          <span aria-hidden="true" className="grid h-6 w-6 shrink-0 place-items-center rounded-md bg-secondary text-xs font-semibold text-strong">
            {initialsOf(name)}
          </span>
          <span className="flex min-w-0 flex-col">
            <span className="truncate text-[13px] font-medium leading-4 text-strong" data-ph-mask="">
              {name}
            </span>
            <WaitingLine waiting={company.waiting} />
            {updated && <span className="text-xs tabular-nums text-muted-foreground">{t('picture.updated', { when: updated })}</span>}
          </span>
        </div>
        {rows.map((row) => (
          <button
            key={row.view}
            type="button"
            data-picture-row={row.view}
            onClick={() => onOpen(row.view)}
            className="relative -mx-2 flex w-[calc(100%+1rem)] flex-col gap-0.5 rounded-lg py-2 pl-2 pr-8 text-left outline-none transition-colors duration-150 hover:bg-secondary/60 focus-visible:ring-2 focus-visible:ring-ring/70"
          >
            <span className="text-[13px] font-medium text-strong">{t(`picture.row_${row.view}`)}</span>
            <span className="text-xs tabular-nums text-foreground/80">{row.line}</span>
            {row.under}
            <ChevronRightIcon className="absolute right-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
          </button>
        ))}
      </div>
    </div>
  )
}

/**
 * The memory as dots: rows of twelve, one filled dot per remembered thing
 * (memoryDots says how many). A dot that fills while the page is open comes
 * in with the app's enter motion, which stands still under reduced motion.
 */
function MemoryDots({ count }: { count: number }) {
  const { total, filled } = memoryDots(count)
  // What was filled when the picture opened: only what comes after it animates in.
  const [filledAtOpen] = useState(filled)
  return (
    <span aria-hidden="true" className="mt-1.5 grid w-max gap-1" style={{ gridTemplateColumns: `repeat(${DOTS_PER_ROW}, 6px)` }}>
      {Array.from({ length: total }, (_, i) => (
        <span
          key={i}
          className={cn(
            'h-1.5 w-1.5 rounded-full',
            i >= filled && 'bg-line-strong',
            i < filled && i >= filledAtOpen && 'animate-in fade-in-0 duration-300 ease-emphasized [--tw-enter-scale:0.3]',
          )}
          style={i < filled ? { backgroundColor: BLUE } : undefined}
        />
      ))}
    </span>
  )
}
